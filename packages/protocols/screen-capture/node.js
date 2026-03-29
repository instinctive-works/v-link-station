// Screen Capture node plugin
// In Electron: uses desktopCapturer (via IPC) + getUserMedia with chromeMediaSource
// In browser:  falls back to getDisplayMedia
window.NodePlugins['screen-capture'] = {
  label:       'スクリーンキャプチャ',
  icon:        '🖥️',
  menuSection: '映像入力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [{ type: 'video', label: '映像' }],
    in:  [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('screen-capture', 'Screen Capture');
    window.createPluginNode('screen-capture', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { stream: null, fps: '--', resolution: '--' };
    window._screenState = window._screenState || {};
    window._screenState[nodeId] = state;

    const isElectron = !!(window.electronAPI && window.electronAPI.getSources);

    // Build source-select row HTML only for Electron
    const sourceSelectHtml = isElectron ? `
        <div class="form-row" style="margin-top:8px">
          <label>キャプチャソース</label>
          <select id="sc-source-${nodeId}"></select>
        </div>` : '';

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="Screen Capture" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        ${sourceSelectHtml}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <button class="btn-primary" id="sc-btn-${nodeId}">開始</button>
          <div class="pin-row pin-out pin-type-video" data-type="video" style="margin:0;">
            <span class="pin-label">映像</span>
            <span class="pin-dot"></span>
          </div>
        </div>
      </div>
    `;

    // Attach events after innerHTML is set
    const btn = document.getElementById(`sc-btn-${nodeId}`);
    if (btn) btn.addEventListener('click', () => window._screenToggle(nodeId));

    if (isElectron) {
      window._screenRefreshSources(nodeId);
    }
  },

  createPanel(nodeId, cont) {
    const state = window._screenState && window._screenState[nodeId];

    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge" id="psc-badge-${nodeId}">停止</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">解像度</span>
          <span class="stats-val" id="psc-res-${nodeId}">--</span>
        </div>
        <div class="stats-row">
          <span class="stats-lbl">FPS</span>
          <span class="stats-val" id="psc-fps-${nodeId}">--</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">プレビュー</div>
        <video id="psc-video-${nodeId}" autoplay muted playsinline
          style="width:100%;border-radius:6px;background:#000;display:block;"></video>
      </div>
    `;

    if (state && state.stream) {
      const vid = document.getElementById(`psc-video-${nodeId}`);
      if (vid) vid.srcObject = state.stream;
    }

    const timer = setInterval(() => {
      if (!state) return;
      const badge = document.getElementById(`psc-badge-${nodeId}`);
      const resEl = document.getElementById(`psc-res-${nodeId}`);
      const fpsEl = document.getElementById(`psc-fps-${nodeId}`);
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
    const state = window._screenState && window._screenState[nodeId];
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
    const state = window._screenState && window._screenState[nodeId];
    if (state && state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
    }
    window.nodeStreams.delete(nodeId);
    if (window._screenState) delete window._screenState[nodeId];
  },
};

// Refresh the source dropdown list (Electron only)
window._screenRefreshSources = async (nodeId) => {
  if (!window.electronAPI || !window.electronAPI.getSources) return;
  const sel = document.getElementById(`sc-source-${nodeId}`);
  if (!sel) return;
  try {
    const sources = await window.electronAPI.getSources({ types: ['screen'] });
    const prev = sel.value;
    sel.innerHTML = '';
    for (const src of sources) {
      const opt = document.createElement('option');
      opt.value = src.id;
      opt.textContent = src.name;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
    } else if (sel.options.length > 0) {
      sel.value = sel.options[0].value;
    }
  } catch (err) {
    console.error('getSources error:', err);
  }
};

window._screenToggle = async (nodeId) => {
  const state = window._screenState && window._screenState[nodeId];
  if (!state) return;

  // ── Stop ─────────────────────────────────────────────────────────────────
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    window.nodeStreams.delete(nodeId);
    const btn = document.getElementById(`sc-btn-${nodeId}`);
    if (btn) { btn.textContent = '開始'; btn.className = 'btn-primary'; }
    const dot = document.getElementById(`ndot-${nodeId}`);
    if (dot) dot.className = 'node-state-dot';
    return;
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  try {
    let stream;
    const isElectron = !!(window.electronAPI && window.electronAPI.getSources);

    if (isElectron) {
      const sel = document.getElementById(`sc-source-${nodeId}`);
      const sourceId = sel ? sel.value : '';
      if (!sourceId) {
        alert('キャプチャソースを選択してください。');
        return;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: 60,
          },
        },
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: false,
      });
    }

    state.stream = stream;
    window.nodeStreams.set(nodeId, stream);

    const btn = document.getElementById(`sc-btn-${nodeId}`);
    if (btn) { btn.textContent = '停止'; btn.className = 'btn-danger'; }
    const dot = document.getElementById(`ndot-${nodeId}`);
    if (dot) dot.className = 'node-state-dot state-active';

    // Resolution
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    state.resolution = `${settings.width || '--'}×${settings.height || '--'}`;
    const resEl = document.getElementById(`sc-res-${nodeId}`);
    if (resEl) resEl.textContent = state.resolution;

    // Stop when user ends share via browser/OS UI (browser path only)
    track.addEventListener('ended', () => window._screenToggle(nodeId));

    // FPS via requestVideoFrameCallback
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
        }
        if (state.stream) vid.requestVideoFrameCallback(tick);
      };
      vid.requestVideoFrameCallback(tick);
    }
  } catch (err) {
    console.error('Screen capture error:', err);
  }
};
