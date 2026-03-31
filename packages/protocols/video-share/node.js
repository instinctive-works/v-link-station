// VideoShare node plugin
// Accepts VIDEO (MediaStream) or WASM_FRAME input.
// WASM_FRAME path: passes frames downstream with a preview canvas.
// VIDEO path: shows a MediaStream preview (existing behaviour).
window.NodePlugins['video-share'] = {
  label:       'VideoShare',
  icon:        '📡',
  menuGroup:   '映像',
  menuSection: '出力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [
      { type: window.PIN_TYPES.WASM_FRAME, label: 'フレーム出力' }, // index 0
    ],
    in: [
      { label: '映像入力',     accepts: window.PIN_TYPES.VIDEO },       // index 0
      { label: 'フレーム入力', accepts: window.PIN_TYPES.WASM_FRAME },  // index 1
    ],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('video-share', 'VideoShare');
    window.createPluginNode('video-share', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = {
      sourceNodeId: null,      // VIDEO source
      frameSourceId: null,     // WASM_FRAME source
      fps: '--', resolution: '--',
    };
    window._streamOutState = window._streamOutState || {};
    window._streamOutState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="VideoShare" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div class="pin-row pin-in pin-type-video" data-accepts="${window.PIN_TYPES.VIDEO}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;">映像入力</span>
            </div>
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;">フレーム入力</span>
            </div>
          </div>
          <div class="pin-row pin-out pin-type-wasm-frame" data-type="${window.PIN_TYPES.WASM_FRAME}" style="margin:0;align-self:center;">
            <span class="pin-label">フレーム出力</span>
            <span class="pin-dot"></span>
          </div>
        </div>
        <div class="stats-row" style="margin-top:6px">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="so-badge-${nodeId}">未接続</span>
        </div>
      </div>
    `;

    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;

        const conn = [...window.connections.values()]
          .find(c => c.toNodeId === nodeId && c.fromNodeId === fromNodeId);
        if (!conn) return;

        if (conn.toPinIdx === 0) {
          // VIDEO input — allow only one
          const existing = [...window.connections.values()]
            .filter(c => c.toNodeId === nodeId && c.toPinIdx === 0 && c.fromNodeId !== fromNodeId);
          for (const c of existing) window.removeSingleConnection(c.fromNodeId, nodeId);
          state.sourceNodeId = fromNodeId;
          applyStreamVS(nodeId);
        } else if (conn.toPinIdx === 1) {
          // WASM_FRAME input — allow only one
          const existing = [...window.connections.values()]
            .filter(c => c.toNodeId === nodeId && c.toPinIdx === 1 && c.fromNodeId !== fromNodeId);
          for (const c of existing) window.removeSingleConnection(c.fromNodeId, nodeId);
          state.frameSourceId = fromNodeId;
        }
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        if (state.sourceNodeId === fromNodeId) {
          state.sourceNodeId = null;
          clearStreamVS(nodeId);
        }
        if (state.frameSourceId === fromNodeId) {
          state.frameSourceId = null;
        }
      },
      onFrame(token, fromNodeId) {
        if (fromNodeId !== state.frameSourceId) return;
        // Pass through to downstream WASM_FRAME nodes (out pin index 0)
        window.notifyFrame(nodeId, 0, token);
        // Update preview canvas if panel is open
        const canvas = document.getElementById(`pso-canvas-${nodeId}`);
        if (canvas && window.VLinkWasm) {
          const w = token.width, h = token.height;
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          const ctx  = canvas.getContext('2d');
          const data = new Uint8ClampedArray(window.VLinkWasm.memory.buffer, token.ptr, w * h * 4);
          ctx.putImageData(new ImageData(data, w, h), 0, 0);
          state.resolution = `${w}×${h}`;
        }
      },
    });

    const badgeTimer = setInterval(() => {
      const s = window._streamOutState && window._streamOutState[nodeId];
      if (!s) { clearInterval(badgeTimer); return; }
      const hasVideo = s.sourceNodeId  && window.nodeStreams.has(s.sourceNodeId);
      const hasFrame = !!s.frameSourceId;
      const badge    = document.getElementById(`so-badge-${nodeId}`);
      const dot      = document.getElementById(`ndot-${nodeId}`);
      if (badge) {
        const active = hasVideo || hasFrame;
        badge.textContent = active ? '配信中' : '未接続';
        badge.className   = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
      }
      if (dot) dot.className = 'node-state-dot' + ((hasVideo || hasFrame) ? ' state-active' : '');
    }, 500);
  },

  createPanel(nodeId, cont) {
    const state = window._streamOutState && window._streamOutState[nodeId];

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge" id="pso-badge-${nodeId}">未接続</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">解像度</span>
          <span class="stats-val" id="pso-res-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <video id="pso-video-${nodeId}" autoplay muted playsinline
          style="width:100%;border-radius:6px;background:#000;display:none;"></video>
        <canvas id="pso-canvas-${nodeId}"
          style="width:100%;border-radius:6px;background:#000;display:block;image-rendering:pixelated;"></canvas>
      </div>
    `;

    if (state && state.sourceNodeId) {
      const stream = window.nodeStreams.get(state.sourceNodeId);
      const vid    = document.getElementById(`pso-video-${nodeId}`);
      if (vid && stream) { vid.srcObject = stream; vid.style.display = 'block'; }
    }

    const timer = setInterval(() => {
      if (!state) return;
      const hasVideo = state.sourceNodeId && window.nodeStreams.has(state.sourceNodeId);
      const hasFrame = !!state.frameSourceId;
      const badge    = document.getElementById(`pso-badge-${nodeId}`);
      const resEl    = document.getElementById(`pso-res-${nodeId}`);
      if (badge) {
        const active    = hasVideo || hasFrame;
        badge.textContent = active ? '配信中' : '未接続';
        badge.className   = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
      }
      if (resEl) resEl.textContent = state.resolution;
    }, 500);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state    = window._streamOutState && window._streamOutState[nodeId];
    const hasVideo = state && state.sourceNodeId && window.nodeStreams.has(state.sourceNodeId);
    const hasFrame = !!(state && state.frameSourceId);
    const active   = hasVideo || hasFrame;
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? '配信中' : '未接続',
      stats: [
        { lbl: '解像度', val: state ? state.resolution : '--' },
      ],
    };
  },

  unmount(nodeId) {
    window.unregisterNodeHandlers(nodeId);
    if (window._streamOutState) delete window._streamOutState[nodeId];
  },
};

function applyStreamVS(nodeId) {
  const state = window._streamOutState && window._streamOutState[nodeId];
  if (!state || !state.sourceNodeId) return;
  const stream = window.nodeStreams.get(state.sourceNodeId);
  if (!stream) return;
  const panelVid = document.getElementById(`pso-video-${nodeId}`);
  if (panelVid) { panelVid.srcObject = stream; panelVid.style.display = 'block'; }
  const track = stream.getVideoTracks()[0];
  if (track) {
    const s = track.getSettings();
    state.resolution = `${s.width || '--'}×${s.height || '--'}`;
  }
}

function clearStreamVS(nodeId) {
  const state = window._streamOutState && window._streamOutState[nodeId];
  if (!state) return;
  state.resolution = '--';
  const panelVid = document.getElementById(`pso-video-${nodeId}`);
  if (panelVid) { panelVid.srcObject = null; panelVid.style.display = 'none'; }
}
