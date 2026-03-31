// Countdown node plugin
(function () {
  // ── Private state ──────────────────────────────────────────────────────────
  // nodeId → { seconds, running, remaining, secondStartTime, canvas, ctx, stream, intervalId, drawTimerId }
  window._cdState = window._cdState || {};

  // ── Canvas drawing ─────────────────────────────────────────────────────────
  function cdDraw(nodeId) {
    const st = window._cdState[nodeId];
    if (!st) return;
    const { ctx, canvas, running, remaining } = st;
    const w = canvas.width, h = canvas.height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (running && remaining > 0) {
      const cx = w / 2, cy = h / 2;
      const r  = Math.round(Math.min(w, h) * 0.38);
      const lw = Math.round(Math.min(w, h) * 0.072);

      // Sub-second progress within current second
      const elapsed  = st.secondStartTime ? (Date.now() - st.secondStartTime) / 1000 : 0;
      const progress = Math.min(1, Math.max(0, elapsed));

      // Background ring
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth   = lw;
      ctx.stroke();

      // Progress arc:
      //   odd  remaining (5, 3, 1) → drain CW (消えていく: 満タンから時計回りに消える)
      //   even remaining (4, 2)    → fill CW  (出現していく: 空から時計回りに出現)
      const isDrain = remaining % 2 === 1;
      const base    = -Math.PI / 2; // 12時の位置

      ctx.beginPath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = lw;
      ctx.lineCap     = 'butt';

      if (isDrain) {
        // 時計回りに消える: 始点が時計回りに移動し残り弧が縮む
        const arcStart = base + progress * 2 * Math.PI;
        const arcEnd   = base + 2 * Math.PI;
        if (arcEnd - arcStart > 0.02) {
          ctx.arc(cx, cy, r, arcStart, arcEnd);
          ctx.stroke();
        }
      } else {
        // 時計回りに出現: 終点が時計回りに伸びる
        const arcEnd = base + progress * 2 * Math.PI;
        if (arcEnd - base > 0.02) {
          ctx.arc(cx, cy, r, base, arcEnd);
          ctx.stroke();
        }
      }

      // Number
      ctx.fillStyle    = '#ffffff';
      ctx.font         = `bold ${Math.round(h * 0.40)}px sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(remaining), cx, cy);
    } else if (!running) {
      // Standby
      ctx.fillStyle    = '#444';
      ctx.font         = `${Math.round(h * 0.09)}px sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('STANDBY', w / 2, h / 2);
    }
    // running && remaining === 0: 黒画面のみ（0は表示しない）
  }

  // ── Button / display sync ──────────────────────────────────────────────────
  function cdUpdateNode(nodeId) {
    const st  = window._cdState[nodeId];
    const btn = document.getElementById(`cd-btn-${nodeId}`);
    const num = document.getElementById(`cd-num-${nodeId}`);
    if (!st) return;
    if (btn) {
      btn.textContent = st.running ? 'Stop' : 'Start';
      btn.className   = st.running ? 'btn-secondary' : 'btn-primary';
    }
    if (num) {
      num.textContent = (st.running && st.remaining > 0) ? String(st.remaining) : '\u00a0';
    }
  }

  // ── Toggle (Start / Stop) ──────────────────────────────────────────────────
  window._cdToggle = function (nodeId) {
    const st = window._cdState[nodeId];
    if (!st) return;

    if (st.running) {
      // ── Stop ──
      clearInterval(st.intervalId);
      st.intervalId = null;
      st.running    = false;
      st.remaining  = 0;
      cdUpdateNode(nodeId);
      return;
    }

    // ── Start ──
    st.running         = true;
    st.remaining       = st.seconds;
    st.secondStartTime = Date.now();
    cdUpdateNode(nodeId);

    st.intervalId = setInterval(() => {
      st.remaining--;
      st.secondStartTime = Date.now(); // 1秒ごとに円弧の基準時刻を更新
      cdUpdateNode(nodeId);

      if (st.remaining <= 0) {
        // Fire trigger at pin index 1 (trigger pin)
        window.fireTrigger(nodeId, 1);

        clearInterval(st.intervalId);
        st.intervalId = null;

        // 1 秒後にスタンバイへ戻る（0は表示しない）
        setTimeout(() => {
          if (!window._cdState[nodeId]) return;
          st.running         = false;
          st.remaining       = 0;
          st.secondStartTime = 0;
          cdUpdateNode(nodeId);
        }, 1000);
      }
    }, 1000);
  };

  // ── Plugin registration ────────────────────────────────────────────────────
  window.NodePlugins['countdown'] = {
    label:       'Countdown',
    icon:        '⏳',
    menuGroup:   'ユーティリティ',
    menuSection: null,
    nodeClass:   'node-card node-video',
    pins: {
      out: [
        { type: window.PIN_TYPES.VIDEO,   label: '映像'     },
        { type: window.PIN_TYPES.TRIGGER, label: 'トリガー' },
      ],
      in: [{ label: '開始', accepts: window.PIN_TYPES.TRIGGER }],
    },

    create(pos) {
      const nodeId = window.generateNodeId();
      const name   = window.nextUniqueName('countdown', 'Countdown');
      window.createPluginNode('countdown', nodeId, pos);
      const nameEl = document.getElementById(`ename-${nodeId}`);
      if (nameEl) nameEl.value = name;
      return nodeId;
    },

    mount(nodeId, nodeEl) {
      // Offscreen canvas → MediaStream
      const canvas = document.createElement('canvas');
      canvas.width  = 640;
      canvas.height = 360;
      const ctx    = canvas.getContext('2d');
      const stream = canvas.captureStream(30);

      const state = {
        seconds:         5,
        running:         false,
        remaining:       0,
        secondStartTime: 0,
        canvas,
        ctx,
        stream,
        intervalId:      null,
        drawTimerId:     null,
      };
      window._cdState[nodeId] = state;
      window.nodeStreams.set(nodeId, stream);

      // Keep stream alive at ~30 fps
      state.drawTimerId = setInterval(() => cdDraw(nodeId), 1000 / 30);
      cdDraw(nodeId);

      nodeEl.innerHTML = `
        <div class="node-header node-video" id="nheader-${nodeId}">
          <span class="node-state-dot" id="ndot-${nodeId}"></span>
          <input class="node-name" id="ename-${nodeId}" value="Countdown" />
          <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
        </div>
        <div class="node-body">
          <div style="display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px;">
            <div style="text-align:center;padding:4px 0;">
              <button class="btn-primary" id="cd-btn-${nodeId}"
                      onclick="window._cdToggle('${nodeId}')"
                      onmousedown="event.stopPropagation()"
                      style="transform:scale(2);transform-origin:center;margin:16px 0 10px;">Start</button>
              <div id="cd-num-${nodeId}"
                   style="font-size:28px;font-weight:bold;color:var(--text1);min-height:36px;line-height:36px;margin-top:8px;">&nbsp;</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end;">
              <div class="pin-row pin-out pin-type-trigger" data-type="trigger"
                   style="margin:0;justify-content:flex-end;">
                <span class="pin-label">トリガー</span>
                <span class="pin-dot"></span>
              </div>
              <div class="pin-row pin-out pin-type-video" data-type="video"
                   style="margin:0;justify-content:flex-end;">
                <span class="pin-label">映像</span>
                <span class="pin-dot"></span>
              </div>
            </div>
          </div>
        </div>
      `;

      // Allow trigger input pin to start the countdown
      window.registerNodeHandlers(nodeId, {
        onTrigger(_from, to) {
          if (to !== nodeId) return;
          window._cdToggle(nodeId);
        },
      });
    },

    createPanel(nodeId, cont) {
      const state = window._cdState[nodeId];

      cont.innerHTML = `
        <div class="perf-section">
          <div class="perf-section-title">ステータス</div>
          <div class="stats-row">
            <span class="stats-lbl">状態</span>
            <span class="badge badge-inactive" id="pcd-badge-${nodeId}">待機中</span>
          </div>
          <div class="stats-row">
            <span class="stats-lbl">残り</span>
            <span class="stats-val" id="pcd-rem-${nodeId}">--</span>
          </div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">設定</div>
          <div class="form-row">
            <label>秒数</label>
            <input type="number" id="pcd-sec-${nodeId}" min="1" max="999"
                   value="${state ? state.seconds : 5}"
                   style="width:80px;" />
          </div>
        </div>
        <div class="perf-section">
          <div class="perf-section-title">プレビュー</div>
          <canvas id="pcd-preview-${nodeId}"
                  style="width:100%;border-radius:6px;background:#000;display:block;"></canvas>
        </div>
      `;

      // Wire seconds input
      const secInput = document.getElementById(`pcd-sec-${nodeId}`);
      if (secInput && state) {
        secInput.addEventListener('change', () => {
          const v = parseInt(secInput.value, 10);
          if (v > 0) state.seconds = v;
        });
      }

      // Live preview: blit from offscreen canvas
      if (state) {
        const preview = document.getElementById(`pcd-preview-${nodeId}`);
        if (preview) {
          preview.width  = state.canvas.width;
          preview.height = state.canvas.height;
          const pctx = preview.getContext('2d');
          const previewTimer = setInterval(() => {
            if (!document.getElementById(`pcd-preview-${nodeId}`)) {
              clearInterval(previewTimer);
              return;
            }
            pctx.drawImage(state.canvas, 0, 0);
          }, 1000 / 30);
          cont._cleanupPreview = previewTimer;
        }
      }

      // Status update loop
      const timer = setInterval(() => {
        if (!state) return;
        const badge = document.getElementById(`pcd-badge-${nodeId}`);
        const rem   = document.getElementById(`pcd-rem-${nodeId}`);
        if (badge) {
          badge.textContent = state.running ? 'カウント中' : '待機中';
          badge.className   = 'badge ' + (state.running ? 'badge-active' : 'badge-inactive');
        }
        if (rem) rem.textContent = state.running ? `${Math.max(0, state.remaining)} s` : '--';
      }, 200);
      cont._cleanupTimer = timer;
    },

    getMetrics(nodeId) {
      const state   = window._cdState[nodeId];
      const running = !!(state && state.running && state.remaining > 0);
      const standby = !running; // Startボタン表示中
      return {
        dotCls:      running ? 'node-state-dot state-orange' : 'node-state-dot state-active',
        statusCls:   running ? 'badge-orange' : 'badge-active',
        statusLabel: running ? `${Math.max(0, state.remaining)} s` : '待機中',
        stats: [{ lbl: '秒数', val: state ? String(state.seconds) : '--' }],
      };
    },

    unmount(nodeId) {
      const state = window._cdState[nodeId];
      if (state) {
        if (state.intervalId)  clearInterval(state.intervalId);
        if (state.drawTimerId) clearInterval(state.drawTimerId);
        delete window._cdState[nodeId];
      }
      window.nodeStreams.delete(nodeId);
      window.unregisterNodeHandlers(nodeId);
    },
  };
})();

