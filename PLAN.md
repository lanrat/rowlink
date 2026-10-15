# Yosuda Rower Web App — Plan (draft for review)

Static HTML/JS web app that talks to the Yosuda rower (`YOSUDA-RM-*`) over Web Bluetooth and replaces both the FED Fitness app and PowerTrain.

Status: **draft, nothing built yet.** Decisions are in [section 9](#9-decisions), workouts in [section 10](#10-workouts).

---

## 1. Goals and non-goals

**Goals**
- Live dashboard with smooth, trustworthy numbers (pace, stroke rate, power, distance, time)
- Interval workouts that prompt knob changes (1–16) and assume you made them
- Local workout history with charts
- Export to FIT (Garmin/Strava upload), TCX, CSV
- Works offline once loaded (PWA), no account, no trackers

**Non-goals**
- Other rowers or machine types (bike, treadmill)
- Strava/Health Connect integration
- iOS (Web Bluetooth unsupported)
- FED's paid video courses

---

## 2. What we know about the rower

Measured from three captures in [captures/](captures/).

| Fact | Detail |
|---|---|
| Advertises as | `YOSUDA-RM-xxxx`, FTMS service `0x1826` |
| Data | Rower Data `0x2AD1` only. Bike/treadmill/cross-trainer characteristics exist but stay silent |
| Rate | 1 Hz, always 2 packets: **A** `flags 0x007F` (avg spm, distance, pace, avg pace, power, avg power) then **B** `flags 0x0900` (spm, strokes, kcal, elapsed) |
| MTU | 23, which is why the record is split in two |
| Resistance | Manual knob 1–16. **Invisible to BT.** Power/distance are computed from flywheel speed only |
| Control | Not needed: data streams with no commands. Knob can't be set |
| Screen | Rower console turns **off** while connected. The app is the only display |
| Auto-pause | ~4 s after the last stroke: status `02 02`, live values go to 0, Elapsed Time freezes. Next stroke: status `04` |
| Rests | Counters continue after a 3-min rest. Elapsed Time does **not** count rest time |
| Disconnects | Dropped once right after auto-pause (console stayed off). Counters survived the reconnect |
| Session start | Counters may already be non-zero (rower counts from wake) |

**Glitches to filter**

| Glitch | Example |
|---|---|
| Pace `0xFFFF` (= no value) | First stroke of session / after resume |
| Zeros while paused | pace=0, power=0, spm=0 |
| First stroke after resume | 425 W, 46–48 spm (real ~36) |
| Distance jump at start | 0 → 41 → 82 m in ~3 s |
| Per-stroke pace noise | Steady rowing: pace swings 2:19–6:46; reported pace ~10% faster than distance implies |

---

## 3. Platform

| Choice | Decision |
|---|---|
| Browsers | Chrome/Edge on Android, Windows, macOS, ChromeOS. Linux may need `chrome://flags/#enable-web-bluetooth` |
| Hosting | Any static HTTPS host (GitHub Pages / Cloudflare Pages), or `localhost` |
| Build | **None.** Plain ES modules, open `index.html` via any static server |
| Framework | None. Small UI, vanilla JS + CSS |
| Libraries | None shipped. FIT is written by our own small encoder (`js/export/fit.js`): Garmin's SDK license forbids redistributing it, so `@garmin/fitsdk` is a **dev-only** dependency used by the tests to decode and validate our files. Charts are plain canvas |
| Offline | Service worker caches the app shell → installable PWA |
| Screen | Screen Wake Lock API during sessions |
| Storage | IndexedDB for sessions (`sessions` summaries + `sessionData` samples/raw packets); settings stay in localStorage |

---

## 4. Architecture

```
            ┌──────────── transports (same interface) ────────────┐
            │ WebBluetooth   │  Replay (capture .jsonl)  │ Simulator │
            └───────┬────────┴─────────────┬────────────┴─────┬─────┘
                    ▼ raw packets {t, char, bytes}             │
              protocol/ftms.js   pure decode (rower, status, training)
                    ▼
              pipeline/assembler.js   A+B → one 1 Hz frame
                    ▼
              pipeline/sanitize.js    glitches, baselines, counter resets
                    ▼
              pipeline/metrics.js     smoothing / derived metrics
                    ▼
              session/clock.js        wall-clock time, pause/rest state
                    ▼
     workout/engine.js ──► ui/*  ◄── storage/db.js ──► export/*
```

Everything from `protocol/` to `workout/` is **pure JS with no browser APIs** → unit-testable in Node against the real captures.

### 4.1 Transport (`ble/transport.js`)
- `requestDevice({filters: [{namePrefix: 'YOSUDA-RM'}, {namePrefix: 'YSD-RM'}], optionalServices: [0x1826, 0x180a]})`
- Subscribe `0x2AD1`, `0x2ADA`, `0x2AD3`
- Reconnect on `gattserverdisconnected`: retry `device.gatt.connect()` with backoff (no picker needed within the same page load). Banner: "Reconnecting…"
- After a page reload, try `navigator.bluetooth.getDevices()` to skip the picker. If it's unavailable, one tap on "Connect"
- Records every raw packet with a timestamp (for debugging and replay)
- On connect and on **New session**: Request Control (`00`) → Reset (`01`) → Start (`07`), 200 ms apart, like the FED app. Zeroes the rower's counters. Not sent on automatic reconnects
- A Reset status (`01`) from the rower itself ends the session (ignored for 5 s after the app's own reset)

### 4.2 Assembler
- Buffer packet A, emit a frame on packet B (`bit0 = 0`)
- If a lone A or lone B arrives, still emit with what's present (never blank a field: last-known values carry forward)

### 4.3 Sanitize
| Rule | Action |
|---|---|
| pace ≥ 0xFFFF or 0 | `null` (not a number to display) |
| status paused | live metrics → `null`, UI shows "Paused" |
| First 2 strokes after start/resume | ignore power and spm |
| Distance jump implying > 7 m/s + 5 m | reject the jump (keep counting from the next sane value) |
| Flywheel spin-up (first 4 strokes of a session, 2 after a pause) | distance must stay under 6 m/s with no slack; those strokes are left out of the pace window |
| Counter decreases (rower reset/slept) | add previous total to an offset; session totals keep increasing |
| Session start | record baseline of distance/strokes/kcal; subtract |

### 4.4 Metrics (tunable in Settings, defaults from the captures)
| Display | Source | Default |
|---|---|---|
| Pace | **least-squares slope of distance** over 15 s, with an adaptive 10 s window that takes over during real changes and after pauses, plus a light exponential filter | 15 s / 10 s |
| Power | rolling **median** of reported power | 10 s |
| Stroke rate | same method on the stroke counter | 15 s / 10 s |
| Distance, strokes, kcal | sanitized counters | — |
| Time | **wall clock** of the session (rower elapsed ignores rests) | — |

Raw values stay in the recording so smoothing can be re-tuned later.

### 4.5 Session clock
States: `idle → active ⇄ auto-paused → finished`, plus `rest` (driven by a workout).
- Free row: auto-paused time is excluded from "moving time" but shown as total time
- Workout: rest segments are timed by the app, not the rower

### 4.6 Workout engine
Workout JSON:
```json
{
  "name": "Pyramid 4×4",
  "segments": [
    {"type": "row",  "duration_s": 300, "knob": 4, "target": {"spm": [20, 22]}},
    {"type": "row",  "duration_s": 240, "knob": 8, "target": {"spm": [26, 28], "pace_s": [140, 150]}},
    {"type": "rest", "duration_s": 120},
    {"type": "row",  "distance_m": 500, "knob": 12}
  ]
}
```
- Segment ends by time **or** distance
- **Knob prompt:** 10 s before a change → big "Set knob to 8" banner + countdown + beep. At the boundary the app assumes the new level
- One tap "I'm actually at __" to correct (recorded)
- Targets: pace and/or stroke-rate ranges (not watts: watts ignore the knob). Tile turns green/amber/red
- Free row: manual knob selector on the dashboard

### 4.7 Storage (IndexedDB)
- `sessions`: summary + 1 Hz samples `{t, dist, strokes, spm, pace, power, kcal, knob, segment}` + raw packets (≈ 400 KB/hour, can be pruned)
- `workouts`: built-in presets + user-made
- `settings`: smoothing windows, sounds/voice, units, default knob

### 4.8 Export
| Format | Contents | Use |
|---|---|---|
| FIT | sport `rowing` / `indoor_rowing`, laps per segment, records with distance, speed, power, cadence (spm), **resistance (knob)** | Garmin Connect, Strava manual upload |
| TCX | distance, time, cadence, watts | Older tools |
| CSV | 1 Hz samples | Spreadsheets |
| JSON | full session + raw packets | Backup, replay, bug reports |

Import of the JSON backup restores history on another device.

---

## 5. Screens

| Screen | Contents |
|---|---|
| **Connect** | Big "Connect rower" button, last device, browser-support check with clear message |
| **Live** | Huge tiles: time, pace, spm, power, distance, **knob**. Segment progress bar + "next: knob 8 in 0:10". Pause/finish buttons. Reconnecting banner |
| **Workouts** | Preset list, simple editor (add segment, duration/distance, knob, targets) |
| **History** | List of sessions; detail view with pace/spm/power charts, knob shown as a step line, export buttons |
| **Settings** | Smoothing windows, sounds/voice, units |
| **Debug** | Live raw packets, decoded frames, replay a capture file, simulator toggle |

Live screen is designed for a phone/tablet on a mount: landscape and portrait, readable at 2 m.

---

## 6. File layout

```
web/
  index.html            app shell
  manifest.webmanifest  PWA
  sw.js                 service worker (offline cache)
  css/app.css
  js/
    main.js             router + wiring
    ble/transport.js    Web Bluetooth
    ble/replay.js       capture-file transport
    ble/simulator.js    fake rower
    protocol/ftms.js
    pipeline/assembler.js
    pipeline/sanitize.js
    pipeline/metrics.js
    session/clock.js
    workout/engine.js
    workout/presets.js
    storage/db.js
    export/fit.js  export/tcx.js  export/csv.js
    ui/live.js  ui/connect.js  ui/workouts.js  ui/history.js  ui/settings.js  ui/debug.js
  vendor/               fitsdk, uPlot
  test/                 node --test, runs the pipeline over ../captures/*.jsonl
captures/               real rower recordings (already here)
```

---

## 7. Testing

- `node --test web/test` with no dependencies
- Golden checks on the real captures:
  - No `65535` or `0` pace ever reaches the UI
  - Smoothed pace stays within ~5% of the distance-derived average
  - 425 W resume spike and the 0 → 82 m start jump are filtered
  - Session totals survive the disconnect in `03-rest.jsonl`
- Simulator + replay transport for UI work without rowing
- Final check on the real rower: Chrome on Linux (this machine) and Chrome on Android

---

## 8. Milestones

| # | Deliverable | Estimate |
|---|---|---|
| M1 ✅ | Connect, decode, pipeline, live dashboard, replay + simulator, tests on captures | done |
| M2 ✅ | Session recording, history with charts, FIT/TCX/CSV/JSON export, backup/restore | done |
| M3 | Workouts: engine, knob prompts (beep + voice), presets, editor | 1–2 days |
| M4 | PWA offline/install, wake lock, reconnection polish, settings | ~½ day |
| M5 (optional) | Bluetooth heart-rate strap | ~½ day |

Each milestone ends usable: after M1 you can row with a non-jumpy display.

---

## 9. Decisions

| Topic | Decision |
|---|---|
| Hosting | Local (`localhost`) for now; GitHub Pages later via an Actions workflow that publishes `web/` |
| Heart rate | Later (M5) |
| Prompts | **Beep only** for now (drop `speechSynthesis` from 4.6) |
| Calories | **Both**, selectable in Settings: (a) rower's kcal, (b) estimate from body weight + knob + stroke rate (see 10.3) |
| Minimum to save | Sessions under **20 m** are discarded, as in the FED app (`view.worthSaving`; enforced when M2 adds history) |
| Units | **Imperial by default** (distance in miles, weight in lb), metric selectable. Pace stays /500m, the rowing standard. Stored internally in metres and kg |
| Presets | See section 10 |

---

## 10. Workouts

### 10.1 Sources
| Source | Usable? |
|---|---|
| FED app | **No.** Rower courses are streamed from FED's server with videos; nothing is bundled in the APK, and the content is theirs |
| PowerTrain | **Ideas only.** License allows non-commercial forks. Its generator has 7 types (base endurance, VO2max, sprint, technique, strength, pyramid, race sim) with targets as **% of a reference pace** + stroke rate |
| Standard rowing sessions | **Yes.** Common formats like 2k test, 8×500m, 4×1000m, pyramids, 30 min at 20 spm are general training knowledge, written fresh here |

### 10.2 Personalised targets
- Settings holds a **reference pace** (default: from a benchmark test, else entered by hand)
- Workout targets are written as **% of reference speed** (100% = reference, 110% = faster) plus stroke-rate ranges, so presets scale to fitness
- After a benchmark workout, the app offers to update the reference pace
- Knob levels in presets are **suggested defaults** (warm-up 4, steady 6, intervals 8–10, power pieces 12–14). A global "knob offset" setting shifts all presets up or down

### 10.3 Calorie estimate (option b)
Taken from the FED app's own fallback formula (`RowerDataCompat.getMETs`):
- kcal per second = `weight_kg × MET / 3600`
- MET from knob position (≤30%, ≤70%, >70% of 16) × stroke-rate bucket (≤20, ≤30, ≤40, ≤50, >50 spm)
  - low knob: 4 / 5 / 6 / 7.5 / 9
  - mid knob: 5 / 6 / 8 / 9.5 / 12
  - high knob: 6 / 8 / 10 / 12.5 / 15

### 10.4 Preset list (draft)
| Category | Preset |
|---|---|
| Benchmark | 2000 m test · 500 m test · 20 min test |
| Steady | 20 min @ 20 spm · 30 min @ 22 spm · 5000 m |
| Intervals | 8 × 500 m / 2:00 rest · 4 × 1000 m / 3:00 rest · 4 × 4 min / 2:00 rest · 10 × 1 min on / 1 min easy |
| Pyramid | 1-2-3-4-3-2-1 min, 1 min easy between |
| Strength | 6 × 2 min @ 16–18 spm high knob / 1 min easy |
| Technique | 4 × (1 min @ 18, 20, 22, 24 spm) ladder |

Each preset: 5 min warm-up + main set + 5 min cool-down unless it's a test.
