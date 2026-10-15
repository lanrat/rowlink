import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRowerData, encodeRowerData, parseMachineStatus, hexToBytes } from '../js/protocol/ftms.js';
import { Counter } from '../js/pipeline/sanitize.js';
import { replay } from './helpers.js';
import { RowerPipeline, MIN_SAVE_DISTANCE_M } from '../js/pipeline/index.js';

const CAPTURES = ['01-passive.jsonl', '02-knob.jsonl', '03-rest.jsonl', '04-chrome.jsonl', '05-chrome-sprint.jsonl'];
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const p90 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
const steps = (vals) => vals.slice(1).flatMap((v, i) => (v != null && vals[i] != null ? [Math.abs(v - vals[i])] : []));

test('decodes packet A (More Data set)', () => {
  const p = parseRowerData(hexToBytes('7f001f930000c200ce003f005200'));
  assert.equal(p.moreData, true);
  assert.deepEqual(p.fields, { avgSpm: 15.5, distance: 147, pace: 194, avgPace: 206, power: 63, avgPower: 82 });
});

test('decodes packet B (stroke rate, kcal, elapsed)', () => {
  const p = parseRowerData(hexToBytes('000942200008000000003d00'));
  assert.equal(p.moreData, false);
  assert.deepEqual(p.fields, { spm: 33, strokes: 32, kcal: 8, kcalPerHour: 0, kcalPerMin: 0, elapsed: 61 });
});

test('encode/decode round trip', () => {
  const fields = { spm: 27.5, strokes: 300, kcal: 12, kcalPerHour: 0, kcalPerMin: 0, elapsed: 600 };
  assert.deepEqual(parseRowerData(encodeRowerData(fields)).fields, fields);
  const a = { avgSpm: 20, distance: 70000, pace: 125, avgPace: 130, power: -5, avgPower: 200 };
  const pa = parseRowerData(encodeRowerData(a));
  assert.equal(pa.moreData, true);
  assert.deepEqual(pa.fields, a);
});

test('machine status events', () => {
  assert.equal(parseMachineStatus(hexToBytes('0202')).event, 'paused');
  assert.equal(parseMachineStatus(hexToBytes('04')).event, 'started');
});

test('counter: baseline, glitch rejection, device reset', () => {
  const c = new Counter(7, 5);
  assert.equal(c.update(147, 0), 0); // pre-session distance is the baseline
  assert.equal(c.update(152, 1), 5);
  assert.equal(c.update(200, 2), 5); // +48 m in 1 s: rejected
  assert.equal(c.update(204, 3), 9);
  assert.equal(c.update(3, 4), 12); // rower reset to 0 and counted 3 m
  assert.equal(c.update(2, 5), 12); // small decrease: ignored
});

for (const name of CAPTURES) {
  test(`${name}: one sample per second, all values sane`, () => {
    const { views } = replay(name);
    const packets = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../captures', name), 'utf8')
      .split('\n').filter((l) => l.includes('"rower"')).length;
    assert.ok(Math.abs(views.length - packets / 2) <= 2, `${views.length} samples from ${packets} packets`);
    for (const v of views) {
      if (v.pace != null) assert.ok(v.pace > 60 && v.pace < 900, `pace ${v.pace}`);
      if (v.state === 'paused') assert.equal(v.pace, null);
      if (v.state === 'paused') assert.equal(v.power, null);
    }
    const dist = views.map((v) => v.distance);
    dist.slice(1).forEach((d, i) => assert.ok(d >= dist[i], 'distance never decreases'));
  });

  test(`${name}: smoothed pace is far steadier than the rower's`, () => {
    const { views } = replay(name);
    const raw = steps(views.map((v) => (v.raw.pace > 0 && v.raw.pace < 3600 ? v.raw.pace : null)));
    const smooth = steps(views.map((v) => v.pace));
    assert.ok(p90(smooth) < 20, `p90 step ${p90(smooth)}`); // a real sprint changes pace ~13 s/500m per second
    assert.ok(p90(smooth) < p90(raw) / 3, `smoothed p90 ${p90(smooth)} vs raw ${p90(raw)}`);
  });
}

