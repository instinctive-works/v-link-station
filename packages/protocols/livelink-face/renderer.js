// LiveLink Face — browser-side data renderer / visualizer
// Draws a simple blendshape bar chart on a canvas element.

window.LiveLinkFaceRenderer = {
  // Draw blendshape bars onto a <canvas>
  drawBlendshapes(canvas, blendshapes) {
    if (!canvas || !blendshapes) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const keys = Object.keys(blendshapes);
    if (keys.length === 0) return;

    const barH = Math.max(2, Math.floor(h / keys.length) - 1);
    const labelW = 130;

    ctx.font = `${Math.min(barH - 1, 10)}px monospace`;
    ctx.textBaseline = 'middle';

    keys.forEach((key, i) => {
      const val = Math.max(0, Math.min(1, blendshapes[key]));
      const y = i * (barH + 1);
      const barW = Math.floor((w - labelW) * val);

      // Bar background
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(labelW, y, w - labelW, barH);

      // Bar fill — colour by value
      const r = Math.floor(val * 90 + 58);
      const g = Math.floor(130 - val * 60);
      const b = Math.floor(246);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(labelW, y, barW, barH);

      // Label
      ctx.fillStyle = '#9090b0';
      ctx.fillText(key, 2, y + barH / 2);
    });
  },
};
