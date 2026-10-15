// Minimal FIT activity encoder (Garmin FIT protocol), enough for Garmin Connect,
// Strava and similar tools: file_id, timer events, 1 Hz records, one lap, session, activity.
// Field numbers and types follow the FIT profile; tests decode the output with
// Garmin's own SDK to check it.

const FIT_EPOCH_S = 631065600; // 1989-12-31T00:00:00Z
const PROFILE_VERSION = 2100;

const BASE = {
  enum: { id: 0x00, size: 1, invalid: 0xff, min: 0, max: 0xfe },
  uint8: { id: 0x02, size: 1, invalid: 0xff, min: 0, max: 0xfe },
  uint16: { id: 0x84, size: 2, invalid: 0xffff, min: 0, max: 0xfffe },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff, min: 0, max: 0xfffffffe },
  uint32z: { id: 0x8c, size: 4, invalid: 0, min: 1, max: 0xffffffff },
};

// FIT enum values used here
const MESG = { FILE_ID: 0, SESSION: 18, LAP: 19, RECORD: 20, EVENT: 21, ACTIVITY: 34 };
const FILE_ACTIVITY = 4;
const MANUFACTURER_DEVELOPMENT = 255;
const EVENT = { TIMER: 0, SESSION: 8, LAP: 9, ACTIVITY: 26 };
const EVENT_TYPE = { START: 0, STOP: 1, STOP_ALL: 4 };
const SPORT_ROWING = 15;
const SUB_SPORT_INDOOR_ROWING = 14;
const LAP_TRIGGER_SESSION_END = 7;
const LAP_TRIGGER_MANUAL = 0;
const INTENSITY = { active: 0, rest: 1, warmup: 2, cooldown: 3, recovery: 4, interval: 5 };
const SESSION_TRIGGER_ACTIVITY_END = 0;
const ACTIVITY_MANUAL = 0;

// [field number, base type, scale]
const FIELDS = {
  [MESG.FILE_ID]: { type: [0, 'enum'], manufacturer: [1, 'uint16'], product: [2, 'uint16'], serialNumber: [3, 'uint32z'], timeCreated: [4, 'uint32'] },
  [MESG.EVENT]: { timestamp: [253, 'uint32'], event: [0, 'enum'], eventType: [1, 'enum'] },
  [MESG.RECORD]: {
    timestamp: [253, 'uint32'], distance: [5, 'uint32', 100], speed: [6, 'uint16', 1000], power: [7, 'uint16'],
    cadence: [4, 'uint8'], resistance: [10, 'uint8'], calories: [33, 'uint16'],
  },
  [MESG.LAP]: {
    messageIndex: [254, 'uint16'], timestamp: [253, 'uint32'], event: [0, 'enum'], eventType: [1, 'enum'],
    startTime: [2, 'uint32'], totalElapsedTime: [7, 'uint32', 1000], totalTimerTime: [8, 'uint32', 1000],
    totalDistance: [9, 'uint32', 100], totalCycles: [10, 'uint32'], totalCalories: [11, 'uint16'],
    avgSpeed: [13, 'uint16', 1000], maxSpeed: [14, 'uint16', 1000], avgPower: [19, 'uint16'], maxPower: [20, 'uint16'],
    avgCadence: [17, 'uint8'], maxCadence: [18, 'uint8'], sport: [25, 'enum'], subSport: [39, 'enum'], lapTrigger: [24, 'enum'],
    intensity: [23, 'enum'],
  },
  [MESG.SESSION]: {
    messageIndex: [254, 'uint16'], timestamp: [253, 'uint32'], event: [0, 'enum'], eventType: [1, 'enum'],
    startTime: [2, 'uint32'], sport: [5, 'enum'], subSport: [6, 'enum'], totalElapsedTime: [7, 'uint32', 1000],
    totalTimerTime: [8, 'uint32', 1000], totalDistance: [9, 'uint32', 100], totalCycles: [10, 'uint32'],
    totalCalories: [11, 'uint16'], avgSpeed: [14, 'uint16', 1000], maxSpeed: [15, 'uint16', 1000],
    avgPower: [20, 'uint16'], maxPower: [21, 'uint16'], avgCadence: [18, 'uint8'], maxCadence: [19, 'uint8'],
    firstLapIndex: [25, 'uint16'], numLaps: [26, 'uint16'], trigger: [28, 'enum'],
  },
  [MESG.ACTIVITY]: {
    timestamp: [253, 'uint32'], totalTimerTime: [0, 'uint32', 1000], numSessions: [1, 'uint16'], type: [2, 'enum'],
    event: [3, 'enum'], eventType: [4, 'enum'], localTimestamp: [5, 'uint32'],
  },
};

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

