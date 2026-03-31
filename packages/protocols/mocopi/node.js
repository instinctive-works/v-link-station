// Sony mocopi node plugin — stub (未実装)
window.NodePlugins['mocopi'] = {
  label:       'mocopi in',
  icon:        '🕺',
  menuGroup:   'モーションキャプチャ',
  menuSection: 'mocopi',
  nodeClass:   'node-card node-livelink',
  pins: {
    out: [{ type: window.PIN_TYPES.LIVELINK_FACE, label: 'Motion Data' }],
    in:  [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('mocopi', 'mocopi');
    window.createPluginNode('mocopi', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    nodeEl.innerHTML = `
      <div class="node-header node-livelink" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="mocopi" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-out pin-type-livelink-face" data-type="livelink-face" style="justify-content:flex-end;margin:0;">
          <span class="pin-label">Motion Data</span>
          <span class="pin-dot"></span>
        </div>
        <p style="color:var(--text2);font-size:11px;text-align:center;padding:8px 0;">⚠ 未実装</p>
      </div>
    `;
  },

  createPanel(nodeId, cont) {
    cont.innerHTML = '<p class="panel-placeholder">⚠ 未実装</p>';
  },

  getMetrics() {
    return { dotCls: 'node-state-dot', statusCls: 'badge-inactive', statusLabel: '未実装', stats: [] };
  },

  unmount() {},
};
