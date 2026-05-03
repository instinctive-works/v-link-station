// AJA Ki Pro node plugin
window.NodePlugins['remote-aja-kipro'] = {
  label:       'Aja Kipro',
  icon:        '📼',
  menuGroup:   'リモート操作',
  menuSection: null,
  nodeClass:   'node-card node-livelink',
  pins: {
    in:  [{ label: 'トリガー', accepts: window.PIN_TYPES.TRIGGER }],
    out: [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('remote-aja-kipro', 'Aja Kipro');
    window.createPluginNode('remote-aja-kipro', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { host: '192.168.0.100', recording: false, lastMsg: '--' };
    window._kiproState = window._kiproState || {};
    window._kiproState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-livelink" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="Aja Kipro" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-in pin-type-trigger" data-accepts="${window.PIN_TYPES.TRIGGER}" style="margin:8px 0 0 0;">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">トリガー</span>
        </div>
      </div>
    `;

    const onResult = ({ nodeId: nid, ok, action, message }) => {
      if (nid !== nodeId) return;
      if (action === 'record' && ok) state.recording = true;
      if (action === 'stop')        state.recording = false;
      state.lastMsg = ok ? 'OK' : `エラー: ${message}`;
      const dot = document.getElementById(`ndot-${nodeId}`);
      if (dot) dot.className = state.recording ? 'node-state-dot state-active' : 'node-state-dot';
    };
    state._onResult = onResult;
    window.socket.on('kipro:result', onResult);

    window.registerNodeHandlers(nodeId, {
      onTrigger(from, to, payload = {}) {
        if (to !== nodeId) return;
        if (payload.bool === false) {
          window.socket.emit('kipro:stop',   { nodeId, host: state.host });
        } else {
          window.socket.emit('kipro:record', { nodeId, host: state.host });
        }
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._kiproState && window._kiproState[nodeId];

    // ステータスセクションを先頭に置く → 500ms タイマーが getMetrics で更新する
    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">接続設定</div>
        <div class="form-row">
          <label>IP アドレス</label>
          <input id="pkipro-host-${nodeId}" type="text"
            value="${state ? window.escHtml(state.host) : ''}"
            onchange="window._kiproSetHost('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()" />
        </div>
      </div>
    `;
  },

  getSettings(nodeId) {
    const state = window._kiproState && window._kiproState[nodeId];
    return { host: state ? state.host : '192.168.0.100' };
  },

  applySettings(nodeId, s) {
    const state = window._kiproState && window._kiproState[nodeId];
    if (!state) return;
    if (s.host != null) {
      state.host = s.host;
      const el = document.getElementById(`pkipro-host-${nodeId}`);
      if (el) el.value = s.host;
    }
  },

  getMetrics(nodeId) {
    const state  = window._kiproState && window._kiproState[nodeId];
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
    const state = window._kiproState && window._kiproState[nodeId];
    if (state && state._onResult) window.socket.off('kipro:result', state._onResult);
    window.unregisterNodeHandlers(nodeId);
    if (window._kiproState) delete window._kiproState[nodeId];
  },
};

window._kiproSetHost = (nodeId, val) => {
  const st = window._kiproState && window._kiproState[nodeId];
  if (st) st.host = val.trim();
};
