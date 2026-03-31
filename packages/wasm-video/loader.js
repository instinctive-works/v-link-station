// VLink WASM video loader
// Fetches /wasm-video/video_proc.wasm and exposes window.VLinkWasm.
// Loaded before mocap.js so it begins fetching early; nodes guard with
// `if (window.VLinkWasm)` before using it.
(async function initVLinkWasm() {
  try {
    const result = await WebAssembly.instantiateStreaming(
      fetch('/wasm-video/video_proc.wasm'),
      { env: {} },
    );
    const exp = result.instance.exports;
    window.VLinkWasm = {
      memory:       exp.memory,
      alloc_frame:  exp.alloc_frame,
      free_frame:   exp.free_frame,
      copy_frame:   exp.copy_frame,
      blend_frames: exp.blend_frames,
    };
    console.log('[VLinkWasm] ready — memory:', exp.memory.buffer.byteLength, 'bytes');
  } catch (e) {
    console.warn('[VLinkWasm] init failed (WASM_FRAME pins unavailable):', e.message);
    window.VLinkWasm = null;
  }
})();
