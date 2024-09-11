use napi_derive::napi;

#[napi]
pub fn boom() -> napi::Result<()> {
    unsafe { std::ptr::null_mut::<i32>().write(42) };

    Ok(())
}
