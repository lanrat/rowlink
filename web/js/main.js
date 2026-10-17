import { RowerPipeline, MIN_SAVE_DISTANCE_M } from './pipeline/index.js';
import { Recorder } from './session/recorder.js';
import { saveSession, deleteSession, finalizeInterrupted, eraseAllData } from './storage/db.js';
import { HistoryView } from './ui/history.js';
import { bytesToHex } from './protocol/ftms.js';
import { BleTransport, bluetoothSupport } from './ble/transport.js';
import { ReplayTransport, parseCapture } from './ble/replay.js';
import { SimulatorTransport } from './ble/simulator.js';
import { renderLive, renderConnection, renderWorkout, renderKnobPrompt, renderWorkoutDone, fitValues } from './ui/live.js';
import { WorkoutRun, isHard } from './workout/engine.js';
import { targetResults } from './session/targets.js';
import { drawRolling, setupGauge, updateGauge, ROLLING_S } from './ui/livecharts.js';
import { sound, unlockAudio, setSoundEnabled, setMetronomeEnabled } from './workout/sound.js';
import { Pacer } from './workout/pacer.js';
import { WorkoutsView } from './ui/workouts.js';
import { DebugView } from './ui/debug.js';
import { loadSettings, saveSettings, pipelineSettings, setupSettingsDialog, SMOOTHING } from './ui/settings.js';
import { fmtPace, fmtTime, fmtDistance } from './ui/format.js';

const APP_VERSION = '0.4.0';
const LAST_DEVICE_KEY = 'rower.lastDevice';
const $ = (id) => document.getElementById(id);
const BUNDLED_CAPTURES = ['01-passive.jsonl', '02-knob.jsonl', '03-rest.jsonl', '04-chrome.jsonl', '05-chrome-sprint.jsonl'];

let settings = loadSettings();
const pipeline = new RowerPipeline(pipelineSettings(settings));
const debug = new DebugView();
let transport = null;
let deviceName = '';
let capture = []; // raw packets + connection events, same format as captures/*.jsonl
let view = 'live';
let wakeLock = null;
let recorder = null; // the session being rowed (null until the first stroke)
let captureStart = 0; // index in `capture` where the current session began
const AUTOSAVE_MS = 15000;
const history = new HistoryView(() => settings.units);

// workout state
let run = null; // WorkoutRun being rowed
let pendingWorkout = null; // chosen before the rower was connected
let knobPrompt = null; // {knob, initial?, hideAt?}
let workoutDone = null; // {name, text, targets, refPaceS} shown after a workout ends
let series = []; // last few minutes of {t, pace, spm} for the rolling chart
const workouts = new WorkoutsView(() => settings, startWorkout);
setSoundEnabled(settings.sounds);
setMetronomeEnabled(settings.metronome);

// ---------- transports ----------

function attach(tr) {
  transport = tr;
  epochAnchor = null;
  capture = [];
  debug.reset();
  pipeline.reset();
  pipeline.setKnob(settings.defaultKnob);

  tr.on('info', (info) => {
    deviceName = info.name ?? '';
    if (tr instanceof BleTransport && deviceName) storageSet(LAST_DEVICE_KEY, deviceName);
  });
  tr.on('ended', () => {
    renderConnection('disconnected', '', 'Replay finished');
    finishSession();
  });
  tr.on('packet', (pkt) => {
    capture.push({ t: round(pkt.t), c: pkt.char, hex: bytesToHex(pkt.bytes) });
    debug.onPacket(pkt, capture.length);
    if (pipeline.packet(pkt)) {
      const v = pipeline.view(pkt.t);
      debug.onSample(pkt.t, v);
      if (run) onWorkoutEvents(run.update(v, epochOf(pkt.t) / 1000), epochOf(pkt.t) / 1000);
      series.push({ t: pkt.t, pace: v.pace, spm: v.spm });
      while (series.length && series[0].t < pkt.t - ROLLING_S - 5) series.shift();
      record(v, pkt.t);
    }
    for (const ev of pipeline.takeEvents()) {
      if (ev === 'rower-reset') {
        // someone pressed reset on the rower: that session is over (M2 will save it first)
        newSession({ resetRower: false });
        showNotice('The rower was reset, so a new session started.');
      }
    }
  });
  let started = false;
  tr.on('state', (state) => {
    pipeline.setConnection(state);
    if (state === 'reconnecting') lostAt ??= performance.now();
    if (state === 'connected') lostAt = null;
    const event = { connected: 'EVENT_CONNECTED', reconnecting: 'EVENT_DISCONNECTED' }[state];
    if (event) capture.push({ t: round(tr.now()), c: event, hex: '' });
    if (state === 'disconnected' && transport === tr) detach();
    else showLive();
    // zero the rower's counters once per connection, not on automatic reconnects
    if (state === 'connected' && !started) {
      started = true;
      newSession({ resetRower: true });
      if (pendingWorkout) loadRun(pendingWorkout);
    }
    renderConnection(state, deviceName);
    updateWakeLock();
  });
}

