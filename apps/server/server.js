const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const path = require('path');
const fs = require('fs');

const { LIVELINK_FACE_PORT, SERVER_PORT, EVENTS } = require('../../packages/shared/constants');

// ─── Take ID validator ────────────────────────────────────────────────────────
function isValidTakeId(id) {
  return typeof id === 'string' && /^take_[\w\-]+$/.test(id);
}

// ─── Protocol parsers ─────────────────────────────────────────────────────────
const PROTOCOL_PARSERS = [
  require('../../packages/protocols/livelink-face/parser'),
];

// ─── Express + Socket.IO setup ────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// Electron の User-Agent に "Electron" が含まれる — それ以外は外部ブラウザとして /browser へ転送
// static より先に評価しないと express.static が index.html を直接返してしまう
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    const ua = req.headers['user-agent'] || '';
    if (!ua.includes('Electron')) return res.redirect('/browser');
  }
  next();
});

// Serve static renderer files (index: false で / への自動配信を無効化)
app.use(express.static(path.join(__dirname, '..', '..', 'packages', 'renderer'), { index: false }));

// Serve protocol renderer scripts
app.use('/protocols', express.static(path.join(__dirname, '..', '..', 'packages', 'protocols')));

// Serve shared constants
app.use('/shared', express.static(path.join(__dirname, '..', '..', 'packages', 'shared')));

// Serve WASM video processor
app.use('/wasm-video', express.static(path.join(__dirname, '..', '..', 'packages', 'wasm-video')));

app.get('/', (_req, res) => {
  // COOP/COEP は SharedArrayBuffer (WASM) に必要 — index.html にのみ付与
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.sendFile(path.join(__dirname, '..', '..', 'packages', 'renderer', 'index.html'));
});

app.get('/browser', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'packages', 'renderer', 'browser.html'));
});

// ─── MJPEG stream endpoint ────────────────────────────────────────────────────
app.get('/stream/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  if (!/^[\w\-]+$/.test(nodeId)) return res.status(400).send('Invalid nodeId');

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=vlnkframe');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!mjpegClients.has(nodeId)) mjpegClients.set(nodeId, new Set());
  mjpegClients.get(nodeId).add(res);

  req.on('close', () => {
    const set = mjpegClients.get(nodeId);
    if (set) { set.delete(res); if (set.size === 0) mjpegClients.delete(nodeId); }
  });
});

// ─── Takes API ────────────────────────────────────────────────────────────────
const RECORD_DIR = path.join(__dirname, '..', '..', 'record');

app.get('/api/takes', (_req, res) => {
  if (!fs.existsSync(RECORD_DIR)) return res.json([]);
  const dirs = fs.readdirSync(RECORD_DIR).filter(d => {
    try { return fs.statSync(path.join(RECORD_DIR, d)).isDirectory(); } catch { return false; }
  }).sort().reverse();
  const takes = dirs.map(d => {
    const dir = path.join(RECORD_DIR, d);
    const hasVideo = fs.existsSync(path.join(dir, 'video.webm'));
    const hasMocap = fs.existsSync(path.join(dir, 'mocap.vlnk'));
    const videoSize = hasVideo ? fs.statSync(path.join(dir, 'video.webm')).size : 0;
    const mocapSize = hasMocap ? fs.statSync(path.join(dir, 'mocap.vlnk')).size : 0;
    return { id: d, hasVideo, hasMocap, videoSize, mocapSize };
  });
  res.json(takes);
});

