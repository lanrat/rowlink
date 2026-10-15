// FTMS (Fitness Machine Service) decoding for the Yosuda rower.
// Pure functions: no browser APIs, so they run in Node tests too.

export const UUID = {
  FTMS: 0x1826,
  DEVICE_INFO: 0x180a,
  ROWER_DATA: 0x2ad1,
  MACHINE_STATUS: 0x2ada,
  TRAINING_STATUS: 0x2ad3,
  CONTROL_POINT: 0x2ad9,
};

// Rower Data (0x2AD1) fields in wire order: [flag bit, key, bytes, signed, scale].
// Bit 0 ("More Data") is inverted: stroke rate + count are present when it is 0.
const ROWER_FIELDS = [
  [0, 'spm', 1, false, 0.5],
  [0, 'strokes', 2, false, 1],
  [1, 'avgSpm', 1, false, 0.5],
  [2, 'distance', 3, false, 1],
  [3, 'pace', 2, false, 1],
  [4, 'avgPace', 2, false, 1],
  [5, 'power', 2, true, 1],
  [6, 'avgPower', 2, true, 1],
  [7, 'resistance', 2, true, 1],
  [8, 'kcal', 2, false, 1],
  [8, 'kcalPerHour', 2, false, 1],
  [8, 'kcalPerMin', 1, false, 1],
  [9, 'heartRate', 1, false, 1],
  [10, 'met', 1, false, 0.1],
  [11, 'elapsed', 2, false, 1],
  [12, 'remaining', 2, false, 1],
];

function fieldPresent(flags, bit) {
  return bit === 0 ? (flags & 1) === 0 : ((flags >> bit) & 1) === 1;
}

function readInt(bytes, off, size, signed) {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + bytes[off + i];
  if (signed && v >= 2 ** (size * 8 - 1)) v -= 2 ** (size * 8);
  return v;
}

/** Decode one Rower Data notification. Raw values; invalid markers (0xFFFF pace) are left as-is. */
export function parseRowerData(bytes) {
  if (bytes.length < 2) return { flags: 0, moreData: false, fields: {}, truncated: true };
  const flags = bytes[0] | (bytes[1] << 8);
  const fields = {};
  let off = 2;
  let truncated = false;
  for (const [bit, key, size, signed, scale] of ROWER_FIELDS) {
    if (!fieldPresent(flags, bit)) continue;
    if (off + size > bytes.length) { truncated = true; break; }
    fields[key] = readInt(bytes, off, size, signed) * scale;
    off += size;
  }
  return { flags, moreData: (flags & 1) === 1, fields, truncated };
}

/** Encode Rower Data (used by the simulator and tests). Includes a field group only if its key is present. */
export function encodeRowerData(fields) {
  let flags = 0;
  if (!('spm' in fields)) flags |= 1;
  for (const [bit, key] of ROWER_FIELDS) if (bit > 0 && key in fields) flags |= 1 << bit;
  const out = [flags & 0xff, flags >> 8];
  for (const [bit, key, size, , scale] of ROWER_FIELDS) {
    if (!fieldPresent(flags, bit)) continue;
    let v = Math.round((fields[key] ?? 0) / scale);
    if (v < 0) v += 2 ** (size * 8);
    for (let i = 0; i < size; i++) { out.push(v & 0xff); v = Math.floor(v / 256); }
  }
  return Uint8Array.from(out);
}

const STATUS_OPS = {
  0x01: 'reset',
  0x02: 'stopped', // param: 1 = stopped by user, 2 = paused by user
  0x03: 'safety-stop',
  0x04: 'started',
};

/** Fitness Machine Status (0x2ADA). */
export function parseMachineStatus(bytes) {
  const op = bytes[0] ?? 0;
  const param = bytes.length > 1 ? bytes[1] : null;
  let event = STATUS_OPS[op] ?? 'other';
  if (op === 0x02) event = param === 0x02 ? 'paused' : 'stopped';
  return { op, param, event };
}

/** Training Status (0x2AD3). */
export function parseTrainingStatus(bytes) {
  return { flags: bytes[0] ?? 0, status: bytes[1] ?? 0 };
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
