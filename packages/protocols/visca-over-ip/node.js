// VISCA over IP node plugin
// Sends PTZ/Zoom control commands to cameras via UDP (default port 52381)
(function () {
  const DEFAULT_HOST = '192.168.1.100';
  const DEFAULT_PORT = 52381;

  // VISCA over IP シーケンスリセット（制御コマンド、通常のVISCAパケットとは別フォーマット）
  const SEQ_RESET_PACKET = [0x02, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01];

  // nodeId → { host, port, panSpeed, tiltSpeed, seqNum, connected, errorHandler }
  window._viscaState = window._viscaState || {};

  // Build VISCA over IP packet (8-byte header + VISCA command)
  function buildPacket(viscaCmd, seqNum) {
    const len = viscaCmd.length;
    return [
      0x01, 0x00,                      // Payload Type: VISCA Command
      (len >> 8) & 0xFF, len & 0xFF,   // Payload Length
      (seqNum >> 24) & 0xFF,
      (seqNum >> 16) & 0xFF,
      (seqNum >> 8)  & 0xFF,
      seqNum & 0xFF,                   // Sequence Number
      ...viscaCmd,
    ];
  }

  function toHex(data) {
    return data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  function renderLogs(nodeId, logEl) {
    const st = window._viscaState[nodeId];
    if (!st || !st.logs || st.logs.length === 0) {
      logEl.innerHTML = '<span style="color:#555;font-size:10px;">ログなし</span>';
      return;
    }
    logEl.innerHTML = st.logs.map(l =>
      `<div style="margin-bottom:3px;line-height:1.4;">` +
      `<span style="color:#555;">${l.time}</span> ` +
      `<span style="color:${l.type === 'tx' ? '#60a5fa' : '#4ade80'};">${l.type === 'tx' ? '→ TX' : '← RX'}</span> ` +
      `<span style="color:#ccc;word-break:break-all;">${window.escHtml(l.hex)}</span>` +
      `</div>`
    ).join('');
  }

  function addLog(nodeId, type, data) {
    const st = window._viscaState[nodeId];
    if (!st) return;
    if (!st.logs) st.logs = [];
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    st.logs.unshift({ time, type, hex: toHex(data) });
    if (st.logs.length > 100) st.logs.length = 100;
    const logEl = document.getElementById(`pvisca-log-${nodeId}`);
    if (logEl) renderLogs(nodeId, logEl);
  }

  function sendVISCA(nodeId, viscaCmd) {
    const st = window._viscaState[nodeId];
    if (!st) return;
    st.seqNum = (st.seqNum + 1) & 0xFFFFFFFF;
    const packet = buildPacket(viscaCmd, st.seqNum);
    window.socket.emit('visca:send', {
      nodeId,
      host:    st.host,
      port:    st.port,
      command: packet,
    });
    addLog(nodeId, 'tx', packet);
    const statusEl = document.getElementById(`visca-status-${nodeId}`);
    if (statusEl) statusEl.textContent = '';
  }

  function makePTCmd(nodeId, panDir, tiltDir) {
    const st = window._viscaState[nodeId];
    const pSpd = st ? Math.max(1, Math.min(18, st.panSpeed))  : 12;
    const tSpd = st ? Math.max(1, Math.min(14, st.tiltSpeed)) : 10;
    return [0x81, 0x01, 0x06, 0x01, pSpd, tSpd, panDir, tiltDir, 0xFF];
  }

  // 接続状態を更新し、関連UIを同期する
  function setConnected(nodeId, connected) {
    const st = window._viscaState[nodeId];
    if (!st) return;
    st.connected = connected;

    // ドット色
    const dotEl = document.getElementById(`ndot-${nodeId}`);
    if (dotEl) dotEl.className = connected ? 'node-state-dot state-active' : 'node-state-dot';

    // ノードカード内の接続状態テキスト
    const connEl = document.getElementById(`visca-conn-${nodeId}`);
    if (connEl) {
      connEl.textContent = connected ? '' : '未接続 — 右ペインで接続設定';
    }

    // ノードカード内のPTZ/Zoomボタン有効/無効
    const bodyEl = document.getElementById(`visca-body-${nodeId}`);
    if (bodyEl) {
      bodyEl.querySelectorAll('button').forEach(btn => { btn.disabled = !connected; });
    }

    // 右ペインの接続ボタン表示切替
    const connBtnEl = document.getElementById(`pvisca-conn-${nodeId}`);
    if (connBtnEl) {
      connBtnEl.textContent = connected ? '切断' : '接続';
    }

    // 右ペインの電源ボタン有効/無効
    ['pvisca-pwron', 'pvisca-pwroff'].forEach(pfx => {
      const el = document.getElementById(`${pfx}-${nodeId}`);
      if (el) el.disabled = !connected;
    });
  }

  function connectCamera(nodeId) {
    const st = window._viscaState[nodeId];
    if (!st) return;
    st.seqNum = 0;
    // 1. シーケンスリセット（VISCAoverIPヘッダー制御コマンド）
    window.socket.emit('visca:send', { nodeId, host: st.host, port: st.port, command: SEQ_RESET_PACKET });
    setConnected(nodeId, true);
    const statusEl = document.getElementById(`visca-status-${nodeId}`);
    if (statusEl) statusEl.textContent = '';
    // 2. IF_Clear カメラ1（81 01 00 01 FF）
    sendVISCA(nodeId, CMDS.ifClear);
    // 3. ホーム位置へ移動
    sendVISCA(nodeId, CMDS.home);
  }

  function disconnectCamera(nodeId) {
    setConnected(nodeId, false);
  }

  // panDir: 0x01=Left, 0x02=Right, 0x03=Stop
  // tiltDir: 0x01=Up, 0x02=Down, 0x03=Stop
  const CMDS = {
    ifClear:  [0x81, 0x01, 0x00, 0x01, 0xFF],      // IF_Clear カメラ1
    zoomIn:   [0x81, 0x01, 0x04, 0x07, 0x02, 0xFF],
    zoomOut:  [0x81, 0x01, 0x04, 0x07, 0x03, 0xFF],
    zoomStop: [0x81, 0x01, 0x04, 0x07, 0x00, 0xFF],
    home:     [0x81, 0x01, 0x06, 0x04, 0xFF],
    afAuto:   [0x81, 0x01, 0x04, 0x38, 0x02, 0xFF],
    powerOn:  [0x81, 0x01, 0x04, 0x00, 0x02, 0xFF],
    powerOff: [0x81, 0x01, 0x04, 0x00, 0x03, 0xFF],
  };

  window.NodePlugins['visca-over-ip'] = {
    label:       'VISCA over IP',
    icon:        '🎥',
    menuGroup:   '制御',
    menuSection: '周辺機器',
    nodeClass:   'node-card',
    pins: { out: [], in: [] },

    create(pos) {
      const nodeId = window.generateNodeId();
      const name   = window.nextUniqueName('visca-over-ip', 'VISCA Camera');
      window.createPluginNode('visca-over-ip', nodeId, pos);
      const nameEl = document.getElementById(`ename-${nodeId}`);
      if (nameEl) nameEl.value = name;
      return nodeId;
    },

    mount(nodeId, nodeEl) {
      window._viscaState[nodeId] = {
        host:      DEFAULT_HOST,
        port:      DEFAULT_PORT,
        panSpeed:  12,
        tiltSpeed: 10,
        seqNum:    0,
        connected: false,
        errorHandler: null,
      };

      nodeEl.innerHTML = `
        <div class="node-header" id="nheader-${nodeId}">
          <span class="node-state-dot" id="ndot-${nodeId}"></span>
          <input class="node-name" id="ename-${nodeId}" value="VISCA Camera" />
          <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
        </div>
        <div class="node-body" id="visca-body-${nodeId}">
          <div style="margin-bottom:6px;font-size:11px;color:#888;text-align:center;"
            id="visca-conn-${nodeId}">未接続 — 右ペインで接続設定</div>
          <div style="text-align:center;">
            <div style="display:inline-grid;grid-template-columns:repeat(3,36px);grid-template-rows:repeat(3,36px);gap:4px;">
              <div></div>
              <button class="btn-secondary" id="visca-up-${nodeId}" disabled
                style="width:36px;height:36px;padding:0;font-size:15px;" title="Tilt Up">▲</button>
              <div></div>
              <button class="btn-secondary" id="visca-left-${nodeId}" disabled
                style="width:36px;height:36px;padding:0;font-size:15px;" title="Pan Left">◀</button>
              <button class="btn-secondary" id="visca-home-${nodeId}" disabled
                style="width:36px;height:36px;padding:0;font-size:14px;" title="Home">⌂</button>
              <button class="btn-secondary" id="visca-right-${nodeId}" disabled
                style="width:36px;height:36px;padding:0;font-size:15px;" title="Pan Right">▶</button>
              <div></div>
              <button class="btn-secondary" id="visca-down-${nodeId}" disabled
                style="width:36px;height:36px;padding:0;font-size:15px;" title="Tilt Down">▼</button>
              <div></div>
            </div>
          </div>
          <div style="margin-top:8px;display:flex;gap:6px;justify-content:center;">
            <button class="btn-secondary" id="visca-zoomin-${nodeId}" disabled
              style="min-width:44px;font-size:12px;" title="Zoom Tele">Z＋</button>
            <button class="btn-secondary" id="visca-zoomout-${nodeId}" disabled
              style="min-width:44px;font-size:12px;" title="Zoom Wide">Z－</button>
            <button class="btn-secondary" id="visca-af-${nodeId}" disabled
              style="min-width:44px;font-size:12px;" title="Auto Focus">AF</button>
          </div>
          <div style="margin-top:6px;font-size:11px;color:#e87;text-align:center;min-height:14px;"
            id="visca-status-${nodeId}"></div>
        </div>
      `;

      // Pan/Tilt buttons — hold to move, release to stop
      const ptMap = [
        { id: `visca-up-${nodeId}`,    pd: 0x03, td: 0x01 }, // Tilt Up
        { id: `visca-down-${nodeId}`,  pd: 0x03, td: 0x02 }, // Tilt Down
        { id: `visca-left-${nodeId}`,  pd: 0x01, td: 0x03 }, // Pan Left
        { id: `visca-right-${nodeId}`, pd: 0x02, td: 0x03 }, // Pan Right
      ];
      for (const { id, pd, td } of ptMap) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('mousedown',  () => sendVISCA(nodeId, makePTCmd(nodeId, pd, td)));
        el.addEventListener('mouseup',    () => sendVISCA(nodeId, makePTCmd(nodeId, 0x03, 0x03)));
        el.addEventListener('mouseleave', () => sendVISCA(nodeId, makePTCmd(nodeId, 0x03, 0x03)));
      }

      // Home
      document.getElementById(`visca-home-${nodeId}`).addEventListener('click', () => {
        sendVISCA(nodeId, CMDS.home);
      });

      // Zoom — hold to zoom, release to stop
      const zInEl  = document.getElementById(`visca-zoomin-${nodeId}`);
      const zOutEl = document.getElementById(`visca-zoomout-${nodeId}`);
      zInEl.addEventListener('mousedown',  () => sendVISCA(nodeId, CMDS.zoomIn));
      zInEl.addEventListener('mouseup',    () => sendVISCA(nodeId, CMDS.zoomStop));
      zInEl.addEventListener('mouseleave', () => sendVISCA(nodeId, CMDS.zoomStop));
      zOutEl.addEventListener('mousedown',  () => sendVISCA(nodeId, CMDS.zoomOut));
      zOutEl.addEventListener('mouseup',    () => sendVISCA(nodeId, CMDS.zoomStop));
      zOutEl.addEventListener('mouseleave', () => sendVISCA(nodeId, CMDS.zoomStop));

      // Auto Focus
      document.getElementById(`visca-af-${nodeId}`).addEventListener('click', () => {
        sendVISCA(nodeId, CMDS.afAuto);
      });

      // Error handler (scoped per node)
      const errorHandler = ({ nodeId: eid, error }) => {
        if (eid !== nodeId) return;
        const el = document.getElementById(`visca-status-${nodeId}`);
        if (el) el.textContent = `エラー: ${window.escHtml(error)}`;
        setConnected(nodeId, false);
      };
      window._viscaState[nodeId].errorHandler = errorHandler;
      window.socket.on('visca:error', errorHandler);

      // Response handler (scoped per node)
      const responseHandler = ({ nodeId: eid, data }) => {
        if (eid !== nodeId) return;
        addLog(nodeId, 'rx', data);
      };
      window._viscaState[nodeId].responseHandler = responseHandler;
      window.socket.on('visca:response', responseHandler);
    },

    createPanel(nodeId, cont) {
      const st = window._viscaState[nodeId] || {};
      const connected = !!st.connected;
      cont.innerHTML = `
        <div class="perf-section">
          <div class="perf-section-title">ステータス</div>
          <div class="stats-row"><span class="stats-lbl">状態</span><span class="badge">---</span></div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">接続設定</div>
          <div style="margin-top:8px;">
            <label style="display:block;margin-bottom:3px;">IP アドレス</label>
            <input type="text" id="pvisca-host-${nodeId}"
              value="${window.escHtml(String(st.host || DEFAULT_HOST))}"
              placeholder="192.168.1.100" />
          </div>
          <div style="margin-top:6px;">
            <label style="display:block;margin-bottom:3px;">ポート</label>
            <input type="number" id="pvisca-port-${nodeId}"
              value="${st.port || DEFAULT_PORT}" min="1" max="65535" style="width:100px;" />
          </div>
          <div style="margin-top:8px;">
            <button id="pvisca-conn-${nodeId}" class="btn-primary" style="width:100%;">
              ${connected ? '切断' : '接続'}
            </button>
          </div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">電源</div>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button id="pvisca-pwron-${nodeId}"  class="btn-secondary" style="flex:1;"
              ${connected ? '' : 'disabled'}>電源 ON</button>
            <button id="pvisca-pwroff-${nodeId}" class="btn-secondary" style="flex:1;"
              ${connected ? '' : 'disabled'}>電源 OFF</button>
          </div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">スピード設定</div>
          <div class="form-row" style="margin-top:4px;">
            <label>パン速度 (1–18)</label>
            <input type="number" id="pvisca-pspd-${nodeId}" value="${st.panSpeed || 12}"
              min="1" max="18" style="width:60px;" />
          </div>
          <div class="form-row">
            <label>チルト速度 (1–14)</label>
            <input type="number" id="pvisca-tspd-${nodeId}" value="${st.tiltSpeed || 10}"
              min="1" max="14" style="width:60px;" />
          </div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">操作メモ</div>
          <div style="font-size:11px;color:#888;line-height:1.6;">
            PTZ ボタン：長押しで動作、離すと停止<br>
            Z＋／Z－：長押しでズーム、離すと停止<br>
            AF：オートフォーカス実行<br>
            ⌂：ホームポジションへ移動
          </div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title" style="display:flex;justify-content:space-between;align-items:center;">
            <span>通信ログ</span>
            <button id="pvisca-log-clear-${nodeId}" style="font-size:10px;padding:1px 6px;background:#333;border:1px solid #555;border-radius:3px;color:#aaa;cursor:pointer;">クリア</button>
          </div>
          <div id="pvisca-log-${nodeId}"
            style="margin-top:6px;max-height:180px;overflow-y:auto;font-family:monospace;font-size:10px;background:#0d0d0d;border:1px solid #333;border-radius:4px;padding:6px;"></div>
        </div>
      `;

      // IP 変更 → 切断
      document.getElementById(`pvisca-host-${nodeId}`).addEventListener('change', e => {
        if (window._viscaState[nodeId]) {
          window._viscaState[nodeId].host = e.target.value.trim();
          setConnected(nodeId, false);
        }
      });

      // ポート変更 → 切断
      document.getElementById(`pvisca-port-${nodeId}`).addEventListener('change', e => {
        const p = parseInt(e.target.value, 10);
        if (window._viscaState[nodeId]) {
          window._viscaState[nodeId].port = (p > 0 && p < 65536) ? p : DEFAULT_PORT;
          setConnected(nodeId, false);
        }
      });

      // 接続 / 切断ボタン
      document.getElementById(`pvisca-conn-${nodeId}`).addEventListener('click', () => {
        const s = window._viscaState[nodeId];
        if (!s) return;
        if (s.connected) {
          disconnectCamera(nodeId);
        } else {
          // IPをパネル入力欄から反映してから接続
          const hostEl = document.getElementById(`pvisca-host-${nodeId}`);
          const portEl = document.getElementById(`pvisca-port-${nodeId}`);
          if (hostEl) s.host = hostEl.value.trim();
          if (portEl) {
            const p = parseInt(portEl.value, 10);
            s.port = (p > 0 && p < 65536) ? p : DEFAULT_PORT;
          }
          connectCamera(nodeId);
        }
      });

      // 電源 ON / OFF
      document.getElementById(`pvisca-pwron-${nodeId}`).addEventListener('click',  () => sendVISCA(nodeId, CMDS.powerOn));
      document.getElementById(`pvisca-pwroff-${nodeId}`).addEventListener('click', () => sendVISCA(nodeId, CMDS.powerOff));

      // スピード設定
      const pSpdEl = document.getElementById(`pvisca-pspd-${nodeId}`);
      const tSpdEl = document.getElementById(`pvisca-tspd-${nodeId}`);
      if (pSpdEl) {
        pSpdEl.addEventListener('change', e => {
          const v = parseInt(e.target.value, 10);
          if (window._viscaState[nodeId]) window._viscaState[nodeId].panSpeed = Math.max(1, Math.min(18, v));
        });
      }
      if (tSpdEl) {
        tSpdEl.addEventListener('change', e => {
          const v = parseInt(e.target.value, 10);
          if (window._viscaState[nodeId]) window._viscaState[nodeId].tiltSpeed = Math.max(1, Math.min(14, v));
        });
      }

      // ログ初期描画
      const logEl = document.getElementById(`pvisca-log-${nodeId}`);
      if (logEl) renderLogs(nodeId, logEl);

      // クリアボタン
      const logClearEl = document.getElementById(`pvisca-log-clear-${nodeId}`);
      if (logClearEl) {
        logClearEl.addEventListener('click', () => {
          const s = window._viscaState[nodeId];
          if (s) s.logs = [];
          if (logEl) renderLogs(nodeId, logEl);
        });
      }
    },

    getMetrics(nodeId) {
      const st = window._viscaState[nodeId];
      const connected = st && st.connected;
      return {
        dotCls:      connected ? 'node-state-dot state-active' : 'node-state-dot',
        statusCls:   connected ? 'badge-active' : '',
        statusLabel: connected ? '接続中' : '',
        stats: [],
      };
    },

    getSettings(nodeId) {
      const st = window._viscaState[nodeId];
      if (!st) return null;
      return { host: st.host, port: st.port, panSpeed: st.panSpeed, tiltSpeed: st.tiltSpeed };
    },

    applySettings(nodeId, settings) {
      const st = window._viscaState[nodeId];
      if (!st || !settings) return;
      if (settings.host      != null) st.host      = settings.host;
      if (settings.port      != null) st.port      = settings.port;
      if (settings.panSpeed  != null) st.panSpeed  = settings.panSpeed;
      if (settings.tiltSpeed != null) st.tiltSpeed = settings.tiltSpeed;
    },

    unmount(nodeId) {
      const st = window._viscaState[nodeId];
      if (st && st.errorHandler) {
        window.socket.off('visca:error', st.errorHandler);
      }
      if (st && st.responseHandler) {
        window.socket.off('visca:response', st.responseHandler);
      }
      delete window._viscaState[nodeId];
    },
  };
})();
