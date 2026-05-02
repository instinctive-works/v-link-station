// VideoShare node plugin
// WebRTC / Socket.IO / MJPEG の3モードで映像を配信する。
window.NodePlugins['video-share'] = {
  label:       '映像を共有',
  icon:        '📡',
  menuGroup:   '映像',
  menuSection: '出力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [],
    in: [
      { label: '映像', accepts: window.PIN_TYPES.WASM_FRAME }, // index 0
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
      frameSourceId:    null,
      resolution:       '--',
      mode:             'webrtc',   // 'webrtc' | 'socket' | 'mjpeg'
      _broadcastCanvas: null,
      _broadcastStream: null,
      _socketRegistered: false,
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
        <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">映像</span>
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
        if (!conn || conn.toPinIdx !== 0) return;
        const existing = [...window.connections.values()]
          .filter(c => c.toNodeId === nodeId && c.toPinIdx === 0 && c.fromNodeId !== fromNodeId);
        for (const c of existing) window.removeSingleConnection(c.fromNodeId, nodeId);
        state.frameSourceId = fromNodeId;
        _vsStartBroadcast(nodeId, state);
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        if (state.frameSourceId === fromNodeId) {
          state.frameSourceId = null;
          state.resolution = '--';
          _vsStopBroadcast(nodeId, state);
        }
      },
      onFrame(token, fromNodeId) {
        if (fromNodeId !== state.frameSourceId) return;
        if (!window.VLinkWasm) return;
        const w = token.width, h = token.height;
        const data = new Uint8ClampedArray(window.VLinkWasm.memory.buffer, token.ptr, w * h * 4);
        const img  = new ImageData(data, w, h);

        if (state.mode === 'webrtc') {
          // Draw to broadcast canvas → captureStream → WebRTC
          if (state._broadcastCanvas) {
            if (state._broadcastCanvas.width !== w || state._broadcastCanvas.height !== h) {
              state._broadcastCanvas.width  = w;
              state._broadcastCanvas.height = h;
            }
            state._broadcastCanvas.getContext('2d').putImageData(img, 0, 0);
          }
        } else if (state.mode === 'socket' || state.mode === 'mjpeg') {
          // Socket.IO mode / MJPEG: encode to JPEG and emit (throttled to 30fps)
          const now = Date.now();
          if (!state._lastEmit || now - state._lastEmit >= 33) {
            state._lastEmit = now;
            if (!state._socketCanvas) {
              state._socketCanvas = document.createElement('canvas');
            }
            const sc = state._socketCanvas;
            if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; }
            sc.getContext('2d').putImageData(img, 0, 0);
            sc.toBlob(blob => {
              if (!blob) return;
              blob.arrayBuffer().then(buf => {
                window.socket.emit(window.EVENTS.STREAM_FRAME, { nodeId, jpeg: buf });
              });
            }, 'image/jpeg', 0.85);
          }
        }

        // Panel preview (always, throttled)
        const panelCanvas = document.getElementById(`pso-canvas-${nodeId}`);
        if (panelCanvas) {
          if (panelCanvas.width !== w || panelCanvas.height !== h) {
            panelCanvas.width  = w;
            panelCanvas.height = h;
          }
          panelCanvas.getContext('2d').putImageData(img, 0, 0);
        }

        state.resolution = `${w}×${h}`;
      },
    });

    const badgeTimer = setInterval(() => {
      const s = window._streamOutState && window._streamOutState[nodeId];
      if (!s) { clearInterval(badgeTimer); return; }
      const active = !!s.frameSourceId;
      const badge  = document.getElementById(`so-badge-${nodeId}`);
      const dot    = document.getElementById(`ndot-${nodeId}`);
      if (badge) {
        badge.textContent = active ? '配信中' : '未接続';
        badge.className   = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
      }
      if (dot) dot.className = 'node-state-dot' + (active ? ' state-active' : '');
    }, 500);
  },

  createPanel(nodeId, cont) {
    const state = window._streamOutState && window._streamOutState[nodeId];
    cont.innerHTML = `
      <div class="perf-section"></div>
      <div class="perf-section">
        <div class="perf-section-title">配信モード</div>
        <select id="pso-mode-${nodeId}"
          onchange="window._videoShareSetMode('${nodeId}', this.value)"
          onmousedown="event.stopPropagation()"
          style="width:100%;margin-bottom:4px;">
          <option value="webrtc" ${!state || state.mode === 'webrtc' ? 'selected' : ''}>WebRTC（低遅延）</option>
          <option value="socket" ${state && state.mode === 'socket' ? 'selected' : ''}>Socket.IO（低負荷）</option>
          <option value="mjpeg"  ${state && state.mode === 'mjpeg'  ? 'selected' : ''}>MJPEG（OBS用リンク）</option>
        </select>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge" id="pso-badge-${nodeId}">未接続</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">解像度</span>
          <span class="stats-val" id="pso-res-${nodeId}">--</span>
        </div>
        <div id="pso-mjpeg-row-${nodeId}" style="display:${state && state.mode === 'mjpeg' ? 'block' : 'none'};margin-top:6px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="stats-lbl" style="flex-shrink:0;">URL</span>
            <span class="stats-val" id="pso-mjpeg-url-${nodeId}" style="word-break:break-all;font-size:10px;flex:1;">${location.origin}/stream/${nodeId}</span>
            <button onclick="(()=>{navigator.clipboard.writeText('${location.origin}/stream/${nodeId}');const b=document.getElementById('pso-mjpeg-copy-${nodeId}');b.textContent='✓';setTimeout(()=>b.textContent='コピー',1500);})()"
              id="pso-mjpeg-copy-${nodeId}"
              onmousedown="event.stopPropagation()"
              style="flex-shrink:0;padding:2px 8px;font-size:11px;cursor:pointer;border-radius:4px;border:1px solid var(--border);background:var(--bg2);color:var(--text);">コピー</button>
          </div>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <canvas id="pso-canvas-${nodeId}"
          style="width:100%;border-radius:6px;background:#000;display:block;image-rendering:pixelated;"></canvas>
      </div>
    `;
    const timer = setInterval(() => {
      if (!state) return;
      const active = !!state.frameSourceId;
      const badge  = document.getElementById(`pso-badge-${nodeId}`);
      const resEl  = document.getElementById(`pso-res-${nodeId}`);
      const modeEl = document.getElementById(`pso-mode-${nodeId}`);
      const mjpegRow = document.getElementById(`pso-mjpeg-row-${nodeId}`);
      if (mjpegRow) mjpegRow.style.display = state.mode === 'mjpeg' ? 'flex' : 'none';
      if (badge) {
        badge.textContent = active ? '配信中' : '未接続';
        badge.className   = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
      }
      if (resEl) resEl.textContent = state.resolution;
      if (modeEl && modeEl.value !== state.mode) modeEl.value = state.mode;
    }, 500);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state  = window._streamOutState && window._streamOutState[nodeId];
    const active = !!(state && state.frameSourceId);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? `配信中 (${state.mode})` : '未接続',
      stats: [
        { lbl: '解像度', val: state ? state.resolution : '--' },
        { lbl: 'モード',  val: state ? state.mode : '--' },
      ],
    };
  },

  // シーン保存・復元用
  getSettings(nodeId) {
    const state = window._streamOutState && window._streamOutState[nodeId];
    return { mode: state ? state.mode : 'webrtc' };
  },

  applySettings(nodeId, settings) {
    if (!settings || !settings.mode) return;
    const state = window._streamOutState && window._streamOutState[nodeId];
    if (!state) return;
    if (state.mode === settings.mode) return;
    // _videoShareSetMode 経由で状態・UI・登録を一括変更
    window._videoShareSetMode(nodeId, settings.mode);
  },

  unmount(nodeId) {
    window.unregisterNodeHandlers(nodeId);
    const state = window._streamOutState && window._streamOutState[nodeId];
    if (state) _vsStopBroadcast(nodeId, state);
    if (window._streamOutState) delete window._streamOutState[nodeId];
  },
};

