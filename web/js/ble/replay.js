// Plays back a capture (.jsonl of {t, c, hex}) as if it came from the rower.
import { Emitter } from './emitter.js';
import { hexToBytes } from '../protocol/ftms.js';

export function parseCapture(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => typeof r.t === 'number' && typeof r.c === 'string');
}

export class ReplayTransport extends Emitter {
  constructor(records, { speed = 1 } = {}) {
    super();
    this.records = records;
    this.speed = speed;
    this.index = 0;
    this.t0 = records[0]?.t ?? 0;
    this.timer = null;
  }

  /** capture time currently being played */
  now() {
    if (this.endedAt != null) return this.endedAt;
    return this.startVt + ((performance.now() - this.startWall) / 1000) * this.speed;
  }

  start() {
    this.startWall = performance.now();
    this.startVt = this.t0;
    this.emit('info', { name: 'Replay' });
    this.emit('state', 'connected');
    this.timer = setInterval(() => this.pump(), 50);
  }

  /** Replays can't be reset; the capture already contains whatever happened. */
  async resetSession() {}

  setSpeed(speed) {
    this.startVt = this.now();
    this.startWall = performance.now();
    this.speed = speed;
  }

  pump() {
    const vt = this.now();
    while (this.index < this.records.length && this.records[this.index].t <= vt) {
      const r = this.records[this.index++];
      if (r.c === 'EVENT_DISCONNECTED') this.emit('state', 'reconnecting');
      else if (r.c === 'EVENT_CONNECTED') this.emit('state', 'connected');
      else if (!r.c.startsWith('EVENT_')) this.emit('packet', { t: r.t, char: r.c, bytes: hexToBytes(r.hex) });
    }
    if (this.index >= this.records.length) {
      // keep the final numbers on screen; the user disconnects when done
      this.endedAt = this.records[this.records.length - 1].t;
      clearInterval(this.timer);
      this.emit('ended');
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.emit('state', 'disconnected');
  }

  disconnect() {
    this.stop();
  }
}
