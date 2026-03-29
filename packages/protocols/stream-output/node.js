// Stream Output node plugin
// Receives a video pin input and exposes it as a named MediaStream output
// (e.g. for WebRTC, virtual camera, or preview)
window.NodePlugins['stream-output'] = {
  label:       'VideoShare',
  icon:        '📡',
  menuSection: '映像出力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [],
    in:  [{ label: '映像入力', accepts: 'video' }],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('stream-output', 'VideoShare');
    window.createPluginNode('stream-output', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { sourceNodeId: null, fps: '--', resolution: '--', streaming: false };
    window._streamOutState = window._streamOutState || {};
    window._streamOutState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="VideoShare" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-in pin-type-video" data-accepts="video">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">映像入力</span>
        </div>
        <div class="stats-row" style="margin-top:8px">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="so-badge-${nodeId}">未接続</span>
        </div>
      </div>
    `;

    // Connection handlers
    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;

        // Allow only one input — disconnect any previous
        const existing = [...window.connections.values()]
          .filter(c => c.toNodeId === nodeId && c.fromNodeId !== fromNodeId);
        for (const conn of existing) {
          window.removeSingleConnection(conn.fromNodeId, nodeId);
        }

        state.sourceNodeId = fromNodeId;
        applyStream(nodeId);
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        if (state.sourceNodeId === fromNodeId) {
          state.sourceNodeId = null;
          clearStream(nodeId);
        }
      },
    });

    // Keep node-body badge in sync even when source hasn't started yet
    const badgeTimer = setInterval(() => {
      const s = window._streamOutState && window._streamOutState[nodeId];
      if (!s) { clearInterval(badgeTimer); return; }
      const hasStream = s.sourceNodeId && window.nodeStreams.has(s.sourceNodeId);
      const badge = document.getElementById(`so-badge-${nodeId}`);
      if (badge) {
        badge.textContent = hasStream ? '配信中' : (s.sourceNodeId ? '接続済' : '未接続');
        badge.className   = 'badge ' + (hasStream ? 'badge-active' : (s.sourceNodeId ? 'badge-orange' : 'badge-inactive'));
      }
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
        <div class="stats-row">
          <span class="stats-lbl">FPS</span>
          <span class="stats-val" id="pso-fps-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <video id="pso-video-${nodeId}" autoplay muted playsinline
          style="width:100%;border-radius:6px;background:#000;display:block;"></video>
      </div>
    `;

    if (state && state.sourceNodeId) {
      const stream = window.nodeStreams.get(state.sourceNodeId);
      const vid = document.getElementById(`pso-video-${nodeId}`);
      if (vid && stream) vid.srcObject = stream;
    }

    const timer = setInterval(() => {
      if (!state) return;
      const hasStream = state.sourceNodeId && window.nodeStreams.has(state.sourceNodeId);
      const badge = document.getElementById(`pso-badge-${nodeId}`);
      const resEl = document.getElementById(`pso-res-${nodeId}`);
      const fpsEl = document.getElementById(`pso-fps-${nodeId}`);
      if (badge) {
        badge.textContent = hasStream ? '配信中' : (state.sourceNodeId ? '接続済' : '未接続');
        badge.className   = 'badge ' + (hasStream ? 'badge-active' : (state.sourceNodeId ? 'badge-orange' : 'badge-inactive'));
      }
      if (resEl) resEl.textContent = state.resolution;
      if (fpsEl) fpsEl.textContent = state.fps;
    }, 500);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state = window._streamOutState && window._streamOutState[nodeId];
    const hasStream = state && state.sourceNodeId && window.nodeStreams.has(state.sourceNodeId);
    return {
      dotCls:      hasStream ? 'node-state-dot state-active' : (state && state.sourceNodeId ? 'node-state-dot state-orange' : 'node-state-dot'),
      statusCls:   hasStream ? 'badge-active' : (state && state.sourceNodeId ? 'badge-orange' : 'badge-inactive'),
      statusLabel: hasStream ? '配信中' : (state && state.sourceNodeId ? '接続済' : '未接続'),
      stats: [
        { lbl: '解像度', val: state ? state.resolution : '--' },
        { lbl: 'FPS',   val: state ? String(state.fps) : '--' },
      ],
    };
  },

  unmount(nodeId) {
    window.unregisterNodeHandlers(nodeId);
    if (window._streamOutState) delete window._streamOutState[nodeId];
  },
};

function applyStream(nodeId) {
  const state = window._streamOutState && window._streamOutState[nodeId];
  if (!state || !state.sourceNodeId) return;

  const stream = window.nodeStreams.get(state.sourceNodeId);
  if (!stream) {
    // Connected but source not yet streaming — show "接続済" immediately
    const badge = document.getElementById(`so-badge-${nodeId}`);
    if (badge) { badge.textContent = '接続済'; badge.className = 'badge badge-orange'; }
    return;
  }

  // Update dot
  const dot = document.getElementById(`ndot-${nodeId}`);
  if (dot) dot.className = 'node-state-dot state-active';
  const badge = document.getElementById(`so-badge-${nodeId}`);
  if (badge) { badge.textContent = '配信中'; badge.className = 'badge badge-active'; }

  // Get resolution
  const track = stream.getVideoTracks()[0];
  if (track) {
    const s = track.getSettings();
    state.resolution = `${s.width || '--'}×${s.height || '--'}`;
    const resEl = document.getElementById(`so-res-${nodeId}`);
    if (resEl) resEl.textContent = state.resolution;
  }

  // FPS via rVFC
  const vid = document.createElement('video');
  vid.srcObject = stream;
  vid.muted = true;
  vid.play();
  if (vid.requestVideoFrameCallback) {
    let last = performance.now(), count = 0;
    const tick = () => {
      count++;
      const now = performance.now();
      if (now - last >= 1000) {
        state.fps = (count / ((now - last) / 1000)).toFixed(1);
        count = 0; last = now;
        const fpsEl = document.getElementById(`so-fps-${nodeId}`);
        if (fpsEl) fpsEl.textContent = state.fps;
      }
      if (state.sourceNodeId) vid.requestVideoFrameCallback(tick);
    };
    vid.requestVideoFrameCallback(tick);
  }
  state._previewVid = vid;
}

function clearStream(nodeId) {
  const state = window._streamOutState && window._streamOutState[nodeId];
  if (!state) return;
  state.resolution = '--';
  state.fps = '--';
  if (state._previewVid) { state._previewVid.srcObject = null; state._previewVid = null; }
  const dot = document.getElementById(`ndot-${nodeId}`);
  if (dot) dot.className = 'node-state-dot';
  const badge = document.getElementById(`so-badge-${nodeId}`);
  if (badge) { badge.textContent = '未接続'; badge.className = 'badge badge-inactive'; }
}
