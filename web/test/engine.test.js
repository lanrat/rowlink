import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutRun, flatten, isHard, KNOB_PROMPT_S } from '../js/workout/engine.js';
import { PRESETS } from '../js/workout/presets.js';

/** Simulated rowing: 1 view per second. speed in m/s; `rows(t)` says whether rowing at wall second t. */
function simulate(run, { seconds, speed = 3, rows = () => true }) {
  const log = [];
  let movingS = 0;
  let distance = 0;
  for (let t = 0; t <= seconds; t++) {
    const active = rows(t);
    if (t > 0 && active) {
      movingS += 1;
      distance += speed;
    }
    const view = { state: t === 0 ? 'idle' : active ? 'active' : 'paused', movingS, distance, pace: active ? 500 / speed : null, spm: 24 };
    for (const e of run.update(view, t)) log.push({ t, ...e, step: e.step?.label });
  }
  return log;
}

test('presets are all valid', () => {
  assert.ok(PRESETS.length >= 12);
  const ids = new Set();
  for (const w of PRESETS) {
    assert.ok(!ids.has(w.id), `duplicate id ${w.id}`);
    ids.add(w.id);
    const steps = flatten(w);
    assert.ok(steps.length > 0, w.id);
    for (const s of steps) {
      assert.ok(['row', 'rest'].includes(s.type), `${w.id}: type`);
      assert.ok((s.durationS > 0) !== (s.distanceM > 0), `${w.id}: exactly one of durationS/distanceM`);
      if (s.knob != null) assert.ok(Number.isInteger(s.knob) && s.knob >= 1 && s.knob <= 16, `${w.id}: knob ${s.knob}`);
      if (s.spm) assert.ok(s.spm[0] < s.spm[1], `${w.id}: spm range`);
      if (s.pacePct) assert.ok(s.pacePct[0] < s.pacePct[1], `${w.id}: pace range`);
      assert.ok(s.label, `${w.id}: label`);
    }
  }
});

test('repeat groups expand with numbered labels', () => {
  const steps = flatten(PRESETS.find((w) => w.id === 'int-8x500'));
  assert.equal(steps.length, 1 + 8 * 2 + 1);
  assert.equal(steps[1].label, '500 m (1/8)');
  assert.equal(steps[16].label, 'Rest (8/8)');
});

test('time, rest and distance steps advance; rest counts wall time while paused', () => {
  const run = new WorkoutRun({ segments: [
    { type: 'row', durationS: 20, knob: 4, label: 'A' },
    { type: 'rest', durationS: 30, label: 'R' },
    { type: 'row', distanceM: 60, knob: 8, label: 'B' },
  ] });
  // row through A (it starts on the first stroke at t=1), sit out the 30 s rest, then row again
  const log = simulate(run, { seconds: 80, rows: (t) => t <= 21 || t > 50 });
  const steps = log.filter((e) => e.type === 'step').map((e) => `${e.t}:${e.step}`);
  assert.deepEqual(steps, ['1:A', '21:R', '51:B']);
  assert.ok(log.some((e) => e.type === 'done' && e.t === 71), 'B is 60 m at 3 m/s: done 20 s after it started');
  assert.equal(log[0].type, 'start');
});

test('time steps wait while you are paused (moving time)', () => {
  const run = new WorkoutRun({ segments: [{ type: 'row', durationS: 10, label: 'A' }] });
  const log = simulate(run, { seconds: 30, rows: (t) => t <= 5 || t > 15 }); // 10 s pause in the middle
  assert.equal(log.find((e) => e.type === 'done').t, 21);
});

test('countdown beeps and a knob prompt 10 s before the knob changes', () => {
  const run = new WorkoutRun({ segments: [
    { type: 'row', durationS: 60, knob: 4, label: 'A' },
    { type: 'rest', durationS: 60, label: 'R' },
    { type: 'row', durationS: 30, knob: 9, label: 'B' },
  ] });
  const log = simulate(run, { seconds: 170, rows: (t) => t <= 61 || t > 120 });
  const knob = log.filter((e) => e.type === 'knob');
  assert.deepEqual(knob.map((e) => [e.t, e.knob]), [[121 - KNOB_PROMPT_S, 9]], 'prompt during the rest, 10 s before B');
  const countdown = log.filter((e) => e.type === 'countdown' && e.t < 62).map((e) => e.s);
  assert.deepEqual(countdown, [3, 2, 1]);
  assert.equal(run.knob, 9);
});

