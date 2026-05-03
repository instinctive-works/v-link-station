// Stype Data Recorder node plugin
window.NodePlugins['stype'] = {
  label:       'Stype',
  icon:        '📡',
  menuGroup:   'リモート操作',
  menuSection: null,
  nodeClass:   'node-card node-livelink',
  pins: {
    in:  [{ label: 'トリガー', accepts: window.PIN_TYPES.TRIGGER }],
    out: [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('stype', 'Stype');
    window.createPluginNode('stype', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { host: '127.0.0.1', recording: false, lastMsg: '--' };
    window._stypeState = window._stypeState || {};
    window._stypeState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-livelink" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="Stype" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-in pin-type-trigger" data-accepts="${window.PIN_TYPES.TRIGGER}" style="margin:8px 0 0 0;">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">トリガー</span>
        </div>
      </div>
    `;

    const onResult = ({ nodeId: nid, ok, message }) => {
      if (nid !== nodeId) return;
      state.lastMsg = ok ? (message || 'OK') : `エラー: ${message}`;
      const dot = document.getElementById(`ndot-${nodeId}`);
      if (dot) dot.className = state.recording ? 'node-state-dot state-active' : 'node-state-dot';
    };
    state._onResult = onResult;
    window.socket.on('stype:result', onResult);

    window.registerNodeHandlers(nodeId, {
      onTrigger(from, to, payload = {}) {
        if (to !== nodeId) return;
        if (payload.bool === false) {
          state.recording = false;
          window.socket.emit('stype:send', { nodeId, host: state.host, message: 'StypeStop' });
        } else {
          state.recording = true;
          window.socket.emit('stype:send', { nodeId, host: state.host, message: 'StypeStart' });
        }
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._stypeState && window._stypeState[nodeId];

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">接続設定</div>
        <div class="form-row">
          <label>IP アドレス</label>
          <input id="pstype-host-${nodeId}" type="text"
            value="${state ? window.escHtml(state.host) : ''}"
            onchange="window._stypeSetHost('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()" />
        </div>
        <div style="font-size:11px;color:var(--text2,#888);margin-top:2px;">UDP port 2458 固定</div>
      </div>
    `;
  },

  getSettings(nodeId) {
    const state = window._stypeState && window._stypeState[nodeId];
    return { host: state ? state.host : '127.0.0.1' };
  },

  applySettings(nodeId, s) {
    const state = window._stypeState && window._stypeState[nodeId];
    if (!state) return;
    if (s.host != null) {
      state.host = s.host;
      const el = document.getElementById(`pstype-host-${nodeId}`);
      if (el) el.value = s.host;
    }
  },

  getMetrics(nodeId) {
    const state  = window._stypeState && window._stypeState[nodeId];
    const active = state && state.recording;
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? '録画中' : '停止',
      stats: [
        { lbl: '最後の結果', val: state ? state.lastMsg : '--' },
      ],
    };
  },

  unmount(nodeId) {
    const state = window._stypeState && window._stypeState[nodeId];
    if (state) {
      if (state._onResult) window.socket.off('stype:result', state._onResult);
    }
    window.unregisterNodeHandlers(nodeId);
    if (window._stypeState) delete window._stypeState[nodeId];
  },
};

window._stypeSetHost = (nodeId, val) => {
  const st = window._stypeState && window._stypeState[nodeId];
  if (st) st.host = val.trim();
};
