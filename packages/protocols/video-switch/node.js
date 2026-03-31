// VideoSwitch node plugin
// Two WASM_FRAME inputs (A / B).
// Manual mode: button toggles which input is passed downstream.
// Auto mode:   outputs A while A frames are arriving; falls back to B when A is stale (>300 ms gap).
window.NodePlugins['video-switch'] = {
  label:       'スイッチング',
  icon:        '🔀',
  menuGroup:   '映像',
  menuSection: 'ユーティリティ',
  menuOrder:   1,
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
    const state = {
      active:        'a',    // manual mode active input
      srcA:          null,
      srcB:          null,
      autoMode:      true,
      aAlive:        false,  // true while A frames are arriving
      aAliveTimer:   null,
      _updateCard:   null,
      _lastBImgData: null,   // cached last B frame for immediate display on switch
    };
    window._vSwitchState = window._vSwitchState || {};
    window._vSwitchState[nodeId] = state;

    // ── Node card DOM update ───────────────────────────────────────────────
    function updateNodeCard() {
      const arrA = document.getElementById(`vsarr-a-${nodeId}`);
      const arrB = document.getElementById(`vsarr-b-${nodeId}`);
      const btn  = document.getElementById(`vs-toggle-${nodeId}`);

      if (state.autoMode) {
        if (arrA) arrA.style.opacity = state.aAlive  ? '1' : '0';
        if (arrB) arrB.style.opacity = !state.aAlive ? '1' : '0';
        if (btn)  { btn.disabled = true;  btn.style.opacity = '0.4'; }
      } else {
        if (arrA) arrA.style.opacity = state.active === 'a' ? '1' : '0';
        if (arrB) arrB.style.opacity = state.active === 'b' ? '1' : '0';
        if (btn)  { btn.disabled = false; btn.style.opacity = ''; }
      }
    }
    state._updateCard = updateNodeCard;

    // ── Node card HTML ─────────────────────────────────────────────────────
    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="VideoSwitch" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;">映像A<span id="vsarr-a-${nodeId}" style="margin-left:3px;opacity:0;">▶</span></span>
            </div>
            <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
              <span class="pin-dot"></span>
              <span class="pin-label" style="margin-left:6px;">映像B<span id="vsarr-b-${nodeId}" style="margin-left:3px;opacity:0;">▶</span></span>
            </div>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
            <button class="btn-primary" id="vs-toggle-${nodeId}"
              onclick="window._vSwitchToggle('${nodeId}')"
              onmousedown="event.stopPropagation()"
              style="width:52px;height:52px;font-size:13px;" disabled>切替</button>
          </div>
          <div style="flex-shrink:0;">
            <div class="pin-row pin-out pin-type-wasm-frame" data-type="${window.PIN_TYPES.WASM_FRAME}" style="margin:0;">
              <span class="pin-label">映像</span>
              <span class="pin-dot"></span>
            </div>
          </div>
        </div>
      </div>
    `;

    // Apply initial card state (opacity etc.)
    updateNodeCard();

    // ── Connection / frame handlers ────────────────────────────────────────
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
        if (state.srcA === fromNodeId) {
          state.srcA = null;
          if (state.aAliveTimer) { clearTimeout(state.aAliveTimer); state.aAliveTimer = null; }
          if (state.aAlive) { state.aAlive = false; updateNodeCard(); }
        }
        if (state.srcB === fromNodeId) state.srcB = null;
      },
      onFrame(token, fromNodeId) {
        // Helper: draw current frame to preview canvas (if panel is open)
        function drawPreview(t) {
          if (!window.VLinkWasm || !state._previewCanvas || !state._previewCanvas.isConnected) return;
          const ctx = state._previewCanvas.getContext('2d');
          if (!ctx) return;
          const { ptr, width, height } = t;
          const size = width * height * 4;
          state._previewCanvas.width  = width;
          state._previewCanvas.height = height;
          const raw = new Uint8ClampedArray(window.VLinkWasm.memory.buffer, ptr, size);
          ctx.putImageData(new ImageData(raw.slice(), width, height), 0, 0);
        }

        if (state.autoMode) {
          if (fromNodeId === state.srcA) {
            if (state.aAliveTimer) clearTimeout(state.aAliveTimer);
            const wasAlive = state.aAlive;
            state.aAlive = true;
            if (!wasAlive) updateNodeCard();
            state.aAliveTimer = setTimeout(() => {
              state.aAlive = false;
              updateNodeCard();
              // Immediately show the last cached B frame if the panel is open
              if (state._lastBImgData && state._previewCanvas && state._previewCanvas.isConnected) {
                const ctx = state._previewCanvas.getContext('2d');
                if (ctx) {
                  state._previewCanvas.width  = state._lastBImgData.width;
                  state._previewCanvas.height = state._lastBImgData.height;
                  ctx.putImageData(state._lastBImgData, 0, 0);
                }
              }
            }, 100);
            drawPreview(token);
            window.notifyFrame(nodeId, 0, token);
          } else if (fromNodeId === state.srcB) {
            // Always cache the latest B frame so we can show it immediately when A dies
            if (window.VLinkWasm) {
              const { ptr, width, height } = token;
              const size = width * height * 4;
              const raw = new Uint8ClampedArray(window.VLinkWasm.memory.buffer, ptr, size);
              state._lastBImgData = new ImageData(raw.slice(), width, height);
            }
            if (!state.aAlive) {
              drawPreview(token);
              window.notifyFrame(nodeId, 0, token);
            }
          }
        } else {
          if (state.active === 'a' && fromNodeId === state.srcA) {
            drawPreview(token);
            window.notifyFrame(nodeId, 0, token);
          } else if (state.active === 'b' && fromNodeId === state.srcB) {
            drawPreview(token);
            window.notifyFrame(nodeId, 0, token);
          }
        }
      },
    });
  },

  createPanel(nodeId, cont) {
    const state = window._vSwitchState && window._vSwitchState[nodeId];
    cont.innerHTML = `
      <div class="perf-section"></div>
      <div class="perf-section">
        <div class="perf-section-title">モード</div>
        <div class="stats-row" style="align-items:center;">
          <input type="checkbox" id="pvs-auto-${nodeId}"
            ${state && state.autoMode ? 'checked' : ''}
            style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;" />
          <span style="color:var(--text);margin-left:8px;cursor:pointer;"
            onclick="document.getElementById('pvs-auto-${nodeId}').click()">オートモード</span>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px;">
          A 入力あり → A出力 / なし → B出力
        </div>
      </div>
      <div class="perf-section" id="pvs-manual-section-${nodeId}"
           style="${state && state.autoMode ? 'opacity:0.4;pointer-events:none;' : ''}">
        <div class="perf-section-title">手動操作</div>
        <button class="btn-primary" style="width:100%"
          onclick="window._vSwitchToggle('${nodeId}')"
          onmousedown="event.stopPropagation()">A / B 切り替え</button>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <canvas id="pvs-preview-${nodeId}"
          style="width:100%;border-radius:6px;background:#000;display:block;"></canvas>
      </div>
    `;

    // Set preview canvas reference
    if (state) {
      state._previewCanvas = document.getElementById(`pvs-preview-${nodeId}`);
    }

    // Auto mode checkbox
    const chk = document.getElementById(`pvs-auto-${nodeId}`);
    if (chk && state) {
      chk.addEventListener('change', () => {
        state.autoMode = chk.checked;
        if (!state.autoMode) {
          if (state.aAliveTimer) { clearTimeout(state.aAliveTimer); state.aAliveTimer = null; }
          state.aAlive = false;
        }
        if (state._updateCard) state._updateCard();
        const manSec = document.getElementById(`pvs-manual-section-${nodeId}`);
        if (manSec) manSec.style.cssText = state.autoMode ? 'opacity:0.4;pointer-events:none;' : '';
      });
    }
  },

  getMetrics(nodeId) {
    const state = window._vSwitchState && window._vSwitchState[nodeId];
    const connected = !!(state && (state.srcA || state.srcB));
    let statusLabel;
    if (!connected)          statusLabel = '未接続';
    else if (state.autoMode) statusLabel = state.aAlive ? 'AUTO:A' : 'AUTO:B';
    else                     statusLabel = `手動:${state.active.toUpperCase()}`;
    return {
      dotCls:      connected ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   connected ? 'badge-active' : 'badge-inactive',
      statusLabel,
      stats: [
        { lbl: '映像A', val: state && state.srcA ? '接続済' : '未接続' },
        { lbl: '映像B', val: state && state.srcB ? '接続済' : '未接続' },
      ],
    };
  },

  unmount(nodeId) {
    const state = window._vSwitchState && window._vSwitchState[nodeId];
    if (state) {
      if (state.aAliveTimer) clearTimeout(state.aAliveTimer);
      state._previewCanvas = null;
    }
    window.unregisterNodeHandlers(nodeId);
    if (window._vSwitchState) delete window._vSwitchState[nodeId];
  },
};

window._vSwitchToggle = (nodeId) => {
  const state = window._vSwitchState && window._vSwitchState[nodeId];
  if (!state || state.autoMode) return;
  state.active = state.active === 'a' ? 'b' : 'a';
  const arrA = document.getElementById(`vsarr-a-${nodeId}`);
  const arrB = document.getElementById(`vsarr-b-${nodeId}`);
  if (arrA) arrA.style.opacity = state.active === 'a' ? '1' : '0';
  if (arrB) arrB.style.opacity = state.active === 'b' ? '1' : '0';
};
