// ── Global state ──────────────────────────────────────────────────────────────
window.NodePlugins   = {};          // pluginId → plugin descriptor
window.nodeStreams   = new Map();   // nodeId → MediaStream
window.nodeMetrics  = new Map();   // nodeId → metrics object
window.devices      = new Map();   // deviceId → device object
window.connections  = new Map();   // connId → { fromNodeId, fromPinIdx, toNodeId, toPinIdx, type }
window.pluginNodeCounters = {};    // pluginId → Set of existing names (for nextUniqueName)

// ── View transform (pan / zoom) ────────────────────────────────────────────────
let isPanning      = false;
let rightDragMoved = false;
let panStart       = { x: 0, y: 0, tx: 0, ty: 0 };

const viewTransform = { tx: 0, ty: 0, s: 1 };

function applyViewTransform() {
  const vp = document.getElementById('graph-viewport');
  if (vp) vp.style.transform =
    `translate(${viewTransform.tx}px,${viewTransform.ty}px) scale(${viewTransform.s})`;
}

/** Convert screen (clientX/Y) to graph-viewport local coordinates. */
function screenToCanvas(sx, sy) {
  const r = document.getElementById('canvas-area').getBoundingClientRect();
  return {
    x: (sx - r.left - viewTransform.tx) / viewTransform.s,
    y: (sy - r.top  - viewTransform.ty) / viewTransform.s,
  };
}

window.fitToView = () => {
  const nodes = [...document.querySelectorAll('#node-canvas .node-card')];
  const ca = document.getElementById('canvas-area').getBoundingClientRect();
  if (!nodes.length) {
    viewTransform.tx = 0; viewTransform.ty = 0; viewTransform.s = 1;
    applyViewTransform(); return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const l = n.offsetLeft, t = n.offsetTop;
    const rx = l + n.offsetWidth, b = t + n.offsetHeight;
    if (l < minX) minX = l; if (t < minY) minY = t;
    if (rx > maxX) maxX = rx; if (b > maxY) maxY = b;
  }
  const pad = 60;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const s = Math.min(1, Math.min(ca.width / (maxX - minX), ca.height / (maxY - minY)));
  viewTransform.s  = s;
  viewTransform.tx = (ca.width  - (maxX - minX) * s) / 2 - minX * s;
  viewTransform.ty = (ca.height - (maxY - minY) * s) / 2 - minY * s;
  applyViewTransform();
  redrawConnections();
};

window.zoomIn = () => {
  const ca = document.getElementById('canvas-area').getBoundingClientRect();
  const cx = ca.width / 2, cy = ca.height / 2;
  const ns = Math.min(3, viewTransform.s * 1.25);
  viewTransform.tx = cx - (cx - viewTransform.tx) * (ns / viewTransform.s);
  viewTransform.ty = cy - (cy - viewTransform.ty) * (ns / viewTransform.s);
  viewTransform.s  = ns;
  applyViewTransform(); redrawConnections();
};

window.zoomOut = () => {
  const ca = document.getElementById('canvas-area').getBoundingClientRect();
  const cx = ca.width / 2, cy = ca.height / 2;
  const ns = Math.max(0.15, viewTransform.s / 1.25);
  viewTransform.tx = cx - (cx - viewTransform.tx) * (ns / viewTransform.s);
  viewTransform.ty = cy - (cy - viewTransform.ty) * (ns / viewTransform.s);
  viewTransform.s  = ns;
  applyViewTransform(); redrawConnections();
};

// Active nodes: nodeId → { pluginId, el, pos }
const nodeRegistry = new Map();
// Connection event handlers: nodeId → { onConnected, onDisconnected }
const nodeHandlers  = new Map();

// ── Socket.IO ─────────────────────────────────────────────────────────────────
window.socket = io();

socket.on('connect',    () => setConnectionBadge(true));
socket.on('disconnect', () => setConnectionBadge(false));

socket.on('get-devices', (list) => {
  for (const dev of list) window.devices.set(dev.id, dev);
});
socket.on('device-update', (dev) => window.devices.set(dev.id, dev));
socket.on('device-remove', (id)  => window.devices.delete(id));

function setConnectionBadge(connected) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.textContent  = connected ? 'Connected' : 'Disconnected';
  el.className    = 'badge ' + (connected ? 'badge-active' : 'badge-inactive');
}

// ── Utility ───────────────────────────────────────────────────────────────────
window.escHtml = (s) =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

window.formatBytes = (n) => {
  if (n < 1024)       return n + ' B';
  if (n < 1048576)    return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
};

window.generateNodeId = () => 'n' + Math.random().toString(36).slice(2, 9);