app.get('/api/takes/:takeId/video.webm', (req, res) => {
  const takeId = req.params.takeId;
  if (!isValidTakeId(takeId)) return res.status(400).send('Invalid take ID');
  const filePath = path.join(RECORD_DIR, takeId, 'video.webm');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

app.get('/api/takes/:takeId/mocap.vlnk', (req, res) => {
  const takeId = req.params.takeId;
  if (!isValidTakeId(takeId)) return res.status(400).send('Invalid take ID');
  const filePath = path.join(RECORD_DIR, takeId, 'mocap.vlnk');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ─── Device state ─────────────────────────────────────────────────────────────
// deviceId → { id, format, name, lastSeen, data }
const devices = new Map();

function touchDevice(deviceId, format, parsed) {
  const existing = devices.get(deviceId);
  const now = Date.now();
  if (!existing) {
    const dev = { id: deviceId, format, name: deviceId, lastSeen: now, data: parsed };
    devices.set(deviceId, dev);
    io.emit(EVENTS.DEVICE_UPDATE, dev);
  } else {
    existing.lastSeen = now;
    existing.data = parsed;
    io.emit(EVENTS.DEVICE_UPDATE, existing);
  }
}

// Prune devices not seen for 5s
setInterval(() => {
  const now = Date.now();
  for (const [id, dev] of devices) {
    if (now - dev.lastSeen > 5000) {
      devices.delete(id);
      io.emit(EVENTS.DEVICE_REMOVE, id);
    }
  }
}, 2000);

// ─── UDP listener ─────────────────────────────────────────────────────────────
const boundPorts = new Map(); // port → dgram.Socket

function bindLiveLinkPort(port) {
  if (boundPorts.has(port)) return; // already listening
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf) => {
    for (const parser of PROTOCOL_PARSERS) {
      const result = parser.parse(buf);
      if (result) {
        touchDevice(result.parsed.deviceId || result.parsed.uuid || 'unknown', result.format, result.parsed);
        io.emit(EVENTS.MOCAP_DATA, { format: result.format, data: result.parsed, port });
        return;
      }
    }
  });
  sock.bind(port, () => {
    console.log(`UDP listening on port ${port}`);
    boundPorts.set(port, sock);
  });
  sock.on('error', (err) => {
    console.error(`UDP port ${port} error:`, err.message);
    boundPorts.delete(port);
  });
}

// Always bind the default LiveLink port
bindLiveLinkPort(LIVELINK_FACE_PORT);

// ─── Socket.IO stream registry (socket mode) ─────────────────────────────────
// nodeId → { name, socketId, mode }
const socketStreams = new Map();

// ─── MJPEG client registry ────────────────────────────────────────────────────
// nodeId → Set<res>
const mjpegClients = new Map();

function _closeMjpegClients(nodeId) {
  const clients = mjpegClients.get(nodeId);
  if (!clients) return;
  for (const res of clients) { try { res.end(); } catch (_) {} }
  mjpegClients.delete(nodeId);
}

// ─── Socket.IO handlers ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current device list and stream list on connect
  socket.emit(EVENTS.GET_DEVICES, [...devices.values()]);
  socket.emit(EVENTS.STREAM_LIST, [...socketStreams.entries()].map(([nodeId, s]) => ({ nodeId, name: s.name, mode: s.mode })));

  socket.on(EVENTS.GET_DEVICES, () => {
    socket.emit(EVENTS.GET_DEVICES, [...devices.values()]);
  });

  // ── Dynamic LiveLink port binding ──
  socket.on('livelink:bind-port', ({ port }) => {
    const p = parseInt(port);
    if (p > 0 && p < 65536) bindLiveLinkPort(p);
  });

  // ── Take recording ──
  socket.on(EVENTS.TAKE_START, ({ takeId, recordDir, deviceIds }) => {
    startTake(socket, takeId, recordDir, deviceIds);
  });

  socket.on(EVENTS.TAKE_STOP, ({ takeId }) => {
    stopTake(socket, takeId);
  });

  socket.on(EVENTS.TAKE_VIDEO_CHUNK, ({ takeId, chunk }) => {
    const take = activeTakes.get(takeId);
    if (!take) return;
    if (!take.videoStream) {
      const videoPath = path.join(take.takeDir, 'video.webm');
      take.videoStream = fs.createWriteStream(videoPath);
    }
    take.videoStream.write(Buffer.from(chunk));
  });

  // ── WebRTC signaling ──
  socket.on(EVENTS.RTC_VIEWER_JOIN, () => {
    // Notify all other clients (broadcasters) that a viewer wants a stream
    socket.broadcast.emit(EVENTS.RTC_VIEWER_JOINED, { viewerId: socket.id });
  });

  socket.on(EVENTS.RTC_OFFER, ({ viewerId, sdp }) => {
    io.to(viewerId).emit(EVENTS.RTC_OFFER, { broadcasterId: socket.id, sdp });
  });

  socket.on(EVENTS.RTC_ANSWER, ({ broadcasterId, sdp }) => {
    io.to(broadcasterId).emit(EVENTS.RTC_ANSWER, { viewerId: socket.id, sdp });
  });

  socket.on(EVENTS.RTC_ICE, ({ targetId, candidate }) => {
    io.to(targetId).emit(EVENTS.RTC_ICE, { fromId: socket.id, candidate });
  });

  // ── Socket.IO stream (video-share socket mode) ──
  socket.on(EVENTS.STREAM_REGISTER, ({ nodeId, name, mode }) => {
    socketStreams.set(nodeId, { name, socketId: socket.id, mode });
    socket.broadcast.emit(EVENTS.STREAM_REGISTER, { nodeId, name, mode });
  });

  socket.on(EVENTS.STREAM_FRAME, ({ nodeId, jpeg }) => {
    socket.broadcast.emit(EVENTS.STREAM_FRAME, { nodeId, jpeg });
    // Push to MJPEG HTTP clients
    const clients = mjpegClients.get(nodeId);
    if (clients && clients.size > 0) {
      const buf = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg);
      const header = `--vlnkframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
      for (const res of clients) {
        try { res.write(header); res.write(buf); res.write('\r\n'); } catch (_) {}
      }
    }
  });

  socket.on(EVENTS.STREAM_UNREGISTER, ({ nodeId }) => {
    socketStreams.delete(nodeId);
    socket.broadcast.emit(EVENTS.STREAM_UNREGISTER, { nodeId });
    _closeMjpegClients(nodeId);
  });

  // ── FastShare (WebP/JPEG) ──
  socket.on('fastshare:frame', (payload) => {
    // payload: { streamId: string, frame: string(base64) }
    socket.broadcast.emit('fastshare:frame', payload);
  });

  // ── VISCA over IP ──
  socket.on('visca:send', ({ nodeId, host, port, command }) => {
    // Validate IPv4 address
    if (typeof host !== 'string') {
      socket.emit('visca:error', { nodeId, error: 'Invalid host' });
      return;
    }
    const octets = host.split('.');
    const validIP = octets.length === 4 && octets.every(o => {
      const n = Number(o);
      return /^\d+$/.test(o) && n >= 0 && n <= 255;
    });
    if (!validIP) {
      socket.emit('visca:error', { nodeId, error: 'Invalid host (IPv4 only)' });
      return;
    }
    const safePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 52381;
    if (!Array.isArray(command) || command.length === 0 || command.length > 64) {
      socket.emit('visca:error', { nodeId, error: 'Invalid command' });
      return;
    }
    const buf = Buffer.from(command.map(b => (b & 0xFF)));
    const udpClient = dgram.createSocket('udp4');
    udpClient.on('message', (msg) => {
      socket.emit('visca:response', { nodeId, data: Array.from(msg) });
    });
    udpClient.bind(() => {
      udpClient.send(buf, safePort, host, (err) => {
        if (err) {
          socket.emit('visca:error', { nodeId, error: err.message });
          try { udpClient.close(); } catch (_) {}
        } else {
          setTimeout(() => { try { udpClient.close(); } catch (_) {} }, 500);
        }
      });
    });
  });

  socket.on('disconnect', () => {
    // Notify broadcasters that the viewer left
    socket.broadcast.emit(EVENTS.RTC_VIEWER_LEFT, { viewerId: socket.id });
    // Auto-unregister any socket streams owned by this socket
    for (const [nodeId, s] of socketStreams.entries()) {
      if (s.socketId === socket.id) {
        socketStreams.delete(nodeId);
        socket.broadcast.emit(EVENTS.STREAM_UNREGISTER, { nodeId });
        _closeMjpegClients(nodeId);
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

// ─── Take recording ───────────────────────────────────────────────────────────
// takeId → { stream, filePath, frameCount }
const activeTakes = new Map();

function startTake(socket, takeId, recordDir, deviceIds) {
  if (activeTakes.has(takeId)) return;

  const dir = recordDir || path.join(__dirname, '..', '..', 'record');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const takeDir = path.join(dir, `take_${timestamp}`);
  fs.mkdirSync(takeDir, { recursive: true });

  const filePath = path.join(takeDir, 'mocap.vlnk');
  const writeStream = fs.createWriteStream(filePath);

  // Write JSON-lines header
  writeStream.write(JSON.stringify({ type: 'header', version: 1, startTime: Date.now(), deviceIds }) + '\n');

  const onData = (payload) => {
    if (deviceIds && deviceIds.length > 0) {
      const id = payload.data?.deviceId || payload.data?.uuid;
      if (!deviceIds.includes(id)) return;
    }
    writeStream.write(JSON.stringify({ type: 'frame', t: Date.now(), ...payload }) + '\n');
  };

  io.on(EVENTS.MOCAP_DATA, onData);

  activeTakes.set(takeId, { writeStream, filePath, takeDir, onData });
  socket.emit(EVENTS.TAKE_STARTED, { takeId, filePath });
  console.log(`Take started: ${filePath}`);
}

function stopTake(socket, takeId) {
  const take = activeTakes.get(takeId);
  if (!take) return;

  io.off(EVENTS.MOCAP_DATA, take.onData);
  if (take.videoStream) {
    take.videoStream.end();
    take.videoStream = null;
  }
  take.writeStream.end(() => {
    socket.emit(EVENTS.TAKE_STOPPED, { takeId, filePath: take.filePath });
    console.log(`Take stopped: ${take.filePath}`);
  });
  activeTakes.delete(takeId);
}

// ─── Start HTTP server ────────────────────────────────────────────────────────
httpServer.listen(SERVER_PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const addrs = ['127.0.0.1'];
  for (const iface of Object.values(nets)) {
    for (const n of iface) {
      if (n.family === 'IPv4' && !n.internal) addrs.push(n.address);
    }
  }
  console.log(`V-Link Station server running on port ${SERVER_PORT}`);
  addrs.forEach(a => console.log(`  http://${a}:${SERVER_PORT}`));
  // Notify parent Electron process that the server is ready
  if (process.send) process.send({ type: 'ready', addresses: addrs, port: SERVER_PORT });
});
