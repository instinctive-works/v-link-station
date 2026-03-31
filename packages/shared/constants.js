// Shared constants between server and renderer

const LIVELINK_FACE_PORT = 11111;
const SERVER_PORT = (typeof process !== 'undefined' && process.env && process.env.PORT)
  ? parseInt(process.env.PORT) : 3000;

const PROTOCOL_IDS = {
  LIVELINK_FACE: 'livelink-face',
};

// ── Pin type identifiers ───────────────────────────────────────────────────────
// Basic pin types shared across all nodes.
// Protocol-specific pin types (e.g. 'vmc', 'mocopi') should be defined
// inside their own protocols/<name>/ folder and registered separately.
const PIN_TYPES = {
  VIDEO:         'video',         // MediaStream 映像 (orange)
  TRIGGER:       'trigger',       // トリガー信号 (green)
  LIVELINK_FACE: 'livelink-face', // LiveLink Face モーションデータ (blue)
  REPLAY:        'replay',        // リプレイデータ（映像＋モーション内包）(purple)
  WASM_FRAME:    'wasm-frame',    // WASM ヒープ上のピクセルフレーム ptr トークン (cyan)
};

// Socket.IO event names
const EVENTS = {
  // Server → Client
  DEVICE_UPDATE: 'device-update',
  DEVICE_REMOVE: 'device-remove',
  MOCAP_DATA: 'mocap-data',
  TAKE_STARTED: 'take-started',
  TAKE_STOPPED: 'take-stopped',
  TAKE_ERROR: 'take-error',

  // Client → Server
  TAKE_START: 'take-start',
  TAKE_STOP: 'take-stop',
  TAKE_VIDEO_CHUNK: 'take-video-chunk',
  GET_DEVICES: 'get-devices',

  // WebRTC signaling (live stream)
  RTC_VIEWER_JOIN:   'rtc:viewer-join',
  RTC_VIEWER_JOINED: 'rtc:viewer-joined',
  RTC_VIEWER_LEFT:   'rtc:viewer-left',
  RTC_OFFER:         'rtc:offer',
  RTC_ANSWER:        'rtc:answer',
  RTC_ICE:           'rtc:ice',
};

// Expose to browser globals (constants.js is loaded as a plain <script>)
if (typeof window !== 'undefined') {
  window.PIN_TYPES = PIN_TYPES;
  window.EVENTS    = EVENTS;
}

if (typeof module !== 'undefined') {
  module.exports = { LIVELINK_FACE_PORT, SERVER_PORT, PROTOCOL_IDS, PIN_TYPES, EVENTS };
}
