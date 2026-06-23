use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn zstd_compress(data: Uint8Array, level: i32) -> Uint8Array {
    let vecdata = data.to_vec();
    let compressed_data = zstd::encode_all(&vecdata[..], level).expect("Failed to compress data");
    Uint8Array::from(compressed_data.as_slice())
}
