// Packet stream -> display view. Pure: time is always passed in, so the same
// code runs live, on replayed captures, and in Node tests.

import { parseRowerData, parseMachineStatus } from '../protocol/ftms.js';
import { Assembler } from './assembler.js';
import { Sanitizer } from './sanitize.js';
import { Metrics } from './metrics.js';
import { SessionClock } from '../session/clock.js';

// FED's app discards sessions shorter than this rather than saving them.
export const MIN_SAVE_DISTANCE_M = 20;
// After the app resets the rower, ignore the rower's own "reset" status for this long.
const OWN_RESET_WINDOW_S = 5;

export const DEFAULT_SETTINGS = {
  paceWindowS: 15,
  spmWindowS: 15,
  powerWindowS: 10,
  adaptive: { shortS: 10, threshold: 0.2, alphaFast: 0.3, persist: 2 },
  weightKg: 75,
  calorieSource: 'rower', // 'rower' | 'estimate'
  maxKnob: 16,
  defaultKnob: 6,
};

export class RowerPipeline {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.connection = 'disconnected';
    this.suppressResetUntil = -Infinity;
    this.reset();
  }

  /** Start a new session; keeps the connection and knob. */
  reset() {
    this.assembler = new Assembler();
    this.sanitizer = new Sanitizer();
    this.metrics = new Metrics(this.settings);
    this.clock = new SessionClock();
    this.base = null; // counter values when the session started
    this.sample = null;
    this.events = [];
    this.knob ??= this.settings.defaultKnob;
  }

  /** The app is about to reset the rower: don't treat the rower's reset status as the user ending the session. */
  expectReset(t) {
    this.suppressResetUntil = t + OWN_RESET_WINDOW_S;
  }

  /** Events since the last call, e.g. 'rower-reset' (someone reset the rower: the session has ended). */
  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  setKnob(level) {
    this.knob = Math.min(this.settings.maxKnob, Math.max(1, Math.round(level)));
  }

  setConnection(state) {
    if (state === 'connected' && this.connection !== 'connected') {
      this.assembler.reset();
      this.sanitizer.onReconnect();
    }
    this.connection = state;
  }

  /**
   * @param {{t:number, char:string, bytes:Uint8Array}} pkt
   * @returns {boolean} true if a new 1 Hz sample was produced
   */
  packet(pkt) {
    if (pkt.char === 'status') {
      const { event } = parseMachineStatus(pkt.bytes);
      if (event === 'reset') {
        if (pkt.t >= this.suppressResetUntil) this.events.push('rower-reset');
      } else {
        this.sanitizer.onStatus(event);
      }
      return false;
    }
    if (pkt.char !== 'rower') return false;
    const frame = this.assembler.push(pkt.t, parseRowerData(pkt.bytes));
    if (!frame) return false;

    const sample = this.sanitizer.process(frame);
    if (this.clock.onSample(sample)) {
      this.base = { distance: sample.distance, strokes: sample.strokes, kcal: sample.kcal };
      this.metrics = new Metrics(this.settings);
    }
    this.metrics.update(sample, {
      knob: this.knob,
      maxKnob: this.settings.maxKnob,
      weightKg: this.settings.weightKg,
    });
    this.sample = sample;
    return true;
  }

  view(now) {
    const s = this.sample;
    const started = this.clock.started;
    const rel = (key) => (s && started ? s[key] - this.base[key] : 0);
    const distance = rel('distance');
    const strokes = rel('strokes');
    const movingS = this.clock.movingNow(now);
    const active = started && this.clock.state === 'active';
    const kcalRower = rel('kcal');
    const kcalEstimate = this.metrics.kcalEstimate;
    return {
      connection: this.connection,
      state: this.clock.state,
      totalS: this.clock.totalS(now),
      movingS,
      distance,
      strokes,
      pace: active ? this.metrics.pace() : null,
      spm: active ? this.metrics.spm() : null,
      power: active ? this.metrics.powerW() : null,
      avgPace: distance > 0 ? (500 * movingS) / distance : null,
      avgSpm: movingS > 0 ? strokes / (movingS / 60) : null,
      avgPower: this.metrics.avgPowerW(),
      kcal: this.settings.calorieSource === 'estimate' ? kcalEstimate : kcalRower,
      kcalRower,
      kcalEstimate,
      knob: this.knob,
      worthSaving: distance >= MIN_SAVE_DISTANCE_M,
      raw: s ? { pace: s.raw.pace, power: s.raw.power, spm: s.raw.spm, elapsed: s.raw.elapsed } : null,
    };
  }
}
