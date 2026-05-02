// LiveLink Face — browser-side blendshape bar chart renderer

window.LiveLinkFaceRenderer = {
  drawBlendshapes(canvas, blendshapes) {
    if (!canvas || !blendshapes) return;

    const keys = Object.keys(blendshapes);
    if (keys.length === 0) return;

    const BAR_H   = 14;
    const GAP     = 2;
    const ROW     = BAR_H + GAP;
    const LABEL_W = 140;
    const VAL_W   = 36;
    const W       = canvas.offsetWidth || 276;
    const H       = keys.length * ROW + GAP;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width  = W + 'px';
      canvas.style.height = H + 'px';
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const BAR_W = W - LABEL_W - VAL_W - 4;
    ctx.font = '11px monospace';
    ctx.textBaseline = 'middle';

    keys.forEach((key, i) => {
      const raw = blendshapes[key];
      const val = isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      const y   = GAP + i * ROW;
      const cy  = y + BAR_H / 2;

      // Bar background
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(LABEL_W, y, BAR_W, BAR_H);

      // Bar fill
      const r = Math.floor(val * 90 + 58);
      const g = Math.floor(130 - val * 60);
      ctx.fillStyle = `rgb(${r},${g},246)`;
      ctx.fillRect(LABEL_W, y, Math.floor(BAR_W * val), BAR_H);

      // Label
      ctx.fillStyle = '#9090b0';
      ctx.fillText(key, 2, cy);

      // Numeric value
      ctx.fillStyle = '#c0c0d8';
      ctx.textAlign = 'right';
      ctx.fillText(raw != null && isFinite(raw) ? raw.toFixed(2) : '--', W - 2, cy);
      ctx.textAlign = 'left';
    });
  },
};