// ── Unique name generation ────────────────────────────────────────────────────
window.nextUniqueName = (pluginId, baseName) => {
  // Collect existing names for this pluginId
  const existing = new Set();
  for (const [, info] of nodeRegistry) {
    if (info.pluginId !== pluginId) continue;
    const nameEl = info.el.querySelector('.node-name');
    if (nameEl) existing.add(nameEl.value);
  }
  if (!existing.has(baseName)) return baseName;
  for (let i = 2; i < 999; i++) {
    const candidate = `${baseName}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return baseName + '_' + Date.now();
};

// ── Node creation / removal ───────────────────────────────────────────────────
function setupPinTooltips(nodeEl) {
  nodeEl.querySelectorAll('.pin-row').forEach(row => {
    const dot = row.querySelector('.pin-dot');
    if (!dot) return;
    const type = row.dataset.type || row.dataset.accepts;
    if (type) dot.title = type;
  });
}

window.createPluginNode = (pluginId, nodeId, pos) => {
  const plugin = window.NodePlugins[pluginId];
  if (!plugin) return console.warn('Unknown plugin:', pluginId);

  const el = document.createElement('div');
  el.id = nodeId;
  el.className = 'node-card ' + (plugin.nodeClass || '');
  el.style.left = pos.x + 'px';
  el.style.top  = pos.y + 'px';

  document.getElementById('node-canvas').appendChild(el);
  nodeRegistry.set(nodeId, { pluginId, el, pos: { ...pos } });

  plugin.mount(nodeId, el);
  setupPinTooltips(el);
  makeDraggable(el, nodeId);
  el.addEventListener('mousedown', () => selectNode(nodeId));

  return el;
};

window.removePluginNode = (nodeId) => {
  const info = nodeRegistry.get(nodeId);
  if (!info) return;

  const plugin = window.NodePlugins[info.pluginId];
  if (plugin && plugin.unmount) plugin.unmount(nodeId);

  removeConnectionsForNode(nodeId);
  unregisterNodeHandlers(nodeId);

  info.el.remove();
  nodeRegistry.delete(nodeId);
  window.nodeStreams.delete(nodeId);
  window.nodeMetrics.delete(nodeId);

  if (selectedNodeId === nodeId) {
    selectedNodeId = null;
    showNodeList();
  }
};

// ── Selection ─────────────────────────────────────────────────────────────────
let selectedNodeId = null;

function selectNode(nodeId) {
  if (selectedNodeId) {
    const prev = document.getElementById(selectedNodeId);
    if (prev) prev.classList.remove('selected');
  }
  selectedNodeId = nodeId;
  const el = document.getElementById(nodeId);
  if (el) el.classList.add('selected');

  showNodePanel(nodeId);
}
window.selectNode = selectNode;

function showNodePanel(nodeId) {
  const info = nodeRegistry.get(nodeId);
  if (!info) return;
  const plugin = window.NodePlugins[info.pluginId];
  const titleEl   = document.getElementById('panel-title');
  const contentEl = document.getElementById('panel-content');
  const nameEl    = info.el.querySelector('.node-name');

  if (titleEl)   titleEl.textContent = nameEl ? nameEl.value : info.pluginId;
  if (contentEl) contentEl.innerHTML = '';

  if (plugin && plugin.createPanel) {
    plugin.createPanel(nodeId, contentEl);
  } else {
    showNodeList();
  }
}

function showNodeList() {
  const titleEl   = document.getElementById('panel-title');
  const contentEl = document.getElementById('panel-content');
  if (titleEl) titleEl.textContent = 'ノード一覧';
  if (!contentEl) return;

  if (!nodeRegistry.size) {
    contentEl.innerHTML = '<p class="panel-placeholder">ノードを追加するには右クリックしてください</p>';
    return;
  }

  // Build list: one row per node
  let html = '<div class="node-list">';
  for (const [nid, info] of nodeRegistry) {
    const plugin = window.NodePlugins[info.pluginId];
    const nameEl = info.el.querySelector('.node-name');
    const name   = nameEl ? window.escHtml(nameEl.value) : window.escHtml(info.pluginId);
    const icon   = plugin ? window.escHtml(plugin.icon || '◆') : '◆';

    let m = null;
    if (plugin && plugin.getMetrics) m = plugin.getMetrics(nid);

    const dotCls   = m ? m.dotCls   : 'node-state-dot';
    const badgeCls = m ? m.statusCls : 'badge-inactive';
    const label    = m ? window.escHtml(m.statusLabel) : '--';
    const fpsRow   = m && m.stats ? m.stats.find(s => s.lbl === 'FPS') : null;
    const fpsVal   = fpsRow ? window.escHtml(fpsRow.val) : '--';

    html += `
      <div class="node-list-item" onclick="window.selectNode('${window.escHtml(nid)}')">
        <div class="node-list-row">
          <span class="${dotCls}" style="flex-shrink:0"></span>
          <span class="node-list-icon">${icon}</span>
          <span class="node-list-name">${name}</span>
        </div>
        <div class="node-list-meta">
          <span class="badge ${badgeCls}">${label}</span>
          <span class="stats-val" style="font-size:10px">${fpsVal} fps</span>
        </div>
      </div>`;
  }
  html += '</div>';
  contentEl.innerHTML = html;
}

// ── Drag nodes ────────────────────────────────────────────────────────────────
function makeDraggable(el, nodeId) {
  let dragging = false;
  let ox = 0, oy = 0;

  // Use the entire card as drag handle so users can drag from any empty area,
  // not just the narrow header strip.
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Let interactive controls handle their own events
    if (e.target.closest('button, input, select, textarea')) return;
    if (e.target.classList.contains('pin-dot')) return;
    e.preventDefault();
    dragging = true;
    const lp = screenToCanvas(e.clientX, e.clientY);
    ox = lp.x - el.offsetLeft;
    oy = lp.y - el.offsetTop;
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const lp = screenToCanvas(e.clientX, e.clientY);
    el.style.left = (lp.x - ox) + 'px';
    el.style.top  = (lp.y - oy) + 'px';
    redrawConnections();
  });

  document.addEventListener('mouseup', () => { dragging = false; });
}

// ── Connection handlers ───────────────────────────────────────────────────────
window.registerNodeHandlers = (nodeId, handlers) => nodeHandlers.set(nodeId, handlers);
window.unregisterNodeHandlers = (nodeId) => nodeHandlers.delete(nodeId);

// ── Connection drawing ────────────────────────────────────────────────────────
// connId → SVGPathElement
const connPaths = new Map();

function getPinCenter(nodeId, pinType, pinIdx) {
  const el = document.getElementById(nodeId);
  if (!el) return null;
  const rows = el.querySelectorAll(`.pin-row.pin-${pinType}`);
  const row  = rows[pinIdx];
  if (!row) return null;
  const dot  = row.querySelector('.pin-dot');
  if (!dot) return null;
  const r = dot.getBoundingClientRect();
  return screenToCanvas(r.left + r.width / 2, r.top + r.height / 2);
}

function bezierPath(a, b) {
  const dx = Math.abs(b.x - a.x) * 0.5;
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function redrawConnections() {
  const svg = document.getElementById('conn-svg');
  for (const [connId, conn] of window.connections) {
    const from = getPinCenter(conn.fromNodeId, 'out', conn.fromPinIdx);
    const to   = getPinCenter(conn.toNodeId,   'in',  conn.toPinIdx);
    let path = connPaths.get(connId);
    if (!from || !to) {
      if (path) { path.remove(); connPaths.delete(connId); }
      continue;
    }
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('conn-path', `type-${conn.type || 'default'}`);
      // mousedown on a connection line: remove it and re-drag from the out-pin
      path.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const snap = { ...conn };
        window.connections.delete(connId);
        const p2 = connPaths.get(connId);
        if (p2) { p2.remove(); connPaths.delete(connId); }
        const toH = nodeHandlers.get(snap.toNodeId);
        if (toH && toH.onDisconnected) toH.onDisconnected(snap.fromNodeId, snap.toNodeId);
        const frH = nodeHandlers.get(snap.fromNodeId);
        if (frH && frH.onDisconnected) frH.onDisconnected(snap.fromNodeId, snap.toNodeId);
        const startPt = getPinCenter(snap.fromNodeId, 'out', snap.fromPinIdx);
        if (startPt) startDraftConnection(snap.fromNodeId, snap.fromPinIdx, snap.type || 'default', startPt);
      });
      svg.appendChild(path);
      connPaths.set(connId, path);
    }
    path.setAttribute('d', bezierPath(from, to));
  }
}

// ── Connection management ─────────────────────────────────────────────────────
let connIdCounter = 0;

function createConnection(fromNodeId, fromPinIdx, toNodeId, toPinIdx, type) {
  const connId = `c${++connIdCounter}`;
  window.connections.set(connId, { fromNodeId, fromPinIdx, toNodeId, toPinIdx, type });
  redrawConnections();

  const toHandler = nodeHandlers.get(toNodeId);
  if (toHandler && toHandler.onConnected) toHandler.onConnected(fromNodeId, toNodeId);
  const fromHandler = nodeHandlers.get(fromNodeId);
  if (fromHandler && fromHandler.onConnected) fromHandler.onConnected(fromNodeId, toNodeId);

  return connId;
}

window.removeSingleConnection = (fromId, toId) => {
  for (const [connId, conn] of window.connections) {
    if (conn.fromNodeId === fromId && conn.toNodeId === toId) {
      window.connections.delete(connId);
      const path = connPaths.get(connId);
      if (path) { path.remove(); connPaths.delete(connId); }

      const toHandler = nodeHandlers.get(toId);
      if (toHandler && toHandler.onDisconnected) toHandler.onDisconnected(fromId, toId);
      const fromHandler = nodeHandlers.get(fromId);
      if (fromHandler && fromHandler.onDisconnected) fromHandler.onDisconnected(fromId, toId);
      return;
    }
  }
};

window.removeConnectionsForNode = (nodeId) => {
  for (const [connId, conn] of window.connections) {
    if (conn.fromNodeId === nodeId || conn.toNodeId === nodeId) {
      window.connections.delete(connId);
      const path = connPaths.get(connId);
      if (path) { path.remove(); connPaths.delete(connId); }

      const otherId = conn.fromNodeId === nodeId ? conn.toNodeId : conn.fromNodeId;
      const handler = nodeHandlers.get(otherId);
      if (handler && handler.onDisconnected) handler.onDisconnected(conn.fromNodeId, conn.toNodeId);
    }
  }
};

// ── Pin drag-to-connect ───────────────────────────────────────────────────────
let draftState = null; // { fromNodeId, fromPinIdx, type, svgPath }

function startDraftConnection(fromNodeId, fromPinIdx, type, startPt) {
  const svg = document.getElementById('conn-svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.classList.add('conn-path-draft');
  svg.appendChild(path);
  draftState = { fromNodeId, fromPinIdx, type, svgPath: path, startPt };
}

document.addEventListener('mousemove', (e) => {
  if (!draftState) return;
  const end = screenToCanvas(e.clientX, e.clientY);
  if (draftState.reversed) {
    draftState.svgPath.setAttribute('d', bezierPath(end, draftState.startPt));
    highlightCompatibleOutPins(draftState.accepts);
  } else {
    draftState.svgPath.setAttribute('d', bezierPath(draftState.startPt, end));
    highlightCompatiblePins(draftState.type);
  }
});

document.addEventListener('mouseup', (e) => {
  if (!draftState) return;
  clearPinHighlights();

  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (draftState.reversed) {
    // Dragged from in-pin → connect to an out-pin
    if (target && target.classList.contains('pin-dot') && target.closest('.pin-row.pin-out')) {
      const row       = target.closest('.pin-row');
      const nodeEl    = target.closest('.node-card');
      const outNodeId = nodeEl ? nodeEl.id : null;
      const type      = row.dataset.type;
      if (outNodeId && outNodeId !== draftState.toNodeId) {
        if (!draftState.accepts || draftState.accepts === type) {
          const outRows    = nodeEl.querySelectorAll('.pin-row.pin-out');
          const fromPinIdx = [...outRows].indexOf(row);
          createConnection(outNodeId, fromPinIdx, draftState.toNodeId, draftState.toPinIdx, type);
        }
      }
    }
  } else {
    // Dragged from out-pin → connect to an in-pin
    if (target && target.classList.contains('pin-dot') && target.closest('.pin-row.pin-in')) {
      const row      = target.closest('.pin-row');
      const nodeEl   = target.closest('.node-card');
      const toNodeId = nodeEl ? nodeEl.id : null;
      const accepts  = row.dataset.accepts;
      if (toNodeId && toNodeId !== draftState.fromNodeId) {
        if (!accepts || accepts === draftState.type) {
          const inRows   = nodeEl.querySelectorAll('.pin-row.pin-in');
          const toPinIdx = [...inRows].indexOf(row);
          createConnection(draftState.fromNodeId, draftState.fromPinIdx, toNodeId, toPinIdx, draftState.type);
        }
      }
    }
  }

  draftState.svgPath.remove();
  draftState = null;
});

function highlightCompatiblePins(type) {
  document.querySelectorAll('.pin-row.pin-in .pin-dot').forEach(dot => {
    const row = dot.closest('.pin-row');
    const accepts = row.dataset.accepts;
    if (!accepts || accepts === type) {
      dot.classList.add('accept-highlight');
    }
  });
}

function highlightCompatibleOutPins(accepts) {
  document.querySelectorAll('.pin-row.pin-out .pin-dot').forEach(dot => {
    const row  = dot.closest('.pin-row');
    const type = row.dataset.type;
    if (!accepts || accepts === type) dot.classList.add('accept-highlight');
  });
}

function clearPinHighlights() {
  document.querySelectorAll('.pin-dot.accept-highlight').forEach(d => d.classList.remove('accept-highlight'));
}

// Attach drag-start to pins; Alt+rightclick disconnects
document.addEventListener('mousedown', (e) => {
  const dot = e.target;
  if (!dot.classList.contains('pin-dot')) return;
  const row    = dot.closest('.pin-row');
  if (!row) return;
  const nodeEl = dot.closest('.node-card');
  const nodeId = nodeEl ? nodeEl.id : null;

  // Alt+click on any pin → disconnect all connections on that pin
  if (e.button === 0 && e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    const isPinOut = row.classList.contains('pin-out');
    const outRows  = nodeEl.querySelectorAll('.pin-row.pin-out');
    const inRows   = nodeEl.querySelectorAll('.pin-row.pin-in');
    const pinIdx   = isPinOut ? [...outRows].indexOf(row) : [...inRows].indexOf(row);
    const toRemove = [...window.connections.values()].filter(c =>
      (isPinOut  && c.fromNodeId === nodeId && c.fromPinIdx === pinIdx) ||
      (!isPinOut && c.toNodeId   === nodeId && c.toPinIdx   === pinIdx)
    );
    for (const c of toRemove) window.removeSingleConnection(c.fromNodeId, c.toNodeId);
    rightDragMoved = true; // suppress contextmenu
    return;
  }

  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const r       = dot.getBoundingClientRect();
  const startPt = screenToCanvas(r.left + r.width / 2, r.top + r.height / 2);

  if (row.classList.contains('pin-out')) {
    const outRows = nodeEl.querySelectorAll('.pin-row.pin-out');
    const pinIdx  = [...outRows].indexOf(row);
    const type    = row.dataset.type || 'default';

    // 既存接続があれば in-pin 側を固定端にして reversed draft を開始（in-pin drag と対称な挙動）
    const existing = [...window.connections.values()]
      .find(c => c.fromNodeId === nodeId && c.fromPinIdx === pinIdx);
    if (existing) {
      const inPt  = getPinCenter(existing.toNodeId, 'in', existing.toPinIdx);
      const toId  = existing.toNodeId;
      const toIdx = existing.toPinIdx;
      window.removeSingleConnection(nodeId, existing.toNodeId);
      if (inPt) {
        const svg  = document.getElementById('conn-svg');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('conn-path-draft');
        svg.appendChild(path);
        draftState = { toNodeId: toId, toPinIdx: toIdx, accepts: type,
                       svgPath: path, startPt: inPt, reversed: true };
        return;
      }
    }
    startDraftConnection(nodeId, pinIdx, type, startPt);
  } else if (row.classList.contains('pin-in')) {
    const inRows  = nodeEl.querySelectorAll('.pin-row.pin-in');
    const pinIdx  = [...inRows].indexOf(row);
    const accepts = row.dataset.accepts;

    // If this in-pin already has a connection, detach it and drag from the out-pin
    const existing = [...window.connections.values()]
      .find(c => c.toNodeId === nodeId && c.toPinIdx === pinIdx);
    if (existing) {
      const outPt = getPinCenter(existing.fromNodeId, 'out', existing.fromPinIdx);
      const fromId  = existing.fromNodeId;
      const fromIdx = existing.fromPinIdx;
      const type    = existing.type || 'default';
      window.removeSingleConnection(existing.fromNodeId, nodeId);
      startDraftConnection(fromId, fromIdx, type, outPt);
      return;
    }

    const svg  = document.getElementById('conn-svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('conn-path-draft');
    svg.appendChild(path);
    draftState = { toNodeId: nodeId, toPinIdx: pinIdx, accepts, svgPath: path, startPt, reversed: true };
  }
}, true);

// ── Context menu ──────────────────────────────────────────────────────────────
window.onCanvasContextMenu = (e) => {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY);
};

function showContextMenu(x, y) {
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = '';
  menu.classList.remove('hidden');

  // Group plugins by menuSection
  const sections = {};
  for (const [pluginId, plugin] of Object.entries(window.NodePlugins)) {
    if (!plugin.menuSection) continue;
    const sec = plugin.menuSection;
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push({ pluginId, plugin });
  }

  let firstSection = true;
  for (const [sec, items] of Object.entries(sections)) {
    if (!firstSection) {
      const sep = document.createElement('div');
      sep.className = 'ctx-separator';
      menu.appendChild(sep);
    }
    firstSection = false;

    const lbl = document.createElement('div');
    lbl.className = 'ctx-section-label';
    lbl.textContent = sec;
    menu.appendChild(lbl);

    for (const { pluginId, plugin } of items) {
      const item = document.createElement('div');
      item.className = 'ctx-item';
      item.innerHTML = `<span class="ctx-icon">${plugin.icon || '◆'}</span><span>${plugin.label}</span>`;
      item.addEventListener('click', () => {
        hideContextMenu();
        const cp  = screenToCanvas(x, y);
        const pos = { x: cp.x - 110, y: cp.y - 20 };
        plugin.create(pos);
      });
      menu.appendChild(item);
    }
  }

  // Position
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 200, mh = menu.offsetHeight || 300;
  menu.style.left = (x + mw > vw ? x - mw : x) + 'px';
  menu.style.top  = (y + mh > vh ? y - mh : y) + 'px';
}

function hideContextMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctx-menu')) hideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
    isPanning = false;
    const ca = document.getElementById('canvas-area');
    if (ca) ca.classList.remove('panning');
  }
  if (e.code === 'KeyF' && !e.target.matches('input,textarea,select')) {
    window.fitToView();
  }
});

// ── Pan & Zoom event handlers ─────────────────────────────────────────────────

// Mouse-wheel zoom (zoom towards cursor)
document.getElementById('canvas-area').addEventListener('wheel', (e) => {
  e.preventDefault();
  const ca     = document.getElementById('canvas-area').getBoundingClientRect();
  const mx     = e.clientX - ca.left;
  const my     = e.clientY - ca.top;
  const factor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
  const ns     = Math.min(3, Math.max(0.15, viewTransform.s * factor));
  viewTransform.tx = mx - (mx - viewTransform.tx) * (ns / viewTransform.s);
  viewTransform.ty = my - (my - viewTransform.ty) * (ns / viewTransform.s);
  viewTransform.s  = ns;
  applyViewTransform();
  redrawConnections();
}, { passive: false });

// Middle-mouse or right-drag → pan
document.getElementById('canvas-area').addEventListener('mousedown', (e) => {
  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    isPanning      = true;
    rightDragMoved = false;
    panStart = { x: e.clientX, y: e.clientY, tx: viewTransform.tx, ty: viewTransform.ty };
    document.getElementById('canvas-area').classList.add('panning');
  }
});

document.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  const dx = e.clientX - panStart.x;
  const dy = e.clientY - panStart.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) rightDragMoved = true;
  viewTransform.tx = panStart.tx + dx;
  viewTransform.ty = panStart.ty + dy;
  applyViewTransform();
  redrawConnections();
});

document.addEventListener('mouseup', (e) => {
  if (!isPanning) return;
  if (e.button === 1 || e.button === 2) {
    isPanning = false;
    const ca = document.getElementById('canvas-area');
    if (ca) ca.classList.remove('panning');
  }
});

// Canvas right-click → add-node menu (right-drag suppresses menu)
document.getElementById('canvas-area').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!rightDragMoved) showContextMenu(e.clientX, e.clientY);
  rightDragMoved = false;
});

// Click on empty canvas → deselect node and show node list
document.getElementById('canvas-area').addEventListener('click', (e) => {
  if (e.target.closest('.node-card')) return;
  if (selectedNodeId) {
    const prev = document.getElementById(selectedNodeId);
    if (prev) prev.classList.remove('selected');
    selectedNodeId = null;
    showNodeList();
  }
});

// ── Performance panel refresh ─────────────────────────────────────────────────
setInterval(() => {
  // Update state dots for all nodes regardless of selection
  for (const [nid, info] of nodeRegistry) {
    const plugin = window.NodePlugins[info.pluginId];
    if (!plugin || !plugin.getMetrics) continue;
    const m = plugin.getMetrics(nid);
    if (!m) continue;
    const dot = document.getElementById(`ndot-${nid}`);
    if (dot) dot.className = m.dotCls;
  }

  if (!selectedNodeId) {
    // Refresh node list in right panel
    showNodeList();
    return;
  }

  const info = nodeRegistry.get(selectedNodeId);
  if (!info) return;
  const plugin = window.NodePlugins[info.pluginId];
  if (!plugin || !plugin.getMetrics) return;

  const m = plugin.getMetrics(selectedNodeId);
  if (!m) return;

  // Refresh panel stats section
  const contentEl = document.getElementById('panel-content');
  if (!contentEl) return;
  let statsDiv = contentEl.querySelector('.perf-section');
  if (!statsDiv) return;

  let html = `<div class="perf-section-title">ステータス</div>`;
  html += `<div class="stats-row"><span class="stats-lbl">状態</span><span class="badge ${m.statusCls}">${window.escHtml(m.statusLabel)}</span></div>`;
  for (const s of (m.stats || [])) {
    html += `<div class="stats-row"><span class="stats-lbl">${window.escHtml(s.lbl)}</span><span class="stats-val">${window.escHtml(s.val)}</span></div>`;
  }
  statsDiv.innerHTML = html;
}, 500);

// ── Misc ──────────────────────────────────────────────────────────────────────
// Redraw connections on window resize
window.addEventListener('resize', redrawConnections);

// ── Recording node ────────────────────────────────────────────────────────────
window._recState = {};

window.NodePlugins['recording'] = {
  label:       'Recording',
  icon:        '⏺',
  menuSection: null,
  nodeClass:   'node-card node-recording',
  pins: {
    in:  [{ label: '映像入力', accepts: 'video' }],
    out: [
      { type: 'trigger', label: '録画' },
      { type: 'trigger', label: 'リプレイ' },
    ],
  },

  create(pos) {
    const nodeId = window.generateNodeId();
    window.createPluginNode('recording', nodeId, pos);
    const nameEl = document.getElementById(`ename-${nodeId}`);
    if (nameEl) nameEl.value = 'Recording';
    return nodeId;
  },

  mount(nodeId, nodeEl) {
    const state = {
      active: false, takeId: null,
      timerInterval: null, startTime: 0,
      takeName: 'take',
      recordDir: localStorage.getItem('rec-recordDir') || '',
      connectedVideoIds: new Set(),
      syncInterval: null,
    };
    window._recState[nodeId] = state;

    nodeEl.innerHTML = `
      <div class="node-header node-recording" id="nheader-${nodeId}">
        <span class="node-state-dot" id="ndot-${nodeId}"></span>
        <input class="node-name" id="ename-${nodeId}" value="Recording" />
        <button class="node-delete-btn" onclick="window.removePluginNode('${nodeId}')">✕</button>
      </div>
      <div class="node-body">
        <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:4px;">
          <div class="pin-row pin-in" data-accepts="video" style="margin:0;justify-self:start;">
            <span class="pin-dot"></span>
            <span class="pin-label" style="margin-left:6px;">収録</span>
          </div>
          <button class="btn-rec" id="rec-btn-${nodeId}"
                  onclick="window._recToggle('${nodeId}')" disabled
                  style="margin:0;padding:6px 12px;font-size:13px;letter-spacing:0;">⏺ REC</button>
          <div style="display:flex;flex-direction:column;gap:2px;justify-self:end;">
            <div class="pin-row pin-out pin-type-trigger" data-type="trigger" style="margin:0;">
              <span class="pin-label">収録トリガー</span>
              <span class="pin-dot"></span>
            </div>
            <div class="pin-row pin-out pin-type-trigger" data-type="trigger" style="margin:0;">
              <span class="pin-label">リプレイ</span>
              <span class="pin-dot"></span>
            </div>
          </div>
        </div>
        <span class="take-timer" id="rec-timer-${nodeId}" style="display:block;text-align:center;margin-top:6px;">00:00:00</span>
      </div>
    `;

    window.registerNodeHandlers(nodeId, {
      onConnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        state.connectedVideoIds.add(fromNodeId);
      },
      onDisconnected(fromNodeId, toNodeId) {
        if (toNodeId !== nodeId) return;
        state.connectedVideoIds.delete(fromNodeId);
        if (state.active && state.connectedVideoIds.size === 0) window._recStop(nodeId);
      },
    });

    // Sync: enable/disable REC button based on stream availability
    state.syncInterval = setInterval(() => {
      const hasStream = [...state.connectedVideoIds].some(id => window.nodeStreams.has(id));
      const btn = document.getElementById(`rec-btn-${nodeId}`);
      if (btn) btn.disabled = !hasStream;
    }, 500);
  },

  createPanel(nodeId, cont) {
    const state = window._recState[nodeId];
    cont.innerHTML = `
      <div class="perf-section">
        <div class="perf-section-title">ステータス</div>
        <div class="stats-row">
          <span class="stats-lbl">状態</span>
          <span class="badge badge-inactive" id="prec-badge-${nodeId}">停止</span>
        </div>
      </div>
      <div class="perf-section">
        <div class="perf-section-title">設定</div>
        <div class="form-row">
          <label>テイク名プリセット</label>
          <input type="text" id="prec-name-${nodeId}" value="${window.escHtml(state ? state.takeName : 'take')}" />
        </div>
        <div class="form-row">
          <label>保存先フォルダ</label>
          <div style="display:flex;gap:4px;">
            <input type="text" id="prec-dir-${nodeId}" value="${window.escHtml(state ? state.recordDir : '')}" style="flex:1" />
            <button class="btn-secondary" id="prec-browse-${nodeId}" style="flex-shrink:0;width:auto;padding:4px 8px;">参照</button>
          </div>
        </div>
      </div>
    `;

    const nameInput = document.getElementById(`prec-name-${nodeId}`);
    if (nameInput) nameInput.addEventListener('input', () => { if (state) state.takeName = nameInput.value; });
    const dirInput = document.getElementById(`prec-dir-${nodeId}`);
    if (dirInput) dirInput.addEventListener('input', () => {
      if (state) {
        state.recordDir = dirInput.value;
        localStorage.setItem('rec-recordDir', dirInput.value);
      }
    });
    const browseBtn = document.getElementById(`prec-browse-${nodeId}`);
    if (browseBtn) browseBtn.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.openDirectory) {
        const dir = await window.electronAPI.openDirectory();
        if (dir && state) {
          state.recordDir = dir;
          localStorage.setItem('rec-recordDir', dir);
          if (dirInput) dirInput.value = dir;
        }
      }
    });

    const timer = setInterval(() => {
      if (!state) return;
      const b = document.getElementById(`prec-badge-${nodeId}`);
      if (b) {
        b.textContent  = state.active ? '録画中' : '停止';
        b.className    = 'badge ' + (state.active ? 'badge-danger' : 'badge-inactive');
      }
    }, 500);
    cont._cleanupTimer = timer;
  },

  getMetrics(nodeId) {
    const state     = window._recState[nodeId];
    const active    = !!(state && state.active);
    const hasStream = !!(state && [...state.connectedVideoIds].some(id => window.nodeStreams.has(id)));

    if (active) {
      return { dotCls: 'node-state-dot state-active', statusCls: 'badge-danger',   statusLabel: '録画中', stats: [] };
    } else if (hasStream) {
      return { dotCls: 'node-state-dot state-orange', statusCls: 'badge-orange',   statusLabel: '待機中', stats: [] };
    } else {
      return { dotCls: 'node-state-dot',              statusCls: 'badge-inactive', statusLabel: '停止',   stats: [] };
    }
  },

  unmount(nodeId) {
    const state = window._recState[nodeId];
    if (state) {
      if (state.active) window._recStop(nodeId);
      if (state.timerInterval) clearInterval(state.timerInterval);
      if (state.syncInterval)  clearInterval(state.syncInterval);
      delete window._recState[nodeId];
    }
    window.unregisterNodeHandlers(nodeId);
  },
};

window._recToggle = (nodeId) => {
  const state = window._recState[nodeId];
  if (!state) return;
  if (state.active) window._recStop(nodeId); else window._recStart(nodeId);
};

window._recStart = (nodeId) => {
  const state = window._recState[nodeId];
  if (!state || state.active) return;
  if (![...state.connectedVideoIds].some(id => window.nodeStreams.has(id))) return;
  state.active    = true;
  state.takeId    = (state.takeName || 'take') + '_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  state.startTime = Date.now();
  localStorage.setItem('rec-recordDir', state.recordDir || '');
  const btn = document.getElementById(`rec-btn-${nodeId}`);
  if (btn) { btn.textContent = '⏹ STOP'; btn.className = 'btn-rec btn-rec-active'; }
  state.timerInterval = setInterval(() => {
    const s   = Math.floor((Date.now() - state.startTime) / 1000);
    const h   = String(Math.floor(s / 3600)).padStart(2, '0');
    const m   = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    const el  = document.getElementById(`rec-timer-${nodeId}`);
    if (el) el.textContent = `${h}:${m}:${sec}`;
  }, 1000);
  window.socket.emit(EVENTS.TAKE_START, { takeId: state.takeId, recordDir: state.recordDir || undefined });
};

window._recStop = (nodeId) => {
  const state = window._recState[nodeId];
  if (!state || !state.active) return;
  state.active = false;
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  const btn = document.getElementById(`rec-btn-${nodeId}`);
  if (btn) { btn.textContent = '⏺ REC'; btn.className = 'btn-rec'; }
  const el = document.getElementById(`rec-timer-${nodeId}`);
  if (el) el.textContent = '00:00:00';
  window.socket.emit(EVENTS.TAKE_STOP, { takeId: state.takeId });
  state.takeId = null;
};

// Auto-place Recording node once on startup
window.NodePlugins['recording'].create({ x: 50, y: 50 });

// Show node list on initial load
showNodeList();
