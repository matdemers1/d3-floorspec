"""The IFC worker's HTTP interface, on the compose network only (no host port).

    GET  /health   {"status": "ok", ...}
    POST /export   a payload (application/json) → the IFC file (application/x-step), with
                   X-Floorspec-Ifc-Summary: its entity counts and validation result, as JSON.

One export runs at a time; health answers meanwhile. A payload the worker does not read is a 422
with {"error": "..."} — the Node side puts that sentence in the job's error.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import health
from .check import problems
from .export import ExportError, export, summary
from .payload import PayloadError, parse

MAX_BODY = 64 * 1024 * 1024
DEFAULT_PORT = 3410
_lock = threading.Lock()


def render(raw: Any) -> tuple[bytes, dict[str, Any], str]:
    """A payload, as an IFC file's bytes, its summary and its name. Raises PayloadError, ExportError."""
    payload = parse(raw)
    with _lock:
        f = export(payload)
        errors = problems(f)
        if errors:
            first = errors[0].get("message", "")
            raise ExportError(f"the export is not valid IFC4 ({len(errors)} problems; the first: {first})")
        return f.to_string().encode("utf-8"), summary(f, 0), payload.name


def log(**fields: Any) -> None:
    print(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields}), flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "floorspec-ifc"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — the base class's name
        pass

    def _json(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 — the base class's name
        if self.path == "/health":
            self._json(200, health())
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/export":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            self._json(413 if length > MAX_BODY else 411, {"error": f"the payload must have a length of at most {MAX_BODY} bytes"})
            return
        started = time.monotonic()
        try:
            raw = json.loads(self.rfile.read(length))
            data, facts, name = render(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json(400, {"error": "the payload is not JSON"})
            return
        except PayloadError as e:
            log(msg="export refused", error=str(e))
            self._json(422, {"error": str(e)})
            return
        except ExportError as e:
            log(msg="export failed", error=str(e))
            self._json(500, {"error": str(e)})
            return
        except Exception as e:  # a bug: say what kind, never the payload
            log(msg="export failed", error=type(e).__name__, detail=str(e)[:300])
            self._json(500, {"error": f"the IFC worker failed ({type(e).__name__}: {str(e)[:200]})"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-step")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("X-Floorspec-Ifc-Summary", json.dumps(facts, separators=(",", ":")))
        self.end_headers()
        self.wfile.write(data)
        log(msg="exported", file=name, bytes=len(data), ms=round((time.monotonic() - started) * 1000), entities=facts["entities"])


def serve(host: str | None = None, port: int | None = None) -> ThreadingHTTPServer:
    host = host or os.environ.get("IFC_WORKER_HOST", "127.0.0.1")
    port = DEFAULT_PORT if port is None else port
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main(host: str | None = None, port: int | None = None) -> int:
    port = port if port is not None else int(os.environ.get("IFC_WORKER_PORT", DEFAULT_PORT))
    server = serve(host, port)
    log(msg="ifc worker listening", host=server.server_address[0], port=server.server_address[1], **health())
    import signal

    def stop(*_: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    server.serve_forever()
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
