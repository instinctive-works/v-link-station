// Screen Capture node plugin
// In Electron: uses desktopCapturer (via IPC) + getUserMedia with chromeMediaSource
// In browser:  falls back to getDisplayMedia
window.NodePlugins['screen-capture'] = {
  label:       'スクリーンキャプチャ',
  icon:        '🖥️',
  menuGroup:   '映像',
  menuSection: '入力',
  nodeClass:   'node-card node-video',
  pins: {
    out: [
      { type: window.PIN_TYPES.WASM_FRAME, label: '映像' }, // index 0
    ],
    in:  [],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    const name   = window.nextUniqueName('screen-capture', 'ScreenCapture');
    window.createPluginNode('screen-capture', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = name;
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = { stream: null, fps: '--', resolution: '--', fitMode: 'letterbox', outRes: 'source' };
    window._screenState = window._screenState || {};
    window._screenState[nodeId] = state;

    const isElectron = !!(window.electronAPI && window.electronAPI.getSources);

    nodeEl.innerHTML = `
      <div class="node-header node-video" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="ScreenCapture" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-top:8px;">
          ${isElectron ? `
          <div class="form-row" style="margin:0;flex:1;padding-right:8px;">
            <label>キャプチャソース</label>
            <select id="sc-source-${nodeId}"></select>
          </div>` : '<div style="flex:1;"></div>'}
          <div class="pin-row pin-out pin-type-wasm-frame" data-type="${window.PIN_TYPES.WASM_FRAME}" style="margin:0;">
            <span class="pin-label">映像</span>
            <span class="pin-dot"></span>
          </div>
        </div>
        <div style="margin-top:8px;">
          <button class="btn-primary" id="sc-btn-${nodeId}">開始</button>
        </div>
      </div>
    `;

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
        <div class="perf-section-title">出力設定</div>
        <div class="form-row">
          <label>フィットモード</label>
          <select id="psc-fit-${nodeId}"
            onchange="window._screenSetFit('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()">
            <option value="letterbox" ${!state || state.fitMode === 'letterbox' ? 'selected' : ''}>レターボックス</option>
            <option value="crop" ${state && state.fitMode === 'crop' ? 'selected' : ''}>クロップ (中天)</option>
            <option value="stretch" ${state && state.fitMode === 'stretch' ? 'selected' : ''}>ストレッチ</option>
          </select>
        </div>
        <div class="form-row">
          <label>出力解像度</label>
          <select id="psc-outres-${nodeId}"
            onchange="window._screenSetRes('${nodeId}', this.value)"
            onmousedown="event.stopPropagation()">
            <option value="source" ${!state || state.outRes === 'source' ? 'selected' : ''}>ソースのまま</option>
            <option value="1920x1080" ${state && state.outRes === '1920x1080' ? 'selected' : ''}>1920×1080</option>
            <option value="1280x720" ${state && state.outRes === '1280x720' ? 'selected' : ''}>1280×720</option>
          </select>
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

  getSettings(nodeId) {
    const state = window._screenState && window._screenState[nodeId];
    return { fitMode: state ? state.fitMode : 'letterbox', outRes: state ? state.outRes : 'source' };
  },

  applySettings(nodeId, s) {
    const state = window._screenState && window._screenState[nodeId];
    if (!state) return;
    if (s.fitMode) state.fitMode = s.fitMode;
    if (s.outRes)  state.outRes  = s.outRes;
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
    const btn = document.getElementById(`sc-btn-${nodeId}`);
    if (btn) { btn.textContent = '開始'; btn.className = 'btn-primary'; }
    const dot = document.getElementById(`ndot-${nodeId}`);
    if (dot) dot.className = 'node-state-dot';
    const panelVidStop = document.getElementById(`psc-video-${nodeId}`);
    if (panelVidStop) panelVidStop.srcObject = null;
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

    const btn = document.getElementById(`sc-btn-${nodeId}`);
    if (btn) { btn.textContent = '停止'; btn.className = 'btn-danger'; }
    const dot = document.getElementById(`ndot-${nodeId}`);
    if (dot) dot.className = 'node-state-dot state-active';
    const panelVid = document.getElementById(`psc-video-${nodeId}`);
    if (panelVid) panelVid.srcObject = stream;

    // Resolution
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    state.resolution = `${settings.width || '--'}×${settings.height || '--'}`;

    // Stop when user ends share via browser/OS UI
    track.addEventListener('ended', () => window._screenToggle(nodeId));

    // FPS + WASM frame output via requestVideoFrameCallback
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

      count++;
      const elapsed = now - last;
      if (elapsed >= 1000) {
        state.fps = (count / (elapsed / 1000)).toFixed(1);
        count = 0;
        last = now;
      }

      if (window.VLinkWasm) {
        const tr   = state.stream.getVideoTracks()[0];
        const s    = tr ? tr.getSettings() : {};
        const srcW = s.width  || 1280;
        const srcH = s.height || 720;
        const [outW, outH] = state.outRes === '1920x1080' ? [1920, 1080]
                           : state.outRes === '1280x720'  ? [1280, 720]
                           : [srcW, srcH];
        if (oc.width !== outW || oc.height !== outH) { oc.width = outW; oc.height = outH; }
        octx.fillStyle = '#000';
        octx.fillRect(0, 0, outW, outH);
        if (state.fitMode === 'stretch') {
          octx.drawImage(vid, 0, 0, outW, outH);
        } else if (state.fitMode === 'crop') {
          const scale = Math.max(outW / srcW, outH / srcH);
          const sw = outW / scale, sh = outH / scale;
          octx.drawImage(vid, (srcW - sw) / 2, (srcH - sh) / 2, sw, sh, 0, 0, outW, outH);
        } else { // letterbox
          const scale = Math.min(outW / srcW, outH / srcH);
          const dw = srcW * scale, dh = srcH * scale;
          octx.drawImage(vid, 0, 0, srcW, srcH, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
        }
        const imgData = octx.getImageData(0, 0, outW, outH);
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
    console.error('Screen capture error:', err);
  }
};

window._screenSetFit = (nodeId, val) => {
  const st = window._screenState && window._screenState[nodeId];
  if (st) st.fitMode = val;
};

window._screenSetRes = (nodeId, val) => {
  const st = window._screenState && window._screenState[nodeId];
  if (st) st.outRes = val;
};
