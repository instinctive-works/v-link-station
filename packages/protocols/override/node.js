// Override node plugin
// ・Replay 入力 (replay 型, 1本のみ)
// ・Pass In  (任意型, 1本のみ) — 接続したときに Pass Out の型が自動的に一致する
// ・Pass Out (任意型, 1本のみ) — Pass In 接続前に繋いだときは接続先の accepts 型に追従
(function () {
  window._overrideState = window._overrideState || {};

  // ── Pass Out 型を両方向から推論して同期 ───────────────────────────────────
  // 優先度: 1) Pass In の接続元 type  2) Pass Out の接続先 accepts  3) リセット
  function syncPassType(nodeId) {
    const st = window._overrideState[nodeId];
    if (!st) return;

    const nodeEl = document.getElementById(nodeId);
    if (!nodeEl) return;
    const outRow = nodeEl.querySelectorAll('.pin-row.pin-out')[0];
    if (!outRow) return;

    // Priority 1: Pass In (in[1]) の接続元ノードの out ピン型
    const passInConn = [...window.connections.values()]
      .find(c => c.toNodeId === nodeId && c.toPinIdx === 1);
    if (passInConn) {
      const srcEl   = document.getElementById(passInConn.fromNodeId);
      const srcRow  = srcEl
        ? srcEl.querySelectorAll('.pin-row.pin-out')[passInConn.fromPinIdx]
        : null;
      const srcType = srcRow ? (srcRow.dataset.type || null) : null;
      if (srcType) { applyPassType(outRow, srcType, st); return; }
    }

    // Priority 2: Pass Out (out[0]) の接続先ノードの in ピン accepts
    const passOutConn = [...window.connections.values()]
      .find(c => c.fromNodeId === nodeId && c.fromPinIdx === 0);
    if (passOutConn) {
      const tgtEl      = document.getElementById(passOutConn.toNodeId);
      const tgtRow     = tgtEl
        ? tgtEl.querySelectorAll('.pin-row.pin-in')[passOutConn.toPinIdx]
        : null;
      const tgtAccepts = tgtRow ? (tgtRow.dataset.accepts || null) : null;
      if (tgtAccepts) { applyPassType(outRow, tgtAccepts, st); return; }
    }

    // リセット
    st.passType = null;
    delete outRow.dataset.type;
    outRow.className = outRow.className.replace(/\bpin-type-\S+/g, '').trim();
  }

  function applyPassType(outRow, type, st) {
    st.passType = type;
    outRow.dataset.type = type;
    outRow.className = outRow.className.replace(/\bpin-type-\S+/g, '').trim();
    outRow.classList.add(`pin-type-${type}`);
  }

  // ── プラグイン登録 ────────────────────────────────────────────────────────
  window.NodePlugins['util-override'] = {
    label:       'Override',
    icon:        '✏️',
    menuGroup:   'ユーティリティ',
    menuSection: null,
    nodeClass:   'node-card node-livelink',
    pins: {
      out: [{ type: '',                             label: 'Pass Out' }],
      in:  [
        { label: 'Replay', accepts: window.PIN_TYPES.REPLAY },
        { label: 'Pass In' }, // accepts 未指定 = 全型受け入れ
      ],
    },

    create(pos) {
      const nodeId = window.generateNodeId();
      const name   = window.nextUniqueName('util-override', 'Override');
      window.createPluginNode('util-override', nodeId, pos);
      const nameEl = document.getElementById(`ename-${nodeId}`);
      if (nameEl) nameEl.value = name;
      return nodeId;
    },

    mount(nodeId, nodeEl) {
      const state = { passType: null };
      window._overrideState[nodeId] = state;

      nodeEl.innerHTML = `
        <div class="node-header node-livelink" id="nheader-${nodeId}">
          <span class="node-state-dot" id="ndot-${nodeId}"></span>
          <input class="node-name" id="ename-${nodeId}" value="Override" />
          <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
        </div>
        <div class="node-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="display:flex;flex-direction:column;gap:4px;">
              <div class="pin-row pin-in pin-type-replay"
                   data-accepts="${window.PIN_TYPES.REPLAY}">
                <span class="pin-dot"></span>
                <span class="pin-label" style="margin-left:6px;">Replay</span>
              </div>
              <div class="pin-row pin-in" id="ov-passin-${nodeId}">
                <span class="pin-dot"></span>
                <span class="pin-label" style="margin-left:6px;">Pass In</span>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;justify-content:center;flex:1;align-items:flex-end;">
              <div class="pin-row pin-out" data-type=""
                   id="ov-passout-${nodeId}"
                   style="margin:0;justify-content:flex-end;">
                <span class="pin-label">Pass Out</span>
                <span class="pin-dot"></span>
              </div>
            </div>
          </div>
        </div>
      `;

      window.registerNodeHandlers(nodeId, {
        onConnected(fromNodeId, toNodeId) {
          // ── 入力ピン側: this ノードへの接続 ─────────────────────────────
          if (toNodeId === nodeId) {
            // 各入力ピンを 1 本に制限
            for (let idx = 0; idx <= 1; idx++) {
              const pinConns = [...window.connections.values()]
                .filter(c => c.toNodeId === nodeId && c.toPinIdx === idx);
              if (pinConns.length > 1) {
                pinConns.slice(0, -1).forEach(c =>
                  window.removeSingleConnection(c.fromNodeId, nodeId));
              }
            }
          }

          // ── 出力ピン側: this ノードからの接続 ───────────────────────────
          if (fromNodeId === nodeId) {
            // Pass Out (out[0]) を 1 本に制限
            const outConns = [...window.connections.values()]
              .filter(c => c.fromNodeId === nodeId && c.fromPinIdx === 0);
            if (outConns.length > 1) {
              outConns.slice(0, -1).forEach(c =>
                window.removeSingleConnection(nodeId, c.toNodeId));
            }
          }

          // どちらの端が繋がっても型を再推論
          syncPassType(nodeId);
        },

        onDisconnected(_fromNodeId, _toNodeId) {
          // 切断後も型を再推論（もう片方の接続が残っていれば維持）
          syncPassType(nodeId);
        },

        // Pass In (in[1]) に WASM_FRAME が来たら Pass Out (out[0]) へリレー
        onFrame(token, fromNodeId) {
          const conn = [...window.connections.values()]
            .find(c => c.toNodeId === nodeId && c.toPinIdx === 1 && c.fromNodeId === fromNodeId);
          if (!conn) return;
          window.notifyFrame(nodeId, 0, token);
        },
      });
    },

    createPanel(nodeId, cont) {
      const state = window._overrideState[nodeId];

      cont.innerHTML = `
        <div class="perf-section">
          <div class="perf-section-title">ステータス</div>
          <div class="stats-row">
            <span class="stats-lbl">Replay</span>
            <span class="badge badge-inactive" id="pov-replay-${nodeId}">未接続</span>
          </div>
          <div class="stats-row">
            <span class="stats-lbl">Pass In</span>
            <span class="badge badge-inactive" id="pov-passin-${nodeId}">未接続</span>
          </div>
          <div class="stats-row">
            <span class="stats-lbl">Pass 型</span>
            <span class="stats-val" id="pov-type-${nodeId}">--</span>
          </div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">説明</div>
          <p style="color:var(--text2);font-size:11px;line-height:1.5;">
            Replay ピンにリプレイデータを入力。<br>
            Pass In に任意の型を接続すると Pass Out がその型に変化し、
            下流ノードへそのまま中継します。
          </p>
        </div>
      `;

      const timer = setInterval(() => {
        if (!state) return;
        const replayConn  = [...window.connections.values()]
          .find(c => c.toNodeId === nodeId && c.toPinIdx === 0);
        const passInConn  = [...window.connections.values()]
          .find(c => c.toNodeId === nodeId && c.toPinIdx === 1);

        const relEl  = document.getElementById(`pov-replay-${nodeId}`);
        const pinEl  = document.getElementById(`pov-passin-${nodeId}`);
        const typEl  = document.getElementById(`pov-type-${nodeId}`);

        if (relEl) {
          relEl.textContent = replayConn  ? '接続済み' : '未接続';
          relEl.className   = 'badge ' + (replayConn  ? 'badge-active' : 'badge-inactive');
        }
        if (pinEl) {
          pinEl.textContent = passInConn  ? '接続済み' : '未接続';
          pinEl.className   = 'badge ' + (passInConn  ? 'badge-active' : 'badge-inactive');
        }
        if (typEl) typEl.textContent = state.passType || '--';
      }, 300);
      cont._cleanupTimer = timer;
    },

    getMetrics(nodeId) {
      const state      = window._overrideState[nodeId];
      const replayConn = [...window.connections.values()]
        .find(c => c.toNodeId === nodeId && c.toPinIdx === 0);
      const active = !!replayConn;
      return {
        dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
        statusCls:   active ? 'badge-active' : 'badge-inactive',
        statusLabel: active ? '接続済み' : '未接続',
        stats: [{ lbl: 'Pass型', val: state ? (state.passType || '--') : '--' }],
      };
    },

    unmount(nodeId) {
      delete window._overrideState[nodeId];
      window.unregisterNodeHandlers(nodeId);
    },
  };
})();