// ---------- sessions ----------

const sourceOf = (tr) => (tr instanceof BleTransport ? 'ble' : tr instanceof SimulatorTransport ? 'simulator' : 'replay');
// Wall-clock time of a transport timestamp, anchored at the first packet. Replays run
// faster than real time, so their timestamps must not be read against Date.now().
let epochAnchor = null;
const epochOf = (t) => {
  if (!isFinite(t)) return Date.now();
  epochAnchor ??= { ms: Date.now(), t };
  return epochAnchor.ms + (t - epochAnchor.t) * 1000;
};
const saveNonBle = () => $('save-non-ble').checked;
const shouldSave = (rec) => rec.worthSaving && (rec.source === 'ble' || saveNonBle());

function record(view, t) {
  if (!pipeline.clock.started) return;
  recorder ??= new Recorder({
    startedAt: epochOf(pipeline.clock.startT),
    source: sourceOf(transport),
    device: deviceName,
    kcalSource: pipeline.settings.calorieSource,
  });
  if (run && !recorder.workout) {
    recorder.workout = {
      id: run.workout.id,
      name: run.workout.name,
      steps: run.steps.map(({ label, type, intensity, durationS, distanceM, knob, spm, pacePct, paceRange }) => ({
        label, type, intensity, durationS, distanceM, knob, spm, pacePct, paceRange,
      })),
    };
  }
  recorder.add(view, epochOf(t), run && run.i >= 0 && !run.done ? run.i : undefined);
}

/** Save the current session if it counts (>= 20 m), then forget it. */
function finishSession() {
  const rec = recorder;
  recorder = null;
  if (!rec) return;
  if (!shouldSave(rec)) {
    deleteSession(rec.id).catch(() => {}); // drop any autosave
    if (rec.worthSaving) showNotice('Not saved: simulator and replay sessions are only saved when enabled on the Debug tab.');
    else if (rec.distance > 0) showNotice(`Not saved: sessions under ${MIN_SAVE_DISTANCE_M} m are discarded.`);
    return;
  }
  const { session, data } = rec.build({ complete: true, raw: capture.slice(captureStart) });
  const d = fmtDistance(session.summary.distanceM, settings.units);
  saveSession(session, data)
    .then(() => showNotice(`Saved: ${d.value} ${d.unit} in ${fmtTime(session.summary.movingS)}. See History.`))
    .catch((e) => showNotice(`Could not save the session: ${e.message}`));
}

// Autosave so a closed tab or crash loses at most a few seconds; finalizeInterrupted() tidies up on next load.
setInterval(() => {
  if (!recorder || !shouldSave(recorder)) return;
  const { session, data } = recorder.build({ complete: false });
  saveSession(session, data).catch((e) => console.warn('Autosave failed:', e.message));
}, AUTOSAVE_MS);

/** Start a fresh session in the app and, optionally, on the rower (Reset + Start). */
function newSession({ resetRower }) {
  finishSession();
  captureStart = capture.length;
  series = [];
  pipeline.reset();
  debug.reset();
  if (resetRower && transport?.resetSession) {
    pipeline.expectReset(transport.now());
    transport.resetSession().catch((e) => console.warn('Rower reset failed, counting from its current values:', e.message));
  }
}

// ---------- workouts ----------

