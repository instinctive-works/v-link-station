// VirtualCamera node plugin
// WASM_FRAME を JPEG エンコードして Electron IPC 経由で vcam-helper に送り、
// DirectShow 仮想カメラ ("V-Link Station Camera") として出力する。
window.NodePlugins['virtual-camera'] = {
  label:       '仮想カメラ',
  icon:        '📹',
  menuGroup:   '映像',
  menuSection: '出力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [],
    in: [
      { label: '映像', accepts: window.PIN_TYPES.WASM_FRAME },
    ],
  },

  create(pos) {
    if (window._vcamState && Object.keys(window._vcamState).length > 0) {
      alert('仮想カメラノードは1つしか作成できません。');
      return null;
    }
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('virtual-camera', 'VirtualCamera');
    window.createPluginNode('virtual-camera', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = {
      srcId:      null,
      resolution: '--',
      _srcCanvas: null,
      _canvas:    null,
      _lastEmit:  null,
      _encoding:  false,
      _ipcAvail:  !!(window.electronAPI && window.electronAPI.sendVcamFrame),
    };
    window._vcamState = window._vcamState || {};
    window._vcamState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="VirtualCamera" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div class="pin-row pin-in pin-type-wasm-frame" data-accepts="${window.PIN_TYPES.WASM_FRAME}">
          <span class="pin-dot"></span>
          <span class="pin-label" style="margin-left:6px;">映像</span>
        </div>
        <div class="stats-row" style="margin-top:6px;">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="vc-badge-${nodeId}">待機</span>
        </div>
      </div>
    `;

    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        const conn = [...window.connections.values()]
          .find(c => c.toNodeId === nodeId && c.fromNodeId === fromNodeId);
        if (!conn || conn.toPinIdx !== 0) return;
        const existing = [...window.connections.values()]
          .filter(c => c.toNodeId === nodeId && c.toPinIdx === 0 && c.fromNodeId !== fromNodeId);
        for (const c of existing) window.removeSingleConnection(c.fromNodeId, nodeId);
        state.srcId = fromNodeId;
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        if (state.srcId === fromNodeId) {
          state.srcId = null;
          state.resolution = '--';
        }
      },
      onFrame(token, fromNodeId) {
        if (fromNodeId !== state.srcId) return;
        if (!window.VLinkWasm) return;
        if (!state._ipcAvail) return;

        // 前フレームのエンコード中はスキップ（混入防止）
        if (state._encoding) return;

        // 30fps にスロットル
        const now = Date.now();
        if (state._lastEmit && now - state._lastEmit < 33) return;
        state._lastEmit = now;

        const { ptr, width, height } = token;
        const size = width * height * 4;
        const data = new Uint8ClampedArray(window.VLinkWasm.memory.buffer, ptr, size);
        const img  = new ImageData(data, width, height);

        // 入力フレームを中間 OffscreenCanvas に描画して即 ImageBitmap 化（不変スナップショット）
        const OUT_W = 1920, OUT_H = 1080;
        if (!state._srcOC) state._srcOC = new OffscreenCanvas(1, 1);
        const srcOC = state._srcOC;
        if (srcOC.width !== width || srcOC.height !== height) { srcOC.width = width; srcOC.height = height; }
        srcOC.getContext('2d').putImageData(img, 0, 0);
        const bmp = srcOC.transferToImageBitmap();  // 同期スナップショット

        // 出力 OffscreenCanvas に letterbox スケール
        if (!state._outOC) state._outOC = new OffscreenCanvas(OUT_W, OUT_H);
        const outOC = state._outOC;
        const ctx   = outOC.getContext('2d');
        const scale = Math.min(OUT_W / width, OUT_H / height);
        const dw = Math.round(width * scale), dh = Math.round(height * scale);
        const dx = Math.round((OUT_W - dw) / 2), dy = Math.round((OUT_H - dh) / 2);
        // bottom-up layout to match biHeight=+h in vcam_source.cpp
        ctx.save();
        ctx.translate(0, OUT_H);
        ctx.scale(1, -1);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, OUT_W, OUT_H);
        ctx.drawImage(bmp, 0, 0, width, height, dx, dy, dw, dh);
        ctx.restore();
        bmp.close();

        // エンコード中フラグを立ててから非同期 JPEG 化
        // Panel preview (non-flipped, top-down display)
        if (state._previewCanvas && state._previewCanvas.isConnected) {
          const pc = state._previewCanvas;
          if (pc.width !== OUT_W || pc.height !== OUT_H) { pc.width = OUT_W; pc.height = OUT_H; }
          const pctx = pc.getContext('2d');
          pctx.save();
          pctx.translate(0, OUT_H);
          pctx.scale(1, -1);
          pctx.drawImage(outOC, 0, 0);
          pctx.restore();
        }

        state._encoding = true;
        outOC.convertToBlob({ type: 'image/jpeg', quality: 0.85 }).then(blob => {
          return blob.arrayBuffer();
        }).then(jpeg => {
          window.electronAPI.sendVcamFrame(OUT_W, OUT_H, jpeg);
        }).finally(() => {
          state._encoding = false;
        });

        state.resolution = `${width}×${height} → ${OUT_W}×${OUT_H}`;
      },
    });

    const timer = setInterval(() => {
      const s = window._vcamState && window._vcamState[nodeId];
      if (!s) { clearInterval(timer); return; }
      const active = !!s.srcId && s._ipcAvail;
      const badge  = document.getElementById(`vc-badge-${nodeId}`);
      const dot    = document.getElementById(`ndot-${nodeId}`);
      if (badge) {
        badge.textContent = active ? '配信中' : (s._ipcAvail ? '待機' : 'デスクトップ版のみ');
        badge.className   = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
      }
      if (dot) dot.className = 'node-state-dot' + (active ? ' state-active' : '');
    }, 500);
  },

  createPanel(nodeId, cont) {
    const state = window._vcamState && window._vcamState[nodeId];

    const ipcNote = state && state._ipcAvail
      ? `<div style="font-size:11px;color:var(--text2);margin-top:4px;">
           Zoom / Teams 等のカメラ選択で<br>
           <strong>"V-Link Station Camera"</strong> を選んでください。
         </div>`
      : `<div style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.4);
           border-radius:6px;padding:8px;font-size:12px;margin-top:4px;">
           <span style="color:#f87171;font-weight:600;">デスクトップ版専用</span><br>
           <span style="color:var(--text2);">ブラウザでは使用できません。</span>
         </div>`;

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">仮想カメラ出力</div>
        <div class="stats-row" style="margin-top:4px;">
          <span class="stats-lbl">出力仕様</span>
          <span class="stats-val">1920×1080 / 30fps</span>
        </div>
        ${ipcNote}
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <canvas id="pvc-canvas-${nodeId}"
          style="width:100%;border-radius:6px;background:#000;display:block;"></canvas>
      </div>
    `;

    if (state) {
      state._previewCanvas = document.getElementById(`pvc-canvas-${nodeId}`);
    }
  },

  getMetrics(nodeId) {
    const state  = window._vcamState && window._vcamState[nodeId];
    const active = !!(state && state.srcId && state._ipcAvail);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? '配信中' : (state && !state._ipcAvail ? 'デスクトップ版のみ' : '待機'),
      stats: [
        { lbl: '解像度', val: state ? state.resolution : '--' },
      ],
    };
  },

  unmount(nodeId) {
    window.unregisterNodeHandlers(nodeId);
    if (window._vcamState) {
      const s = window._vcamState[nodeId];
      if (s) s._previewCanvas = null;
      delete window._vcamState[nodeId];
    }
  },
};

