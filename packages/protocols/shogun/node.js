// Vicon Shogun Remote Capture node plugin (UDP XML)
window.NodePlugins['remote-vicon-shogun'] = {
  label:       'ViconShogun',
  icon:        '🎯',
  menuGroup:   'リモート操作',
  menuSection: null,
  nodeClass:   'node-card node-livelink',
  pins: {
    in:  [{ label: 'トリガー', accepts: window.PIN_TYPES.TRIGGER }],
    out: [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('remote-vicon-shogun', 'ViconShogun');
    window.createPluginNode('remote-vicon-shogun', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { host: '192.168.0.100', port: 7003, recording: false, lastMsg: '--', autoCaptureName: false };
    window._shogunState = window._shogunState || {};
    window._shogunState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-livelink" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="ViconShogun" />
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
      state.lastMsg = ok ? 'OK' : `エラー: ${message}`;
      const dot = document.getElementById(`ndot-${nodeId}`);
      if (dot) dot.className = state.recording ? 'node-state-dot state-active' : 'node-state-dot state-orange';
    };
    state._onResult = onResult;
    window.socket.on('shogun:result', onResult);

    window.registerNodeHandlers(nodeId, {
      onTrigger(from, to, payload = {}) {
        if (to !== nodeId) return;
        const { host, port, autoCaptureName } = state;
        if (payload.bool === false) {
          state.recording = false;
          window.socket.emit('shogun:send', { nodeId, host, port, xml: window._shogunXmlStop() });
        } else {
          state.recording = true;
          const name = autoCaptureName && payload.st != null ? String(payload.st) : '';
          window.socket.emit('shogun:send', { nodeId, host, port, xml: window._shogunXmlStart(name) });
        }
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._shogunState && window._shogunState[nodeId];
    const auto  = state && state.autoCaptureName;

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">接続設定</div>
        <div class="form-row">
          <label>IP アドレス</label>
          <input id="pshogun-host-${nodeId}" type="text"
            value="${state ? window.escHtml(state.host) : ''}"
            onchange="window._shogunSetField('${nodeId}','host',this.value)"
            onmousedown="event.stopPropagation()" />
        </div>
        <div class="form-row">
          <label>UDP ポート</label>
          <input id="pshogun-port-${nodeId}" type="number"
            value="${state ? state.port : 7003}"
            onchange="window._shogunSetField('${nodeId}','port',parseInt(this.value)||7003)"
            onmousedown="event.stopPropagation()" />
        </div>
        <div style="font-size:11px;color:var(--text2,#888);margin-top:2px;">Shogun側でリモートキャプチャを有効にしてください</div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">キャプチャ名</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="pshogun-auto-${nodeId}" ${auto ? 'checked' : ''}
            onchange="window._shogunSetAuto('${nodeId}', this.checked)"
            onmousedown="event.stopPropagation()" />
          <label for="pshogun-auto-${nodeId}" style="cursor:pointer;user-select:none;color:var(--text2);">テイク名と連動</label>
        </div>
      </div>
    `;
  },

  getSettings(nodeId) {
    const state = window._shogunState && window._shogunState[nodeId];
    if (!state) return { host: '192.168.0.100', port: 7003, autoCaptureName: false };
    return { host: state.host, port: state.port, autoCaptureName: state.autoCaptureName };
  },

  applySettings(nodeId, s) {
    const state = window._shogunState && window._shogunState[nodeId];
    if (!state) return;
    if (s.host            != null) { state.host            = s.host;            const el = document.getElementById(`pshogun-host-${nodeId}`); if (el) el.value = s.host; }
    if (s.port            != null) { state.port            = s.port;            const el = document.getElementById(`pshogun-port-${nodeId}`); if (el) el.value = s.port; }
    if (s.autoCaptureName != null) { state.autoCaptureName = s.autoCaptureName; const el = document.getElementById(`pshogun-auto-${nodeId}`); if (el) el.checked = s.autoCaptureName; }
  },

  getMetrics(nodeId) {
    const state  = window._shogunState && window._shogunState[nodeId];
    const active = state && state.recording;
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot state-orange',
      statusCls:   active ? 'badge-active' : 'badge-warn',
      statusLabel: active ? '録画中' : '待機中',
      stats: [
        { lbl: '最後の結果', val: state ? state.lastMsg : '--' },
      ],
    };
  },

  unmount(nodeId) {
    const state = window._shogunState && window._shogunState[nodeId];
    if (state && state._onResult) window.socket.off('shogun:result', state._onResult);
    window.unregisterNodeHandlers(nodeId);
    if (window._shogunState) delete window._shogunState[nodeId];
  },
};

window._shogunSetField = (nodeId, field, val) => {
  const st = window._shogunState && window._shogunState[nodeId];
  if (st) st[field] = val;
};

window._shogunSetAuto = (nodeId, val) => {
  const st = window._shogunState && window._shogunState[nodeId];
  if (st) st.autoCaptureName = val;
};

window._shogunXmlStart = (name) => {
  const safeName = (name || '').replace(/[<>&"]/g, '');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><CaptureStart><Name VALUE="${safeName}"/><Notes VALUE=""/><Description VALUE=""/><Delay VALUE="0"/><PacketID VALUE="1"/></CaptureStart>`;
};

window._shogunXmlStop = () => {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><CaptureStop><Delay VALUE="0"/><PacketID VALUE="2"/></CaptureStop>`;
};
