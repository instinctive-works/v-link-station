// LiveLink Face node plugin
window.NodePlugins['livelink-face'] = {
  label:       'LiveLink Face',
  icon:        '🎭',
  menuSection: 'モーションキャプチャ',
  nodeClass:   'node-card node-livelink',
  pins: {
    out: [{ type: 'livelink-face', label: 'Face Data' }],
    in:  [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('livelink-face', 'LiveLink Face');
    window.createPluginNode('livelink-face', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    // State
    const state = {
      port: 11111,
      lastData: null,
      lastDataTs: 0,
      fps: 0,
      fpsCount: 0,
      fpsTs: Date.now(),
    };
    window._llFaceState = window._llFaceState || {};
    window._llFaceState[nodeId] = state;

    // Build HTML
    nodeEl.innerHTML = `
      <div class="node-header node-livelink" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="LiveLink Face" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-out pin-type-livelink-face" data-type="livelink-face">
          <span class="pin-label">Face Data</span>
          <span class="pin-dot"></span>
        </div>
        <div class="form-row" style="margin-top:8px">
          <label>受信ポート</label>
          <input type="number" id="ll-port-${nodeId}" value="11111" min="1" max="65535" />
        </div>
      </div>
    `;

    // Bind the default port immediately
    window.socket.emit('livelink:bind-port', { port: state.port });

    // Bind new port when changed
    const portEl = document.getElementById(`ll-port-${nodeId}`);
    if (portEl) portEl.addEventListener('change', () => {
      const p = parseInt(portEl.value) || 11111;
      state.port = p;
      window.socket.emit('livelink:bind-port', { port: p });
    });

    // Listen for mocap data filtered by port
    function onData(payload) {
      if (payload.format !== 'livelink-face') return;
      if (payload.port !== undefined && payload.port !== state.port) return;

      state.lastData   = payload.data;
      state.lastDataTs = Date.now();

      // FPS
      state.fpsCount++;
      const now = Date.now();
      if (now - state.fpsTs >= 1000) {
        state.fps = (state.fpsCount / ((now - state.fpsTs) / 1000)).toFixed(1);
        state.fpsCount = 0;
        state.fpsTs = now;
      }
    }
    window.socket.on('mocap-data', onData);

    // Store cleanup ref
    state._onData = onData;
  },

  createPanel(nodeId, cont) {
    const state = window._llFaceState && window._llFaceState[nodeId];

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="pll-badge-${nodeId}">待機中</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">FPS</span>
          <span class="stats-val" id="pll-fps-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">デバイス名</span>
          <span class="stats-val" id="pll-name-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">ブレンドシェイプ</div>
        <canvas id="pll-canvas-${nodeId}" width="276" height="600" style="width:100%;display:block;border-radius:4px;"></canvas>
      </div>
    `;

    // Update panel with live data
    function updatePanel() {
      if (!state || !state.lastData) return;
      const badge = document.getElementById(`pll-badge-${nodeId}`);
      const fpsEl = document.getElementById(`pll-fps-${nodeId}`);
      const nameEl = document.getElementById(`pll-name-${nodeId}`);
      const canvas = document.getElementById(`pll-canvas-${nodeId}`);

      if (badge) { badge.textContent = '受信中'; badge.className = 'badge badge-active'; }
      if (fpsEl)  fpsEl.textContent = state.fps || '--';
      if (nameEl) nameEl.textContent = state.lastData.deviceName || '--';
      if (canvas && window.LiveLinkFaceRenderer) {
        window.LiveLinkFaceRenderer.drawBlendshapes(canvas, state.lastData.blendshapes);
      }
    }

    const timer = setInterval(updatePanel, 100);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state = window._llFaceState && window._llFaceState[nodeId];
    const active = state && state.lastData && (Date.now() - (state.lastDataTs || 0) < 3000);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? '受信中' : '待機中',
      stats: [
        { lbl: 'FPS', val: state ? String(state.fps || '--') : '--' },
      ],
    };
  },

  unmount(nodeId) {
    const state = window._llFaceState && window._llFaceState[nodeId];
    if (state) {
      if (state._onData) window.socket.off('mocap-data', state._onData);
      delete window._llFaceState[nodeId];
    }
  },
};