function startWorkout(workout) {
  unlockAudio(); // browsers only allow sound after a tap
  workoutDone = null;
  if (!transport) {
    pendingWorkout = workout; // starts when the rower connects
    setView('live');
    return;
  }
  newSession({ resetRower: true });
  loadRun(workout);
  setView('live');
}

function loadRun(workout) {
  pendingWorkout = null;
  run = new WorkoutRun(workout, { referencePaceS: settings.referencePaceS, knobOffset: settings.knobOffset });
  if (run.knob != null) pipeline.setKnob(run.knob);
  knobPrompt = run.knob != null ? { knob: run.knob, initial: true } : null;
  applySmoothing(null);
}

function endWorkout() {
  run = null;
  knobPrompt = null;
  applySmoothing(null);
}

/** Quicker smoothing during hard intervals (if enabled), the user's choice otherwise. */
function applySmoothing(step) {
  const fast = step && settings.fastWork && isHard(step);
  pipeline.setSmoothing(fast ? SMOOTHING.low : SMOOTHING[settings.smoothing] ?? SMOOTHING.medium);
}

function onWorkoutEvents(events, wallS) {
  for (const e of events) {
    if (e.type === 'start' && knobPrompt) knobPrompt.hideAt = wallS + 3;
    if (e.type === 'step') {
      if (e.step.knob != null) pipeline.setKnob(e.step.knob); // assume the knob was changed as prompted
      applySmoothing(e.step);
      sound.step();
      if (knobPrompt && !knobPrompt.initial && e.step.knob === knobPrompt.knob) knobPrompt.hideAt = wallS + 4;
    }
    if (e.type === 'countdown') sound.countdown();
    if (e.type === 'knob') {
      knobPrompt = { knob: e.knob };
      sound.knob();
    }
    if (e.type === 'done') {
      sound.done();
      completeWorkout();
    }
  }
}

/** Average pace over the benchmark steps, from the recorded samples. */
function benchmarkPace(rec, r) {
  if (!rec) return null;
  const idx = new Set(r.steps.flatMap((s, i) => (s.benchmark ? [i] : [])));
  const first = rec.samples.findIndex((p) => idx.has(p.g));
  if (first < 0) return null;
  const last = rec.samples.findLastIndex((p) => idx.has(p.g));
  const before = first > 0 ? rec.samples[first - 1] : { d: 0, mv: 0 };
  const a = rec.samples[last];
  const d = a.d - before.d;
  return d > 0 ? Math.round((500 * (a.mv - before.mv)) / d) : null;
}

function completeWorkout() {
  const w = run.workout;
  const refPaceS = w.benchmark ? benchmarkPace(recorder, run) : null;
  const d = fmtDistance(recorder?.distance ?? 0, settings.units);
  const text = `${d.value} ${d.unit} in ${fmtTime(pipeline.clock.movingNow(transport.now()))}.${refPaceS ? ` Average pace ${fmtPace(refPaceS)} /500m.` : ''}`;
  const tr = recorder?.workout ? targetResults(recorder.workout.steps, recorder.samples) : null;
  const pct = (x) => `${Math.round(x.onPct)}%`;
  const targets = tr && (tr.pace || tr.spm)
    ? `On target: ${[tr.pace && `pace ${pct(tr.pace)}`, tr.spm && `rate ${pct(tr.spm)}`].filter(Boolean).join(', ')} of the time. Details in History.`
    : null;
  endWorkout();
  newSession({ resetRower: true }); // saves the workout session
  // closes itself so nothing needs a tap; a reference-pace offer stays up a little longer
  workoutDone = { name: w.name, text, targets, refPaceS, hideAt: performance.now() + (refPaceS ? 60000 : 30000) };
}

function knobPromptView(v, wallS) {
  if (!knobPrompt) return null;
  if (knobPrompt.hideAt != null && wallS > knobPrompt.hideAt) {
    knobPrompt = null;
    return null;
  }
  if (knobPrompt.initial && (!run || run.i < 0)) return { knob: knobPrompt.knob, when: 'then start rowing' };
  const change = run?.nextKnobChange();
  const p = run && run.i >= 0 ? run.progress(v, wallS) : null;
  if (change && change.knob === knobPrompt.knob && p?.remainingS != null) {
    return { knob: knobPrompt.knob, when: `in ${fmtTime(Math.max(0, Math.ceil(p.remainingS + change.betweenS)))}` };
  }
  return { knob: knobPrompt.knob, when: 'now' };
}

