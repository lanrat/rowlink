import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workoutFile, workoutText, workoutFileName, parseWorkoutFile, suggestionUrl, WORKOUT_FORMAT } from '../js/workout/share.js';
import { flatten } from '../js/workout/engine.js';
import { PRESETS } from '../js/workout/presets.js';
import { CLASSES } from '../js/workout/classes.js';

const mine = {
  id: 'w-abc', category: 'Mine', name: '4 × 500 m', description: 'Short and sharp.',
  segments: [
    { type: 'row', durationS: 300, knob: 4, spm: [18, 22], intensity: 'warmup', label: 'Warm-up' },
    { type: 'row', distanceM: 500, knob: 9, spm: [26, 30], pacePct: [103, 108] },
    { type: 'rest', durationS: 120, label: 'Rest' },
    { type: 'free', durationS: 60 },
  ],
};

test('the file holds the workout without its local id, one segment per line', () => {
  const textOut = workoutText(mine);
  const json = JSON.parse(textOut);
  assert.deepEqual(json, workoutFile(mine));
  assert.equal(json.format, WORKOUT_FORMAT);
  assert.deepEqual(Object.keys(json.workout), ['name', 'description', 'segments']);
  assert.deepEqual(json.workout.segments, mine.segments);
  for (const s of mine.segments) assert.ok(textOut.includes(`      ${JSON.stringify(s)}`), 'segment on its own line');
});

test('names that look like JSON or replacement patterns survive', () => {
  const w = { ...mine, name: 'A $& $\' "segments": [] B', description: '' };
  const json = JSON.parse(workoutText(w));
  assert.equal(json.workout.name, w.name);
  assert.equal(json.workout.description, undefined);
  assert.equal(json.workout.segments.length, 4);
});

test('import reads back a shared file as one of yours', () => {
  const w = parseWorkoutFile(JSON.parse(workoutText(mine)));
  assert.deepEqual(w, { name: mine.name, description: mine.description, category: 'Mine', segments: mine.segments });
  assert.equal(w.id, undefined, 'the caller gives it a new id');
});

test('import keeps only the fields the app uses', () => {
  const w = parseWorkoutFile({ format: WORKOUT_FORMAT, version: 1, workout: { name: '  X  ', segments: [
    { type: 'rest', durationS: 60, knob: 5, spm: [20, 22], extra: 1 },
    { type: 'row', durationS: 60, distanceM: 400, spm: [30, 24], pacePct: [90], intensity: 'sprint' },
  ] } });
  assert.equal(w.name, 'X');
  assert.deepEqual(w.segments, [{ type: 'rest', durationS: 60 }, { type: 'row', distanceM: 400, spm: [24, 30] }]);
});

test('import refuses files it cannot row', () => {
  const file = (workout) => ({ format: WORKOUT_FORMAT, version: 1, workout });
  const seg = { type: 'row', durationS: 60 };
  assert.throws(() => parseWorkoutFile({ format: 'rower-backup', items: [] }), /not a Rowlink workout file/);
  assert.throws(() => parseWorkoutFile(null), /not a Rowlink workout file/);
  assert.throws(() => parseWorkoutFile(file({ name: '', segments: [seg] })), /incomplete/);
  assert.throws(() => parseWorkoutFile(file({ name: 'X', segments: [] })), /incomplete/);
  assert.throws(() => parseWorkoutFile(file({ name: 'X', segments: [seg, { type: 'row', durationS: '60' }] })), /incomplete/);
  assert.throws(() => parseWorkoutFile(file({ name: 'X', segments: [{ type: 'swim', durationS: 60 }] })), /incomplete/);
  assert.throws(() => parseWorkoutFile(file({ name: 'X', segments: [{ repeat: 2, segments: [seg] }] })), /incomplete/);
});

test('every built-in workout, copied as Customize does, shares and imports intact', () => {
  for (const b of [...PRESETS, ...CLASSES]) {
    const segments = flatten(b);
    const back = parseWorkoutFile(JSON.parse(workoutText({ name: b.name, segments })));
    assert.equal(back.segments.length, segments.length, b.id);
    back.segments.forEach((s, i) => {
      for (const k of ['type', 'durationS', 'distanceM', 'knob', 'spm', 'pacePct', 'intensity']) assert.deepEqual(s[k], segments[i][k], `${b.id} step ${i} ${k}`);
    });
  }
});

test('file names are tidy', () => {
  assert.equal(workoutFileName({ name: '8 × 500 m (copy)' }), 'workout-8-500-m-copy.json');
  assert.equal(workoutFileName({ name: 'Café sprint' }), 'workout-cafe-sprint.json');
  assert.equal(workoutFileName({ name: '×××' }), 'workout-shared.json');
});

test('the GitHub suggestion carries the workout file', () => {
  const { url, complete } = suggestionUrl(mine, '≈ 12:00 · knob 4–9');
  assert.ok(complete);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://github.com/lanrat/rowlink/issues/new');
  assert.equal(u.searchParams.get('title'), 'Workout suggestion: 4 × 500 m');
  const body = u.searchParams.get('body');
  assert.ok(body.includes('**4 × 500 m**\nShort and sharp.\n≈ 12:00 · knob 4–9'));
  const json = body.slice(body.indexOf('```json\n') + 8, body.lastIndexOf('\n```'));
  assert.deepEqual(parseWorkoutFile(JSON.parse(json)).segments, mine.segments);
});

test('a workout too long for a link asks for a paste instead', () => {
  const long = { name: 'Long', segments: Array.from({ length: 80 }, (_, i) => ({ type: 'row', durationS: 60 + i, knob: 6, spm: [20, 24], pacePct: [90, 95], intensity: 'active', label: 'Steady' })) };
  const { url, complete } = suggestionUrl(long, '≈ 2:00:00');
  assert.equal(complete, false);
  assert.ok(url.length < 8000);
  assert.match(new URL(url).searchParams.get('body'), /Paste the workout here/);
});
