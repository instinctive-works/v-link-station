// LiveLink Face UDP packet parser (Node.js server-side)
//
// v6 (ARKit mode) layout:
//   version(1) + uuid_len(4BE) + uuid(N) + name_len(4BE) + name(N)
//   + frame_number(4BE) + sub_frame(4BE) + rate_num(4BE) + rate_den(4BE)
//   + bs_count(1) + bs_count × float32BE
//
// v1 (MetaHuman Animator mode) layout:
//   version(1) + reserved(1) + uuid_len(2LE) + uuid(N)
//   + frame_number(4LE) + sub_frame(4LE float) + rate_num(4LE) + rate_den(4LE)
//   + (remaining-24) bytes as uint16LE blendshapes (÷32767 → 0-1)
//   + 6 × float32LE rotations (HeadYaw/Pitch/Roll, LeftEyeYaw/Pitch/Roll) in degrees

const PROTOCOL_ID = 'livelink-face';

const BLENDSHAPE_NAMES = [
  'EyeBlinkLeft','EyeLookDownLeft','EyeLookInLeft','EyeLookOutLeft','EyeLookUpLeft',
  'EyeSquintLeft','EyeWideLeft','EyeBlinkRight','EyeLookDownRight','EyeLookInRight',
  'EyeLookOutRight','EyeLookUpRight','EyeSquintRight','EyeWideRight',
  'JawForward','JawLeft','JawRight','JawOpen',
  'MouthClose','MouthFunnel','MouthPucker','MouthLeft','MouthRight',
  'MouthSmileLeft','MouthSmileRight','MouthFrownLeft','MouthFrownRight',
  'MouthDimpleLeft','MouthDimpleRight','MouthStretchLeft','MouthStretchRight',
  'MouthRollLower','MouthRollUpper','MouthShrugLower','MouthShrugUpper',
  'MouthPressLeft','MouthPressRight','MouthLowerDownLeft','MouthLowerDownRight',
  'MouthUpperUpLeft','MouthUpperUpRight',
  'BrowDownLeft','BrowDownRight','BrowInnerUp','BrowOuterUpLeft','BrowOuterUpRight',
  'CheekPuff','CheekSquintLeft','CheekSquintRight',
  'NoseSneerLeft','NoseSneerRight',
  'TongueOut',
  // Head rotation (Euler, radians)
  'HeadYaw','HeadPitch','HeadRoll',
  // Eye rotations
  'LeftEyeYaw','LeftEyePitch','LeftEyeRoll',
  'RightEyeYaw','RightEyePitch','RightEyeRoll',
];

function parseV1(buf) {
  let o = 0;
  o++; // version
  o++; // reserved

  if (o + 2 > buf.length) return null;
  const uuidLen = buf.readUInt16LE(o); o += 2;
  if (o + uuidLen > buf.length) return null;
  const uuid = buf.toString('utf8', o, o + uuidLen); o += uuidLen;

  if (o + 16 > buf.length) return null;
  const frameNumber = buf.readUInt32LE(o); o += 4;
  o += 4; // sub_frame
  const frameRateNum = buf.readUInt32LE(o); o += 4;
  const frameRateDen = buf.readUInt32LE(o); o += 4;
  const frameRate = frameRateDen > 0 ? frameRateNum / frameRateDen : frameRateNum;

  // Blendshapes: uint16LE values ÷ 32767, then 6 float32LE rotations (24 bytes) at end
  const ROT_BYTES = 24;
  const bsBytes = buf.length - o - ROT_BYTES;
  if (bsBytes < 0 || bsBytes % 2 !== 0) return null;
  const bsCount = bsBytes / 2;

  // Read all values then trim trailing zeros
  const raw = [];
  for (let i = 0; i < bsCount; i++) { raw.push(buf.readUInt16LE(o + i * 2)); }
  let last = raw.length - 1;
  while (last > 0 && raw[last] === 0) last--;
  o += bsCount * 2;

  const blendshapes = {};
  for (let i = 0; i <= last; i++) {
    const name = BLENDSHAPE_NAMES[i] || `bs_${i}`;
    blendshapes[name] = raw[i] / 32767;
  }

  // Head + left-eye rotations in degrees
  blendshapes['HeadYaw']      = buf.readFloatLE(o);      o += 4;
  blendshapes['HeadPitch']    = buf.readFloatLE(o);      o += 4;
  blendshapes['HeadRoll']     = buf.readFloatLE(o);      o += 4;
  blendshapes['LeftEyeYaw']   = buf.readFloatLE(o);      o += 4;
  blendshapes['LeftEyePitch'] = buf.readFloatLE(o);      o += 4;
  blendshapes['LeftEyeRoll']  = buf.readFloatLE(o);

  return {
    format: PROTOCOL_ID,
    parsed: { deviceId: uuid, uuid, deviceName: '', frameNumber, frameRate, blendshapes },
  };
}

function parse(buf) {
  if (buf.length < 20) return null;
  let offset = 0;

  const version = buf.readUInt8(offset++);
  if (version === 1) return parseV1(buf);
  if (version !== 6) return null;

  // UUID: 4-byte BE length prefix + UTF-8 string
  if (offset + 4 > buf.length) return null;
  const uuidLen = buf.readUInt32BE(offset); offset += 4;
  if (offset + uuidLen > buf.length) return null;
  const uuid = buf.toString('utf8', offset, offset + uuidLen);
  offset += uuidLen;

  // Device name: 4-byte BE length prefix + UTF-8 string
  if (offset + 4 > buf.length) return null;
  const nameLen = buf.readUInt32BE(offset); offset += 4;
  if (offset + nameLen > buf.length) return null;
  const deviceName = buf.toString('utf8', offset, offset + nameLen);
  offset += nameLen;

  // Frame number (4 bytes BE)
  if (offset + 4 > buf.length) return null;
  const frameNumber = buf.readUInt32BE(offset); offset += 4;

  // Sub-frame float (4 bytes) — skip
  if (offset + 4 > buf.length) return null;
  offset += 4;

  // Frame rate: numerator (4 bytes BE) + denominator (4 bytes BE)
  if (offset + 8 > buf.length) return null;
  const frameRateNum = buf.readUInt32BE(offset); offset += 4;
  const frameRateDen = buf.readUInt32BE(offset); offset += 4;
  const frameRate = frameRateDen > 0 ? frameRateNum / frameRateDen : frameRateNum;

  // Blendshape count (1 byte)
  if (offset + 1 > buf.length) return null;
  const bsCount = buf.readUInt8(offset++);

  if (offset + bsCount * 4 > buf.length) return null;
  const blendshapes = {};
  for (let i = 0; i < bsCount; i++) {
    const name = BLENDSHAPE_NAMES[i] || `bs_${i}`;
    blendshapes[name] = buf.readFloatBE(offset); offset += 4;
  }

  return {
    format: PROTOCOL_ID,
    parsed: { deviceId: uuid, uuid, deviceName, frameNumber, frameRate, blendshapes },
  };
}

module.exports = { PROTOCOL_ID, parse };
