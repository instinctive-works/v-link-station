/// V-Link WASM video frame management.
///
/// All pointers refer to WASM linear memory (SharedArrayBuffer on the JS side).
/// JS calls alloc_frame to reserve a pixel buffer, writes RGBA data into it,
/// passes the pointer through the node graph, then calls free_frame when done.
use std::alloc::{alloc, dealloc, Layout};

/// Allocate a zeroed frame buffer of `size` bytes.
/// Returns a pointer into WASM memory, or 0 on failure.
#[no_mangle]
pub extern "C" fn alloc_frame(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    let layout = match Layout::from_size_align(size, 16) {
        Ok(l) => l,
        Err(_) => return std::ptr::null_mut(),
    };
    let ptr = unsafe { alloc(layout) };
    if ptr.is_null() {
        return std::ptr::null_mut();
    }
    // Zero-initialise so callers that do partial writes see no garbage.
    unsafe { std::ptr::write_bytes(ptr, 0, size) };
    ptr
}

/// Free a frame buffer previously returned by `alloc_frame`.
#[no_mangle]
pub extern "C" fn free_frame(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    let layout = match Layout::from_size_align(size, 16) {
        Ok(l) => l,
        Err(_) => return,
    };
    unsafe { dealloc(ptr, layout) };
}

/// Copy `len` bytes from `src` to `dst` (both in WASM memory).
/// Used by Merge to snapshot incoming frames before the source frees them.
#[no_mangle]
pub extern "C" fn copy_frame(src: *const u8, dst: *mut u8, len: usize) {
    if src.is_null() || dst.is_null() || len == 0 {
        return;
    }
    unsafe { std::ptr::copy_nonoverlapping(src, dst, len) };
}

/// Alpha-blend two RGBA frame buffers into `ptr_out`.
///
/// `alpha_256`: 0 → 100 % A,  256 → 100 % B,  128 → 50/50 mix.
/// The output alpha channel is always 255 (fully opaque).
#[no_mangle]
pub extern "C" fn blend_frames(
    ptr_a: *const u8,
    ptr_b: *const u8,
    ptr_out: *mut u8,
    len: usize,
    alpha_256: u32,
) {
    if ptr_a.is_null() || ptr_b.is_null() || ptr_out.is_null() || len < 4 {
        return;
    }
    let a   = unsafe { std::slice::from_raw_parts(ptr_a, len) };
    let b   = unsafe { std::slice::from_raw_parts(ptr_b, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(ptr_out, len) };

    let alpha   = alpha_256.min(256);
    let inv     = 256 - alpha;
    let pixels  = len / 4;

    for i in 0..pixels {
        let j = i * 4;
        out[j]     = (((a[j]     as u32) * inv + (b[j]     as u32) * alpha) >> 8) as u8;
        out[j + 1] = (((a[j + 1] as u32) * inv + (b[j + 1] as u32) * alpha) >> 8) as u8;
        out[j + 2] = (((a[j + 2] as u32) * inv + (b[j + 2] as u32) * alpha) >> 8) as u8;
        out[j + 3] = 255;
    }
}
