pub trait FromBytes: Sized {
    type Bytes: ?Sized;
    fn from_bytes(bytes: &[u8]) -> Self;
}

macro_rules! impl_from_bytes {
    ($ty:ty, $len:expr) => {
        impl FromBytes for $ty {
            type Bytes = $ty;

            // Note that this always does a copy into a new variable. This is
            // because the values in the buffer are not aligned. We could save
            // ourselves a copy by ensuring alignment from the managed side.
            fn from_bytes(bytes: &[u8]) -> Self {
                let mut code_buf = [0u8; $len];
                code_buf.copy_from_slice(bytes);
                <$ty>::from_le_bytes(code_buf)
            }
        }
    };
}

impl_from_bytes!(u128, 16);
impl_from_bytes!(u64, 8);
impl_from_bytes!(f64, 8);
impl_from_bytes!(i64, 8);
impl_from_bytes!(i32, 4);
impl_from_bytes!(u32, 4);

/// Read a `T` from `buf` at `*index` (little-endian) and advance `*index`.
///
/// Returns `None` if the buffer is too short, so callers can't index out of
/// bounds — the bounds check lives here rather than relying on every call site.
/// The remaining-bytes form (`size > buf.len() - id`) is overflow-safe.
pub(crate) fn get_num<T: Copy + FromBytes>(buf: &[u8], index: &mut usize) -> Option<T> {
    let id: usize = *index;
    let size = std::mem::size_of::<T>();
    if id > buf.len() || size > buf.len() - id {
        return None;
    }
    let result: T = T::from_bytes(&buf[id..id + size]);
    *index += size;
    Some(result)
}
