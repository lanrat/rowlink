// Live dashboard rendering. Called ~4x per second with pipeline.view().
import { fmtPace, fmtTime, fmtInt, fmtDistance } from './format.js';

const $ = (id) => document.getElementById(id);

function set(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function bannerFor(view, notice) {
  if (notice) return { text: notice };
  if (view.connection === 'reconnecting') return { text: 'Connection lost. Reconnecting… keep rowing, nothing is lost.', kind: 'warn' };
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