let lostAt = null; // performance.now() when the connection dropped

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not fatal
  }
}

/** Connect screen: name the rower used last, and offer a picker-free reconnect if the browser allows it. */
async function showKnownRower() {
  const last = storageGet(LAST_DEVICE_KEY);
  $('last-device').hidden = !last;
  if (last) $('last-device').textContent = `Last used: ${last}`;
  if (!navigator.bluetooth?.getDevices) return;
  try {
    const known = (await navigator.bluetooth.getDevices()).find((d) => d.name?.startsWith('YOSUDA-RM') || d.name?.startsWith('YSD-RM'));
    $('btn-reconnect').hidden = !known;
    if (known) $('btn-reconnect').textContent = `Reconnect ${known.name} (no picker)`;
  } catch {
    // permissions API unavailable: the normal Connect button still works
  }
}

let toastTimer = null;
function showNotice(text, seconds = 8) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, seconds * 1000);
}

function detach() {
  exitFullscreen(); // the connect screen needs the normal layout
  endWorkout();
  finishSession();
  lostAt = null;
  showKnownRower();
  transport = null;
  $('connect').hidden = view !== 'live';
  $('live').hidden = true;
  renderConnection('disconnected');
  updateWakeLock();
}

function showLive() {
  $('connect').hidden = true;
  $('live').hidden = view !== 'live';
  $('sim-controls').hidden = !(transport instanceof SimulatorTransport);
  $('replay-controls').hidden = !(transport instanceof ReplayTransport);
}

const round = (t) => Math.round(t * 1000) / 1000;

async function connectRower({ known = false } = {}) {
  const tr = new BleTransport();
  attach(tr);
  try {
    if (known) {
      if (!(await tr.connectKnown())) throw new Error('rower not found; use Connect rower');
    } else {
      await tr.connect();
    }
  } catch (e) {
    if (transport === tr) detach();
    if (e.name !== 'NotFoundError') showSupport(`Could not connect: ${e.message}`); // NotFoundError = picker cancelled
  }
}

function startSimulator() {
  const sim = new SimulatorTransport();
  attach(sim);
  sim.start();
}

function startReplay(text) {
  const records = parseCapture(text);
  if (!records.length) return showSupport('That file has no rower packets.');
  const tr = new ReplayTransport(records);
  attach(tr);
  tr.start();
}

function showSupport(msg) {
  const el = $('support');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- screen wake lock (keep the phone screen on while rowing) ----------

async function updateWakeLock() {
  const want = transport != null && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // wake lock refused (battery saver etc.): not fatal
  }
}
document.addEventListener('visibilitychange', updateWakeLock);

// ---------- render loop ----------

function frame() {
  if (transport) {
    const v = pipeline.view(transport.now());
    v.kcalSource = pipeline.settings.calorieSource;
    v.lostS = lostAt != null ? (performance.now() - lostAt) / 1000 : null;
    renderLive(v, settings.units);
    const wallS = epochOf(transport.now()) / 1000;
    const paceS = settings.referencePaceS ?? v.avgPace ?? 150; // for estimating distance steps' time
    renderWorkout(run, run && run.i >= 0 ? run.progress(v, wallS) : null, v, {
      referencePaceS: settings.referencePaceS,
      overall: run ? run.overall(v, wallS, paceS) : null,
    });
    const rowStep = run?.step?.type === 'row' ? run.step : null;
    updateGauge($('spm-gauge'), v.spm, rowStep?.spm ?? null, rowStep ? run.targetStatus(v).spm : null);
    drawRolling($('pace-chart'), series, transport.now(), rowStep?.paceRange ?? null);
    renderKnobPrompt(knobPromptView(v, wallS));
    if (workoutDone && performance.now() > workoutDone.hideAt) workoutDone = null;
    renderWorkoutDone(workoutDone);
  }
  debug.render(view === 'debug');
}
setInterval(frame, 250);

