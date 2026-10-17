// Segmented workout timeline: one block per step, sized by planned time, coloured by kind.
import { timeline } from '../workout/engine.js';

/** easy / steady / hard / rest, for colouring (free steps, with no targets, look like rest) */
export function stepKind(step) {
  if (step.type === 'rest' || step.type === 'free') return 'rest';
  if (step.intensity === 'interval') return 'hard';
  if (['warmup', 'cooldown', 'recovery'].includes(step.intensity)) return 'easy';
  return 'steady';
}

/** Fill `container` with blocks (and a position marker if `marker`). */
export function buildTimeline(container, steps, paceS, { marker = false } = {}) {
  const blocks = timeline(steps, paceS).map(({ start, end, step }, i) => {
    const d = document.createElement('div');
    d.className = `seg seg-${stepKind(step)}`;
    d.style.left = `${(start * 100).toFixed(3)}%`;
    d.style.width = `${((end - start) * 100).toFixed(3)}%`;
    d.dataset.i = i;
    d.title = step.label ?? '';
    return d;
  });
  container.replaceChildren(...blocks);
  if (marker) {
    const m = document.createElement('div');
    m.className = 'seg-marker';
    container.append(m);
  }
}

/** Highlight the current step, dim finished ones, move the marker. */
export function updateTimeline(container, currentIndex, fraction) {
  for (const seg of container.querySelectorAll('.seg')) {
    const i = Number(seg.dataset.i);
    seg.classList.toggle('done', i < currentIndex);
    seg.classList.toggle('current', i === currentIndex);
  }
  const m = container.querySelector('.seg-marker');
  if (m) m.style.left = `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(2)}%`;
}