test('02-knob: smoothed pace matches distance actually covered (within 10%)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../captures');
  const m = JSON.parse(readFileSync(join(dir, '02-knob.markers.json'), 'utf8'));
  const { views } = replay('02-knob.jsonl');
  for (const [a, b] of [[m.start_rowing, m.knob_to_max], [m.knob_to_max, m.knob_to_mid], [m.knob_to_mid, m.stop]]) {
    const ph = views.filter((v) => v.w >= a + 15 && v.w < b);
    const truth = (500 * (ph.at(-1).t - ph[0].t)) / (ph.at(-1).distance - ph[0].distance);
    const shown = median(ph.map((v) => v.pace).filter((p) => p != null));
    assert.ok(Math.abs(shown - truth) / truth < 0.1, `shown ${shown.toFixed(0)} vs truth ${truth.toFixed(0)}`);
  }
});

test('04-chrome: shown pace catches up after a pause and a speed-up', () => {
  const { views } = replay('04-chrome.jsonl');
  const t0 = views[0].t;
  const i = views.findIndex((v) => v.t - t0 >= 92); // ~10 s after rowing hard following the pause
  const a = views[i - 5];
  const b = views[i + 5];
  const truth = (500 * (b.t - a.t)) / (b.distance - a.distance);
  const shown = views[i].pace;
  assert.ok(Math.abs(shown - truth) / truth < 0.15, `shown ${shown.toFixed(0)} vs truth ${truth.toFixed(0)}`);
});

test('04-chrome: fake start-up distance (0 -> 139 m on stroke 2) is dropped', () => {
  const { views } = replay('04-chrome.jsonl');
  const early = views.filter((v) => v.strokes <= 4);
  assert.ok(Math.max(...early.map((v) => v.distance)) < 40, 'at most a few strokes worth of distance');
});

test('05-chrome-sprint: spin-up strokes do not fake a fast pace at the start', () => {
  // the rower reported +32 m on stroke 2 and +17 m the next second; shown pace used to start at 2:13
  const { views } = replay('05-chrome-sprint.jsonl');
  const first = views.find((v) => v.pace != null);
  assert.ok(first.pace > 240, `first shown pace ${first.pace.toFixed(0)} s/500m`);
});

test('05-chrome-sprint: pace follows the sprint the right way', () => {
  const { views } = replay('05-chrome-sprint.jsonl');
  const t0 = views[0].t;
  const at = (s) => views.find((v) => v.t - t0 >= s).pace;
  assert.ok(at(60) < at(50) - 60, `50 s: ${at(50).toFixed(0)}, 60 s: ${at(60).toFixed(0)}`);
  assert.ok(at(60) < 180, `mid-sprint shown ${at(60).toFixed(0)}`);
});

test('03-rest: start glitch and resume spikes are filtered', () => {
  const { views } = replay('03-rest.jsonl');
  assert.ok(Math.max(...views.map((v) => v.power ?? 0)) < 400, 'no 425 W resume spike');
  assert.ok(Math.max(...views.map((v) => v.spm ?? 0)) < 45, 'no 46-48 spm resume spike');
  // raw distance went 0 -> 181 m but ~95 m of that was a start-up glitch
  assert.ok(views.at(-1).distance < 100, `distance ${views.at(-1).distance}`);
});

test('03-rest: rest time counts in total but not moving time; counters survive the reconnect', () => {
  const { views } = replay('03-rest.jsonl');
  const last = views.at(-1);
  assert.ok(last.totalS > 230, `total ${last.totalS}`);
  assert.ok(last.movingS < 60, `moving ${last.movingS}`);
  assert.equal(last.state, 'active');
  const beforeRest = views.filter((v) => v.state === 'paused')[0].distance;
  assert.ok(last.distance > beforeRest + 30, 'distance keeps counting after the rest');
});

test('a reset status from the rower ends the session, except right after the app reset it', () => {
  const p = new RowerPipeline();
  const status01 = (t) => p.packet({ t, char: 'status', bytes: hexToBytes('01') });
  status01(10);
  assert.deepEqual(p.takeEvents(), ['rower-reset']);
  p.expectReset(20); // the app sends Reset at t=20
  status01(21);
  assert.deepEqual(p.takeEvents(), [], 'own reset is not reported');
  status01(26);
  assert.deepEqual(p.takeEvents(), ['rower-reset'], 'a later reset is the user ending the session');
});

test(`sessions under ${MIN_SAVE_DISTANCE_M} m are not worth saving`, () => {
  const { views } = replay('02-knob.jsonl');
  assert.equal(views.find((v) => v.distance > 0 && v.distance < MIN_SAVE_DISTANCE_M).worthSaving, false);
  assert.equal(views.at(-1).worthSaving, true);
});
