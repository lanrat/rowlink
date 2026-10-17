#!/usr/bin/env node
// Builds js/workout/classes.js from the FED app's rower classes (captures/app-workouts.json).
//
// Only the structure is used: stage times, resistance (= our knob, both 1-16) and stroke-rate
// ranges. Names and descriptions are our own (NAMES below); FED's text, images and videos are not.
// Introduction and Feedback steps are dropped (video talk). Stages with no target become `free`
// steps, timed on the wall clock: floor exercises, stretches, untargeted warm-up.
//
// Usage: node web/tools/import-fed.mjs   (rewrites web/js/workout/classes.js)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const CAPTURE = here('../../captures/app-workouts.json');
const OUT = here('../js/workout/classes.js');

/** course_id -> our name, one-line description, and optional names for the main steps. */
const NAMES = {
  78: { name: 'Stroke phases', description: 'A minute on each part of the stroke (catch, drive, finish, recovery), then a minute of full strokes. Knob 1.', steps: ['The catch', 'The drive', 'The finish', 'The recovery', 'Full stroke'] },
  72: { name: 'First intervals', description: 'Warm-up, then 4 × 2 min at 28–36 spm on knob 4 with 30 s easy between.' },
  2067: { name: 'Technique practice', description: 'Seven minutes of technique rowing with no targets: row at your own rate on any knob.' },
  79: { name: 'Build and hold', description: 'Three 2-min pieces as the rate climbs to 30–34 spm on knob 4–6, 2 min easy, then 2 × (2 min on knob 6, 1 min on knob 4).' },
  2061: { name: 'Lower-body circuit', description: '2 × (2 min row at 24–28 spm on knob 3, then 90 s of lower-body floor work).' },
  82: { name: 'Power push', description: '3 × 2 min at 28–36 spm with 1 min easy, then 5 min at 32–36 spm on knob 6.' },
  2068: { name: 'Core circuit', description: '2 × (2 min row at 24–28 spm on knob 3, then 90 s of core floor work).' },
  75: { name: 'Stamina ladder', description: 'Six 2-min pieces alternating knob 2 and 4 as the rate climbs to 26–30 spm, then five pieces alternating 24–28 and 28–32 spm.' },
  80: { name: 'Sprint repeats', description: '4 × 1 min at 34–38 spm on knob 4, with 2 min easy between.' },
  2062: { name: 'Lower-body builder', description: '3 × (2 min row at 28–32 spm on knob 3, then about 2 min of lower-body floor work).' },
  73: { name: 'Total-body mix', description: '4 × (1 min on knob 4, then a 20–30 s burst at 34–38 spm), 3 min on knob 8, 2 min on knob 6, then 2 min with no target.' },
  2063: { name: 'Core builder', description: '3 × (2 min row at 28–32 spm on knob 3, then 2 min of core floor work).' },
  76: { name: 'Stamina builder', description: '7 min on knob 4–6, 4 min easy, then 5 × 2 min on knob 6–8 with the rate rising to 34–38 spm.' },
  85: { name: 'Speed strokes', description: 'Almost 14 min of 1- and 2-min pieces on knob 2–8, with 1-min bursts at 32–36 spm.' },
  81: { name: 'Rising rate', description: '4 × 2 min as the rate climbs from 24–28 to 30–34 spm, then 2 min easy.' },
  2064: { name: 'Full-body circuit', description: '3 × (4 min row at 30–34 spm on knob 3, then 2 min of full-body floor work).' },
  74: { name: 'Endurance challenge', description: '19 min of mostly 3-min pieces on knob 4 at 26–34 spm, with 2 min easy at 18–22 spm twice.' },
  2065: { name: 'Functional circuit', description: '3 × (5 min row, then 2 min of floor work). The rate rises each round: 24–28, 30–34, 34–38 spm.' },
  90: { name: 'Energizer', description: '1-min pieces building to 32 spm, 2 × 30 s bursts on knob 6, then 4 min at 28–32 spm.' },
  77: { name: 'Tabata sprints', description: 'Five 10–20 s sprints at 32–36 spm with easy rowing between, then 5 min at 28–32 spm.' },
  2066: { name: 'Interval blocks', description: '4 × (2 min at 32–36 spm on knob 4, then 1–2 min easier on knob 2).' },
  88: { name: 'Long sets', description: '2 × 6 min at 28–32 spm on knob 6 with 2 min easy, then 3 min at 28–34 spm.' },
  69: { name: 'Heavy intervals', description: '3 × 2 min on knob 8 with 1 min easy, then 3 × 1 min on knob 8 at 30–34 spm with 2 min easy.' },
  86: { name: 'Rhythm ride', description: '9 min of pieces on knob 2–8 at 22–34 spm, then 5 min steady on knob 6.' },
  83: { name: 'Progression and power', description: '4 × 2 min as the rate rises to 30–34 spm, 4 min easy, then 3 × 1 min on knob 4 at 30–34 spm.' },
  89: { name: 'Quick surges', description: '2 min on knob 6, 6 × (30 s at 28–32 spm, 30 s easy), then 6 min 20 s at 28–32 spm.' },
  87: { name: 'Long mixed session', description: '4 × 2 min on knob 8 with 1 min easy, 3 × 1 min on knob 12, then 6 min steady on knob 6.' },
};

