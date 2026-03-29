// LiveLink Face UDP packet parser (Node.js server-side)
// Packet format: ARKit 52 blendshapes sent by LiveLink Face iOS app
// Reference: https://docs.unrealengine.com/5.0/en-US/live-link-face/

const PROTOCOL_ID = 'livelink-face';

// Blendshape names in packet order
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

function parse(buf) {
  // Minimum length check: version(1) + uuid(varies) + name(varies) + frameRate + data
  if (buf.length < 20) return null;

  let offset = 0;

  // Version byte
  const version = buf.readUInt8(offset++);
  if (version !== 6) return null; // LiveLink Face sends version 6

  // UUID string (36 chars: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  const uuidLen = buf.readUInt8(offset++);
  if (offset + uuidLen > buf.length) return null;
  const uuid = buf.toString('utf8', offset, offset + uuidLen);
  offset += uuidLen;

  // Device name
  const nameLen = buf.readUInt8(offset++);
  if (offset + nameLen > buf.length) return null;
  const deviceName = buf.toString('utf8', offset, offset + nameLen);
  offset += nameLen;

  // Frame number (4 bytes)
  if (offset + 4 > buf.length) return null;
  const frameNumber = buf.readUInt32BE(offset); offset += 4;

  // Frame rate (4 bytes)
  if (offset + 4 > buf.length) return null;
  const frameRate = buf.readUInt32BE(offset); offset += 4;

  // Blendshape count (1 byte)
  if (offset + 1 > buf.length) return null;
  const bsCount = buf.readUInt8(offset++);

  // Read blendshape float values
  if (offset + bsCount * 4 > buf.length) return null;
  const blendshapes = {};
  for (let i = 0; i < bsCount; i++) {
    const name = BLENDSHAPE_NAMES[i] || `bs_${i}`;
    blendshapes[name] = buf.readFloatBE(offset); offset += 4;
  }

  return {
    format: PROTOCOL_ID,
    parsed: {
      deviceId: uuid,
      uuid,
      deviceName,
      frameNumber,
      frameRate,
      blendshapes,
    },
  };
}

module.exports = { PROTOCOL_ID, parse };
