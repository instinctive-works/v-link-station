// PreviewWindow node plugin
// WASM_FRAME を受け取り、別OSウィンドウで映像を表示する。
// OffscreenCanvas.transferToImageBitmap() + postMessage(transferable) でゼロコピー転送。
window.NodePlugins['preview-window'] = {
  label:       'プレビュー',
  icon:        '🖼️',
  menuGroup:   '映像',
  menuSection: '出力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [],
    in: [{ label: '映像', accepts: window.PIN_TYPES.WASM_FRAME }],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('preview-window', 'PreviewWindow');
    window.createPluginNode('preview-window', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = {
      srcId:      null,
      resolution: '--',
      _popup:     null,
      _oc:        null,
      _octx:      null,
    };
    window._pwState = window._pwState || {};
    window._pwState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="PreviewWindow" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">映像</span>
        </div>
        <div class="stats-row" style="margin-top:6px">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="pw-badge-${nodeId}">待機</span>
        </div>
        <div style="margin-top:6px;">
          <button class="btn-primary" id="pw-reopen-${nodeId}"
            onclick="window._pwReopen('${nodeId}')"
            onmousedown="event.stopPropagation()"
            style="width:100%">ウィンドウを開く</button>
        </div>
      </div>
    `;

    // ノード配置と同時にウィンドウを開く
    _pwOpen(nodeId, state);

    // 500ms ごとにバッジとドットを更新
    const timer = setInterval(() => {
      const s = window._pwState && window._pwState[nodeId];
      if (!s) { clearInterval(timer); return; }
      const alive   = !!(s._popup && !s._popup.closed);
      const active  = alive && !!s.srcId;
      const badge   = document.getElementById(`pw-badge-${nodeId}`);
      const dot     = document.getElementById(`ndot-${nodeId}`);
      const reopBtn = document.getElementById(`pw-reopen-${nodeId}`);
      if (badge) {
        badge.textContent = active ? '表示中' : alive ? '待機' : 'ウィンドウ閉';
        badge.className   = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
      }
      if (dot) dot.className = 'node-state-dot' + (active ? ' state-active' : '');
      if (reopBtn) reopBtn.style.display = alive ? 'none' : '';
    }, 500);

    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        const conn = [...window.connections.values()]
          .find(c => c.toNodeId === nodeId && c.fromNodeId === fromNodeId);
        if (!conn || conn.toPinIdx !== 0) return;
        // 1入力のみ許可
        const existing = [...window.connections.values()]
          .filter(c => c.toNodeId === nodeId && c.toPinIdx === 0 && c.fromNodeId !== fromNodeId);
        for (const c of existing) window.removeSingleConnection(c.fromNodeId, nodeId);
        state.srcId = fromNodeId;
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        if (state.srcId === fromNodeId) {
          state.srcId = null;
          state.resolution = '--';
        }
      },
      onFrame(token, fromNodeId) {
        if (fromNodeId !== state.srcId) return;
        if (!window.VLinkWasm) return;
        if (!state._popup || state._popup.closed) return;

        const { ptr, width, height } = token;
        const size = width * height * 4;
        const raw  = new Uint8ClampedArray(window.VLinkWasm.memory.buffer, ptr, size);

        // OffscreenCanvas へ描画（ここだけコピー発生）
        const oc = state._oc, octx = state._octx;
        if (oc.width !== width || oc.height !== height) { oc.width = width; oc.height = height; }
        octx.putImageData(new ImageData(raw, width, height), 0, 0);

        // 同期ゼロコピーで ImageBitmap 化 → popup へ転送
        const bmp = oc.transferToImageBitmap();
        state._popup.postMessage({ type: 'vlnk-frame', bmp, w: width, h: height }, '*', [bmp]);

        state.resolution = `${width}×${height}`;
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._pwState && window._pwState[nodeId];
    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge" id="ppw-badge-${nodeId}">待機</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">解像度</span>
          <span class="stats-val" id="ppw-res-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <button class="btn-primary" style="width:100%"
          onclick="window._pwReopen('${nodeId}')"
          onmousedown="event.stopPropagation()">ウィンドウを開く</button>
      </div>
    `;
    const timer = setInterval(() => {
      if (!state) return;
      const alive  = !!(state._popup && !state._popup.closed);
      const active = alive && !!state.srcId;
      const badge  = document.getElementById(`ppw-badge-${nodeId}`);
      const resEl  = document.getElementById(`ppw-res-${nodeId}`);
      if (badge) {
        badge.textContent = active ? '表示中' : alive ? '待機' : 'ウィンドウ閉';
        badge.className   = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
      }
      if (resEl) resEl.textContent = state.resolution;
    }, 500);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state  = window._pwState && window._pwState[nodeId];
    const alive  = !!(state && state._popup && !state._popup.closed);
    const active = alive && !!state.srcId;
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? '表示中' : alive ? '待機' : 'ウィンドウ閉',
      stats: [
        { lbl: '解像度', val: state ? state.resolution : '--' },
      ],
    };
  },

  unmount(nodeId) {
    const state = window._pwState && window._pwState[nodeId];
    if (state && state._popup && !state._popup.closed) state._popup.close();
    window.unregisterNodeHandlers(nodeId);
    if (window._pwState) delete window._pwState[nodeId];
  },
};

// ── ウィンドウを開く ───────────────────────────────────────────────────────────
function _pwOpen(nodeId, state) {
  if (state._popup && !state._popup.closed) return; // すでに開いている

  const popup = window.open(
    '',
    `vlnk_preview_${nodeId}`,
    'width=640,height=360,resizable=yes,scrollbars=no,toolbar=no,menubar=no,status=no'
  );
  if (!popup) return; // ポップアップブロック時は再オープンボタンで対応

  popup.document.write(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>Preview</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
</head><body>
<canvas id="c"></canvas>
<script>
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('bitmaprenderer');
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'vlnk-frame') return;
    if (canvas.width !== e.data.w) canvas.width = e.data.w;
    if (canvas.height !== e.data.h) canvas.height = e.data.h;
    ctx.transferFromImageBitmap(e.data.bmp);
  });
<\/script>
</body></html>`);
  popup.document.close();

  state._popup = popup;
  state._oc    = new OffscreenCanvas(1, 1);
  state._octx  = state._oc.getContext('2d');
}

window._pwReopen = (nodeId) => {
  const state = window._pwState && window._pwState[nodeId];
  if (state) _pwOpen(nodeId, state);
};
