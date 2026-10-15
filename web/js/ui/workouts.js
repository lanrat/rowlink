// Workouts screen: presets + your own workouts, and a simple editor.
import { PRESETS } from '../workout/presets.js';
import { flatten, plannedDurationS, plannedDistanceM } from '../workout/engine.js';
import { listWorkouts, saveWorkout, deleteWorkout } from '../storage/db.js';
import { fmtTime, fmtPace } from './format.js';
import { buildTimeline } from './timeline.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...children.filter((c) => c != null));
  return e;
};

export function describe(workout, referencePaceS) {
  const steps = flatten(workout);
  const rows = steps.filter((s) => s.type === 'row');
  const knobs = rows.map((s) => s.knob).filter((k) => k != null);
  const dist = plannedDistanceM(steps);
  const parts = [`≈ ${fmtTime(plannedDurationS(steps, referencePaceS ?? 150))}`];
  if (dist) parts.push(`${dist.toLocaleString()} m of distance pieces`);
  if (knobs.length) parts.push(Math.min(...knobs) === Math.max(...knobs) ? `knob ${knobs[0]}` : `knob ${Math.min(...knobs)}–${Math.max(...knobs)}`);
  return parts.join(' · ');
}

export class WorkoutsView {
  /**
   * @param getSettings () => settings
   * @param onStart (workout) => void
   */
  constructor(getSettings, onStart) {
    this.getSettings = getSettings;
    this.onStart = onStart;
    this.editing = null;
    $('wo-new').addEventListener('click', () => this.edit({ id: null, name: '', description: '', segments: [{ type: 'row', durationS: 600, knob: 6 }] }));
    $('wo-add').addEventListener('click', () => this.addSegmentRow({ type: 'row', durationS: 60, knob: 6 }));
    $('wo-cancel').addEventListener('click', () => this.show());
    $('wo-editor').addEventListener('submit', (e) => {
      e.preventDefault();
      this.save();
    });
    $('wo-editor').addEventListener('input', () => this.updateTotal());
  }

  async show() {
    $('wo-editor').hidden = true;
    $('workouts-list-view').hidden = false;
    const ref = this.getSettings().referencePaceS;
    $('wo-ref-hint').textContent = ref
      ? `Pace targets use your reference pace of ${fmtPace(ref)} /500m (change it in Settings).`
      : 'Set a reference pace in Settings, or row a benchmark, to get pace targets. Stroke-rate targets work without one.';
    let mine = [];
    try {
      mine = await listWorkouts();
    } catch (e) {
      console.warn('Could not load your workouts:', e.message);
    }
    const groups = [];
    if (mine.length) groups.push(['My workouts', mine, true]);
    const cats = [...new Set(PRESETS.map((p) => p.category))];
    for (const c of cats) groups.push([c, PRESETS.filter((p) => p.category === c), false]);
    $('workouts-list').replaceChildren(...groups.flatMap(([title, list, own]) => [
      el('h3', { class: 'wo-group' }, title),
      el('div', { class: 'wo-cards' }, ...list.map((w) => this.card(w, own))),
    ]));
  }

