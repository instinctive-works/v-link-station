// Webcam node plugin
window.NodePlugins['webcam'] = {
  label:       'Webcam',
  icon:        '📷',
  menuSection: '映像入力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [{ type: 'video', label: '映像' }],
    in:  [],
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
        <div class="form-row" style="margin-top:8px">
          <label>カメラ</label>
          <select id="wc-device-${nodeId}"></select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <button class="btn-primary" id="wc-btn-${nodeId}" onclick="window._webcamToggle('${nodeId}')">開始</button>
          <div class="pin-row pin-out pin-type-video" data-type="video" style="margin:0;">
            <span class="pin-label">映像</span>
            <span class="pin-dot"></span>
          </div>
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
          <span class="badge" id="pwc-badge-${nodeId}">停止</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">解像度</span>
          <span class="stats-val" id="pwc-res-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">FPS</span>
          <span class="stats-val" id="pwc-fps-${nodeId}">--</span>
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
      const badge = document.getElementById(`pwc-badge-${nodeId}`);
      const resEl = document.getElementById(`pwc-res-${nodeId}`);
      const fpsEl = document.getElementById(`pwc-fps-${nodeId}`);
      if (badge) {
        badge.textContent = state.stream ? 'キャプチャ中' : '停止';
        badge.className   = 'badge ' + (state.stream ? 'badge-active' : 'badge-inactive');
      }
      if (resEl) resEl.textContent = state.resolution;
      if (fpsEl) fpsEl.textContent = state.fps;
    }, 500);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state = window._webcamState && window._webcamState[nodeId];
    const active = !!(state && state.stream);
    return {
      dotCls:      active ? 'node-state-dot state-active' : 'node-state-dot',
      statusCls:   active ? 'badge-active' : 'badge-inactive',
      statusLabel: active ? 'キャプチャ中' : '停止',
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

    // Measure FPS & resolution
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    state.resolution = `${settings.width || '--'}×${settings.height || '--'}`;
    const resEl = document.getElementById(`wc-res-${nodeId}`);
    if (resEl) resEl.textContent = state.resolution;

    // FPS via requestVideoFrameCallback if available
    const vid = document.createElement('video');
    vid.srcObject = stream;
    vid.muted = true;
    vid.play();

    if (vid.requestVideoFrameCallback) {
      let last = performance.now(), count = 0;
      const tick = () => {
        count++;
        const now = performance.now();
        if (now - last >= 1000) {
          state.fps = (count / ((now - last) / 1000)).toFixed(1);
          count = 0; last = now;
          const fpsEl = document.getElementById(`wc-fps-${nodeId}`);
          if (fpsEl) fpsEl.textContent = state.fps;
        }
        if (state.stream) vid.requestVideoFrameCallback(tick);
      };
      vid.requestVideoFrameCallback(tick);
    }
  } catch (err) {
    console.error('Webcam error:', err);
  }
};
