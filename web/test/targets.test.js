import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetResults, GRACE_S } from '../js/session/targets.js';
import { timeline, WorkoutRun } from '../js/workout/engine.js';

/** samples for one step: n seconds at constant pace/spm, continuing moving time from `mv0` */
const rows = (g, n, pace, spm, mv0 = 0) => Array.from({ length: n }, (_, i) => ({ g, mv: mv0 + i, p: pace, r: spm, z: 0 }));

test('no targets: no results', () => {
  assert.equal(targetResults([{ type: 'row', durationS: 60 }], rows(0, 60, 120, 24)), null);
});

test('scores pace and rate per step and overall, skipping the first seconds of each step', () => {
  const steps = [
    { type: 'row', label: 'A', paceRange: [110, 120], spm: [24, 26] },
    { type: 'rest', label: 'R' },
    { type: 'row', label: 'B', paceRange: [100, 110], spm: [28, 30] },
  ];
  const samples = [
    // A: first GRACE_S seconds way off (ignored), then 30 s on target
    ...rows(0, GRACE_S, 200, 18, 0), ...rows(0, 30, 115, 25, GRACE_S),
    ...rows(1, 20, null, null, 40).map((p) => ({ ...p, z: 1 })),
    // B: 10 s grace, then 20 s too slow at the right rate, 20 s on pace
    ...rows(2, GRACE_S, 130, 29, 40), ...rows(2, 20, 125, 29, 40 + GRACE_S), ...rows(2, 20, 105, 29, 60 + GRACE_S),
  ];
  const r = targetResults(steps, samples);
  assert.equal(r.steps[0].pace.onPct, 100);
  assert.equal(r.steps[0].spm.onPct, 100);
  assert.equal(r.steps[1].pace, null, 'rests are not scored');
  assert.equal(r.steps[2].pace.onPct, 50);
  assert.equal(r.steps[2].spm.onPct, 100);
  assert.equal(r.pace.onPct, (100 * (30 + 20)) / (30 + 40));
  assert.equal(r.spm.scored, 70);
  assert.ok(Math.abs(r.steps[0].pace.avg - (GRACE_S * 200 + 30 * 115) / (GRACE_S + 30)) < 1e-9, 'average includes the whole step');
});

test('rate tolerance matches the live outline (half a stroke)', () => {
  const r = targetResults([{ type: 'row', spm: [24, 26] }], [...rows(0, GRACE_S, 25, 25), ...rows(0, 10, 23.5, 23.5, GRACE_S), ...rows(0, 10, 23.4, 23.4, GRACE_S + 10)]);
  assert.equal(r.steps[0].spm.onPct, 50);
});

test('timeline blocks are sized by planned time and cover 0..1', () => {
  const blocks = timeline([{ durationS: 60 }, { durationS: 120 }, { distanceM: 500 }], 120); // 500 m at 2:00 = 120 s
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[0, 0.2], [0.2, 0.6], [0.6, 1]]);
});

test('overall progress and time left through a workout', () => {
  const run = new WorkoutRun({ segments: [{ type: 'row', durationS: 60 }, { type: 'rest', durationS: 60 }, { type: 'row', distanceM: 500 }] });
  const v = (movingS, distance, pace = 120) => ({ state: 'active', movingS, distance, pace, spm: 24 });
  assert.deepEqual(run.overall(v(0, 0), 0, 120), { fraction: 0, remainingS: 240, totalS: 240 }); // 500 m at 2:00 = 120 s
  run.update(v(1, 0), 1);
  run.update(v(31, 120), 31); // half way through step 1
  const mid = run.overall(v(31, 120), 31, 120);
  assert.ok(Math.abs(mid.fraction - 30 / 240) < 0.01, `fraction ${mid.fraction}`);
  assert.ok(Math.abs(mid.remainingS - 210) < 1, `left ${mid.remainingS}`);
  assert.equal(mid.totalS, 240);
});
