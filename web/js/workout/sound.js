// Workout beeps (Web Audio, no sound files). Browsers only allow audio after a tap,
// so unlockAudio() is called from the button that starts a workout.

let ctx = null;
let enabled = true;

export function setSoundEnabled(on) {
  enabled = on;
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

export const sound = {
  countdown: () => beep(880, 90),
  step: () => beep(1320, 380),
  knob: () => beep(660, 140, 2),
  done: () => beep(1320, 160, 3),
};
