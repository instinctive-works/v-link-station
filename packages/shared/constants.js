// Shared constants between server and renderer

const LIVELINK_FACE_PORT = 11111;
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const PROTOCOL_IDS = {
  LIVELINK_FACE: 'livelink-face',
};

const PIN_TYPES = {
  LIVELINK_FACE: 'livelink-face',
  VIDEO: 'video',
  TRIGGER: 'trigger',
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
  GET_DEVICES: 'get-devices',
};

if (typeof module !== 'undefined') {
  module.exports = { LIVELINK_FACE_PORT, SERVER_PORT, PROTOCOL_IDS, PIN_TYPES, EVENTS };
}
