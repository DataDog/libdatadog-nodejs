use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(js_name = "zstd_compress")]
pub fn zstd_compress(data: Buffer, level: i32) -> Result<Buffer> {
    zstd::encode_all(data.as_ref(), level)
        .map(Buffer::from)
        .map_err(|error| Error::from_reason(format!("failed to compress data: {error}")))
}
