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

// ─── Internal mocap event emitter (for server-side recording) ─────────────────
const mocapEmitter = new (require('events').EventEmitter)();
mocapEmitter.setMaxListeners(50);

// ─── UDP forward rules: fromPort → Set<{ host, toPort }> ──────────────────────
const forwardRules = new Map();


// ─── UDP listener ─────────────────────────────────────────────────────────────
const boundPorts = new Map(); // port → dgram.Socket

function bindLiveLinkPort(port) {
  if (boundPorts.has(port)) return; // already listening
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf) => {
    // Save raw bytes to active takes that requested this port
    for (const take of activeTakes.values()) {
      const ws = take.rawStreams && take.rawStreams[port];
      if (!ws) continue;
      const hdr = Buffer.allocUnsafe(12);
      hdr.writeBigUInt64LE(BigInt(Date.now()), 0);
      hdr.writeUInt32LE(buf.length, 8);
      ws.write(Buffer.concat([hdr, buf]));
    }

    // Forward raw bytes before parsing — lowest latency, no overhead
    const rules = forwardRules.get(port);
    if (rules) {
      for (const { host, toPort } of rules) {
        const fwd = dgram.createSocket('udp4');
        fwd.send(buf, 0, buf.length, toPort, host, () => fwd.close());
      }
    }

    for (const parser of PROTOCOL_PARSERS) {
      const result = parser.parse(buf);
      if (result) {
        const { _raw, ...parsedData } = result.parsed;
        touchDevice(parsedData.deviceId || parsedData.uuid || 'unknown', result.format, parsedData);
        mocapEmitter.emit(EVENTS.MOCAP_DATA, { format: result.format, data: parsedData, port });
        io.emit(EVENTS.MOCAP_DATA, { format: result.format, data: parsedData, port });
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
  // ── LiveLink Face packet forwarding (server-side rule management) ──
  socket.on('livelink:forward-start', ({ fromPort, host, toPort }) => {
    if (!fromPort || !host || !toPort) return;
    if (!forwardRules.has(fromPort)) forwardRules.set(fromPort, new Set());
    const rules = forwardRules.get(fromPort);
    // Remove existing rule for same destination before adding
    for (const r of rules) { if (r.host === host && r.toPort === toPort) rules.delete(r); }
    rules.add({ host, toPort });
    console.log(`Forward rule added: UDP:${fromPort} → ${host}:${toPort}`);
  });

  socket.on('livelink:forward-stop', ({ fromPort, host, toPort }) => {
    const rules = forwardRules.get(fromPort);
    if (!rules) return;
    for (const r of rules) { if (r.host === host && r.toPort === toPort) rules.delete(r); }
    console.log(`Forward rule removed: UDP:${fromPort} → ${host}:${toPort}`);
  });

  socket.on('disconnect', () => {
    // Clean up forward rules registered by this socket
    // (tracked via closure — rules added during this socket's lifetime)
  });

  socket.on('livelink:bind-port', ({ port }) => {
    const p = parseInt(port);
    if (p > 0 && p < 65536) bindLiveLinkPort(p);
  });

  // ── Take recording ──
  socket.on(EVENTS.TAKE_START, ({ takeId, recordDir, deviceIds, rawSources }) => {
    startTake(socket, takeId, recordDir, deviceIds, rawSources);
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

  socket.on(EVENTS.TAKE_MOCAP_FRAME, ({ takeId, payload }) => {
    const take = activeTakes.get(takeId);
    if (!take) return;
    take.writeStream.write(JSON.stringify({ type: 'frame', t: Date.now(), ...payload }) + '\n');
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

  // ── AJA Ki Pro ──
  socket.on('kipro:record', async ({ nodeId, host }) => {
    try {
      // Switch to Record-Play mode if needed
      const stateRes = await kiproGet(host, 'action=get&paramid=eParamID_MediaState');
      const stateVal = JSON.parse(stateRes.body).value;
      if (stateVal === '1') {
        await kiproGet(host, 'action=set&paramid=eParamID_MediaState&value=0');
      }
      await kiproGet(host, 'action=set&paramid=eParamID_TransportCommand&value=3');
      socket.emit('kipro:result', { nodeId, ok: true, action: 'record', message: 'Recording started' });
    } catch (err) {
      socket.emit('kipro:result', { nodeId, ok: false, action: 'record', message: err.message });
    }
  });

  socket.on('kipro:stop', async ({ nodeId, host }) => {
    try {
      await kiproGet(host, 'action=set&paramid=eParamID_TransportCommand&value=4');
      socket.emit('kipro:result', { nodeId, ok: true, action: 'stop', message: 'Stopped' });
    } catch (err) {
      socket.emit('kipro:result', { nodeId, ok: false, action: 'stop', message: err.message });
    }
  });

  // ── OBS WebSocket ──
  // commands: [{ requestType, requestData? }]
  // 1接続でコマンドを順次実行し、完了後に切断する
  socket.on('obs:exec', async ({ nodeId, host, port, password, commands }) => {
    const action = resolveObsAction(commands[0]?.requestType);
    try {
      await obsWsSession(host, port || 4455, password, commands);
      socket.emit('obs:result', { nodeId, ok: true, action, connected: true });
    } catch (err) {
      socket.emit('obs:result', { nodeId, ok: false, action, connected: false, message: err.message });
    }
  });

  socket.on('obs:ping', async ({ nodeId, host, port, password }) => {
    try {
      await obsWsSession(host, port || 4455, password, [{ requestType: 'GetVersion' }]);
      socket.emit('obs:result', { nodeId, ok: true, action: 'ping', connected: true });
    } catch (err) {
      socket.emit('obs:result', { nodeId, ok: false, action: 'ping', connected: false, message: err.message });
    }
  });

  // ── Stype ──
  socket.on('stype:send', ({ nodeId, host, message }) => {
    const sock = dgram.createSocket('udp4');
    const buf = Buffer.from(message, 'utf8');
    sock.send(buf, 2458, host, (err) => {
      sock.close();
      if (err) socket.emit('stype:result', { nodeId, ok: false, message: err.message });
      else      socket.emit('stype:result', { nodeId, ok: true,  message });
    });
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

// ─── AJA Ki Pro HTTP helper ───────────────────────────────────────────────────
function kiproGet(host, query) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}/config?${query}`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ki Pro request timeout')); });
  });
}

// ─── OBS WebSocket v5 helper ──────────────────────────────────────────────────
// 1接続でcommands配列を順次実行し、全完了後に切断する
function obsWsSession(host, port, password, commands) {
  const WebSocket = require('ws');
  const { createHash } = require('crypto');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('OBS connection timeout')); }, 8000);
    let cmdIndex = 0;
    let done = false;

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err); else resolve();
    }

    function sendNext() {
      if (cmdIndex >= commands.length) { finish(null); return; }
      const { requestType, requestData } = commands[cmdIndex];
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: String(cmdIndex), requestData: requestData || {} } }));
    }

    ws.on('error', (err) => finish(err));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.op === 0) { // Hello
        let auth;
        if (password && msg.d.authentication) {
          const { salt, challenge } = msg.d.authentication;
          const secret = createHash('sha256').update(password + salt).digest('base64');
          auth = createHash('sha256').update(secret + challenge).digest('base64');
        }
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: auth, eventSubscriptions: 0 } }));
      } else if (msg.op === 2) { // Identified
        sendNext();
      } else if (msg.op === 7) { // RequestResponse
        if (!msg.d.requestStatus.result) {
          finish(new Error(msg.d.requestStatus.comment || `OBS error ${msg.d.requestStatus.code}`));
          return;
        }
        cmdIndex++;
        sendNext();
      }
    });
  });
}

function resolveObsAction(requestType) {
  if (requestType === 'StartRecord') return 'record';
  if (requestType === 'StopRecord')  return 'stop';
  if (requestType === 'GetVersion')  return 'ping';
  return 'set-text';
}

// ─── Take recording ───────────────────────────────────────────────────────────
// takeId → { stream, filePath, frameCount }
const activeTakes = new Map();

function startTake(socket, takeId, recordDir, deviceIds, rawSources) {
  if (activeTakes.has(takeId)) return;

  const dir = recordDir || path.join(__dirname, '..', '..', 'record');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const takeDir = path.join(dir, `take_${timestamp}`);
  fs.mkdirSync(takeDir, { recursive: true });

  const filePath = path.join(takeDir, 'mocap.vlnk');
  const writeStream = fs.createWriteStream(filePath);
  writeStream.write(JSON.stringify({ type: 'header', version: 1, startTime: Date.now(), deviceIds }) + '\n');

  // Raw UDP streams: port → WriteStream, filename = protocol_nodeName.bin
  const rawStreams = {};
  for (const src of (rawSources || [])) {
    const { nodeName, port, protocol } = src;
    const safeName = (nodeName || 'node').replace(/[^\w\-]/g, '_');
    const ws = fs.createWriteStream(path.join(takeDir, `${protocol}_${safeName}.bin`));
    const headerJson = Buffer.from(JSON.stringify({ type: 'header', protocol, nodeName, port, startTime: Date.now() }));
    const hdr = Buffer.allocUnsafe(12);
    hdr.writeBigUInt64LE(0n, 0);
    hdr.writeUInt32LE(headerJson.length, 8);
    ws.write(Buffer.concat([hdr, headerJson]));
    rawStreams[port] = ws;
  }

  activeTakes.set(takeId, { writeStream, filePath, takeDir, rawStreams });
  socket.emit(EVENTS.TAKE_STARTED, { takeId, filePath });
  console.log(`Take started: ${filePath}`);
}

function stopTake(socket, takeId) {
  const take = activeTakes.get(takeId);
  if (!take) return;

  if (take.videoStream) { take.videoStream.end(); take.videoStream = null; }
  for (const ws of Object.values(take.rawStreams || {})) ws.end();
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
