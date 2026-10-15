// Built-in workouts. Standard indoor-rowing sessions, written for this app.
//
// Segment fields:
//   type: 'row' | 'rest'
//   durationS or distanceM: how the segment ends
//   knob: suggested knob level (1-16); the global knob offset setting shifts it
//   spm: [low, high] stroke-rate target
//   pacePct: [low, high] % of the user's reference speed (100 = reference pace, 110 = faster)
//   intensity: 'warmup' | 'active' | 'interval' | 'recovery' | 'cooldown' (labels + FIT laps)
//   benchmark: true on segments whose average pace can become the new reference pace
// A {repeat, segments} item repeats its segments.

const WARMUP = { type: 'row', durationS: 300, knob: 4, spm: [18, 22], pacePct: [80, 88], intensity: 'warmup', label: 'Warm-up' };
const COOLDOWN = { type: 'row', durationS: 300, knob: 4, spm: [18, 20], pacePct: [78, 85], intensity: 'cooldown', label: 'Cool-down' };
const EASY = (durationS) => ({ type: 'row', durationS, knob: 4, spm: [18, 20], pacePct: [78, 85], intensity: 'recovery', label: 'Easy' });
const REST = (durationS) => ({ type: 'rest', durationS, intensity: 'recovery', label: 'Rest' });

export const PRESETS = [
  // Benchmarks: no warm-up built in, so the whole row is the test.
  {
    id: 'test-2000m', category: 'Benchmark', name: '2000 m test', benchmark: true,
    description: 'The standard rowing test. Warm up first. Sets your reference pace.',
    segments: [{ type: 'row', distanceM: 2000, knob: 8, intensity: 'active', label: '2000 m', benchmark: true }],
  },
  {
    id: 'test-500m', category: 'Benchmark', name: '500 m test', benchmark: true,
    description: 'All-out sprint. Warm up first.',
    segments: [{ type: 'row', distanceM: 500, knob: 10, intensity: 'active', label: '500 m', benchmark: true }],
  },
  {
    id: 'test-20min', category: 'Benchmark', name: '20 min test', benchmark: true,
    description: 'Steady maximum effort for 20 minutes. Sets your reference pace.',
    segments: [{ type: 'row', durationS: 1200, knob: 8, intensity: 'active', label: '20 min', benchmark: true }],
  },

  {
    id: 'steady-20', category: 'Steady', name: '20 min @ 20 spm',
    description: 'Easy aerobic base at a low stroke rate.',
    segments: [WARMUP, { type: 'row', durationS: 1200, knob: 6, spm: [19, 21], pacePct: [88, 94], intensity: 'active', label: 'Steady' }, COOLDOWN],
  },
  {
    id: 'steady-30', category: 'Steady', name: '30 min @ 22 spm',
    description: 'Longer steady state.',
    segments: [WARMUP, { type: 'row', durationS: 1800, knob: 6, spm: [21, 23], pacePct: [90, 95], intensity: 'active', label: 'Steady' }, COOLDOWN],
  },
  {
    id: 'steady-5k', category: 'Steady', name: '5000 m',
    description: 'Steady distance piece.',
    segments: [WARMUP, { type: 'row', distanceM: 5000, knob: 6, spm: [20, 24], pacePct: [90, 96], intensity: 'active', label: '5000 m' }, COOLDOWN],
  },

  {
    id: 'int-8x500', category: 'Intervals', name: '8 × 500 m',
    description: '500 m hard, 2 min rest, eight times.',
    segments: [WARMUP, { repeat: 8, segments: [
      { type: 'row', distanceM: 500, knob: 9, spm: [26, 30], pacePct: [103, 108], intensity: 'interval', label: '500 m' },
      REST(120),
    ] }, COOLDOWN],
  },
  {
    id: 'int-4x1000', category: 'Intervals', name: '4 × 1000 m',
    description: '1000 m hard, 3 min rest, four times.',
    segments: [WARMUP, { repeat: 4, segments: [
      { type: 'row', distanceM: 1000, knob: 8, spm: [24, 28], pacePct: [100, 105], intensity: 'interval', label: '1000 m' },
      REST(180),
    ] }, COOLDOWN],
  },
  {
    id: 'int-4x4', category: 'Intervals', name: '4 × 4 min',
    description: '4 min hard, 2 min rest, four times.',
    segments: [WARMUP, { repeat: 4, segments: [
      { type: 'row', durationS: 240, knob: 8, spm: [24, 28], pacePct: [100, 105], intensity: 'interval', label: '4 min' },
      REST(120),
    ] }, COOLDOWN],
  },
  {
    id: 'int-10x1', category: 'Intervals', name: '10 × 1 min on / 1 min easy',
    description: 'Short, sharp efforts with easy rowing between.',
    segments: [WARMUP, { repeat: 10, segments: [
      { type: 'row', durationS: 60, knob: 10, spm: [28, 32], pacePct: [108, 115], intensity: 'interval', label: '1 min on' },
      EASY(60),
    ] }, COOLDOWN],
  },

  {
    id: 'pyramid', category: 'Pyramid', name: 'Pyramid 1-2-3-4-3-2-1',
    description: 'Hard pieces of 1 to 4 minutes and back down, 1 min easy between.',
    segments: [WARMUP, ...[1, 2, 3, 4, 3, 2, 1].flatMap((m, i, all) => [
      { type: 'row', durationS: m * 60, knob: 8, spm: [24, 28], pacePct: [100, 106], intensity: 'interval', label: `${m} min` },
      ...(i < all.length - 1 ? [EASY(60)] : []),
    ]), COOLDOWN],
  },

  {
    id: 'strength', category: 'Strength', name: '6 × 2 min power strokes',
    description: 'Low rate, high knob: long, strong strokes.',
    segments: [WARMUP, { repeat: 6, segments: [
      { type: 'row', durationS: 120, knob: 13, spm: [16, 18], pacePct: [95, 102], intensity: 'interval', label: '2 min power' },
      EASY(60),
    ] }, COOLDOWN],
  },

  {
    id: 'technique', category: 'Technique', name: 'Rate ladder 18-24',
    description: 'One minute each at 18, 20, 22 and 24 spm, four times. Focus on clean strokes.',
    segments: [WARMUP, { repeat: 4, segments: [18, 20, 22, 24].map((r) => (
      { type: 'row', durationS: 60, knob: 6, spm: [r - 1, r + 1], intensity: 'active', label: `${r} spm` }
    )) }, COOLDOWN],
  },
];
