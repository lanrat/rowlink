// Builds a saved-session record from the pipeline's 1 Hz views.
// Pure: no browser APIs, so exports can be tested in Node.

import { MIN_SAVE_DISTANCE_M } from '../pipeline/index.js';

export const SESSION_VERSION = 1;

const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null || !isFinite(x) ? null : Math.round(x));

export class Recorder {
  /**
   * @param {object} o
   * @param {number} o.startedAt epoch ms of the first stroke
   * @param {string} o.source 'ble' | 'simulator' | 'replay'
   * @param {string} [o.device] rower name
   * @param {string} [o.kcalSource] 'rower' | 'estimate'
   */
  constructor({ startedAt, source, device = '', kcalSource = 'rower' }) {
    this.id = new Date(startedAt).toISOString();
    this.startedAt = startedAt;
    this.source = source;
    this.device = device;
    this.kcalSource = kcalSource;
    this.samples = [];
    this.last = null;
  }

  /** @param view pipeline.view(); @param epochMs wall-clock time of that view */
  add(view, epochMs) {
    this.samples.push({
      t: r1((epochMs - this.startedAt) / 1000), // wall-clock seconds since start
      mv: r1(view.movingS),
      d: r0(view.distance),
      k: r0(view.strokes),
      r: r1(view.spm),
      p: r1(view.pace),
      w: r0(view.power),
      c: r1(view.kcal),
      n: view.knob,
      z: view.state === 'paused' ? 1 : 0,
    });
    this.last = { view, epochMs };
  }

  get distance() {
    return this.last?.view.distance ?? 0;
  }

  get worthSaving() {
    return this.distance >= MIN_SAVE_DISTANCE_M;
  }

  /** @returns {{session:object, data:object}} summary record + bulky per-second data */
  build({ complete = true, raw = [] } = {}) {
    const v = this.last?.view;
    const active = this.samples.filter((s) => !s.z);
    const max = (key) => active.reduce((m, s) => (s[key] != null && s[key] > m ? s[key] : m), 0) || null;
    const mean = (key) => {
      const vals = active.map((s) => s[key]).filter((x) => x != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const knobs = [...new Set(this.samples.map((s) => s.n))];
    const session = {
      id: this.id,
      version: SESSION_VERSION,
      complete,
      startedAt: this.startedAt,
      endedAt: this.last?.epochMs ?? this.startedAt,
      source: this.source,
      device: this.device,
      summary: {
        distanceM: r0(v?.distance ?? 0),
        movingS: r1(v?.movingS ?? 0),
        totalS: r1(this.samples.at(-1)?.t ?? 0),
        strokes: r0(v?.strokes ?? 0),
        kcal: r1(v?.kcal ?? 0),
        kcalSource: this.kcalSource,
        avgPaceS: r1(v?.avgPace),
        avgSpm: r1(v?.avgSpm),
        avgPowerW: r0(v?.avgPower ?? mean('w')),
        maxPowerW: max('w'),
        maxSpm: max('r'),
        bestPaceS: active.reduce((m, s) => (s.p != null && (m == null || s.p < m) ? s.p : m), null),
        knobs,
      },
    };
    return { session, data: { id: this.id, samples: this.samples, raw } };
  }
}
