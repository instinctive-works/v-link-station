// Webcam node plugin
window.NodePlugins['webcam'] = {
  label:       'Webcam',
  icon:        '📷',
  menuGroup:   '映像',
  menuSection: '入力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [
      { type: window.PIN_TYPES.WASM_FRAME, label: 'フレーム' }, // index 0
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
    const state = { stream: null, fps: '--', resolution: '--', devices: [] };
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
            <span class="pin-label">フレーム</span>
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
        <div class="perf-section-title">プレビュー</div>
        <video id="pwc-video-${nodeId}" autoplay muted playsinline
          style="width:100%;border-radius:6px;background:#000;display:block;"></video>
      </div>
    `;

    if (state && state.stream) {
      const vid = document.getElementById(`pwc-video-${nodeId}`);
      if (vid) vid.srcObject = state.stream;
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
    window.nodeStreams.delete(nodeId);
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
    window.nodeStreams.delete(nodeId);
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
    window.nodeStreams.set(nodeId, stream);

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
        const s = track.getSettings();
        const w = s.width  || 1280;
        const h = s.height || 720;
        if (oc.width !== w || oc.height !== h) { oc.width = w; oc.height = h; }
        octx.drawImage(vid, 0, 0, w, h);
        const imgData = octx.getImageData(0, 0, w, h);
        const size = w * h * 4;
        const ptr  = window.VLinkWasm.alloc_frame(size);
        if (ptr) {
          new Uint8Array(window.VLinkWasm.memory.buffer, ptr, size).set(imgData.data);
          window.notifyFrame(nodeId, 1, { ptr, width: w, height: h, stride: w * 4, seq });
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