// ── WebRTC broadcast ──────────────────────────────────────────────────────────
function _vsStartBroadcast(nodeId, state) {
  _vsStopBroadcast(nodeId, state);
  if (state.mode === 'webrtc') {
    const canvas = document.createElement('canvas');
    canvas.width  = 1280;
    canvas.height = 720;
    const stream = canvas.captureStream(60);
    // 静止画・テキスト向けのヒントで WebRTC エンコーダの品質を優先させる
    for (const track of stream.getVideoTracks()) {
      track.contentHint = 'detail';
    }
    state._broadcastCanvas = canvas;
    state._broadcastStream = stream;
    window.broadcastStreams = window.broadcastStreams || new Map();
    window.broadcastStreams.set(nodeId, stream);
    if (window._rtcSyncPeers) window._rtcSyncPeers();
  } else {
    // Socket.IO mode: register stream on server
    if (!window.socket || !window.socket.connected) {
      // Socket 未接続 → 全体の再接続リスナーに任せるだけでよい
      state._socketRegistered = false;
      return;
    }
    const nameEl = document.getElementById(`ename-${nodeId}`);
    const name   = nameEl ? nameEl.value : nodeId;
    window.socket.emit(window.EVENTS.STREAM_REGISTER, { nodeId, name, mode: state.mode });
    state._socketRegistered = true;
  }
}

function _vsStopBroadcast(nodeId, state) {
  if (state._broadcastStream) {
    state._broadcastStream.getTracks().forEach(t => t.stop());
    state._broadcastStream = null;
    state._broadcastCanvas = null;
  }
  if (window.broadcastStreams) window.broadcastStreams.delete(nodeId);
  if (window._rtcSyncPeers) window._rtcSyncPeers();
  if (state._socketRegistered) {
    window.socket.emit(window.EVENTS.STREAM_UNREGISTER, { nodeId });
    state._socketRegistered = false;
  }
}

// ── Socket 再接続時に Socket.IO モードの全ノードを再登録 ──────────────────────
(function _vsInstallReconnectHandler() {
  if (!window.socket) return;
  window.socket.on('connect', () => {
    const states = window._streamOutState;
    if (!states) return;
    for (const [nodeId, state] of Object.entries(states)) {
      if (state.mode !== 'socket' && state.mode !== 'mjpeg') continue;
      const nameEl = document.getElementById(`ename-${nodeId}`);
      const name   = nameEl ? nameEl.value : nodeId;
      window.socket.emit(window.EVENTS.STREAM_REGISTER, { nodeId, name, mode: state.mode });
      state._socketRegistered = true;
    }
  });
})();

window._videoShareSetMode = (nodeId, newMode) => {
  const state = window._streamOutState && window._streamOutState[nodeId];
  if (!state || state.mode === newMode) return;
  const wasActive = !!state.frameSourceId;
  if (wasActive) _vsStopBroadcast(nodeId, state);
  state.mode = newMode;
  // Sync both selects
  ['so-mode', 'pso-mode'].forEach(id => {
    const el = document.getElementById(`${id}-${nodeId}`);
    if (el) el.value = newMode;
  });
  // socket/mjpeg モードへの切替は映像未接続でも常に STREAM_REGISTER を送信してカードを即表示
  // webrtc モードへの切替は映像接続中のみ captureStream を開始
  if (newMode === 'socket' || newMode === 'mjpeg' || wasActive) _vsStartBroadcast(nodeId, state);
};
