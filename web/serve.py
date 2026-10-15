#!/usr/bin/env python3
"""Local dev server: serves the repo root with caching disabled, so edits show up on reload.

Also accepts POST /captures/<name>.jsonl to save a capture from the app into captures/
(dev only: bound to 127.0.0.1, never overwrites).

Usage: python3 web/serve.py [port]   then open http://localhost:8080/web/
"""
import http.server
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAPTURE_NAME = re.compile(r"^/captures/([\w.-]+\.jsonl)$")
MAX_BYTES = 5 * 1024 * 1024


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        m = CAPTURE_NAME.match(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if not m or length <= 0 or length > MAX_BYTES:
            return self.send_error(400, "POST /captures/<name>.jsonl with a body under 5 MB")
        dest = os.path.join(ROOT, "captures", m.group(1))
        if os.path.exists(dest):
            return self.send_error(409, "capture already exists")
        with open(dest, "wb") as f:
            f.write(self.rfile.read(length))
        self.send_response(201)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = lambda *a, **kw: NoCacheHandler(*a, directory=ROOT, **kw)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
