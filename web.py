"""VeritasAI web UI — stdlib only, no framework, no build step.

    python web.py            # http://127.0.0.1:8000
    python web.py --port 9000 --open

Progress streams over Server-Sent Events so the courtroom fills in live as each
party files, which is the whole point of watching a trial.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from veritas.config import CITATIONS, GROUNDING, NoProviderError, ROLE_LABELS, ROLES, STAGES
from veritas.engine import resolve, try_claim

ROOT = Path(__file__).parent
STATIC = ROOT / "templates"

_roster_lock = threading.Lock()
_roster = None


def get_roster():
    """Resolve the roster once per process; the model catalog does not move."""
    global _roster
    with _roster_lock:
        if _roster is None:
            _roster = asyncio.run(resolve())
        return _roster


class Handler(BaseHTTPRequestHandler):
    server_version = "VeritasAI"

    def log_message(self, fmt, *args):  # noqa: A003 - quieter default logging
        if "/api/" in (self.path or ""):
            print(f"  {self.command} {self.path.split('?')[0]}")

    # --- helpers ---

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The server binds to localhost and holds no user data or credentials
        # beyond the operator's own API keys, which are never returned. Open
        # CORS is what lets the browser extension call it from any page.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload).encode("utf-8"), "application/json")

    def _sse(self, event: str, payload: dict) -> None:
        chunk = f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
        self.wfile.write(chunk)
        self.wfile.flush()

    # --- routes ---

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        url = urlparse(self.path)

        if url.path in ("/", "/index.html"):
            page = STATIC / "index.html"
            self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            return

        if url.path == "/api/roster":
            try:
                roster = get_roster()
            except NoProviderError as exc:
                self._json(503, {"error": str(exc)})
                return
            detail = {GROUNDING: "crossref · wikipedia · web", CITATIONS: "crossref lookup"}
            self._json(200, {"roster": [
                {
                    "role": r,
                    "label": ROLE_LABELS[r],
                    "provider": roster[r].provider.name if r in ROLES else "direct",
                    "model": roster[r].model if r in ROLES else detail[r],
                }
                for r in STAGES
            ]})
            return

        if url.path == "/api/try":
            claim = (parse_qs(url.query).get("claim") or [""])[0].strip()
            if not claim:
                self._json(400, {"error": "claim is required"})
                return
            self._stream_trial(claim)
            return

        # Non-streaming equivalent, for the browser extension and for scripts.
        if url.path == "/api/verdict":
            q = parse_qs(url.query)
            claim = (q.get("claim") or [""])[0].strip()
            if not claim:
                self._json(400, {"error": "claim is required"})
                return
            try:
                roster = get_roster()
                trial = asyncio.run(try_claim(
                    claim, roster,
                    ground=(q.get("ground") or ["1"])[0] != "0",
                    verify_citations=(q.get("citations") or ["1"])[0] != "0",
                ))
            except NoProviderError as exc:
                self._json(503, {"error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001 - report rather than 500 blindly
                self._json(500, {"error": f"{type(exc).__name__}: {exc}"})
                return
            self._json(200, trial.to_dict() | {"verdict": trial.verdict})
            return

        asset = (STATIC / url.path.lstrip("/")).resolve()
        if asset.is_file() and STATIC.resolve() in asset.parents:
            ctype = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
            self._send(200, asset.read_bytes(), ctype)
            return

        self._json(404, {"error": "not found"})

    def _stream_trial(self, claim: str) -> None:
        try:
            roster = get_roster()
        except NoProviderError as exc:
            self._json(503, {"error": str(exc)})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def on_progress(role: str, state: str) -> None:
            self._sse("progress", {"role": role, "state": state})

        try:
            trial = asyncio.run(try_claim(claim, roster, on_progress))
        except (BrokenPipeError, ConnectionResetError):
            return  # client navigated away mid-trial
        except Exception as exc:  # noqa: BLE001 - report, never 500 silently
            try:
                self._sse("error", {"message": f"{type(exc).__name__}: {exc}"})
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        try:
            self._sse("verdict", trial.to_dict() | {"verdict": trial.verdict})
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> int:
    p = argparse.ArgumentParser(description="Run the VeritasAI web courtroom.")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--open", action="store_true", help="open a browser once the server is up")
    args = p.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"VeritasAI courtroom in session at {url}")
    print("  ctrl-c to adjourn")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nadjourned")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
