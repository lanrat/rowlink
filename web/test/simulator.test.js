import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatorTransport } from '../js/ble/simulator.js';
import { RowerPipeline } from '../js/pipeline/index.js';
import { parseRowerData } from '../js/protocol/ftms.js';

/** Seeded Math.random for the duration of fn, so the simulator's noise is reproducible. */
function withSeed(seed, fn) {
  const orig = Math.random;
  let a = seed;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

/** Row a 4 x 4 min workout with 1 min rests on the simulator, on a fake clock. */
function rowIntervals(pace, spm) {
  let now = 0;
  const sim = new (class extends SimulatorTransport {
    now() {
      return now;
    }
  })();
  const p = new RowerPipeline();
  p.setConnection('connected');
  const views = [];
  const raw = [];
  sim.on('packet', (pkt) => {
    if (pkt.char === 'rower') raw.push(parseRowerData(pkt.bytes).fields.power);
    if (p.packet(pkt)) views.push(p.view(pkt.t));
  });
  sim.lastTick = 0;
  sim.nextReport = 1;
  sim.resetSession();
  sim.targetPace = pace;
  sim.targetSpm = spm;
  const run = (s) => {
    for (let i = 0; i < s * 10; i++) {
      now += 0.1;
      sim.tick();
    }
  };
  for (let i = 0; i < 4; i++) {
    sim.setRowing(true);
    run(240);
    sim.setRowing(false);
    run(60);
  }
  return { views, raw: raw.filter((w) => w != null) };
}

const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)];

for (const [pace, spm] of [[120, 18], [120, 26], [170, 22]]) {
  test(`simulator at ${pace} s/500m, ${spm} spm: power is steady and plausible`, () => {
    withSeed(pace * 100 + spm, () => {
      const { views, raw } = rowIntervals(pace, spm);
      const nominal = 2.8 * (500 / pace) ** 3; // Concept2 watts for this pace
      const power = views.map((v) => v.power).filter((w) => w != null);
      const steps = views.slice(1).flatMap((v, i) => (v.power != null && views[i].power != null ? [Math.abs(v.power - views[i].power)] : []));
      // raw power: the 400-450 W first stroke after each rest, otherwise within ~2x of nominal
      assert.ok(pct(raw, 0.99) < Math.max(460, nominal * 2), `raw p99 ${pct(raw, 0.99)} W`);
      assert.ok(Math.max(...power) < nominal * 1.6, `shown max ${Math.round(Math.max(...power))} W vs ${Math.round(nominal)} W`);
      const avg = views.at(-1).avgPower;
      assert.ok(Math.abs(avg - nominal) / nominal < 0.2, `avg ${Math.round(avg)} W vs ${Math.round(nominal)} W`);
      assert.ok(pct(steps, 0.95) < nominal * 0.2, `p95 second-to-second change ${Math.round(pct(steps, 0.95))} W`);
    });
  });
}
