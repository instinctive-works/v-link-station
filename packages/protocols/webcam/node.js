// Webcam node plugin
window.NodePlugins['webcam'] = {
  label:       'Webカメラ',
  icon:        '📷',
  menuGroup:   '映像',
  menuSection: '入力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [
      { type: window.PIN_TYPES.WASM_FRAME, label: '映像' }, // index 0
    ],
    in: [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('webcam', 'Webcam');
    window.createPluginNode('webcam', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { stream: null, fps: '--', resolution: '--', devices: [], fitMode: 'letterbox', outRes: 'source', _previewCanvas: null };
    window._webcamState = window._webcamState || {};
    window._webcamState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="Webcam" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-top:8px;">
          <div class="form-row" style="margin:0;flex:1;padding-right:8px;">
            <label>カメラ</label>
            <select id="wc-device-${nodeId}"></select>
          </div>
          <div class="pin-row pin-out pin-type-wasm-frame" data-type="${window.PIN_TYPES.WASM_FRAME}" style="margin:0;">
            <span class="pin-label">映像</span>
            <span class="pin-dot"></span>
          </div>
        </div>
        <div style="margin-top:8px;">
          <button class="btn-primary" id="wc-btn-${nodeId}" onclick="window._webcamToggle('${nodeId}')">開始</button>
        </div>
      </div>
    `;

    // Enumerate cameras
    navigator.mediaDevices.enumerateDevices().then(devs => {
      const sel = document.getElementById(`wc-device-${nodeId}`);
      if (!sel) return;
      sel.innerHTML = '';
      const cams = devs.filter(d => d.kind === 'videoinput');
      cams.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${d.deviceId.slice(0, 8)}`;
        sel.appendChild(opt);
      });
    });
  },

  createPanel(nodeId, cont) {
    const state = window._webcamState && window._webcamState[nodeId];

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge" id="pwc-badge-${nodeId}">待機</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">解像度</span>
          <span class="stats-val" id="pwc-res-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">FPS</span>
          <span class="stats-val" id="pwc-fps-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">フレームモード</span>
          <span class="stats-val" id="pwc-wasm-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">出力設定</div>
        <div class="form-row">
          <label>フィットモード</label>
          <select id="pwc-fit-${nodeId}"
            onchange="window._webcamSetFit('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()">
            <option value="letterbox" ${!state || state.fitMode === 'letterbox' ? 'selected' : ''}>レターボックス</option>
            <option value="crop" ${state && state.fitMode === 'crop' ? 'selected' : ''}>クロップ (中天)</option>
          </select>
        </div>
        <div class="form-row">
          <label>出力解像度</label>
          <select id="pwc-outres-${nodeId}"
            onchange="window._webcamSetRes('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()">
            <option value="source" ${!state || state.outRes === 'source' ? 'selected' : ''}>ソースのまま</option>
            <option value="1920x1080" ${state && state.outRes === '1920x1080' ? 'selected' : ''}>1920×1080</option>
            <option value="1280x720" ${state && state.outRes === '1280x720' ? 'selected' : ''}>1280×720</option>
          </select>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <canvas id="pwc-canvas-${nodeId}"
          style="width:100%;border-radius:6px;background:#000;display:block;"></canvas>
      </div>
    `;

    if (state) {
      state._previewCanvas = document.getElementById(`pwc-canvas-${nodeId}`);
    }

    const timer = setInterval(() => {
      if (!state) return;
      const badge  = document.getElementById(`pwc-badge-${nodeId}`);
      const resEl  = document.getElementById(`pwc-res-${nodeId}`);
      const fpsEl  = document.getElementById(`pwc-fps-${nodeId}`);
      const wasmEl = document.getElementById(`pwc-wasm-${nodeId}`);
      if (badge) {
        badge.textContent = state.stream ? 'キャプチャ中' : '待機';
        badge.className   = 'badge ' + (state.stream ? 'badge-active' : 'badge-inactive');
      }
      if (resEl)  resEl.textContent  = state.resolution;
      if (fpsEl)  fpsEl.textContent  = state.fps;
      if (wasmEl) wasmEl.textContent = window.VLinkWasm ? '有効' : '無効';
    }, 500);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state  = window._webcamState && window._webcamState[nodeId];
    const active = !!(state && state.stream);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? 'キャプチャ中' : '待機',
      stats: [
        { lbl: '解像度', val: state ? state.resolution : '--' },
        { lbl: 'FPS',   val: state ? String(state.fps) : '--' },
      ],
    };
  },

  unmount(nodeId) {
    const state = window._webcamState && window._webcamState[nodeId];
    if (state && state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
    }
    if (window._webcamState) delete window._webcamState[nodeId];
  },
};

window._webcamToggle = async (nodeId) => {
  const state = window._webcamState && window._webcamState[nodeId];
  if (!state) return;

  if (state.stream) {
    // Stop
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    const btn = document.getElementById(`wc-btn-${nodeId}`);
    if (btn) { btn.textContent = '開始'; btn.className = 'btn-primary'; }
    const dot = document.getElementById(`ndot-${nodeId}`);
    if (dot) dot.className = 'node-state-dot';
    const panelVidStop = document.getElementById(`pwc-video-${nodeId}`);
    if (panelVidStop) panelVidStop.srcObject = null;
    return;
  }

  // Start
  const sel = document.getElementById(`wc-device-${nodeId}`);
  const deviceId = sel ? sel.value : undefined;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    });
    state.stream = stream;

    const btn = document.getElementById(`wc-btn-${nodeId}`);
    if (btn) { btn.textContent = '停止'; btn.className = 'btn-danger'; }
    const dot = document.getElementById(`ndot-${nodeId}`);
    if (dot) dot.className = 'node-state-dot state-active';
    const panelVid = document.getElementById(`pwc-video-${nodeId}`);
    if (panelVid) panelVid.srcObject = stream;

    // Resolution from track settings
    const track    = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    state.resolution = `${settings.width || '--'}×${settings.height || '--'}`;

    // Single rVFC loop: FPS measurement + WASM frame capture
    const vid = document.createElement('video');
    vid.srcObject = stream;
    vid.muted = true;
    vid.play();
    state._vid = vid;

    const oc   = new OffscreenCanvas(1, 1);
    const octx = oc.getContext('2d');
    let last = performance.now(), count = 0, seq = 0;

    function onFrame(now) {
      if (!state.stream) return;

      // FPS measurement
      count++;
      const elapsed = now - last;
      if (elapsed >= 1000) {
        state.fps = (count / (elapsed / 1000)).toFixed(1);
        count = 0;
        last = now;
      }

      // WASM frame capture (only when VLinkWasm is ready)
      if (window.VLinkWasm) {
        const s    = track.getSettings();
        const srcW = s.width  || 1280;
        const srcH = s.height || 720;
        const [outW, outH] = state.outRes === '1920x1080' ? [1920, 1080]
                           : state.outRes === '1280x720'  ? [1280, 720]
                           : [srcW, Math.round(srcW * 9 / 16)];
        if (oc.width !== outW || oc.height !== outH) { oc.width = outW; oc.height = outH; }
        octx.fillStyle = '#000';
        octx.fillRect(0, 0, outW, outH);
        if (state.fitMode === 'crop') {
          const scale = Math.max(outW / srcW, outH / srcH);
          const sw = outW / scale, sh = outH / scale;
          octx.drawImage(vid, (srcW - sw) / 2, (srcH - sh) / 2, sw, sh, 0, 0, outW, outH);
        } else { // letterbox
          const scale = Math.min(outW / srcW, outH / srcH);
          const dw = srcW * scale, dh = srcH * scale;
          octx.drawImage(vid, 0, 0, srcW, srcH, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
        }
        const imgData = octx.getImageData(0, 0, outW, outH);

        // Panel preview
        if (state._previewCanvas && state._previewCanvas.isConnected) {
          if (state._previewCanvas.width !== outW || state._previewCanvas.height !== outH) {
            state._previewCanvas.width  = outW;
            state._previewCanvas.height = outH;
          }
          state._previewCanvas.getContext('2d').putImageData(imgData, 0, 0);
        }

        const size = outW * outH * 4;
        const ptr  = window.VLinkWasm.alloc_frame(size);
        if (ptr) {
          new Uint8Array(window.VLinkWasm.memory.buffer, ptr, size).set(imgData.data);
          window.notifyFrame(nodeId, 0, { ptr, width: outW, height: outH, stride: outW * 4, seq });
          window.VLinkWasm.free_frame(ptr, size);
          seq++;
        }
      }

      vid.requestVideoFrameCallback(onFrame);
    }

    if (vid.requestVideoFrameCallback) {
      vid.requestVideoFrameCallback(onFrame);
    }
  } catch (err) {
    console.error('Webcam error:', err);
  }
};

window._webcamSetFit = (nodeId, val) => {
  const st = window._webcamState && window._webcamState[nodeId];
  if (st) st.fitMode = val;
};

window._webcamSetRes = (nodeId, val) => {
  const st = window._webcamState && window._webcamState[nodeId];
  if (st) st.outRes = val;
};