// Live dashboard rendering. Called ~4x per second with pipeline.view().
import { fmtPace, fmtTime, fmtInt, fmtDistance } from './format.js';

const $ = (id) => document.getElementById(id);

function set(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function bannerFor(view, notice) {
  if (notice) return { text: notice };
  if (view.connection === 'reconnecting') {
    const ago = view.lostS != null ? ` (${fmtTime(view.lostS)})` : '';
    return { text: `Connection lost${ago}. Reconnecting… keep rowing, nothing is lost.`, kind: 'warn' };
  }
  if (view.connection === 'connecting') return { text: 'Connecting…' };
  if (view.state === 'idle') return { text: 'Take a stroke to start' };
  if (view.state === 'paused') return { text: 'Paused. Row to resume' };
  return null;
}

export function renderLive(view, units, notice) {
  set('v-pace', fmtPace(view.pace));
  set('v-avgpace', fmtPace(view.avgPace));
  // Main timer is moving time: it stops while the rower is paused. Total includes pauses.
  set('v-time', fmtTime(view.movingS));
  set('v-total', fmtTime(view.totalS));
  $('live').dataset.state = view.state;
  const dist = fmtDistance(view.distance, units);
  set('v-dist', dist.value);
  set('u-dist', dist.unit);
  set('v-strokes', fmtInt(view.strokes));
  set('v-spm', fmtInt(view.spm));
  set('v-avgspm', fmtInt(view.avgSpm));
  set('v-power', fmtInt(view.power));
  set('v-avgpower', fmtInt(view.avgPower));
  set('v-knob', String(view.knob));
  set('v-kcal', fmtInt(view.kcal));
  set('v-kcal-src', view.kcalSource === 'estimate' ? 'estimated' : 'from rower');

  const b = bannerFor(view, notice);
  const el = $('banner');
  el.hidden = !b;
  if (b) {
    if (el.textContent !== b.text) el.textContent = b.text;
    el.dataset.kind = b.kind ?? '';
  }
}

const CONN_LABEL = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
};

export function renderConnection(state, name, label) {
  const el = $('conn');
  el.dataset.state = state;
  el.textContent = label ?? (state === 'connected' && name ? name : CONN_LABEL[state] ?? state);
}

// ---------- workouts ----------

function remainingText(p) {
  if (!p) return '';
  if (p.unit === 'm') return `${Math.max(0, Math.ceil(p.remaining))} m`;
  return fmtTime(Math.max(0, Math.ceil(p.remaining)));
}

function targetsText(step, hasReference) {
  if (!step) return '';
  if (step.type === 'rest') return 'Rest';
  const parts = [];
  if (step.paceRange) parts.push(`Pace ${fmtPace(step.paceRange[0])}–${fmtPace(step.paceRange[1])}`);
  else if (step.pacePct && !hasReference) parts.push('(set a reference pace for pace targets)');
  if (step.spm) parts.push(`Rate ${step.spm[0]}–${step.spm[1]}`);
  if (step.knob != null) parts.push(`Knob ${step.knob}`);
  return parts.join(' · ');
}

function stepSummary(s) {
  if (!s) return '';
  const len = s.distanceM != null ? `${s.distanceM} m` : fmtTime(s.durationS);
  const knob = s.knob != null ? ` · knob ${s.knob}` : '';
  return `${s.type === 'rest' ? 'Rest' : s.label} ${s.type === 'rest' || s.label?.includes(len) ? '' : len}${knob}`.replace(/\s+/g, ' ').trim();
}

/** @param run WorkoutRun or null; @param p run.progress() or null before the first stroke */
export function renderWorkout(run, p, view, hasReference) {
  const panel = $('workout-panel');
  panel.hidden = !run;
  for (const id of ['tile-pace', 'tile-spm']) delete $(id).dataset.target;
  if (!run) return;
  const total = run.steps.length;
  set('wk-name', run.workout.name);
  if (run.i < 0) {
    set('wk-step', `Step 1 of ${total}: ${run.next?.label ?? ''}`);
    set('wk-remaining', 'Ready');
    set('wk-targets', targetsText(run.next, hasReference));
    set('wk-next', 'Starts on your first stroke.');
    $('wk-bar-step').style.width = '0%';
    return;
  }
  const step = run.step;
  set('wk-step', `Step ${run.i + 1} of ${total}: ${step.label}`);
  set('wk-remaining', remainingText(p));
  set('wk-targets', targetsText(step, hasReference));
  set('wk-next', run.next ? `Next: ${stepSummary(run.next)}` : 'Last step');
  $('wk-bar-step').style.width = `${Math.min(100, Math.max(0, (p.elapsed / p.total) * 100)).toFixed(1)}%`;
  const ts = run.targetStatus(view);
  if (ts.pace) $('tile-pace').dataset.target = ts.pace === 'ok' ? 'ok' : 'off';
  if (ts.spm) $('tile-spm').dataset.target = ts.spm === 'ok' ? 'ok' : 'off';
}

/** @param prompt {knob, when} or null */
export function renderKnobPrompt(prompt) {
  const el = $('knob-prompt');
  el.hidden = !prompt;
  if (!prompt) return;
  set('kp-knob', String(prompt.knob));
  set('kp-when', prompt.when);
}

/** @param done {name, text, refPaceS} or null */
export function renderWorkoutDone(done) {
  $('workout-done').hidden = !done;
  if (!done) return;
  set('wd-title', `${done.name}: complete`);
  set('wd-text', done.text);
  const ref = $('wd-ref');
  ref.hidden = !done.refPaceS;
  if (done.refPaceS) set('wd-ref', `Use ${fmtPace(done.refPaceS)} /500m as my reference pace`);
}
