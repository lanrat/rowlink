import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hexToBytes } from '../js/protocol/ftms.js';
import { RowerPipeline } from '../js/pipeline/index.js';

const CAPTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'captures');

export function loadCapture(name) {
  return readFileSync(join(CAPTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Feed a capture through the pipeline; returns one view per 1 Hz sample. */
export function replay(name, settings) {
  const p = new RowerPipeline(settings);
  p.setConnection('connected');
  const views = [];
  for (const r of loadCapture(name)) {
    if (r.c === 'EVENT_DISCONNECTED') p.setConnection('reconnecting');
    else if (r.c === 'EVENT_CONNECTED') p.setConnection('connected');
    else if (r.c.startsWith('EVENT_')) continue;
    else if (p.packet({ t: r.t, char: r.c, bytes: hexToBytes(r.hex) })) views.push({ t: r.t, w: r.w, ...p.view(r.t) });
  }
  return { pipeline: p, views };
}

/** Replay a capture into a saved-session record, as the app would after Finish. */
export async function replayToSession(name, { startedAt = Date.UTC(2026, 9, 15, 7, 30) } = {}) {
  const { Recorder } = await import('../js/session/recorder.js');
  const p = new RowerPipeline();
  p.setConnection('connected');
  let rec = null;
  let t0 = null;
  for (const r of loadCapture(name)) {
    if (r.c.startsWith('EVENT_')) continue;
    if (!p.packet({ t: r.t, char: r.c, bytes: hexToBytes(r.hex) })) continue;
    if (!p.clock.started) continue;
    t0 ??= p.clock.startT;
    rec ??= new Recorder({ startedAt, source: 'replay', device: 'YOSUDA-RM-test' });
    rec.add(p.view(r.t), startedAt + (r.t - t0) * 1000);
  }
  return rec;
}
