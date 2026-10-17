import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer, seatPosition, DRIVE_FRACTION } from '../js/workout/pacer.js';

/** Tick at 60 fps for `seconds`; returns the times of the catches. */
function run(pacer, seconds, from = 0) {
  const catches = [];
  for (let f = 0; f <= seconds * 60; f++) {
    const t = from + f / 60;
    if (pacer.tick(t)) catches.push(t);
  }
  return catches;
}

test('one catch per stroke at the target rate, starting with a catch', () => {
  const p = new Pacer();
  p.setRate(24); // 2.5 s per stroke
  const catches = run(p, 10.1);
  const expected = [0, 2.5, 5, 7.5, 10];
  assert.equal(catches.length, expected.length, `catches at ${catches}`);
  catches.forEach((t, i) => assert.ok(Math.abs(t - expected[i]) <= 1 / 60 + 1e-9, `catch ${i} at ${t}`)); // within a frame
});

test('the seat goes out on a short drive and back on a long recovery', () => {
  assert.equal(seatPosition(0), 0);
  assert.equal(seatPosition(DRIVE_FRACTION), 1);
  assert.ok(seatPosition(DRIVE_FRACTION / 2) === 0.5, 'half way through the drive');
  assert.ok(Math.abs(seatPosition(DRIVE_FRACTION + (1 - DRIVE_FRACTION) / 2) - 0.5) < 1e-9, 'half way back');
  assert.ok(seatPosition(0.999) < 0.01, 'back at the catch');
});

test('a new rate changes speed without moving the marker', () => {
  const p = new Pacer();
  p.setRate(20);
  run(p, 1.2);
  const before = p.position;
  p.setRate(30);
  assert.equal(p.position, before);
  p.tick(1.2 + 1 / 60);
  assert.ok(Math.abs(p.position - before) < 0.1, 'small step on the next frame');
});

test('stopping hides it; restarting begins at a catch', () => {
  const p = new Pacer();
  p.setRate(24);
  run(p, 1);
  p.setRate(null);
  assert.equal(p.position, null);
  assert.equal(p.tick(2), false);
  p.setRate(26);
  assert.equal(p.position, 0);
  assert.equal(p.tick(3), true, 'catch (and click) as it starts again');
});

test('a long gap gives one catch, not a burst', () => {
  const p = new Pacer();
  p.setRate(30);
  p.tick(0);
  assert.equal(p.tick(60), true); // tab hidden for a minute
  assert.equal(p.tick(60 + 1 / 60), false);
});