// Stroke pacer: its own animation loop, since the dashboard only redraws 4 times a second.
// Shown during row steps with a stroke-rate target. It beats only while you're rowing: before
// the first stroke and while auto-paused it stops, parked at the catch, and restarts with a catch.
const pacer = new Pacer();
function pacerFrame(nowMs) {
  const step = run && !run.done ? (run.i < 0 ? run.next : run.step) : null;
  const target = transport && step?.type === 'row' && step.spm ? (step.spm[0] + step.spm[1]) / 2 : null;
  const rowing = target != null && pipeline.clock.state === 'active';
  pacer.setRate(rowing ? target : null);
  if (pacer.tick(nowMs / 1000)) sound.click();
  const el = $('pacer');
  el.hidden = target == null;
  el.classList.toggle('stopped', !rowing);
  if (target != null) el.style.setProperty('--p', (pacer.position ?? 0).toFixed(4));
  requestAnimationFrame(pacerFrame);
}
requestAnimationFrame(pacerFrame);

// ---------- wiring ----------

function setView(name) {
  view = name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === name));
  $('debug').hidden = name !== 'debug';
  $('history').hidden = name !== 'history';
  if (name === 'history') history.showList();
  $('workouts').hidden = name !== 'workouts';
  if (name === 'workouts') workouts.show();
  const pending = $('pending-workout');
  pending.hidden = !pendingWorkout;
  if (pendingWorkout) pending.textContent = `Ready: ${pendingWorkout.name}. Connect your rower to start.`;
  if (transport) showLive();
  else $('connect').hidden = name !== 'live';
  if (name !== 'live') $('live').hidden = true;
  debug.dirty = true;
}

for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setView(b.dataset.view));

$('btn-connect').addEventListener('click', () => connectRower());
$('btn-reconnect').addEventListener('click', () => connectRower({ known: true }));
$('btn-sim').addEventListener('click', startSimulator);
$('wk-skip').addEventListener('click', () => {
  if (!run || !transport) return;
  const now = transport.now();
  onWorkoutEvents(run.skip(pipeline.view(now), epochOf(now) / 1000), epochOf(now) / 1000);
});
$('wk-end').addEventListener('click', endWorkout);
$('wd-close').addEventListener('click', () => { workoutDone = null; });
$('wd-ref').addEventListener('click', () => {
  if (!workoutDone?.refPaceS) return;
  settings = { ...settings, referencePaceS: workoutDone.refPaceS };
  saveSettings(settings);
  showNotice(`Reference pace set to ${fmtPace(workoutDone.refPaceS)} /500m.`);
  workoutDone = { ...workoutDone, refPaceS: null };
});

$('btn-disconnect').addEventListener('click', () => {
  finishSession();
  transport?.disconnect();
});
$('btn-new').addEventListener('click', () => newSession({ resetRower: true }));
$('knob-down').addEventListener('click', () => pipeline.setKnob(pipeline.knob - 1));
$('knob-up').addEventListener('click', () => pipeline.setKnob(pipeline.knob + 1));

const replaySelect = $('replay-select');
for (const name of BUNDLED_CAPTURES) replaySelect.add(new Option(name, name));
replaySelect.addEventListener('change', async () => {
  const name = replaySelect.value;
  replaySelect.value = '';
  if (!name) return;
  try {
    // deployed: captures/ sits next to the app; in the repo it's one level up (web/../captures)
    const places = /\/web\/(index\.html)?$/.test(location.pathname) ? ['../captures', 'captures'] : ['captures', '../captures'];
    let res = await fetch(`${places[0]}/${name}`).catch(() => null);
    if (!res?.ok) res = await fetch(`${places[1]}/${name}`);
    if (!res.ok) throw new Error(res.statusText);
    startReplay(await res.text());
  } catch (e) {
    showSupport(`Could not load ${name}: ${e.message}. Use "Open file…" instead.`);
  }
});
$('replay-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) startReplay(await file.text());
});
for (const b of document.querySelectorAll('#replay-controls button')) {
  b.addEventListener('click', () => {
    transport?.setSpeed?.(Number(b.dataset.speed));
    for (const o of document.querySelectorAll('#replay-controls button')) o.setAttribute('aria-pressed', String(o === b));
  });
}