function crc16(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

function pushInt(out, value, size) {
  for (let i = 0; i < size; i++) {
    out.push(value & 0xff);
    value = Math.floor(value / 256);
  }
}

class FitWriter {
  constructor() {
    this.data = [];
    this.local = new Map(); // global message number -> local message type (one definition per message type)
  }

  write(mesgNum, values) {
    const defs = Object.entries(FIELDS[mesgNum]);
    if (!this.local.has(mesgNum)) {
      const local = this.local.size;
      this.local.set(mesgNum, local);
      this.data.push(0x40 | local, 0, 0); // definition header, reserved, little-endian
      pushInt(this.data, mesgNum, 2);
      this.data.push(defs.length);
      for (const [, [num, base]] of defs) this.data.push(num, BASE[base].size, BASE[base].id);
    }
    this.data.push(this.local.get(mesgNum));
    for (const [name, [, base, scale = 1]] of defs) {
      const b = BASE[base];
      const v = values[name];
      // valid values are clamped into range so they never collide with the type's "invalid" marker
      const raw = v == null || !isFinite(v) ? b.invalid : Math.min(Math.max(Math.round(v * scale), b.min), b.max);
      pushInt(this.data, raw, b.size);
    }
  }

  bytes() {
    const header = [14, 0x20];
    pushInt(header, PROFILE_VERSION, 2);
    pushInt(header, this.data.length, 4);
    header.push(...'.FIT'.split('').map((c) => c.charCodeAt(0)));
    pushInt(header, crc16(header), 2);
    const file = [...header, ...this.data];
    pushInt(file, crc16(file), 2);
    return Uint8Array.from(file);
  }
}

const fitTime = (epochMs) => Math.floor(epochMs / 1000) - FIT_EPOCH_S;

/** One lap per workout step (samples carry the step index `g`); one lap for free rowing. */
function lapsFor(session, samples) {
  const groups = [];
  for (const p of samples) {
    const g = p.g ?? 0;
    if (!groups.length || groups.at(-1).g !== g) groups.push({ g, samples: [] });
    groups.at(-1).samples.push(p);
  }
  const steps = session.workout?.steps ?? [];
  let prev = { t: 0, mv: 0, d: 0, k: 0, c: 0 };
  return groups.map(({ g, samples: ps }) => {
    const last = ps.at(-1);
    const active = ps.filter((p) => !p.z);
    const mean = (k) => {
      const v = active.map((p) => p[k]).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const maxOf = (k) => active.reduce((m, p) => (p[k] != null && (m == null || p[k] > m) ? p[k] : m), null);
    const bestPace = active.reduce((m, p) => (p.p != null && (m == null || p.p < m) ? p.p : m), null);
    const distance = (last.d ?? 0) - (prev.d ?? 0);
    const moving = (last.mv ?? 0) - (prev.mv ?? 0);
    const step = steps[g];
    const lap = {
      timestamp: fitTime(session.startedAt + last.t * 1000),
      startTime: fitTime(session.startedAt + prev.t * 1000),
      totalElapsedTime: last.t - prev.t,
      totalTimerTime: moving,
      totalDistance: distance,
      totalCycles: (last.k ?? 0) - (prev.k ?? 0),
      totalCalories: (last.c ?? 0) - (prev.c ?? 0),
      avgSpeed: moving > 0 ? distance / moving : null,
      maxSpeed: bestPace ? 500 / bestPace : null,
      avgPower: mean('w'),
      maxPower: maxOf('w'),
      avgCadence: mean('r'),
      maxCadence: maxOf('r'),
      intensity: step ? INTENSITY[step.type === 'rest' ? 'rest' : step.intensity ?? 'active'] : INTENSITY.active,
    };
    prev = last;
    return lap;
  });
}

/** Knob 1-16 -> FIT "resistance" (relative, 0-254). */
export const knobToFitResistance = (knob, maxKnob = 16) => Math.round((knob / maxKnob) * 254);

/**
 * @param session saved session (see Recorder.build)
 * @param data {samples}
 * @returns {Uint8Array}
 */
export function encodeFit(session, data) {
  const w = new FitWriter();
  const start = session.startedAt;
  const samples = data.samples;
  const end = start + (samples.at(-1)?.t ?? 0) * 1000;
  const s = session.summary;
  const speed = (pace) => (pace ? 500 / pace : null);

  w.write(MESG.FILE_ID, {
    type: FILE_ACTIVITY, manufacturer: MANUFACTURER_DEVELOPMENT, product: 1,
    serialNumber: Math.floor(start / 1000) % 0xfffffff0 || 1, timeCreated: fitTime(start),
  });
  w.write(MESG.EVENT, { timestamp: fitTime(start), event: EVENT.TIMER, eventType: EVENT_TYPE.START });

  let paused = false;
  for (const p of samples) {
    const ts = fitTime(start + p.t * 1000);
    if (p.z && !paused) w.write(MESG.EVENT, { timestamp: ts, event: EVENT.TIMER, eventType: EVENT_TYPE.STOP_ALL });
    if (!p.z && paused) w.write(MESG.EVENT, { timestamp: ts, event: EVENT.TIMER, eventType: EVENT_TYPE.START });
    paused = !!p.z;
    w.write(MESG.RECORD, {
      timestamp: ts, distance: p.d, speed: p.z ? 0 : speed(p.p), power: p.z ? 0 : p.w,
      cadence: p.z ? 0 : p.r, resistance: knobToFitResistance(p.n), calories: p.c,
    });
  }
  w.write(MESG.EVENT, { timestamp: fitTime(end), event: EVENT.TIMER, eventType: EVENT_TYPE.STOP_ALL });

  const totals = {
    timestamp: fitTime(end), startTime: fitTime(start), totalElapsedTime: s.totalS, totalTimerTime: s.movingS,
    totalDistance: s.distanceM, totalCycles: s.strokes, totalCalories: s.kcal, avgSpeed: speed(s.avgPaceS),
    maxSpeed: speed(s.bestPaceS), avgPower: s.avgPowerW, maxPower: s.maxPowerW, avgCadence: s.avgSpm,
    maxCadence: s.maxSpm, sport: SPORT_ROWING, subSport: SUB_SPORT_INDOOR_ROWING,
  };
  const laps = lapsFor(session, samples);
  laps.forEach((lap, i) => w.write(MESG.LAP, {
    ...lap, messageIndex: i, event: EVENT.LAP, eventType: EVENT_TYPE.STOP, sport: SPORT_ROWING, subSport: SUB_SPORT_INDOOR_ROWING,
    lapTrigger: laps.length > 1 ? LAP_TRIGGER_MANUAL : LAP_TRIGGER_SESSION_END,
  }));
  w.write(MESG.SESSION, {
    ...totals, messageIndex: 0, event: EVENT.SESSION, eventType: EVENT_TYPE.STOP,
    firstLapIndex: 0, numLaps: laps.length, trigger: SESSION_TRIGGER_ACTIVITY_END,
  });
  const tzOffsetS = -new Date(end).getTimezoneOffset() * 60;
  w.write(MESG.ACTIVITY, {
    timestamp: fitTime(end), totalTimerTime: s.movingS, numSessions: 1, type: ACTIVITY_MANUAL,
    event: EVENT.ACTIVITY, eventType: EVENT_TYPE.STOP, localTimestamp: fitTime(end) + tzOffsetS,
  });
  return w.bytes();
}
