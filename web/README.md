# Rower web app

Web Bluetooth app for the Yosuda rower (`YOSUDA-RM-*`). See [../PLAN.md](../PLAN.md).

## Run locally

Serve the repo root (the replay menu loads `../captures/`) with caching off:

```bash
python3 serve.py
```

Open <http://localhost:8080/web/> in Chrome. On Linux, Web Bluetooth may need `chrome://flags/#enable-web-bluetooth`.

No rower nearby? Use **Simulator** or **Replay a capture** on the connect screen.

## Test

```bash
npm test
```

Runs the decoding and smoothing pipeline over the real captures in `../captures/`. Needs Node 18+, no dependencies.

## Layout

| Path | What |
|---|---|
| `js/protocol/ftms.js` | FTMS packet decode/encode |
| `js/pipeline/` | assembler (2 packets → 1 Hz frame), sanitize (glitches, counters), metrics (smoothing), index (pipeline + view) |
| `js/session/clock.js` | total vs moving time |
| `js/ble/` | Web Bluetooth, replay, simulator transports |
| `js/ui/` | live dashboard, debug charts/log, settings |
