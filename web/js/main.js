import { RowerPipeline, MIN_SAVE_DISTANCE_M } from './pipeline/index.js';
import { Recorder } from './session/recorder.js';
import { saveSession, deleteSession, finalizeInterrupted } from './storage/db.js';
import { HistoryView } from './ui/history.js';
import { bytesToHex } from './protocol/ftms.js';
import { BleTransport, bluetoothSupport } from './ble/transport.js';
import { ReplayTransport, parseCapture } from './ble/replay.js';
import { SimulatorTransport } from './ble/simulator.js';
import { renderLive, renderConnection } from './ui/live.js';
import { DebugView } from './ui/debug.js';
import { loadSettings, pipelineSettings, setupSettingsDialog } from './ui/settings.js';
import { fmtPace, fmtTime, fmtDistance } from './ui/format.js';

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
    const event = { connected: 'EVENT_CONNECTED', reconnecting: 'EVENT_DISCONNECTED' }[state];
    if (event) capture.push({ t: round(tr.now()), c: event, hex: '' });
    if (state === 'disconnected' && transport === tr) detach();
    else showLive();
    // zero the rower's counters once per connection, not on automatic reconnects
    if (state === 'connected' && !started) {
      started = true;
      newSession({ resetRower: true });
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
  recorder.add(view, epochOf(t));
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
  pipeline.reset();
  debug.reset();
  if (resetRower && transport?.resetSession) {
    pipeline.expectReset(transport.now());
    transport.resetSession().catch((e) => console.warn('Rower reset failed, counting from its current values:', e.message));
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
  finishSession();
  transport = null;
  $('connect').hidden = view !== 'live';
  $('live').hidden = true;
  renderConnection('disconnected');
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
  updateWakeLock();
}

function showLive() {
  $('connect').hidden = true;
  $('live').hidden = view !== 'live';
  $('sim-controls').hidden = !(transport instanceof SimulatorTransport);
  $('replay-controls').hidden = !(transport instanceof ReplayTransport);
}

const round = (t) => Math.round(t * 1000) / 1000;

async function connectRower() {
  const tr = new BleTransport();
  attach(tr);
  try {
    await tr.connect();
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
    renderLive(v, settings.units);
  }
  debug.render(view === 'debug');
}
setInterval(frame, 250);

// ---------- wiring ----------

function setView(name) {
  view = name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === name));
  $('debug').hidden = name !== 'debug';
  $('history').hidden = name !== 'history';
  if (name === 'history') history.showList();
  if (transport) showLive();
  else $('connect').hidden = name !== 'live';
  if (name !== 'live') $('live').hidden = true;
  debug.dirty = true;
}

for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setView(b.dataset.view));

$('btn-connect').addEventListener('click', connectRower);
$('btn-sim').addEventListener('click', startSimulator);
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
    const res = await fetch(`../captures/${name}`);
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
