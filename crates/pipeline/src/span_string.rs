use bumpalo::Bump;
use libdd_trace_utils::span::SpanText;
use serde::Serialize;
use std::borrow::Borrow;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ptr::NonNull;

thread_local! {
    /// Session-scoped bump arena for string data.
    ///
    /// bumpalo guarantees that once a string is allocated, its memory is never
    /// moved, making it safe to hold raw pointers into this arena for the full
    /// session lifetime. In WASM's single-threaded environment this is
    /// effectively a global. The arena is never reset; it grows to accommodate
    /// all unique strings registered during the session (same behaviour as the
    /// previous Arc<str> approach, where table entries lived indefinitely).
    static ARENA: Bump = Bump::with_capacity(64 * 1024);
}

/// Allocate `s` in the thread-local bump arena and return a stable pointer.
///
/// # Safety
/// The returned pointer is valid for the entire thread lifetime (= the WASM
/// session). bumpalo guarantees that previously allocated memory is never
/// moved when additional allocations are made.
fn arena_alloc(s: &str) -> NonNull<str> {
    ARENA.with(|arena| {
        let interned: &str = arena.alloc_str(s);
        // SAFETY: &str is non-null; we extend the lifetime to 'static by
        // casting to a raw pointer. The pointed-to data lives in ARENA,
        // which outlives all SpanString values.
        unsafe { NonNull::new_unchecked(interned as *const str as *mut str) }
    })
}

/// A span string backed by the session-scoped thread-local bump arena.
///
/// ### Compared to `Arc<str>`
///
/// | Operation | `Arc<str>`            | `SpanString`              |
/// |-----------|----------------------|---------------------------|
/// | Clone     | atomic fetch_add     | 16-byte pointer copy      |
/// | Drop      | atomic fetch_sub     | no-op                     |
/// | Alloc     | malloc + refcount    | bump pointer + memcpy     |
///
/// Strings are allocated once (on first registration in the string table) and
/// their data is packed contiguously in the arena, improving cache locality
/// when iterating span tags. Individual strings are never freed; the arena
/// is freed all-at-once at session end.
///
/// # Safety
/// `SpanString` holds a `NonNull<str>` pointing into the thread-local `ARENA`.
/// In WASM's single-threaded model there is only one thread, so this is always
/// safe. `SpanString` is intentionally not `Send`/`Sync`.
pub struct SpanString(NonNull<str>);

impl Clone for SpanString {
    #[inline]
    fn clone(&self) -> Self {
        // O(1) — copies a 16-byte fat pointer. No atomic ops.
        SpanString(self.0)
    }
}

impl Default for SpanString {
    fn default() -> Self {
        // Points directly at the 'static empty string — no arena allocation.
        SpanString::from_static_str("")
    }
}

impl fmt::Debug for SpanString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // SAFETY: pointer is valid for the session lifetime.
        write!(f, "{:?}", unsafe { self.0.as_ref() })
    }
}

impl fmt::Display for SpanString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // SAFETY: pointer is valid for the session lifetime.
        write!(f, "{}", unsafe { self.0.as_ref() })
    }
}

impl PartialEq for SpanString {
    fn eq(&self, other: &Self) -> bool {
        // Compare string content, not pointer identity.
        // SAFETY: both pointers are valid.
        let a: &str = unsafe { self.0.as_ref() };
        let b: &str = unsafe { other.0.as_ref() };
        a == b
    }
}

impl Eq for SpanString {}

impl Hash for SpanString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // Hash string content — consistent with `str`'s Hash impl so that
        // HashMap::get(&str) lookups work correctly without constructing a key.
        // SAFETY: pointer is valid.
        let s: &str = unsafe { self.0.as_ref() };
        s.hash(state);
    }
}

impl Borrow<str> for SpanString {
    fn borrow(&self) -> &str {
        // SAFETY: The pointed-to str lives in ARENA for the session lifetime,
        // which exceeds the lifetime of any SpanString. The lifetime bound to
        // &self is conservative but correct.
        unsafe { self.0.as_ref() }
    }
}

impl Serialize for SpanString {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // SAFETY: pointer is valid.
        s.serialize_str(unsafe { self.0.as_ref() })
    }
}

impl SpanText for SpanString {
    fn from_static_str(value: &'static str) -> Self {
        // Static strings never move — store their pointer directly without
        // touching the arena. This is used for the ~10 cached meta key
        // constants (e.g. "language", "_dd.top_level") in ChangeBufferState.
        // SAFETY: &'static str is non-null and valid forever.
        SpanString(unsafe { NonNull::new_unchecked(value as *const str as *mut str) })
    }
}

impl From<String> for SpanString {
    fn from(s: String) -> SpanString {
        SpanString(arena_alloc(&s))
    }
}

impl From<&str> for SpanString {
    fn from(s: &str) -> SpanString {
        SpanString(arena_alloc(s))
    }
}