const DROP = new Set(['Introduction', 'Feedback']);

/** Warm-up / Cool-down / Block n kept; other main steps become "Set n" unless NAMES gives names. */
function stepLabels(steps, names) {
  let n = 0;
  return steps.map((s) => {
    if (/warm/i.test(s.name)) return { label: 'Warm-up', intensity: 'warmup' };
    if (/cool/i.test(s.name)) return { label: 'Cool-down', intensity: 'cooldown' };
    const label = names?.[n] ?? (/^Block \d+$/.test(s.name) ? s.name : `Set ${n + 1}`);
    n++;
    return { label, intensity: null };
  });
}

/**
 * Main-set intensity, for timeline colours and FIT laps: hard pieces are `interval`, the easy
 * stages after them `recovery`, the rest `active`. The first piece of a set is never an easy
 * stage "after" anything, so a set that starts low and builds starts `active`.
 */
function mainIntensity(stage, rowed) {
  const first = rowed[0] === stage;
  const maxKnob = Math.max(...rowed.map((x) => x.resistance));
  const maxSpm = Math.max(...rowed.map((x) => x.spm_target));
  const { resistance: knob, spm_target: spm } = stage;
  if (spm >= 30 || knob >= 10) return 'interval';
  if (spm <= 22 || (!first && knob < maxKnob && spm < maxSpm && (knob <= 2 || spm <= 24))) return 'recovery';
  return 'active';
}

function convertClass(w) {
  const our = NAMES[w.course_id];
  if (!our) throw new Error(`no name for course ${w.course_id} (${w.name}): add it to NAMES`);
  const steps = w.steps.filter((s) => !DROP.has(s.name));
  const labels = stepLabels(steps, our.steps);
  const segments = steps.flatMap((step, i) => {
    const { label, intensity } = labels[i];
    // consecutive untargeted stages (e.g. 4 × 30 s of stretches) become one free step
    const parts = [];
    for (const st of step.stages) {
      const free = st.resistance == null && st.spm_min == null;
      const last = parts.at(-1);
      if (free && last?.free) last.durationS += st.duration_s;
      else parts.push({ free, durationS: st.duration_s, stage: st });
    }
    const rowed = parts.filter((p) => !p.free).map((p) => p.stage);
    return parts.map((p, k) => {
      const seg = { type: p.free ? 'free' : 'row', durationS: p.durationS };
      if (!p.free) {
        seg.knob = p.stage.resistance;
        seg.spm = [p.stage.spm_min, p.stage.spm_max];
      }
      seg.intensity = intensity ?? (p.free ? 'active' : mainIntensity(p.stage, rowed));
      seg.label = parts.length > 1 ? `${label} (${k + 1}/${parts.length})` : label;
      return seg;
    });
  });
  const out = {
    id: `fed-${w.course_id}`,
    category: `Classes · Level ${w.difficulty.replace(/^F/, '')}`,
    name: our.name,
    description: our.description,
    tag: w.type,
  };
  if (w.estimated_distance_m) out.estDistanceM = w.estimated_distance_m;
  out.segments = segments;
  return out;
}

/** All classes, by level then length. */
export function convert(capture) {
  const total = (c) => c.segments.reduce((t, s) => t + s.durationS, 0);
  return capture.workouts.map(convertClass)
    .sort((a, b) => a.category.localeCompare(b.category) || total(a) - total(b));
}

/** A JS literal in the repo's style: single quotes, spaced braces and arrays. */
function lit(v) {
  if (typeof v === 'string') return v.includes("'") ? JSON.stringify(v) : `'${v}'`;
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }`;
  return String(v);
}

function render(classes) {
  const body = classes.map((c) => {
    const { segments, ...head } = c;
    const fields = Object.entries(head).map(([k, v]) => `    ${k}: ${lit(v)},`).join('\n');
    const segs = segments.map((s) => `      ${lit(s)},`).join('\n');
    return `  {\n${fields}\n    segments: [\n${segs}\n    ],\n  },`;
  }).join('\n');
  return `// Generated by tools/import-fed.mjs from captures/app-workouts.json. Do not edit by hand.
//
// Classes with the structure of the FED app's rower classes: stage times, knob levels and
// stroke-rate targets. Names and descriptions are our own. \`free\` steps have no targets and run
// on the clock (floor exercises, stretches, untargeted warm-up). estDistanceM is the FED app's
// distance estimate for the class.

export const CLASSES = [
${body}
];
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const classes = convert(JSON.parse(readFileSync(CAPTURE, 'utf8')));
  writeFileSync(OUT, render(classes));
  console.log(`wrote ${classes.length} classes to ${OUT}`);
}
