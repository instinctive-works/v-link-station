// Merge node plugin
// Blends two WASM_FRAME inputs using Rust blend_frames().
// Each input maintains its own persistent WASM buffer (copied from source frame).
// Output fires whenever either input receives a new frame (if both have data).
window.NodePlugins['merge'] = {
  label:       'Merge',
  icon:        '⊕',
  menuGroup:   '映像',
  menuSection: '入力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [{ type: window.PIN_TYPES.WASM_FRAME, label: 'フレーム出力' }], // index 0
    in:  [
      { label: 'フレーム 1', accepts: window.PIN_TYPES.WASM_FRAME }, // index 0
      { label: 'フレーム 2', accepts: window.PIN_TYPES.WASM_FRAME }, // index 1
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
      ptr1: 0, size1: 0,
      ptr2: 0, size2: 0,
      alpha: 128, // 0-256; 128 = 50/50
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
              <span class="pin-label" style="margin-left:6px;">フレーム 1</span>
            </div>
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;">フレーム 2</span>
            </div>
          </div>
          <div class="pin-row pin-out pin-type-wasm-frame" data-type="${window.PIN_TYPES.WASM_FRAME}" style="margin:0;align-self:center;">
            <span class="pin-label">フレーム出力</span>
            <span class="pin-dot"></span>
          </div>
        </div>
        <div style="margin-top:8px;">
          <label style="color:var(--text2);font-size:11px;">ブレンド比 (B が優先)</label>
          <input type="range" min="0" max="256" value="128" id="mg-alpha-${nodeId}"
            oninput="window._mergeSetAlpha('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()"
            style="width:100%;margin-top:4px;" />
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
          // Free persistent buffer
          if (state.ptr1 && window.VLinkWasm) window.VLinkWasm.free_frame(state.ptr1, state.size1);
          state.src1 = null; state.ptr1 = 0; state.size1 = 0;
        }
        if (state.src2 === fromNodeId) {
          if (state.ptr2 && window.VLinkWasm) window.VLinkWasm.free_frame(state.ptr2, state.size2);
          state.src2 = null; state.ptr2 = 0; state.size2 = 0;
        }
        window._mergeUpdateDot(nodeId);
      },
      onFrame(token, fromNodeId) {
        if (!window.VLinkWasm) return;
        const wasm = window.VLinkWasm;
        const size = token.width * token.height * 4;

        // Snapshot the incoming frame into persistent merge buffer
        if (fromNodeId === state.src1) {
          if (state.size1 !== size) {
            if (state.ptr1) wasm.free_frame(state.ptr1, state.size1);
            state.ptr1  = wasm.alloc_frame(size);
            state.size1 = size;
            state.outWidth  = token.width;
            state.outHeight = token.height;
          }
          if (state.ptr1) wasm.copy_frame(token.ptr, state.ptr1, size);
        } else if (fromNodeId === state.src2) {
          if (state.size2 !== size) {
            if (state.ptr2) wasm.free_frame(state.ptr2, state.size2);
            state.ptr2  = wasm.alloc_frame(size);
            state.size2 = size;
            state.outWidth  = token.width;
            state.outHeight = token.height;
          }
          if (state.ptr2) wasm.copy_frame(token.ptr, state.ptr2, size);
        } else {
          return;
        }

        // Only render if both inputs have data
        if (!state.ptr1 || !state.ptr2 || state.size1 !== state.size2) return;

        // Blend into a temporary output buffer
        const outPtr = wasm.alloc_frame(size);
        if (!outPtr) return;
        wasm.blend_frames(state.ptr1, state.ptr2, outPtr, size, state.alpha);

        window.notifyFrame(nodeId, 0, {
          ptr:    outPtr,
          width:  state.outWidth,
          height: state.outHeight,
          stride: state.outWidth * 4,
          seq:    token.seq,
        });

        wasm.free_frame(outPtr, size);

        // Dot active while both inputs are present
        const dot = document.getElementById(`ndot-${nodeId}`);
        if (dot) dot.className = 'node-state-dot state-active';
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._mergeState && window._mergeState[nodeId];
    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
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
        <div class="perf-section-title">ブレンド比 (B 側)</div>
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

  getMetrics(nodeId) {
    const state  = window._mergeState && window._mergeState[nodeId];
    const active = !!(state && state.ptr1 && state.ptr2);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? 'ブレンド中' : '待機中',
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

window._mergeUpdateDot = (nodeId) => {
  const state = window._mergeState && window._mergeState[nodeId];
  const dot   = document.getElementById(`ndot-${nodeId}`);
  if (!dot) return;
  const ready = state && (state.src1 || state.src2);
  dot.className = 'node-state-dot' + (ready ? ' state-orange' : '');
};
