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
    /// session lifetime. Node.js is single-threaded so this thread-local is
    /// effectively a global for the lifetime of the addon.
    static ARENA: Bump = Bump::with_capacity(64 * 1024);
}

/// Allocate `s` in the thread-local bump arena and return a stable pointer.
fn arena_alloc(s: &str) -> NonNull<str> {
    ARENA.with(|arena| {
        let interned: &str = arena.alloc_str(s);
        // SAFETY: bumpalo never moves previously allocated data.
        // ARENA lives for the thread (= session) lifetime.
        unsafe { NonNull::new_unchecked(interned as *const str as *mut str) }
    })
}

/// A span string backed by the session-scoped thread-local bump arena.
///
/// ### Compared to `Arc<str>`
///
/// | Operation | `Arc<str>`            | `NativeSpanString`        |
/// |-----------|----------------------|---------------------------|
/// | Clone     | atomic fetch_add     | 16-byte pointer copy      |
/// | Drop      | atomic fetch_sub     | no-op                     |
/// | Alloc     | malloc + refcount    | bump pointer + memcpy     |
///
/// # Safety
/// `NativeSpanString` holds a `NonNull<str>` pointing into the thread-local
/// `ARENA`. Node.js is single-threaded; all string allocation and access
/// happens on the main JS thread. The `unsafe impl Send + Sync` below is
/// consistent with `unsafe impl Send + Sync for NativeSpanState {}`: we
/// assert that no concurrent access actually occurs at runtime.
pub struct NativeSpanString(NonNull<str>);

// SAFETY: Node.js is single-threaded. All NativeSpanString values are created
// and accessed on the main thread. The arena data lives in heap memory that is
// technically accessible from any thread (read-only), and no new allocations
// happen off the main thread. This mirrors the existing `unsafe impl Send for
// NativeSpanState {}` in lib.rs.
unsafe impl Send for NativeSpanString {}
unsafe impl Sync for NativeSpanString {}

impl Clone for NativeSpanString {
    #[inline]
    fn clone(&self) -> Self {
        // O(1) — copies a 16-byte fat pointer. No atomic ops.
        NativeSpanString(self.0)
    }
}

impl Default for NativeSpanString {
    fn default() -> Self {
        NativeSpanString::from_static_str("")
    }
}

impl fmt::Debug for NativeSpanString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", unsafe { self.0.as_ref() })
    }
}

impl fmt::Display for NativeSpanString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", unsafe { self.0.as_ref() })
    }
}

impl PartialEq for NativeSpanString {
    fn eq(&self, other: &Self) -> bool {
        let a: &str = unsafe { self.0.as_ref() };
        let b: &str = unsafe { other.0.as_ref() };
        a == b
    }
}

impl Eq for NativeSpanString {}

impl Hash for NativeSpanString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        let s: &str = unsafe { self.0.as_ref() };
        s.hash(state);
    }
}

impl Borrow<str> for NativeSpanString {
    fn borrow(&self) -> &str {
        // SAFETY: pointer is valid for the session lifetime.
        unsafe { self.0.as_ref() }
    }
}

impl Serialize for NativeSpanString {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(unsafe { self.0.as_ref() })
    }
}

impl SpanText for NativeSpanString {
    fn from_static_str(value: &'static str) -> Self {
        // Static strings never move — store pointer directly, no arena needed.
        // SAFETY: &'static str is non-null and valid forever.
        NativeSpanString(unsafe { NonNull::new_unchecked(value as *const str as *mut str) })
    }
}

impl From<String> for NativeSpanString {
    fn from(s: String) -> NativeSpanString {
        NativeSpanString(arena_alloc(&s))
    }
}

impl From<&str> for NativeSpanString {
    fn from(s: &str) -> NativeSpanString {
        NativeSpanString(arena_alloc(s))
    }
}
