const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const path = require('path');
const fs = require('fs');

const { LIVELINK_FACE_PORT, SERVER_PORT, EVENTS } = require('../../packages/shared/constants');

// ─── Protocol parsers ─────────────────────────────────────────────────────────
const PROTOCOL_PARSERS = [
  require('../../packages/protocols/livelink-face/parser'),
];

// ─── Express + Socket.IO setup ────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// Serve static renderer files
app.use(express.static(path.join(__dirname, '..', '..', 'packages', 'renderer')));

// Serve protocol renderer scripts
app.use('/protocols', express.static(path.join(__dirname, '..', '..', 'packages', 'protocols')));

// Serve shared constants
app.use('/shared', express.static(path.join(__dirname, '..', '..', 'packages', 'shared')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'packages', 'renderer', 'index.html'));
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

// ─── Socket.IO handlers ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current device list on connect
  socket.emit(EVENTS.GET_DEVICES, [...devices.values()]);

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

  socket.on('disconnect', () => {
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
  take.writeStream.end(() => {
    socket.emit(EVENTS.TAKE_STOPPED, { takeId, filePath: take.filePath });
    console.log(`Take stopped: ${take.filePath}`);
  });
  activeTakes.delete(takeId);
}

// ─── Start HTTP server ────────────────────────────────────────────────────────
httpServer.listen(SERVER_PORT, '127.0.0.1', () => {
  console.log(`V-Link Station server running at http://127.0.0.1:${SERVER_PORT}`);
  // Notify parent Electron process that the server is ready
  if (process.send) process.send({ type: 'ready' });
});
