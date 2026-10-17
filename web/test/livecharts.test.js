import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paceGridlines, rateScale } from '../js/ui/livecharts.js';

test('pace gridlines fall on round paces, at most three', () => {
  assert.deepEqual(paceGridlines(118, 142), [120, 130, 140]); // 2:00 2:10 2:20
  assert.deepEqual(paceGridlines(140, 180), [150, 165, 180]); // 2:30 2:45 3:00
  assert.deepEqual(paceGridlines(100, 200), [120, 150, 180]);
  assert.deepEqual(paceGridlines(90, 400), [120, 240, 360]);
  assert.deepEqual(paceGridlines(118, 142, 5), [120, 125, 130, 135, 140], 'a tall chart gets more');
});

test('the rate scale snaps to multiples of 5 and is at least 10 spm tall', () => {
  assert.deepEqual(rateScale(24, 24), [20, 30]);
  assert.deepEqual(rateScale(18, 22), [15, 25]);
  assert.deepEqual(rateScale(20, 30), [15, 35]);
  assert.deepEqual(rateScale(0, 3), [0, 10]);
  for (let a = 0; a < 50; a++) {
    for (let b = a; b < a + 15; b++) {
      const [lo, hi] = rateScale(a, b);
      assert.ok(lo % 5 === 0 && hi % 5 === 0 && hi - lo >= 10 && lo <= a && hi >= b && lo >= 0, `${a}-${b}: ${lo}-${hi}`);
    }
  }
});