  card(w, own) {
    const ref = this.getSettings().referencePaceS;
    const preview = el('div', { class: 'wk-timeline', 'aria-hidden': 'true' });
    buildTimeline(preview, flatten(w), ref ?? 150);
    return el('div', { class: 'wo-card' },
      el('h3', {}, w.name),
      preview,
      w.description ? el('div', { class: 'meta' }, w.description) : null,
      el('div', { class: 'meta' }, describe(w, ref)),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => this.onStart(w) }, 'Start'),
        own
          ? el('button', { onclick: () => this.edit(w) }, 'Edit')
          : el('button', { onclick: () => this.edit({ ...w, id: null, name: `${w.name} (copy)`, segments: flatten(w).map(stripLabel) }) }, 'Customize'),
        own ? el('button', { class: 'danger', onclick: (e) => this.confirmDelete(e.currentTarget, w) }, 'Delete') : null));
  }

  async confirmDelete(btn, w) {
    if (btn.dataset.armed) {
      await deleteWorkout(w.id);
      this.show();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to delete';
    setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = 'Delete';
    }, 4000);
  }

  edit(workout) {
    this.editing = workout;
    const form = $('wo-editor');
    form.elements.name.value = workout.name;
    form.elements.description.value = workout.description ?? '';
    $('wo-editor-title').textContent = workout.id ? 'Edit workout' : 'New workout';
    $('wo-segments').replaceChildren();
    for (const s of flatten(workout)) this.addSegmentRow(s);
    $('workouts-list-view').hidden = true;
    form.hidden = false;
    this.updateTotal();
  }

  addSegmentRow(s) {
    const byTime = s.distanceM == null;
    const minutes = byTime && s.durationS % 60 === 0;
    const amount = byTime ? (minutes ? s.durationS / 60 : s.durationS) : s.distanceM;
    const unit = byTime ? (minutes ? 'min' : 's') : 'm';
    const num = (name, value, attrs = {}) => el('input', { name, type: 'number', value: value ?? '', ...attrs });
    const row = el('div', { class: 'seg-row', 'data-type': s.type },
      el('select', { name: 'type', 'aria-label': 'Type', onchange: (e) => { row.dataset.type = e.target.value; } },
        el('option', { value: 'row', selected: s.type === 'row' }, 'Row'),
        el('option', { value: 'rest', selected: s.type === 'rest' }, 'Rest')),
      num('amount', amount, { min: 1, step: 1, required: true, 'aria-label': 'Length' }),
      el('select', { name: 'unit', 'aria-label': 'Unit' }, ...['min', 's', 'm'].map((u) => el('option', { value: u, selected: u === unit }, u))),
      num('knob', s.knob, { min: 1, max: 16, step: 1, class: 'row-only', 'aria-label': 'Knob' }),
      el('div', { class: 'pair row-only' }, num('spmLo', s.spm?.[0], { min: 10, max: 50, 'aria-label': 'Rate from' }), '–', num('spmHi', s.spm?.[1], { min: 10, max: 50, 'aria-label': 'Rate to' })),
      el('div', { class: 'pair row-only' }, num('pctLo', s.pacePct?.[0], { min: 50, max: 150, 'aria-label': 'Pace % from' }), '–', num('pctHi', s.pacePct?.[1], { min: 50, max: 150, 'aria-label': 'Pace % to' })),
      el('div', { class: 'btns' },
        el('button', { type: 'button', 'aria-label': 'Move up', onclick: () => { row.previousElementSibling?.before(row); this.updateTotal(); } }, '↑'),
        el('button', { type: 'button', 'aria-label': 'Move down', onclick: () => { row.nextElementSibling?.after(row); this.updateTotal(); } }, '↓'),
        el('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { row.remove(); this.updateTotal(); } }, '✕')));
    row.dataset.intensity = s.intensity ?? '';
    row.dataset.label = KEEP_LABELS.has(s.label) ? s.label : ''; // other labels are regenerated from the length
    $('wo-segments').append(row);
  }

  readSegments() {
    return [...$('wo-segments').children].map((row) => {
      const v = (n) => row.querySelector(`[name="${n}"]`).value;
      const n = (name) => (v(name) === '' ? null : Number(v(name)));
      const type = v('type');
      const amount = n('amount') ?? 0;
      const seg = { type };
      if (v('unit') === 'm') seg.distanceM = amount;
      else seg.durationS = v('unit') === 'min' ? amount * 60 : amount;
      if (row.dataset.intensity) seg.intensity = row.dataset.intensity;
      if (row.dataset.label) seg.label = row.dataset.label;
      if (type === 'row') {
        if (n('knob') != null) seg.knob = n('knob');
        if (n('spmLo') != null && n('spmHi') != null) seg.spm = [n('spmLo'), n('spmHi')].sort((a, b) => a - b);
        if (n('pctLo') != null && n('pctHi') != null) seg.pacePct = [n('pctLo'), n('pctHi')].sort((a, b) => a - b);
      }
      return seg;
    });
  }

  updateTotal() {
    const w = { segments: this.readSegments() };
    $('wo-total').textContent = w.segments.length ? `Total ${describe(w, this.getSettings().referencePaceS)}` : 'Add at least one segment.';
  }

  async save() {
    const form = $('wo-editor');
    const segments = this.readSegments();
    if (!segments.length) return;
    const workout = {
      id: this.editing?.id ?? `w-${Date.now().toString(36)}`,
      name: form.elements.name.value.trim(),
      description: form.elements.description.value.trim(),
      category: 'Mine',
      segments,
    };
    await saveWorkout(workout);
    this.show();
  }
}

/**
 * Editor works on a flat list. Keep only descriptive labels (Warm-up, Easy, ...);
 * labels like "500 m" are regenerated from the length, so editing the length can't leave them stale.
 */
const KEEP_LABELS = new Set(['Warm-up', 'Cool-down', 'Easy', 'Rest', 'Steady']);
function stripLabel(s) {
  const base = s.label?.replace(/ \(\d+\/\d+\)$/, '');
  return { ...s, label: KEEP_LABELS.has(base) ? base : undefined };
}
