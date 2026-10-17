// Workout beeps and the pacer click (Web Audio, no sound files). Browsers only allow audio after a tap,
// so unlockAudio() is called from the button that starts a workout.

let ctx = null;
let enabled = true;
let metronome = false;
let lastBeepS = -Infinity; // audio-clock time the last beep started

export function setSoundEnabled(on) {
  enabled = on;
}

export function setMetronomeEnabled(on) {
  metronome = on;
}

export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null; // no Web Audio: workouts still run, silently
  }
}

function beep(freq, ms, count = 1, gapMs = 110) {
  if (!enabled || !ctx) return;
  const t0 = ctx.currentTime + 0.02;
  lastBeepS = t0 + ((count - 1) * (ms + gapMs)) / 1000;
  for (let i = 0; i < count; i++) {
    const start = t0 + (i * (ms + gapMs)) / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.4, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + ms / 1000 + 0.02);
  }
}

/** Pacer click at the catch: short and soft, and skipped when it would land on a beep. */
function click() {
  if (!metronome || !ctx) return;
  const start = ctx.currentTime + 0.01;
  if (Math.abs(start - lastBeepS) < 0.4) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = 1000;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.25, start + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.06);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + 0.08);
}

export const sound = {
  click,
  countdown: () => beep(880, 90),
  step: () => beep(1320, 380),
  knob: () => beep(660, 140, 2),
  done: () => beep(1320, 160, 3),
};