// simulator controls
$('sim-row').addEventListener('click', () => {
  if (!(transport instanceof SimulatorTransport)) return;
  transport.setRowing(!transport.rowing);
  $('sim-row').textContent = transport.rowing ? 'Stop rowing' : 'Start rowing';
});
$('sim-pace').addEventListener('input', (e) => {
  if (transport instanceof SimulatorTransport) transport.targetPace = Number(e.target.value);
  $('sim-pace-v').textContent = fmtPace(Number(e.target.value));
});
$('sim-spm').addEventListener('input', (e) => {
  if (transport instanceof SimulatorTransport) transport.targetSpm = Number(e.target.value);
  $('sim-spm-v').textContent = e.target.value;
});

$('btn-save-capture').addEventListener('click', () => {
  const blob = new Blob([capture.map((r) => JSON.stringify(r)).join('\n') + '\n'], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rower-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

setupSettingsDialog($('settings'), $('open-settings'), () => settings, (s) => {
  settings = s;
  // calorie source and weight apply now; smoothing windows apply from the next session
  Object.assign(pipeline.settings, pipelineSettings(s));
  setSoundEnabled(s.sounds);
  setMetronomeEnabled(s.metronome);
});

// for inspecting a live session from the browser console
globalThis.rower = {
  pipeline,
  view: () => (transport ? pipeline.view(transport.now()) : null),
  capture: () => capture,
  transport: () => transport,
};

const support = bluetoothSupport();
if (!support.ok) {
  showSupport(support.reason);
  $('btn-connect').disabled = true;
}
renderConnection('disconnected');
showKnownRower();
setupGauge($('spm-gauge'));
$('app-version').textContent = APP_VERSION;

// ---------- full screen (on Android it also rotates to landscape) ----------

$('btn-fullscreen').hidden = !document.fullscreenEnabled;

async function enterFullscreen() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) {
    showNotice(`Full screen isn't available here: ${e.message}`);
    return;
  }
  try {
    // Android Chrome honours this even when the phone's rotation is locked to portrait.
    // Desktop browsers refuse it, and full screen alone is fine there.
    await screen.orientation?.lock?.('landscape');
  } catch {
    // orientation lock unsupported
  }
}

function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  document.body.classList.toggle('immersive', on);
  $('fs-exit').hidden = !on;
  requestAnimationFrame(() => fitValues(true));
  if (!on) {
    try {
      screen.orientation?.unlock?.();
    } catch {
      // nothing locked
    }
  }
});
$('btn-fullscreen').addEventListener('click', enterFullscreen);
window.addEventListener('resize', () => fitValues(true));
$('fs-exit').addEventListener('click', exitFullscreen);

// PWA (install + offline) is postponed until development is done; see PLAN.md "Later: PWA".
// A development build briefly registered a service worker; remove it so it can't serve stale files.
navigator.serviceWorker?.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
globalThis.caches?.keys().then((keys) => keys.filter((k) => k.startsWith('rower-')).forEach((k) => caches.delete(k))).catch(() => {});

navigator.bluetooth?.addEventListener?.('availabilitychanged', (e) => {
  if (!e.value) showNotice('Bluetooth is turned off. Turn it on to connect to the rower.');
});

// two-step erase, no confirm() dialog
let eraseArmedUntil = 0;
$('btn-erase').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (performance.now() > eraseArmedUntil) {
    eraseArmedUntil = performance.now() + 4000;
    btn.textContent = 'Tap again to erase everything';
    setTimeout(() => { if (performance.now() > eraseArmedUntil) btn.textContent = 'Erase all data'; }, 4100);
    return;
  }
  await eraseAllData();
  location.reload();
});

finalizeInterrupted().catch((e) => console.warn('Could not tidy interrupted sessions:', e.message));
try {
  $('save-non-ble').checked = localStorage.getItem('rower.saveNonBle') === '1';
} catch {
  // storage unavailable: default off
}
$('save-non-ble').addEventListener('change', (e) => {
  try {
    localStorage.setItem('rower.saveNonBle', e.target.checked ? '1' : '0');
  } catch {
    // not fatal
  }
});
