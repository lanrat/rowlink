// History screen: saved sessions list, session detail with charts, export, delete, backup.
import { listSessions, getSession, deleteSession, exportAll, importBackup } from '../storage/db.js';
import { exportSession, downloadBlob } from '../export/download.js';
import { fmtPace, fmtTime, fmtInt, fmtDistance } from './format.js';
import { drawLineChart } from './chart.js';
import { targetResults, GRACE_S } from '../session/targets.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...children.filter((c) => c != null));
  return e;
};

const SOURCE_LABEL = { simulator: 'Simulator', replay: 'Replay' };

const grade = (pct) => (pct >= 80 ? 'good' : pct >= 50 ? 'fair' : 'poor');

function onTargetText(t) {
  const parts = [];
  if (t.pacePct != null) parts.push(`pace ${t.pacePct}%`);
  if (t.spmPct != null) parts.push(`rate ${t.spmPct}%`);
  return parts.length ? ` · on target: ${parts.join(', ')}` : '';
}

function dateLabel(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function distLabel(m, units) {
  const d = fmtDistance(m, units);
  return `${d.value} ${d.unit}`;
}

export class HistoryView {
  /** @param getUnits () => 'imperial'|'metric' */
  constructor(getUnits) {
    this.getUnits = getUnits;
    this.current = null; // {session, data} open in detail
    this.confirmDeleteUntil = 0;
    $('history-export-all').addEventListener('click', () => this.exportAll());
    $('history-import').addEventListener('change', (e) => this.importFile(e));
    $('history-back').addEventListener('click', () => this.showList());
    for (const b of document.querySelectorAll('#history-detail [data-export]')) {
      b.addEventListener('click', () => this.current && exportSession(b.dataset.export, this.current.session, this.current.data));
    }
    $('history-delete').addEventListener('click', () => this.deleteCurrent());
    window.addEventListener('resize', () => this.current && this.drawCharts());
  }

  async showList() {
    this.current = null;
    $('history-detail').hidden = true;
    $('history-list-view').hidden = false;
    const list = $('history-list');
    let sessions = [];
    try {
      sessions = (await listSessions()).filter((s) => s.complete);
    } catch (e) {
      list.replaceChildren(el('p', { class: 'warn' }, `Could not open saved sessions: ${e.message}`));
      return;
    }
    $('history-empty').hidden = sessions.length > 0;
    const units = this.getUnits();
    list.replaceChildren(...sessions.map((s) => {
      const m = s.summary;
      return el('button', { class: 'session-row', onclick: () => this.openDetail(s.id) },
        el('span', { class: 'when' }, dateLabel(s.startedAt), s.workout ? el('span', { class: 'wo-name' }, s.workout.name) : null,
          SOURCE_LABEL[s.source] ? el('span', { class: 'badge' }, SOURCE_LABEL[s.source]) : null),
        el('span', { class: 'stat big' }, distLabel(m.distanceM, units)),
        el('span', { class: 'stat' }, fmtTime(m.movingS)),
        el('span', { class: 'stat' }, `${fmtPace(m.avgPaceS)} /500m`),
        el('span', { class: 'stat muted' }, `${fmtInt(m.avgSpm)} spm · ${fmtInt(m.avgPowerW)} W`,
          m.targets ? el('span', { class: 'on-target' }, onTargetText(m.targets)) : null));
    }));
  }

  async openDetail(id) {
    const found = await getSession(id);
    if (!found) return this.showList();
    this.current = found;
    this.confirmDeleteUntil = 0;
    $('history-delete').textContent = 'Delete';
    const { session: s } = found;
    const m = s.summary;
    const units = this.getUnits();
    $('history-title').textContent = s.workout ? `${s.workout.name} · ${dateLabel(s.startedAt)}` : dateLabel(s.startedAt);
    const knob = m.knobs?.length ? (m.knobs.length === 1 ? String(m.knobs[0]) : `${Math.min(...m.knobs)}–${Math.max(...m.knobs)}`) : '–';
    const tiles = [
      ['Distance', distLabel(m.distanceM, units)],
      ['Moving time', fmtTime(m.movingS), `total ${fmtTime(m.totalS)}`],
      ['Avg pace', `${fmtPace(m.avgPaceS)}`, `best ${fmtPace(m.bestPaceS)} /500m`],
      ['Stroke rate', `${fmtInt(m.avgSpm)} spm`, `max ${fmtInt(m.maxSpm)}`],
      ['Power', `${fmtInt(m.avgPowerW)} W`, `max ${fmtInt(m.maxPowerW)}`],
      ['Calories', `${fmtInt(m.kcal)} kcal`, m.kcalSource === 'estimate' ? 'estimated' : 'from rower'],
      ['Strokes', fmtInt(m.strokes)],
      ['Knob', knob],
    ];
    $('history-tiles').replaceChildren(...tiles.map(([label, value, sub]) =>
      el('div', { class: 'tile small' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), sub ? el('div', { class: 'sub' }, sub) : null)));
    this.renderTargets();
    $('history-list-view').hidden = true;
    $('history-detail').hidden = false;
    this.drawCharts();
  }

  renderTargets() {
    const { session, data } = this.current;
    const r = session.workout ? targetResults(session.workout.steps, data.samples) : null;
    this.targets = r;
    $('history-targets').hidden = !r;
    $('band-key').hidden = !r;
    if (!r) return;
    $('ht-note').textContent = `(first ${GRACE_S} s of each step not counted)`;
    $('ht-summary').replaceChildren(...[['Pace', r.pace], ['Stroke rate', r.spm]].filter(([, x]) => x).map(([label, x]) =>
      el('div', { class: `tile small grade-${grade(x.onPct)}` },
        el('div', { class: 'label' }, `${label} on target`),
        el('div', { class: 'value' }, `${Math.round(x.onPct)}%`))));
    const cell = (x, fmt) => [
      el('td', {}, x ? `${fmt(x.target[0])}–${fmt(x.target[1])}` : '–'),
      el('td', {}, x?.avg != null ? fmt(x.avg) : '–'),
      el('td', { class: x?.onPct != null ? `grade-${grade(x.onPct)}` : '' }, x?.onPct != null ? `${Math.round(x.onPct)}%` : '–'),
    ];
    $('ht-rows').replaceChildren(...r.steps.filter((s) => s.pace || s.spm).map((s) =>
      el('tr', {}, el('td', {}, s.label ?? `Step ${s.index + 1}`), ...cell(s.pace, fmtPace), ...cell(s.spm, (v) => Math.round(v)))));
  }

  drawCharts() {
    const samples = this.current.data.samples;
    const xs = samples.map((p) => p.mv ?? p.t);
    const xFmt = (s) => fmtTime(s);
    const live = (key) => samples.map((p) => (p.z ? null : p[key]));
    const steps = this.current.session.workout?.steps ?? [];
    const bandsFor = (key) => steps.flatMap((step, i) => {
      const range = step.type === 'row' ? step[key] : null;
      const inStep = samples.filter((p) => p.g === i);
      if (!range || !inStep.length) return [];
      return [{ x0: inStep[0].mv ?? inStep[0].t, x1: inStep.at(-1).mv ?? inStep.at(-1).t, lo: range[0], hi: range[1] }];
    });
    drawLineChart($('hist-chart-pace'), xs, live('p'), { invert: true, fmt: fmtPace, xFmt, bands: bandsFor('paceRange') });
    drawLineChart($('hist-chart-spm'), xs, live('r'), { xFmt, bands: bandsFor('spm') });
    drawLineChart($('hist-chart-power'), xs, live('w'), { fmt: (v) => `${Math.round(v)}`, xFmt });
    drawLineChart($('hist-chart-knob'), xs, samples.map((p) => p.n), { step: true, xFmt });
  }

  async deleteCurrent() {
    const btn = $('history-delete');
    if (performance.now() > this.confirmDeleteUntil) {
      // two-step delete instead of a confirm() dialog
      this.confirmDeleteUntil = performance.now() + 4000;
      btn.textContent = 'Tap again to delete';
      setTimeout(() => { if (performance.now() > this.confirmDeleteUntil) btn.textContent = 'Delete'; }, 4100);
      return;
    }
    await deleteSession(this.current.session.id);
    this.showList();
  }

  async exportAll() {
    const backup = await exportAll();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([JSON.stringify(backup)], { type: 'application/json' }), `rower-backup-${stamp}.json`);
  }

  async importFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const status = $('history-status');
    try {
      const n = await importBackup(JSON.parse(await file.text()));
      status.textContent = `Imported ${n} session${n === 1 ? '' : 's'}.`;
    } catch (err) {
      status.textContent = `Import failed: ${err.message}`;
    }
    this.showList();
  }
}
