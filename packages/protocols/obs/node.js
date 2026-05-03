// OBS WebSocket node plugin
window.NodePlugins['remote-obs'] = {
  label:       'OBS',
  icon:        '🔴',
  menuGroup:   'リモート操作',
  menuSection: null,
  nodeClass:   'node-card node-livelink',
  pins: {
    in:  [{ label: 'トリガー', accepts: window.PIN_TYPES.TRIGGER }],
    out: [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('remote-obs', 'OBS');
    window.createPluginNode('remote-obs', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    // connected: null=未確認, true=接続OK, false=エラー
    const state = { host: '127.0.0.1', port: 4455, password: '', sourceName: '', recording: false, lastMsg: '--', autoSubtitle: false, connected: null };
    window._obsState = window._obsState || {};
    window._obsState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-livelink" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="OBS" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-in pin-type-trigger" data-accepts="${window.PIN_TYPES.TRIGGER}" style="margin:8px 0 0 0;">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">トリガー</span>
        </div>
      </div>
    `;

    const onResult = ({ nodeId: nid, ok, action, connected, message }) => {
      if (nid !== nodeId) return;
      if (connected != null) state.connected = connected;
      if (action === 'record' && ok) state.recording = true;
      if (action === 'stop')        state.recording = false;
      if (action !== 'ping') state.lastMsg = ok ? 'OK' : `エラー: ${message}`;
      const dot = document.getElementById(`ndot-${nodeId}`);
      if (dot) dot.className = window._obsStateDotCls(state);
    };
    state._onResult = onResult;
    window.socket.on('obs:result', onResult);

    window.registerNodeHandlers(nodeId, {
      onTrigger(from, to, payload = {}) {
        if (to !== nodeId) return;
        const { host, port, password, sourceName, autoSubtitle } = state;
        const commands = [];
        if (payload.bool === false) {
          commands.push({ requestType: 'StopRecord' });
          if (autoSubtitle && sourceName) {
            commands.push({ requestType: 'SetInputSettings', requestData: { inputName: sourceName, inputSettings: { text: '' } } });
          }
        } else {
          commands.push({ requestType: 'StartRecord' });
          if (autoSubtitle && sourceName && payload.st != null) {
            commands.push({ requestType: 'SetInputSettings', requestData: { inputName: sourceName, inputSettings: { text: String(payload.st) } } });
          }
        }
        window.socket.emit('obs:exec', { nodeId, host, port, password, commands });
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._obsState && window._obsState[nodeId];
    const auto  = state && state.autoSubtitle;

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">接続設定</div>
        <div class="form-row">
          <label>IP アドレス</label>
          <input id="pobs-host-${nodeId}" type="text"
            value="${state ? window.escHtml(state.host) : ''}"
            onchange="window._obsSetField('${nodeId}','host',this.value)"
            onmousedown="event.stopPropagation()" />
        </div>
        <div class="form-row">
          <label>ポート</label>
          <input id="pobs-port-${nodeId}" type="number"
            value="${state ? state.port : 4455}"
            onchange="window._obsSetField('${nodeId}','port',parseInt(this.value)||4455)"
            onmousedown="event.stopPropagation()" />
        </div>
        <div class="form-row">
          <label>パスワード</label>
          <input id="pobs-pw-${nodeId}" type="password"
            value="${state ? state.password : ''}"
            onchange="window._obsSetField('${nodeId}','password',this.value)"
            onmousedown="event.stopPropagation()" />
        </div>
        <div class="form-row">
          <label>字幕ソース名</label>
          <input id="pobs-src-${nodeId}" type="text"
            value="${state ? window.escHtml(state.sourceName) : ''}"
            placeholder="OBS テキストソース名"
            onchange="window._obsSetField('${nodeId}','sourceName',this.value)"
            onmousedown="event.stopPropagation()" />
        </div>
        <button class="btn-primary" style="margin-top:8px;width:100%;"
          onclick="window._obsPing('${nodeId}')">接続テスト</button>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">字幕送信</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <input type="checkbox" id="pobs-auto-${nodeId}" ${auto ? 'checked' : ''}
            onchange="window._obsSetAuto('${nodeId}', this.checked)"
            onmousedown="event.stopPropagation()" />
          <label for="pobs-auto-${nodeId}" style="cursor:pointer;user-select:none;color:var(--text2);">テイク名と連動</label>
        </div>
        <textarea id="pobs-text-${nodeId}" rows="3"
          style="width:100%;box-sizing:border-box;resize:vertical;font-size:12px;background:var(--bg2,#1a1a2e);color:var(--text,#e0e0e0);border:1px solid var(--border,#333);border-radius:4px;padding:4px;"
          placeholder="送信するテキストを入力"
          ${auto ? 'disabled' : ''}
          onmousedown="event.stopPropagation()"></textarea>
        <button id="pobs-send-${nodeId}" class="btn-primary" style="margin-top:6px;width:100%;"
          ${auto ? 'disabled' : ''}
          onclick="window._obsSendText('${nodeId}')">テキスト送信</button>
      </div>
    `;
  },

  getSettings(nodeId) {
    const state = window._obsState && window._obsState[nodeId];
    if (!state) return { host: '127.0.0.1', port: 4455, password: '', sourceName: '', autoSubtitle: false };
    return { host: state.host, port: state.port, password: state.password, sourceName: state.sourceName, autoSubtitle: state.autoSubtitle };
  },

  applySettings(nodeId, s) {
    const state = window._obsState && window._obsState[nodeId];
    if (!state) return;
    if (s.host         != null) { state.host         = s.host;         const el = document.getElementById(`pobs-host-${nodeId}`); if (el) el.value = s.host; }
    if (s.port         != null) { state.port         = s.port;         const el = document.getElementById(`pobs-port-${nodeId}`); if (el) el.value = s.port; }
    if (s.password     != null) { state.password     = s.password;     const el = document.getElementById(`pobs-pw-${nodeId}`);   if (el) el.value = s.password; }
    if (s.sourceName   != null) { state.sourceName   = s.sourceName;   const el = document.getElementById(`pobs-src-${nodeId}`);  if (el) el.value = s.sourceName; }
    if (s.autoSubtitle != null) { state.autoSubtitle = s.autoSubtitle; window._obsApplyAutoUi(nodeId); }
  },

  getMetrics(nodeId) {
    const state  = window._obsState && window._obsState[nodeId];
    const active = state && state.recording;
    const conn   = state ? state.connected : null;
    const statusLabel = conn === null ? '未確認' : conn ? (active ? '録画中' : '接続中') : 'エラー';
    const statusCls   = conn === null ? 'badge-inactive' : conn ? (active ? 'badge-warn' : 'badge-active') : 'badge-error';
    return {
      dotCls:      state ? window._obsStateDotCls(state) : 'node-state-dot',
      statusCls,
      statusLabel,
      stats: [
        { lbl: '最後の結果', val: state ? state.lastMsg : '--' },
      ],
    };
  },

  unmount(nodeId) {
    const state = window._obsState && window._obsState[nodeId];
    if (state && state._onResult) window.socket.off('obs:result', state._onResult);
    window.unregisterNodeHandlers(nodeId);
    if (window._obsState) delete window._obsState[nodeId];
  },
};

window._obsStateDotCls = (state) => {
  if (state.connected === false) return 'node-state-dot state-error';
  if (state.connected === true && state.recording) return 'node-state-dot state-orange';
  if (state.connected === true) return 'node-state-dot state-active';
  return 'node-state-dot';
};

window._obsSetField = (nodeId, field, val) => {
  const st = window._obsState && window._obsState[nodeId];
  if (st) st[field] = val;
};

window._obsApplyAutoUi = (nodeId) => {
  const state = window._obsState && window._obsState[nodeId];
  if (!state) return;
  const chk = document.getElementById(`pobs-auto-${nodeId}`);
  const txt = document.getElementById(`pobs-text-${nodeId}`);
  const btn = document.getElementById(`pobs-send-${nodeId}`);
  if (chk) chk.checked  = state.autoSubtitle;
  if (txt) txt.disabled = state.autoSubtitle;
  if (btn) btn.disabled = state.autoSubtitle;
};

window._obsSetAuto = (nodeId, val) => {
  const st = window._obsState && window._obsState[nodeId];
  if (!st) return;
  st.autoSubtitle = val;
  window._obsApplyAutoUi(nodeId);
};

window._obsPing = (nodeId) => {
  const state = window._obsState && window._obsState[nodeId];
  if (!state) return;
  window.socket.emit('obs:ping', { nodeId, host: state.host, port: state.port, password: state.password });
};

window._obsSendText = (nodeId) => {
  const state = window._obsState && window._obsState[nodeId];
  if (!state) return;
  const textEl = document.getElementById(`pobs-text-${nodeId}`);
  const text   = textEl ? textEl.value : '';
  if (!state.sourceName) { alert('字幕ソース名を入力してください'); return; }
  window.socket.emit('obs:exec', {
    nodeId,
    host:     state.host,
    port:     state.port,
    password: state.password,
    commands: [{ requestType: 'SetInputSettings', requestData: { inputName: state.sourceName, inputSettings: { text } } }],
  });
};
