// Live dashboard rendering. Called ~4x per second with pipeline.view().
import { fmtPace, fmtTime, fmtInt, fmtDistance, fmtLength } from './format.js';
import { buildTimeline, updateTimeline } from './timeline.js';

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

// In full screen the numbers are sized to the tile height; shrink any that are too wide.
const FIT_IDS = ['v-time', 'v-dist', 'v-power', 'v-knob', 'v-kcal']; // stroke rate lives in the gauge SVG, which scales itself
let fitKey = '';

export function fitValues(force = false) {
  const immersive = document.body.classList.contains('immersive');
  const key = `${immersive}|${innerWidth}x${innerHeight}|${FIT_IDS.map((id) => $(id).textContent.length).join(',')}`;
  if (!force && key === fitKey) return; // only re-measure when the text length or screen changes
  fitKey = key;
  for (const id of FIT_IDS) {
    const el = $(id);
    el.style.fontSize = '';
    if (!immersive || el.scrollWidth <= el.clientWidth) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = `${Math.floor((size * el.clientWidth * 0.97) / el.scrollWidth)}px`;
  }
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

  fitValues();
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

// Without a reference pace there are no pace targets; the Workouts page explains why.
function targetsText(step) {
  if (!step) return '';
  if (step.type === 'rest') return 'Rest';
  if (step.type === 'free') return 'No target · on the clock';
  const parts = [];
  if (step.paceRange) parts.push(`Pace ${fmtPace(step.paceRange[0])}–${fmtPace(step.paceRange[1])}`);
  if (step.spm) parts.push(`Rate ${step.spm[0]}–${step.spm[1]}`);
  if (step.knob != null) parts.push(`Knob ${step.knob}`);
  return parts.join(' · ');
}

function stepSummary(s) {
  if (!s) return '';
  const len = s.distanceM != null ? `${s.distanceM} m` : fmtTime(s.durationS);
  const knob = s.knob != null ? ` · knob ${s.knob}` : '';
  const spm = s.type === 'row' && s.spm ? ` · ${s.spm[0]}–${s.spm[1]} spm` : '';
  return `${s.type === 'rest' ? 'Rest' : s.label} ${s.type === 'rest' || s.label?.includes(len) ? '' : len}${knob}${spm}`.replace(/\s+/g, ' ').trim();
}

let timelineFor = null; // the run whose steps are drawn in the timeline

/** The current step's name under its timeline segment, kept inside the bar. */
function placeStepLabel(i, step) {
  const label = $('wk-steplabel');
  set('wk-steplabel', step?.label ?? '');
  const seg = $('wk-timeline').querySelector(`.seg[data-i="${i}"]`);
  const width = label.parentElement.clientWidth;
  const left = seg ? (parseFloat(seg.style.left) / 100) * width : 0;
  label.style.marginLeft = `${Math.max(0, Math.min(left, width - label.offsetWidth))}px`;
}

/**
 * @param run WorkoutRun or null
 * @param p run.progress() or null before the first stroke
 * @param o.referencePaceS for pace targets and for estimating distance steps' time
 * @param o.overall run.overall(): {fraction, remainingS}
 */
export function renderWorkout(run, p, view, { referencePaceS, overall }) {
  const panel = $('workout-panel');
  panel.hidden = !run;
  // the workout sets the knob at every step, so there's nothing to press
  $('tile-knob').classList.toggle('auto', !!run);
  set('knob-sub', run ? 'set by workout' : 'match the rower');
  for (const id of ['tile-pace', 'tile-spm']) delete $(id).dataset.target;
  if (!run) {
    timelineFor = null;
    return;
  }
  if (timelineFor !== run) {
    buildTimeline($('wk-timeline'), run.steps, referencePaceS ?? 150, { marker: true });
    timelineFor = run;
  }
  updateTimeline($('wk-timeline'), run.i, overall.fraction);
  const length = fmtLength(overall.totalS, run.steps.some((s) => s.distanceM != null));
  set('wk-total', `Total ${fmtTime(view.totalS)} · about ${fmtTime(Math.ceil(overall.remainingS))} left of ${length}`);
  const total = run.steps.length;
  set('wk-name', run.workout.name);
  placeStepLabel(run.i < 0 ? 0 : run.i, run.i < 0 ? run.next : run.step);
  if (run.i < 0) {
    set('wk-step', `Step 1 of ${total}`);
    set('wk-remaining', 'Ready');
    set('wk-targets', targetsText(run.next));
    set('wk-next', 'Starts on your first stroke.');
    return;
  }
  const step = run.step;
  set('wk-step', `Step ${run.i + 1} of ${total}`);
  set('wk-remaining', remainingText(p));
  set('wk-targets', targetsText(step));
  set('wk-next', run.next ? `Next: ${stepSummary(run.next)}` : 'Last step');
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
  set('wd-targets', done.targets ?? '');
  const ref = $('wd-ref');
  ref.hidden = !done.refPaceS;
  if (done.refPaceS) set('wd-ref', `Use ${fmtPace(done.refPaceS)} /500m as my reference pace`);
}
