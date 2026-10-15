import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayToSession } from './helpers.js';
import { encodeFit } from '../js/export/fit.js';
import { encodeTcx } from '../js/export/tcx.js';
import { encodeCsv } from '../js/export/csv.js';

// Garmin's SDK is only used here, to check our encoder (it is not shipped with the app).
let fitsdk = null;
try {
  fitsdk = await import('@garmin/fitsdk');
} catch {
  // not installed: FIT decode test is skipped
}

test('recorder: summary from a real session', async () => {
  const rec = await replayToSession('02-knob.jsonl');
  const { session, data } = rec.build();
  const s = session.summary;
  assert.equal(session.complete, true);
  assert.ok(s.distanceM > 200 && s.distanceM < 300, `distance ${s.distanceM}`);
  assert.ok(s.movingS > 120 && s.movingS < 150, `moving ${s.movingS}`);
  assert.ok(s.totalS >= s.movingS);
  assert.ok(s.avgPaceS > 200 && s.avgPaceS < 300, `avg pace ${s.avgPaceS}`);
  assert.equal(data.samples.length, rec.samples.length);
  assert.ok(rec.worthSaving);
});

test('FIT: decodes with Garmin SDK as an indoor rowing activity', { skip: !fitsdk && 'npm install to run' }, async () => {
  const { Decoder, Stream } = fitsdk;
  const rec = await replayToSession('03-rest.jsonl');
  const { session, data } = rec.build();
  const bytes = encodeFit(session, data);
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  assert.ok(decoder.isFIT());
  assert.ok(decoder.checkIntegrity(), 'header, size and CRC valid');
  const { messages, errors } = decoder.read();
  assert.deepEqual(errors, []);

  const [fileId] = messages.fileIdMesgs;
  assert.equal(fileId.type, 'activity');
  const [sess] = messages.sessionMesgs;
  assert.equal(sess.sport, 'rowing');
  assert.equal(sess.subSport, 'indoorRowing');
  assert.ok(Math.abs(sess.totalDistance - session.summary.distanceM) < 1);
  assert.ok(Math.abs(sess.totalTimerTime - session.summary.movingS) < 1, 'timer time = moving time');
  assert.ok(sess.totalElapsedTime > 200, 'elapsed includes the 3-minute rest');
  assert.equal(messages.lapMesgs.length, 1);
  assert.equal(messages.activityMesgs[0].numSessions, 1);

  const records = messages.recordMesgs;
  assert.equal(records.length, data.samples.length);
  records.slice(1).forEach((r, i) => assert.ok(r.distance >= records[i].distance, 'distance never decreases'));
  assert.equal(records[0].timestamp.getTime(), session.startedAt - (session.startedAt % 1000));
  // the rest shows up as timer stop/start events
  const timer = messages.eventMesgs.filter((e) => e.event === 'timer').map((e) => e.eventType);
  assert.deepEqual(timer, ['start', 'stopAll', 'start', 'stopAll']);
});

test('TCX: one trackpoint per second, lap totals', async () => {
  const rec = await replayToSession('01-passive.jsonl');
  const { session, data } = rec.build();
  const xml = encodeTcx(session, data);
  assert.equal((xml.match(/<Trackpoint>/g) ?? []).length, data.samples.length);
  assert.match(xml, /<Activity Sport="Other">/);
  assert.match(xml, new RegExp(`<DistanceMeters>${session.summary.distanceM}</DistanceMeters>`));
  assert.equal((xml.match(/<Lap /g) ?? []).length, 1);
});

test('CSV: header plus one row per second', async () => {
  const rec = await replayToSession('01-passive.jsonl');
  const { session, data } = rec.build();
  const lines = encodeCsv(session, data).trim().split('\n');
  assert.equal(lines.length, data.samples.length + 1);
  assert.match(lines[0], /^time,elapsed_s,moving_s,distance_m/);
  assert.equal(lines[1].split(',').length, lines[0].split(',').length);
});
