// Merge node plugin
// Blends two WASM_FRAME inputs using Rust blend_frames().
// Each input maintains its own persistent WASM buffer (copied from source frame).
// Output fires whenever either input receives a new frame (if both have data).
window.NodePlugins['merge'] = {
  label:       '合成',
  icon:        '⊕',
  menuGroup:   '映像',
  menuSection: 'ユーティリティ',
  menuOrder:   2,
  nodeClass:   'node-card node-video',
  pins: {
    out: [{ type: window.PIN_TYPES.WASM_FRAME, label: '映像' }], // index 0
    in:  [
      { label: '映像1', accepts: window.PIN_TYPES.WASM_FRAME }, // index 0
      { label: '映像2', accepts: window.PIN_TYPES.WASM_FRAME }, // index 1
    ],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('merge', 'Merge');
    window.createPluginNode('merge', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    // ptr_1 / ptr_2: persistent WASM allocations holding the last frame from each input
    const state = {
      src1: null, src2: null,
      ptr1: 0, size1: 0, w1: 0, h1: 0,
      ptr2: 0, size2: 0, w2: 0, h2: 0,
      alpha: 128,
      blendMode: 'linear',
      outWidth: 0, outHeight: 0,
    };
    window._mergeState = window._mergeState || {};
    window._mergeState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="Merge" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;">映像1</span>
              <span class="node-state-dot" id="nmg-in1-${nodeId}" style="width:8px;height:8px;margin-left:4px;flex-shrink:0;"></span>
            </div>
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;">映像2</span>
              <span class="node-state-dot" id="nmg-in2-${nodeId}" style="width:8px;height:8px;margin-left:4px;flex-shrink:0;"></span>
            </div>
          </div>
          <div class="pin-row pin-out pin-type-wasm-frame" data-type="${window.PIN_TYPES.WASM_FRAME}" style="margin:0;align-self:center;">
            <span class="pin-label">映像</span>
            <span class="pin-dot"></span>
          </div>
        </div>
      </div>
    `;

    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        const conn = [...window.connections.values()]
          .find(c => c.toNodeId === nodeId && c.fromNodeId === fromNodeId);
        if (!conn) return;
        const existing = [...window.connections.values()]
          .filter(c => c.toNodeId === nodeId && c.toPinIdx === conn.toPinIdx && c.fromNodeId !== fromNodeId);
        for (const c of existing) window.removeSingleConnection(c.fromNodeId, nodeId);
        if (conn.toPinIdx === 0) state.src1 = fromNodeId;
        else                      state.src2 = fromNodeId;
        window._mergeUpdateDot(nodeId);
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        if (state.src1 === fromNodeId) {
          if (state.ptr1 && window.VLinkWasm) window.VLinkWasm.free_frame(state.ptr1, state.size1);
          state.src1 = null; state.ptr1 = 0; state.size1 = 0; state.w1 = 0; state.h1 = 0;
        }
        if (state.src2 === fromNodeId) {
          if (state.ptr2 && window.VLinkWasm) window.VLinkWasm.free_frame(state.ptr2, state.size2);
          state.src2 = null; state.ptr2 = 0; state.size2 = 0; state.w2 = 0; state.h2 = 0;
        }
        // Send a black frame so downstream canvas clears immediately
        if (window.VLinkWasm && state.outWidth > 0 && state.outHeight > 0) {
          const bSize = state.outWidth * state.outHeight * 4;
          const bPtr  = window.VLinkWasm.alloc_frame(bSize); // zero-initialised = transparent black
          if (bPtr) {
            window.notifyFrame(nodeId, 0, { ptr: bPtr, width: state.outWidth, height: state.outHeight, stride: state.outWidth * 4, seq: 0 });
            window.VLinkWasm.free_frame(bPtr, bSize);
          }
        }
        if (!state.src1 && !state.src2) { state.outWidth = 0; state.outHeight = 0; }
        window._mergeUpdateDot(nodeId);
      },
      onFrame(token, fromNodeId) {
        if (!window.VLinkWasm) return;
        const wasm = window.VLinkWasm;
        const inSize = token.width * token.height * 4;

        // Snapshot the incoming frame into persistent buffer
        if (fromNodeId === state.src1) {
          if (state.size1 !== inSize) {
            if (state.ptr1) wasm.free_frame(state.ptr1, state.size1);
            state.ptr1 = wasm.alloc_frame(inSize);
            state.size1 = inSize;
          }
          state.w1 = token.width; state.h1 = token.height;
          if (state.ptr1) wasm.copy_frame(token.ptr, state.ptr1, inSize);
        } else if (fromNodeId === state.src2) {
          if (state.size2 !== inSize) {
            if (state.ptr2) wasm.free_frame(state.ptr2, state.size2);
            state.ptr2 = wasm.alloc_frame(inSize);
            state.size2 = inSize;
          }
          state.w2 = token.width; state.h2 = token.height;
          if (state.ptr2) wasm.copy_frame(token.ptr, state.ptr2, inSize);
        } else {
          return;
        }

        // Pass through if only one input connected
        if (!state.ptr1 || !state.ptr2) {
          window.notifyFrame(nodeId, 0, token);
          const dot = document.getElementById(`ndot-${nodeId}`);
          if (dot) dot.className = 'node-state-dot state-active';
          // Draw to preview canvas (throttled ~10fps)
          const _now = Date.now();
          if (!state._lastPreview || _now - state._lastPreview > 100) {
            state._lastPreview = _now;
            const cv = document.getElementById(`pmg-canvas-${nodeId}`);
            if (cv && window.VLinkWasm) {
              if (cv.width !== token.width || cv.height !== token.height) { cv.width = token.width; cv.height = token.height; }
              const pctx = cv.getContext('2d');
              if (pctx) {
                const psize = token.width * token.height * 4;
                const rgba = new Uint8ClampedArray(window.VLinkWasm.memory.buffer, token.ptr, psize);
                pctx.putImageData(new ImageData(rgba.slice(), token.width, token.height), 0, 0);
              }
            }
          }
          return;
        }

        // Output size = larger of both inputs
        const outW = Math.max(state.w1, state.w2);
        const outH = Math.max(state.h1, state.h2);
        const outSize = outW * outH * 4;
        state.outWidth = outW; state.outHeight = outH;

        // Scale smaller inputs up if needed
        let p1 = state.ptr1, p2 = state.ptr2;
        let scaled1 = 0, scaled2 = 0;
        if ((state.w1 !== outW || state.h1 !== outH) && wasm.scale_frame) {
          scaled1 = wasm.alloc_frame(outSize);
          if (scaled1) wasm.scale_frame(state.ptr1, state.w1, state.h1, scaled1, outW, outH);
          if (scaled1) p1 = scaled1;
        }
        if ((state.w2 !== outW || state.h2 !== outH) && wasm.scale_frame) {
          scaled2 = wasm.alloc_frame(outSize);
          if (scaled2) wasm.scale_frame(state.ptr2, state.w2, state.h2, scaled2, outW, outH);
          if (scaled2) p2 = scaled2;
        }

        // Blend
        const outPtr = wasm.alloc_frame(outSize);
        if (outPtr) {
          if (state.blendMode === 'add' && wasm.add_frames) {
            wasm.add_frames(p1, p2, outPtr, outSize);
          } else if (state.blendMode === 'diff' && wasm.diff_frames) {
            wasm.diff_frames(p1, p2, outPtr, outSize);
          } else {
            wasm.blend_frames(p1, p2, outPtr, outSize, state.alpha);
          }
          window.notifyFrame(nodeId, 0, {
            ptr: outPtr, width: outW, height: outH, stride: outW * 4, seq: token.seq,
          });
          // Draw to preview canvas (throttled ~10fps)
          const _now2 = Date.now();
          if (!state._lastPreview || _now2 - state._lastPreview > 100) {
            state._lastPreview = _now2;
            const cv = document.getElementById(`pmg-canvas-${nodeId}`);
            if (cv) {
              if (cv.width !== outW || cv.height !== outH) { cv.width = outW; cv.height = outH; }
              const pctx = cv.getContext('2d');
              if (pctx) {
                const rgba = new Uint8ClampedArray(wasm.memory.buffer, outPtr, outSize);
                pctx.putImageData(new ImageData(rgba.slice(), outW, outH), 0, 0);
              }
            }
          }
          wasm.free_frame(outPtr, outSize);
        }
        if (scaled1) wasm.free_frame(scaled1, outSize);
        if (scaled2) wasm.free_frame(scaled2, outSize);

        const dot = document.getElementById(`ndot-${nodeId}`);
        if (dot) dot.className = 'node-state-dot state-active';
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._mergeState && window._mergeState[nodeId];
    cont.innerHTML = `
      <div class="perf-section"></div>
      <div class="perf-section">
        <div class="perf-section-title">接続状態</div>
        <div class="stats-row">
          <span class="stats-lbl">フレーム 1</span>
          <span class="badge badge-inactive" id="pmg-s1-${nodeId}">未接続</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">フレーム 2</span>
          <span class="badge badge-inactive" id="pmg-s2-${nodeId}">未接続</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">解像度</span>
          <span class="stats-val" id="pmg-res-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">ブレンドモード</div>
        <select id="pmg-mode-${nodeId}"
          onchange="window._mergeSetMode('${nodeId}', this.value)"
          onmousedown="event.stopPropagation()"
          style="width:100%;margin-bottom:8px;">
          <option value="linear" ${!state || state.blendMode === 'linear' ? 'selected' : ''}>リニア (A↔B ブレンド)</option>
          <option value="add"    ${state && state.blendMode === 'add'    ? 'selected' : ''}>加算 (Add)</option>
          <option value="diff"   ${state && state.blendMode === 'diff'   ? 'selected' : ''}>差の絶対値 (Difference)</option>
        </select>
        <div id="pmg-alpha-wrap-${nodeId}" style="${state && state.blendMode !== 'linear' ? 'display:none;' : ''}">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">ブレンド比 (B 側)</div>
          <input type="range" min="0" max="256" value="${state ? state.alpha : 128}"
            id="pmg-alpha-${nodeId}"
            oninput="window._mergeSetAlpha('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()"
            style="width:100%;" />
          <div class="stats-row" style="margin-top:4px;">
            <span class="stats-lbl">A 比率</span>
            <span class="stats-val" id="pmg-aval-${nodeId}">${state ? Math.round((256 - state.alpha) / 2.56) : 50}%</span>
            <span class="stats-lbl" style="margin-left:8px;">B 比率</span>
            <span class="stats-val" id="pmg-bval-${nodeId}">${state ? Math.round(state.alpha / 2.56) : 50}%</span>
          </div>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <canvas id="pmg-canvas-${nodeId}"
          style="width:100%;border-radius:6px;background:#000;display:block;"></canvas>
      </div>
    `;
    const timer = setInterval(() => {
      if (!state) return;
      const s1El  = document.getElementById(`pmg-s1-${nodeId}`);
      const s2El  = document.getElementById(`pmg-s2-${nodeId}`);
      const resEl = document.getElementById(`pmg-res-${nodeId}`);
      if (s1El) { s1El.textContent = state.src1 ? '接続済' : '未接続'; s1El.className = 'badge ' + (state.src1 ? 'badge-active' : 'badge-inactive'); }
      if (s2El) { s2El.textContent = state.src2 ? '接続済' : '未接続'; s2El.className = 'badge ' + (state.src2 ? 'badge-active' : 'badge-inactive'); }
      if (resEl && state.outWidth) resEl.textContent = `${state.outWidth}×${state.outHeight}`;
    }, 300);
    cont._cleanupTimer = timer;
  },

  getSettings(nodeId) {
    const state = window._mergeState && window._mergeState[nodeId];
    return { alpha: state ? state.alpha : 128, blendMode: state ? state.blendMode : 'linear' };
  },

  applySettings(nodeId, s) {
    const state = window._mergeState && window._mergeState[nodeId];
    if (!state) return;
    if (s.alpha     != null) state.alpha     = s.alpha;
    if (s.blendMode != null) state.blendMode = s.blendMode;
    const slider = document.getElementById(`pmg-alpha-${nodeId}`);
    if (slider) slider.value = state.alpha;
    const sel = document.getElementById(`pmg-mode-${nodeId}`);
    if (sel) sel.value = state.blendMode;
  },

  getMetrics(nodeId) {
    const state  = window._mergeState && window._mergeState[nodeId];
    const active = !!(state && state.ptr1 && state.ptr2);
    const modeLabel = { linear: 'リニア', add: '加算', diff: '差分' };
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? ('ブレンド中: ' + (modeLabel[state.blendMode] || state.blendMode)) : '待機中',
      stats: state && state.outWidth ? [{ lbl: '解像度', val: `${state.outWidth}×${state.outHeight}` }] : [],
    };
  },

  unmount(nodeId) {
    const state = window._mergeState && window._mergeState[nodeId];
    if (state && window.VLinkWasm) {
      if (state.ptr1) window.VLinkWasm.free_frame(state.ptr1, state.size1);
      if (state.ptr2) window.VLinkWasm.free_frame(state.ptr2, state.size2);
    }
    window.unregisterNodeHandlers(nodeId);
    if (window._mergeState) delete window._mergeState[nodeId];
  },
};

window._mergeSetAlpha = (nodeId, val) => {
  const state = window._mergeState && window._mergeState[nodeId];
  if (!state) return;
  state.alpha = parseInt(val, 10);
  // Sync both sliders (node body + panel)
  ['mg-alpha', 'pmg-alpha'].forEach(id => {
    const el = document.getElementById(`${id}-${nodeId}`);
    if (el) el.value = state.alpha;
  });
  const aEl = document.getElementById(`pmg-aval-${nodeId}`);
  const bEl = document.getElementById(`pmg-bval-${nodeId}`);
  if (aEl) aEl.textContent = Math.round((256 - state.alpha) / 2.56) + '%';
  if (bEl) bEl.textContent = Math.round(state.alpha / 2.56) + '%';
};

window._mergeSetMode = (nodeId, mode) => {
  const state = window._mergeState && window._mergeState[nodeId];
  if (!state) return;
  state.blendMode = mode;
  // Sync both selects
  ['mg-mode', 'pmg-mode'].forEach(id => {
    const el = document.getElementById(`${id}-${nodeId}`);
    if (el) el.value = mode;
  });
  // Show/hide alpha slider
  ['mg-alpha-wrap', 'pmg-alpha-wrap'].forEach(id => {
    const el = document.getElementById(`${id}-${nodeId}`);
    if (el) el.style.display = mode === 'linear' ? '' : 'none';
  });
};

window._mergeUpdateDot = (nodeId) => {
  const state = window._mergeState && window._mergeState[nodeId];
  const dot = document.getElementById(`ndot-${nodeId}`);
  if (dot) {
    const ready = state && (state.src1 || state.src2);
    dot.className = 'node-state-dot' + (ready ? ' state-orange' : '');
  }
  const d1 = document.getElementById(`nmg-in1-${nodeId}`);
  const d2 = document.getElementById(`nmg-in2-${nodeId}`);
  if (d1) d1.className = 'node-state-dot' + (state && state.src1 ? ' state-active' : '');
  if (d2) d2.className = 'node-state-dot' + (state && state.src2 ? ' state-active' : '');
};
