// VideoSwitch node plugin
// Two WASM_FRAME inputs (A / B). A button toggles which input is active.
// The active input's frame token is passed downstream unchanged.
window.NodePlugins['video-switch'] = {
  label:       'VideoSwitch',
  icon:        '🔀',
  menuGroup:   'ユーティリティ',
  menuSection: null,
  nodeClass:   'node-card node-video',
  pins: {
    out: [{ type: window.PIN_TYPES.WASM_FRAME, label: 'フレーム出力' }], // index 0
    in:  [
      { label: 'フレーム A', accepts: window.PIN_TYPES.WASM_FRAME }, // index 0
      { label: 'フレーム B', accepts: window.PIN_TYPES.WASM_FRAME }, // index 1
    ],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('video-switch', 'VideoSwitch');
    window.createPluginNode('video-switch', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { active: 'a', srcA: null, srcB: null };
    window._vSwitchState = window._vSwitchState || {};
    window._vSwitchState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="VideoSwitch" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;" id="vslbl-a-${nodeId}">フレーム A ▶</span>
            </div>
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;" id="vslbl-b-${nodeId}">フレーム B</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
            <button class="btn-secondary" id="vs-toggle-${nodeId}"
              onclick="window._vSwitchToggle('${nodeId}')"
              onmousedown="event.stopPropagation()"
              style="font-size:11px;padding:3px 8px;">A→B</button>
            <div class="pin-row pin-out pin-type-wasm-frame" data-type="${window.PIN_TYPES.WASM_FRAME}" style="margin:0;">
              <span class="pin-label">出力</span>
              <span class="pin-dot"></span>
            </div>
          </div>
        </div>
      </div>
    `;

    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        const conn = [...window.connections.values()]
          .find(c => c.toNodeId === nodeId && c.fromNodeId === fromNodeId);
        if (!conn) return;
        // Each input pin allows only one connection
        const existing = [...window.connections.values()]
          .filter(c => c.toNodeId === nodeId && c.toPinIdx === conn.toPinIdx && c.fromNodeId !== fromNodeId);
        for (const c of existing) window.removeSingleConnection(c.fromNodeId, nodeId);
        if (conn.toPinIdx === 0) state.srcA = fromNodeId;
        else                      state.srcB = fromNodeId;
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        if (state.srcA === fromNodeId) state.srcA = null;
        if (state.srcB === fromNodeId) state.srcB = null;
      },
      onFrame(token, fromNodeId) {
        if (state.active === 'a' && fromNodeId === state.srcA) {
          window.notifyFrame(nodeId, 0, token);
        } else if (state.active === 'b' && fromNodeId === state.srcB) {
          window.notifyFrame(nodeId, 0, token);
        }
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._vSwitchState && window._vSwitchState[nodeId];
    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
        <div class="stats-row">
          <span class="stats-lbl">アクティブ</span>
          <span class="stats-val" id="pvs-active-${nodeId}">A</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">フレーム A</span>
          <span class="badge badge-inactive" id="pvs-a-${nodeId}">未接続</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">フレーム B</span>
          <span class="badge badge-inactive" id="pvs-b-${nodeId}">未接続</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">操作</div>
        <button class="btn-primary" style="width:100%"
          onclick="window._vSwitchToggle('${nodeId}')"
          onmousedown="event.stopPropagation()">A / B 切り替え</button>
      </div>
    `;
    const timer = setInterval(() => {
      if (!state) return;
      const actEl = document.getElementById(`pvs-active-${nodeId}`);
      const aEl   = document.getElementById(`pvs-a-${nodeId}`);
      const bEl   = document.getElementById(`pvs-b-${nodeId}`);
      if (actEl) actEl.textContent = state.active.toUpperCase();
      if (aEl) { aEl.textContent = state.srcA ? '接続済' : '未接続'; aEl.className = 'badge ' + (state.srcA ? 'badge-active' : 'badge-inactive'); }
      if (bEl) { bEl.textContent = state.srcB ? '接続済' : '未接続'; bEl.className = 'badge ' + (state.srcB ? 'badge-active' : 'badge-inactive'); }
    }, 300);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state = window._vSwitchState && window._vSwitchState[nodeId];
    const active = !!(state && (state.srcA || state.srcB));
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? `Active:${state ? state.active.toUpperCase() : '-'}` : '未接続',
      stats: [],
    };
  },

  unmount(nodeId) {
    window.unregisterNodeHandlers(nodeId);
    if (window._vSwitchState) delete window._vSwitchState[nodeId];
  },
};

window._vSwitchToggle = (nodeId) => {
  const state = window._vSwitchState && window._vSwitchState[nodeId];
  if (!state) return;
  state.active = state.active === 'a' ? 'b' : 'a';
  const lblA = document.getElementById(`vslbl-a-${nodeId}`);
  const lblB = document.getElementById(`vslbl-b-${nodeId}`);
  if (lblA) lblA.textContent = 'フレーム A' + (state.active === 'a' ? ' ▶' : '');
  if (lblB) lblB.textContent = 'フレーム B' + (state.active === 'b' ? ' ▶' : '');
  const dot = document.getElementById(`ndot-${nodeId}`);
  if (dot) dot.className = 'node-state-dot state-active';
};
