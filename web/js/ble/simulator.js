// A fake Yosuda rower: same packet layout, quirks and noise as the real one,
// so the UI can be developed without rowing.
import { Emitter } from './emitter.js';
import { encodeRowerData } from '../protocol/ftms.js';

const PAUSE_AFTER_S = 4;

function gauss() {
  return Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
}

export class SimulatorTransport extends Emitter {
  constructor() {
    super();
    this.rowing = false;
    this.targetPace = 150; // s/500m
    this.targetSpm = 24;
    // the real rower's counters are usually non-zero when an app connects
    this.c = { distance: 40, strokes: 9, kcal: 2, elapsed: 18 };
    this.inst = { pace: 0, power: 0, spm: 0 };
    this.speed = 0; // m/s, set per stroke; distance accrues continuously like the real flywheel
    this.lastStrokeT = -99;
    this.nextStrokeT = 0;
    this.paused = true;
    this.firstStroke = true;
    this.timer = null;
  }

  now() {
    return performance.now() / 1000;
  }

  start() {
    this.emit('info', { name: 'Simulator' });
    this.emit('state', 'connected');
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), 100);
    this.nextReport = this.now() + 1;
  }

  /** Same contract as BleTransport.resetSession(): zero counters, answer with a "reset" status. */
  async resetSession() {
    this.c = { distance: 0, strokes: 0, kcal: 0, elapsed: 0 };
    this.paused = true;
    this.speed = 0;
    this.inst = { pace: 0, power: 0, spm: 0 };
    this.send('status', [0x01]);
  }

  /** Simulate someone pressing reset on the rower itself. */
  rowerReset() {
    this.resetSession();
  }

  setRowing(on) {
    this.rowing = on;
    if (on) this.nextStrokeT = this.now() + 0.3;
  }

  tick() {
    const t = this.now();
    if (!this.paused) this.c.distance += this.speed * (t - this.lastTick);
    this.lastTick = t;
    if (this.rowing && t >= this.nextStrokeT) this.stroke(t);
    if (!this.paused && t - this.lastStrokeT > PAUSE_AFTER_S) {
      this.paused = true;
      this.speed = 0;
      this.inst = { pace: 0, power: 0, spm: 0 };
      this.send('status', [0x02, 0x02]);
    }
    if (t >= this.nextReport) {
      this.nextReport += 1;
      if (!this.paused) this.c.elapsed += 1;
      this.report(t);
    }
  }

  stroke(t) {
    const interval = (60 / this.targetSpm) * (1 + 0.05 * gauss());
    this.nextStrokeT = t + interval;
    if (this.paused) {
      this.paused = false;
      this.firstStroke = true;
      this.send('status', [0x04]);
    }
    this.speed = Math.max(0, (500 / this.targetPace) * (1 + 0.08 * gauss()));
    this.c.strokes += 1;
    if (Math.random() < interval / 6) this.c.kcal += 1;
    if (this.firstStroke) {
      // real rower: first stroke after a pause reports no pace and a power spike
      this.inst = { pace: 0xffff, power: 400 + Math.round(Math.random() * 50), spm: 46 };
      this.firstStroke = false;
    } else {
      // real rower: instantaneous pace/power swing about +/-25% stroke to stroke
      const pace = Math.round(this.targetPace * (1 + 0.25 * gauss()));
      this.inst = {
        pace: Math.min(900, Math.max(90, pace)),
        power: Math.round((2.8 / (pace / 500) ** 3) * (1 + 0.2 * gauss())),
        spm: Math.round(this.targetSpm * 2 * (1 + 0.05 * gauss())) / 2,
      };
    }
    this.lastStrokeT = t;
  }

  report() {
    const { distance, strokes, kcal, elapsed } = this.c;
    this.send('rower', encodeRowerData({
      avgSpm: this.targetSpm, distance: Math.floor(distance), pace: this.inst.pace, avgPace: this.targetPace,
      power: Math.max(0, this.inst.power), avgPower: 100,
    }));
    this.send('rower', encodeRowerData({
      spm: this.inst.spm, strokes, kcal, kcalPerHour: 0, kcalPerMin: 0, elapsed,
    }));
  }

  send(char, bytes) {
    this.emit('packet', { t: this.now(), char, bytes: Uint8Array.from(bytes) });
  }

  disconnect() {
    clearInterval(this.timer);
    this.emit('state', 'disconnected');
  }
}
