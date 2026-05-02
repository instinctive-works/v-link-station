// LiveLink Face node plugin
window.NodePlugins['livelink-face'] = {
  label:       'LiveLink Face in',
  icon:        '🎭',
  menuGroup:   'フェイシャルキャプチャ',
  menuSection: 'LiveLink',
  nodeClass:   'node-card node-livelink',
  pins: {
    out: [{ type: window.PIN_TYPES.LIVELINK_FACE, label: 'Face Data' }],
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
      rxCount: 0,
      version: null,
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
      <div class="node-body" style="min-height:80px;">
        <div class="form-row">
          <label>受信ポート</label>
          <input type="number" id="ll-port-${nodeId}" value="11111" min="1" max="65535" />
        </div>
        <div class="stats-row" style="margin:2px 0 4px;">
          <span class="stats-lbl">受信</span>
          <span class="stats-val" id="ll-rx-${nodeId}">待機中 (0 pkts)</span>
        </div>
        <div class="pin-row pin-out pin-type-livelink-face" data-type="livelink-face" style="justify-content:flex-end;margin:0;">
          <span class="pin-label">Face Data</span>
          <span class="pin-dot"></span>
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
      state.rxCount++;
      state.version    = payload.version ?? null;

      // Update node card rx display
      const rxEl = document.getElementById(`ll-rx-${nodeId}`);
      if (rxEl) rxEl.textContent = `受信中 (${state.rxCount} pkts)`;

      // FPS
      state.fpsCount++;
      const now = Date.now();
      if (now - state.fpsTs >= 1000) {
        state.fps = (state.fpsCount / ((now - state.fpsTs) / 1000)).toFixed(1);
        state.fpsCount = 0;
        state.fpsTs = now;
      }

      // Dispatch to downstream nodes
      window.notifyMocap(nodeId, 0, payload);
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
          <span class="stats-lbl">モード</span>
          <span class="stats-val" id="pll-mode-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">FPS</span>
          <span class="stats-val" id="pll-fps-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">受信数</span>
          <span class="stats-val" id="pll-rx-${nodeId}">0 pkts</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">デバイス</span>
          <span class="stats-val" id="pll-name-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">ポート</span>
          <span class="stats-val" id="pll-port-${nodeId}">${state ? state.port : 11111}</span>
        </div>
      </div>
      <div class="perf-section" id="pll-detail-${nodeId}"></div>
    `;

    let lastVersion = null;

    function updatePanel() {
      if (!state) return;
      const active  = state.lastData && (Date.now() - state.lastDataTs < 3000);
      const version = state.version;

      const badge  = document.getElementById(`pll-badge-${nodeId}`);
      const modeEl = document.getElementById(`pll-mode-${nodeId}`);
      const fpsEl  = document.getElementById(`pll-fps-${nodeId}`);
      const rxEl   = document.getElementById(`pll-rx-${nodeId}`);
      const nameEl = document.getElementById(`pll-name-${nodeId}`);
      const portEl = document.getElementById(`pll-port-${nodeId}`);

      if (badge)  { badge.textContent = active ? '受信中' : '待機中'; badge.className = 'badge ' + (active ? 'badge-active' : 'badge-inactive'); }
      if (modeEl) modeEl.textContent = version === 1 ? 'MetaHuman Animator (v1)' : version === 6 ? 'ARKit (v6)' : '--';
      if (fpsEl)  fpsEl.textContent  = active ? (state.fps || '0.0') : '--';
      if (rxEl)   rxEl.textContent   = `${state.rxCount || 0} pkts`;
      if (nameEl) nameEl.textContent = (active && state.lastData.deviceName) ? state.lastData.deviceName : (state.lastData && state.lastData.uuid ? state.lastData.uuid.slice(0, 8) + '…' : '--');
      if (portEl) portEl.textContent = state.port;

      // Switch detail section when version changes
      if (version !== lastVersion) {
        lastVersion = version;
        const detail = document.getElementById(`pll-detail-${nodeId}`);
        if (detail) {
          if (version === 6) {
            detail.innerHTML = `
              <div class="perf-section-title">ブレンドシェイプ</div>
              <canvas id="pll-canvas-${nodeId}" style="width:100%;display:block;border-radius:4px;"></canvas>`;
          } else if (version === 1) {
            detail.innerHTML = `
              <div class="perf-section-title">MetaHuman Animator</div>
              <p style="font-size:11px;color:#9090b0;margin:4px 0;">
                生パケットはRecordingノードで保存できます。
              </p>`;
          }
        }
      }

      // Draw blendshapes for v6
      if (version === 6 && active) {
        const canvas = document.getElementById(`pll-canvas-${nodeId}`);
        if (canvas && window.LiveLinkFaceRenderer) {
          window.LiveLinkFaceRenderer.drawBlendshapes(canvas, state.lastData.blendshapes);
        }
      }
    }

    const timer = setInterval(updatePanel, 100);
    cont._cleanupTimer = timer;
  },

  getSettings(nodeId) {
    const state = window._llFaceState && window._llFaceState[nodeId];
    return { port: state ? state.port : 11111 };
  },

  applySettings(nodeId, s) {
    const state = window._llFaceState && window._llFaceState[nodeId];
    if (!state || s.port == null) return;
    state.port = s.port;
    const inp = document.getElementById(`ll-port-${nodeId}`);
    if (inp) inp.value = s.port;
    window.socket.emit('livelink:bind-port', { port: s.port });
  },

  getMetrics(nodeId) {
    const state = window._llFaceState && window._llFaceState[nodeId];
    const active = state && state.lastData && (Date.now() - (state.lastDataTs || 0) < 3000);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? '受信中' : '待機中',
      stats: [
        { lbl: 'FPS',  val: state ? String(state.fps || '--') : '--' },
        { lbl: '受信数', val: state ? `${state.rxCount || 0} pkts` : '0 pkts' },
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

// LiveLink Face output node — registers a server-side UDP forward rule
window.NodePlugins['livelink-face-out'] = {
  label:       'LiveLink Face out',
  icon:        '📡',
  menuGroup:   'フェイシャルキャプチャ',
  menuSection: 'LiveLink',
  nodeClass:   'node-card node-livelink',
  pins: {
    out: [],
    in:  [{ label: 'Face Data', accepts: window.PIN_TYPES.LIVELINK_FACE }],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('livelink-face-out', 'LiveLink Face Out');
    window.createPluginNode('livelink-face-out', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { srcId: null, host: '127.0.0.1', port: 11111 };
    window._llFaceOutState = window._llFaceOutState || {};
    window._llFaceOutState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-livelink" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="LiveLink Face Out" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-in pin-type-livelink-face" data-accepts="${window.PIN_TYPES.LIVELINK_FACE}">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">Face Data</span>
        </div>
        <div class="form-row" style="margin-top:6px;">
          <label>送信先 IP</label>
          <input type="text" id="llfo-host-${nodeId}" value="127.0.0.1" />
        </div>
        <div class="form-row">
          <label>送信先ポート</label>
          <input type="number" id="llfo-port-${nodeId}" value="11111" min="1" max="65535" />
        </div>
        <div class="stats-row" style="margin-top:4px;">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="llfo-badge-${nodeId}">未接続</span>
        </div>
      </div>
    `;

    const hostEl = document.getElementById(`llfo-host-${nodeId}`);
    const portEl = document.getElementById(`llfo-port-${nodeId}`);
    if (hostEl) hostEl.addEventListener('change', () => { state.host = hostEl.value.trim() || '127.0.0.1'; });
    if (portEl) portEl.addEventListener('change', () => { state.port = parseInt(portEl.value) || 11111; });

    function srcPort() {
      const src = window._llFaceState && window._llFaceState[state.srcId];
      return src ? src.port : null;
    }
    function startForward() {
      const fp = srcPort();
      if (!fp) return;
      window.socket.emit('livelink:forward-start', { fromPort: fp, host: state.host, toPort: state.port });
      const badge = document.getElementById(`llfo-badge-${nodeId}`);
      if (badge) { badge.textContent = '転送中'; badge.className = 'badge badge-active'; }
    }
    function stopForward(prevSrcId) {
      const src = window._llFaceState && window._llFaceState[prevSrcId];
      const fp = src ? src.port : null;
      if (!fp) return;
      window.socket.emit('livelink:forward-stop', { fromPort: fp, host: state.host, toPort: state.port });
      const badge = document.getElementById(`llfo-badge-${nodeId}`);
      if (badge) { badge.textContent = '未接続'; badge.className = 'badge badge-inactive'; }
    }

    // Re-register when host/port changes
    if (hostEl) hostEl.addEventListener('change', () => {
      state.host = hostEl.value.trim() || '127.0.0.1';
      if (state.srcId) { stopForward(state.srcId); startForward(); }
    });
    if (portEl) portEl.addEventListener('change', () => {
      state.port = parseInt(portEl.value) || 11111;
      if (state.srcId) { stopForward(state.srcId); startForward(); }
    });

    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        state.srcId = fromNodeId;
        startForward();
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId || state.srcId !== fromNodeId) return;
        stopForward(fromNodeId);
        state.srcId = null;
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._llFaceOutState && window._llFaceOutState[nodeId];
    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">LiveLink Face 転送</div>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="pllfo-badge-${nodeId}">未接続</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">送信先</span>
          <span class="stats-val" id="pllfo-dst-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">設定</div>
        <div class="form-row">
          <label>送信先 IP</label>
          <input type="text" id="pllfo-host-${nodeId}" value="${state ? state.host : '127.0.0.1'}" />
        </div>
        <div class="form-row">
          <label>送信先ポート</label>
          <input type="number" id="pllfo-port-${nodeId}" value="${state ? state.port : 11111}" min="1" max="65535" />
        </div>
      </div>
    `;

    if (state) {
      const ph = document.getElementById(`pllfo-host-${nodeId}`);
      const pp = document.getElementById(`pllfo-port-${nodeId}`);
      if (ph) ph.addEventListener('change', () => {
        state.host = ph.value.trim() || '127.0.0.1';
        const nh = document.getElementById(`llfo-host-${nodeId}`);
        if (nh) nh.value = state.host;
      });
      if (pp) pp.addEventListener('change', () => {
        state.port = parseInt(pp.value) || 11111;
        const np = document.getElementById(`llfo-port-${nodeId}`);
        if (np) np.value = state.port;
      });
    }

    const timer = setInterval(() => {
      if (!state) return;
      const active = !!state.srcId;
      const badge = document.getElementById(`pllfo-badge-${nodeId}`);
      const dst   = document.getElementById(`pllfo-dst-${nodeId}`);
      if (badge) { badge.textContent = active ? '転送中' : '未接続'; badge.className = 'badge ' + (active ? 'badge-active' : 'badge-inactive'); }
      if (dst)   dst.textContent = `${state.host}:${state.port}`;
    }, 500);
    cont._cleanupTimer = timer;
  },

  getSettings(nodeId) {
    const state = window._llFaceOutState && window._llFaceOutState[nodeId];
    return { host: state ? state.host : '127.0.0.1', port: state ? state.port : 11111 };
  },

  applySettings(nodeId, s) {
    const state = window._llFaceOutState && window._llFaceOutState[nodeId];
    if (!state) return;
    if (s.host) state.host = s.host;
    if (s.port) state.port = s.port;
    const h = document.getElementById(`llfo-host-${nodeId}`);
    const p = document.getElementById(`llfo-port-${nodeId}`);
    if (h) h.value = state.host;
    if (p) p.value = state.port;
  },

  getMetrics(nodeId) {
    const state  = window._llFaceOutState && window._llFaceOutState[nodeId];
    const active = !!(state && state.srcId);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? '転送中' : '未接続',
      stats: [
        { lbl: '送信先', val: state ? `${state.host}:${state.port}` : '--' },
      ],
    };
  },

  unmount(nodeId) {
    window.unregisterNodeHandlers(nodeId);
    if (window._llFaceOutState) delete window._llFaceOutState[nodeId];
  },
};
