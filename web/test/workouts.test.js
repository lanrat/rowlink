import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentWorkouts } from '../js/ui/workouts.js';

const w = (id) => ({ id, name: id, segments: [{ type: 'row', durationS: 60 }] });
const workouts = [w('a'), w('b'), w('c'), w('d')];
/** sessions newest first, as listSessions() returns them; null = a free row */
const sessions = (...ids) => ids.map((id, i) => ({ startedAt: 1000 - i, ...(id ? { workout: { id, name: id } } : {}) }));

test('recent workouts: newest first, once each, free rows skipped', () => {
  const r = recentWorkouts(sessions('b', null, 'a', 'b', 'c'), workouts);
  assert.deepEqual(r.map((x) => x.workout.id), ['b', 'a', 'c']);
  assert.equal(r[0].workout, workouts[1], 'the current workout, not the copy saved with the session');
  assert.deepEqual(r.map((x) => x.rowedAt), [1000, 998, 996], 'each one dated by its latest session');
});

test('recent workouts: limited to n, and skips workouts that no longer exist', () => {
  assert.deepEqual(recentWorkouts(sessions('a', 'gone', 'b', 'c', 'd'), workouts, 2).map((x) => x.workout.id), ['a', 'b']);
  assert.deepEqual(recentWorkouts(sessions(null, 'gone'), workouts), []);
  assert.deepEqual(recentWorkouts([], workouts), []);
});
