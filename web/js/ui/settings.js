// User settings, persisted per browser. (Moves to IndexedDB with history in M2.)
import { DEFAULT_SETTINGS } from '../pipeline/index.js';
import { KG_PER_LB, fmtPace } from './format.js';

/** "2:05" -> 125; '' -> null */
export function parsePace(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const KEY = 'rower.settings.v1';
export const SMOOTHING = {
  low: { paceWindowS: 10, spmWindowS: 10, powerWindowS: 8, adaptive: { shortS: 6, threshold: 0.2, alphaFast: 0.3, persist: 2 } },
  medium: { paceWindowS: 15, spmWindowS: 15, powerWindowS: 10, adaptive: { shortS: 10, threshold: 0.2, alphaFast: 0.3, persist: 2 } },
  high: { paceWindowS: 20, spmWindowS: 20, powerWindowS: 15, adaptive: { shortS: 12, threshold: 0.25, alphaFast: 0.3, persist: 3 } },
};

// Weight is stored in kg whatever the display units.
const UI_DEFAULTS = {
  smoothing: 'medium', calorieSource: 'rower', units: 'imperial', weightKg: 75, defaultKnob: 6,
  referencePaceS: null, knobOffset: 0, fastWork: true, sounds: true, metronome: false,
};

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    // storage unavailable or corrupt: use defaults
  }
  return { ...UI_DEFAULTS, ...saved };
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not fatal: settings just won't persist
  }
}

/** UI settings -> RowerPipeline settings */
export function pipelineSettings(s) {
  return {
    ...DEFAULT_SETTINGS,
    ...(SMOOTHING[s.smoothing] ?? SMOOTHING.medium),
    calorieSource: s.calorieSource,
    weightKg: Number(s.weightKg) || UI_DEFAULTS.weightKg,
    defaultKnob: Number(s.defaultKnob) || UI_DEFAULTS.defaultKnob,
  };
}

/** Wire the <dialog id="settings">; onSave(settings) is called after a save. */
export function setupSettingsDialog(dialog, openButton, getSettings, onSave) {
  const form = dialog.querySelector('form');
  const toDisplay = (kg, units) => Math.round(units === 'metric' ? kg : kg / KG_PER_LB);
  const toKg = (w, units) => (units === 'metric' ? w : w * KG_PER_LB);
  let shownUnits = 'imperial';
  const showWeightUnit = () => {
    dialog.querySelector('#u-weight').textContent = shownUnits === 'metric' ? 'kg' : 'lb';
  };

  openButton.addEventListener('click', () => {
    const s = getSettings();
    for (const el of form.elements) {
      if (!el.name || !(el.name in s)) continue;
      if (el.type === 'checkbox') el.checked = !!s[el.name];
      else el.value = s[el.name];
    }
    form.elements.referencePace.value = s.referencePaceS ? fmtPace(s.referencePaceS) : '';
    shownUnits = s.units;
    form.elements.weight.value = toDisplay(s.weightKg, s.units);
    showWeightUnit();
    dialog.showModal();
  });
  // switching units converts the weight already in the field
  form.elements.units.addEventListener('change', () => {
    const kg = toKg(Number(form.elements.weight.value), shownUnits);
    shownUnits = form.elements.units.value;
    form.elements.weight.value = toDisplay(kg, shownUnits);
    showWeightUnit();
  });
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const s = { ...getSettings() };
    for (const el of form.elements) {
      if (!el.name || el.name === 'weight' || el.name === 'referencePace') continue;
      s[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    s.referencePaceS = parsePace(form.elements.referencePace.value);
    const w = Number(form.elements.weight.value);
    if (w > 0) s.weightKg = toKg(w, s.units);
    saveSettings(s);
    onSave(s);
  });
}
