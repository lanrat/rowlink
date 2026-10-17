import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CLASSES } from '../js/workout/classes.js';
import { PRESETS } from '../js/workout/presets.js';
import { flatten, WorkoutRun } from '../js/workout/engine.js';
import { convert, CAPTURE } from '../tools/import-fed.mjs';

// The capture holds FED's own text, so it stays out of the repo: these checks run where it exists.
const capture = existsSync(CAPTURE) ? JSON.parse(readFileSync(CAPTURE, 'utf8')) : null;
const needsCapture = { skip: !capture && 'captures/app-workouts.json not present' };

test('classes.js is up to date with the capture (run tools/import-fed.mjs)', needsCapture, () => {
  assert.deepEqual(CLASSES, convert(capture));
});

test('every class is as long as the app\'s, minus Introduction and Feedback', needsCapture, () => {
  assert.equal(CLASSES.length, capture.workouts.length);
  for (const w of capture.workouts) {
    const c = CLASSES.find((x) => x.id === `fed-${w.course_id}`);
    const dropped = w.steps.filter((s) => ['Introduction', 'Feedback'].includes(s.name)).reduce((t, s) => t + s.duration_s, 0);
    assert.equal(c.segments.reduce((t, s) => t + s.durationS, 0), w.total_seconds - dropped, c.name);
  }
});

test('classes are valid workouts with our own names', () => {
  const ids = new Set(PRESETS.map((p) => p.id));
  const fedNames = new Set(capture?.workouts.map((w) => w.name));
  for (const c of CLASSES) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.name && c.description && c.tag && c.category.startsWith('Classes'), c.id);
    assert.ok(!fedNames.has(c.name), `${c.id}: uses the app's name`);
    for (const s of flatten(c)) {
      assert.ok(['row', 'free'].includes(s.type), `${c.id}: type`);
      assert.ok(Number.isInteger(s.durationS) && s.durationS > 0, `${c.id}: duration`);
      assert.ok(['warmup', 'active', 'interval', 'recovery', 'cooldown'].includes(s.intensity), `${c.id}: intensity`);
      if (s.type === 'row') {
        assert.ok(Number.isInteger(s.knob) && s.knob >= 1 && s.knob <= 16, `${c.id}: knob ${s.knob}`);
        assert.ok(s.spm[0] < s.spm[1], `${c.id}: spm range`);
      } else {
        assert.ok(s.knob == null && s.spm == null, `${c.id}: free steps have no targets`);
      }
    }
  }
});

test('a circuit runs hands-free: floor blocks pass with no strokes', () => {
  const c = CLASSES.find((x) => x.id === 'fed-2064'); // 3 × (4 min row, 2 min floor)
  const run = new WorkoutRun(c);
  let movingS = 0;
  let distance = 0;
  let done = null;
  const total = c.segments.reduce((t, s) => t + s.durationS, 0);
  for (let t = 0; t <= total + 5 && done == null; t++) {
    const rowing = t > 0 && run.step?.type !== 'free'; // off the rower for every free step
    if (rowing) {
      movingS += 1;
      distance += 3;
    }
    const view = { state: t === 0 ? 'idle' : rowing ? 'active' : 'paused', movingS, distance, pace: rowing ? 167 : null, spm: rowing ? 32 : null };
    if (run.update(view, t).some((e) => e.type === 'done')) done = t;
  }
  assert.ok(done != null && done <= total + 1, `done at ${done}, planned ${total}`);
});
