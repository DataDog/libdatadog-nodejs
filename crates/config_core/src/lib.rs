use libdd_config_core::WireResolver;
use napi::bindgen_prelude::{Buffer, BufferSlice};
use napi_derive::napi;

#[derive(Default)]
#[napi]
pub struct JsConfigResolver {
    resolver: WireResolver,
}

#[napi]
impl JsConfigResolver {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn request(&mut self, request: BufferSlice<'_>) -> napi::Result<Buffer> {
        self.resolver
            .request(request.as_ref())
            .map(Buffer::from)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }
}