test('a short step inside the prompt window prompts as soon as it starts', () => {
  const run = new WorkoutRun({ segments: [
    { type: 'row', durationS: 30, knob: 4, label: 'A' },
    { type: 'rest', durationS: 5, label: 'R' },
    { type: 'row', durationS: 30, knob: 6, label: 'B' },
  ] });
  const log = simulate(run, { seconds: 70 });
  const prompt = log.find((e) => e.type === 'knob');
  assert.ok(prompt && prompt.t <= 31 - (KNOB_PROMPT_S - 5), `prompted at ${prompt?.t}`);
});

test('pace targets come from the reference pace; knob offset shifts and clamps', () => {
  const run = new WorkoutRun(
    { segments: [{ type: 'row', durationS: 60, knob: 15, pacePct: [100, 110], spm: [24, 28] }] },
    { referencePaceS: 120, knobOffset: 3 },
  );
  const [s] = run.steps;
  assert.equal(s.knob, 16);
  assert.deepEqual(s.paceRange.map(Math.round), [109, 120]); // 110% speed = 1:49, 100% = 2:00
  run.update({ state: 'active', movingS: 1, distance: 3, pace: 115, spm: 26 }, 1);
  assert.deepEqual(run.targetStatus({ pace: 115, spm: 26 }), { pace: 'ok', spm: 'ok' });
  assert.deepEqual(run.targetStatus({ pace: 130, spm: 30 }), { pace: 'slow', spm: 'high' });
  assert.deepEqual(run.targetStatus({ pace: 100, spm: 20 }), { pace: 'fast', spm: 'low' });
});

test('no reference pace: no pace targets, rate targets still work', () => {
  const run = new WorkoutRun({ segments: [{ type: 'row', durationS: 60, pacePct: [100, 110], spm: [24, 28] }] });
  run.update({ state: 'active', movingS: 1, distance: 3, pace: 115, spm: 26 }, 1);
  assert.deepEqual(run.targetStatus({ pace: 115, spm: 26 }), { pace: null, spm: 'ok' });
});

test('skip jumps to the next step', () => {
  const run = new WorkoutRun({ segments: [{ type: 'row', durationS: 600, label: 'A' }, { type: 'row', durationS: 60, label: 'B' }] });
  const view = { state: 'active', movingS: 5, distance: 15, pace: 150, spm: 24 };
  run.update(view, 5);
  assert.deepEqual(run.skip(view, 6).map((e) => e.step?.label), ['B']);
});

test('hard steps get the quicker smoothing', () => {
  const steps = flatten(PRESETS.find((w) => w.id === 'int-10x1'));
  assert.equal(isHard(steps[0]), false, 'warm-up');
  assert.equal(isHard(steps[1]), true, '1 min on');
  assert.equal(isHard(steps[2]), false, 'easy');
});

test('the knob follows every step of a workout without any input', () => {
  const run = new WorkoutRun(PRESETS.find((w) => w.id === 'int-10x1'), { knobOffset: -1 });
  const knobs = [];
  // 5 min warm-up + 10 x (1 min on + 1 min easy) + 5 min cool-down, rowed continuously
  const log = simulate(run, { seconds: 31 * 60 });
  for (const e of log) if (e.type === 'step') knobs.push(run.steps.find((s) => s.label === e.step).knob);
  // preset knobs 4 / 10 / 4 ... shifted by the -1 offset
  assert.deepEqual(knobs.slice(0, 5), [3, 9, 3, 9, 3]);
  assert.equal(knobs.length, run.steps.length);
  assert.ok(log.some((e) => e.type === 'done'));
});

test('skipping a step moves the knob to the next step\'s level', () => {
  const run = new WorkoutRun({ segments: [
    { type: 'row', durationS: 600, knob: 4, label: 'A' },
    { type: 'rest', durationS: 60, label: 'R' },
    { type: 'row', durationS: 60, knob: 11, label: 'B' },
  ] });
  const view = { state: 'active', movingS: 5, distance: 15, pace: 150, spm: 24 };
  run.update(view, 5);
  assert.equal(run.knob, 4);
  run.skip(view, 6); // to the rest: knob unchanged
  assert.equal(run.knob, 4);
  run.skip(view, 7); // to B
  assert.equal(run.knob, 11);
});
