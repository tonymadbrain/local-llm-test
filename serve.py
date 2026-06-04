#!/usr/bin/env python3
"""Tiny HTTP server for the local-llm-test results viewer.

Usage:
    uv run python serve.py            # http://127.0.0.1:8765
    uv run python serve.py --port 9000
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

FRONTEND_DIR  = Path(__file__).parent / "frontend"
RESULTS_DIR   = Path(__file__).parent / "results"
HARDWARE_PATH = Path(__file__).parent / "config" / "hardware.yaml"

_MIME: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


def read_hardware() -> dict:
    try:
        data = yaml.safe_load(HARDWARE_PATH.read_text(encoding="utf-8")) or {}
        return {k: v or "" for k, v in data.items() if k in ("cpu", "gpu", "ram", "os")}
    except Exception:
        return {}


def list_runs() -> list[dict]:
    if not RESULTS_DIR.exists():
        return []
    runs: dict[str, list[Path]] = {}
    for date_dir in sorted(RESULTS_DIR.iterdir()):
        if not date_dir.is_dir():
            continue
        for p in date_dir.glob("*.json"):
            parts = p.stem.split("_", 2)
            if len(parts) < 3:
                continue
            run_id = "_".join(parts[:2])
            runs.setdefault(run_id, []).append(p)
    out = []
    for run_id, paths in sorted(runs.items(), reverse=True):
        judge_names: set[str] = set()
        for p in paths:
            try:
                judge_names.update(json.loads(p.read_text(encoding="utf-8")).get("judges", {}).keys())
            except Exception:
                pass
        out.append({
            "run_id": run_id,
            "date": f"{run_id[:4]}-{run_id[4:6]}-{run_id[6:8]}",
            "time": f"{run_id[9:11]}:{run_id[11:13]}:{run_id[13:15]}",
            "n_candidates": len(paths),
            "judges": sorted(judge_names),
        })
    return out


def get_run(run_id: str) -> list[dict] | None:
    date_dir = RESULTS_DIR / run_id[:8]
    if not date_dir.is_dir():
        return None
    paths = sorted(date_dir.glob(f"{run_id}_*.json"))
    if not paths:
        return None
    results = []
    for p in paths:
        try:
            results.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            pass
    return results or None


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence default request logs
        pass

    def _send_json(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", _MIME.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_404(self) -> None:
        self.send_response(404)
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send_file(FRONTEND_DIR / "index.html")
        elif path == "/app.js":
            self._send_file(FRONTEND_DIR / "app.js")
        elif path == "/style.css":
            self._send_file(FRONTEND_DIR / "style.css")
        elif path == "/api/runs":
            self._send_json({"runs": list_runs(), "hardware": read_hardware()})
        elif path.startswith("/api/runs/"):
            run_id = path[len("/api/runs/"):]
            data = get_run(run_id)
            if data is None:
                self._send_404()
            else:
                self._send_json(data)
        else:
            self._send_404()


def main() -> None:
    parser = argparse.ArgumentParser(description="local-llm-test results viewer")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    addr = ("127.0.0.1", args.port)
    server = ThreadingHTTPServer(addr, _Handler)
    print(f"Serving at http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
