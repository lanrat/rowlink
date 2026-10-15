# [Rowlink](https://lanrat.github.io/rowlink/)

A web app for the **Yosuda rowing machine** (`YOSUDA-RM-*`): live dashboard, guided workouts with knob prompts, history and FIT/TCX/CSV export. It talks to the rower directly over **Web Bluetooth**, so there's nothing to install: open it in Chrome or Edge on Android, Windows, macOS, ChromeOS or Linux.

It replaces the FED Fitness app (no account, no trackers) and fixes the jumpy numbers other apps show: the rower's own instantaneous pace and power swing 2× from stroke to stroke, so the app works them out from the rower's distance and stroke counters instead.

| | |
|---|---|
| App | [`web/`](web/): plain HTML/JS, no build step ([details](web/README.md)) |
| Design notes | [`PLAN.md`](PLAN.md): protocol findings, data pipeline, decisions |
| Recordings | [`captures/`](captures/): raw Bluetooth sessions from the real rower, used by the tests and the Replay feature |

## Run it locally

```bash
python3 web/serve.py
```

Then open <http://localhost:8080/web/> in Chrome. On Linux, Web Bluetooth may need `chrome://flags/#enable-web-bluetooth`.

## Tests

```bash
cd web && npm install && npm test
```

## Not supported

iOS (no Web Bluetooth in any iOS browser), Firefox and Safari.
