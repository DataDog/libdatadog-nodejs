use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn zstd_compress(data: Uint8Array, level: i32) -> Uint8Array {
    let compressed_data = zrip::compress(&data.to_vec(), level).expect("Failed to compress data");
    Uint8Array::from(compressed_data.as_slice())
}
