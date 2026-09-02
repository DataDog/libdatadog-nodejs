mod data_pipeline;
mod remote_config;
mod sketches;
mod zstd;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod wasm_allocator {
    use std::alloc::{alloc, dealloc, Layout};
    use std::mem::{align_of, size_of};
    use std::ptr;

    const ALIGNMENT: usize = 16;
    const HEADER_SIZE: usize = size_of::<usize>().next_multiple_of(ALIGNMENT);

    #[no_mangle]
    unsafe extern "C" fn malloc(size: usize) -> *mut u8 {
        let Some(allocation_size) = size.checked_add(HEADER_SIZE) else {
            return ptr::null_mut();
        };
        let Ok(layout) = Layout::from_size_align(allocation_size, ALIGNMENT) else {
            return ptr::null_mut();
        };
        let allocation = alloc(layout);
        if allocation.is_null() {
            return allocation;
        }
        allocation.cast::<usize>().write(size);
        allocation.add(HEADER_SIZE)
    }

    #[no_mangle]
    unsafe extern "C" fn free(pointer: *mut u8) {
        if pointer.is_null() {
            return;
        }
        let allocation = pointer.sub(HEADER_SIZE);
        let size = allocation.cast::<usize>().read();
        let layout = Layout::from_size_align_unchecked(size + HEADER_SIZE, ALIGNMENT);
        dealloc(allocation, layout);
    }

    const _: () = assert!(ALIGNMENT >= align_of::<usize>());
}

#[napi_derive::module_init]
fn install_async_runtime() {
    let options = napi_async_runtime::RuntimeOptions {
        flavor: napi_async_runtime::RuntimeFlavor::CurrentThread,
        ..Default::default()
    };
    napi_async_runtime::install(options).expect("failed to install the napi-rs async runtime");
}
