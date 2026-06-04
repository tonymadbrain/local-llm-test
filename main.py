"""Spin up llama-server for each configured model, send one prompt, save the result.

Then (optionally) spin up each configured judge, score every result independently,
and append the scores back into each result JSON.
"""

from __future__ import annotations

import argparse
import json
import string
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx
import psutil
import yaml
from openai import OpenAI

LLAMA_SERVER = ""  # populated from config/models.yaml defaults.llama_server at startup
HOST = "127.0.0.1"
PORT = 8080
BASE_URL = f"http://{HOST}:{PORT}"
READY_TIMEOUT_S = 60
SHUTDOWN_TIMEOUT_S = 30
MAX_TOKENS = 2048
JUDGE_MAX_TOKENS = 2048

PROJECT_DIR = Path(__file__).parent
CONFIG_PATH = PROJECT_DIR / "config" / "models.yaml"
PROMPTS_DIR = PROJECT_DIR / "prompts"
PROMPT_PATH = PROMPTS_DIR / "prompt.txt"
REFERENCE_PATH = PROMPTS_DIR / "reference.txt"
JUDGE_PROMPT_PATH = PROMPTS_DIR / "judge_prompt.txt"
RESULTS_DIR = PROJECT_DIR / "results"

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "integer", "minimum": 1, "maximum": 10},
        "reason": {"type": "string"},
    },
    "required": ["score", "reason"],
    "additionalProperties": False,
}
JUDGE_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {"name": "judgment", "schema": JUDGE_SCHEMA, "strict": True},
}


class _Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data: str) -> int:
        for s in self.streams:
            s.write(data)
        return len(data)

    def flush(self) -> None:
        for s in self.streams:
            s.flush()


def wait_until_ready(timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        print(".", end="", flush=True)
        try:
            r = httpx.get(f"{BASE_URL}/health", timeout=2.0)
            if r.status_code == 200:
                return
        except Exception as e:
            last_err = e
        time.sleep(0.5)
    raise TimeoutError(f"llama-server not ready after {timeout_s}s (last: {last_err})")


def start_server(model_path: str, server_args: list[str]) -> subprocess.Popen:
    cmd = [LLAMA_SERVER, "-m", model_path, *server_args]
    print(f"  starting: {' '.join(cmd)}", flush=True)
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop_server(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def rss_mb(ps_proc: psutil.Process) -> float | None:
    try:
        return round(ps_proc.memory_info().rss / (1024 * 1024), 1)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def extract_response(resp) -> tuple[str, str]:
    """Return (primary_text, reasoning_text).

    Reasoning models (gpt-oss, qwen-thinking, etc.) often emit their actual answer
    into `reasoning_content` instead of `content`. Fall back to reasoning when
    content is empty so we don't lose the model's reply.
    """
    msg_dict = resp.choices[0].message.model_dump()
    content = msg_dict.get("content") or ""
    reasoning = msg_dict.get("reasoning_content") or ""
    primary = content if content.strip() else reasoning
    return primary, reasoning


def _set_llama_server(defaults: dict) -> bool:
    global LLAMA_SERVER
    LLAMA_SERVER = str(defaults.get("llama_server") or "").strip()
    if not LLAMA_SERVER:
        print(
            "Missing 'llama_server' under 'defaults' in config/models.yaml",
            file=sys.stderr,
        )
        return False
    return True


def resolve_entry(
    entry: dict, model_root: Path, default_args: list[str]
) -> tuple[str, str, list[str]]:
    name = entry["name"]
    model_path = str(model_root / entry["file"])
    server_args = default_args + list(entry.get("args") or [])
    return name, model_path, server_args


def run_candidate(
    name: str,
    model_path: str,
    server_args: list[str],
    prompt: str,
    reference: str,
    run_id: str,
) -> dict:
    now = datetime.now()
    record: dict = {
        "run_id": run_id,
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "model": name,
        "model_path": model_path,
        "server_args": server_args,
        "input": prompt,
        "reference": reference,
        "output": None,
        "reasoning_content": None,
        "duration_seconds": None,
        "rss_before_mb": None,
        "rss_after_mb": None,
        "rss_delta_mb": None,
        "judges": {},
    }
    proc: subprocess.Popen | None = None
    try:
        proc = start_server(model_path, server_args)
        wait_until_ready(READY_TIMEOUT_S)
        print(f"\n[{name}] ready, sending prompt", flush=True)
        ps_proc = psutil.Process(proc.pid)

        client = OpenAI(base_url=f"{BASE_URL}/v1", api_key="sk-no-key")
        print(f"[{name}] >>> request:\n{prompt}\n", flush=True)
        record["rss_before_mb"] = rss_mb(ps_proc)
        t0 = time.perf_counter()
        resp = client.chat.completions.create(
            model=name,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=MAX_TOKENS,
        )
        record["duration_seconds"] = round(time.perf_counter() - t0, 3)
        record["rss_after_mb"] = rss_mb(ps_proc)
        if record["rss_before_mb"] is not None and record["rss_after_mb"] is not None:
            record["rss_delta_mb"] = round(record["rss_after_mb"] - record["rss_before_mb"], 1)
        record["output"], reasoning = extract_response(resp)
        record["reasoning_content"] = reasoning or None
        print(f"[{name}] <<< response:\n{record['output']}\n", flush=True)
        print(
            f"[{name}] done in {record['duration_seconds']}s  "
            f"rss {record['rss_before_mb']}→{record['rss_after_mb']} MB",
            flush=True,
        )
    except Exception as e:
        record["error"] = f"{type(e).__name__}: {e}"
        print(f"\n[{name}] ERROR: {record['error']}", flush=True)
    finally:
        if proc is not None:
            stop_server(proc)
            print(f"[{name}] server stopped", flush=True)

    return record


def parse_judge_output(raw: str) -> tuple[int | None, str | None]:
    try:
        data = json.loads(raw)
        return data.get("score"), data.get("reason")
    except (json.JSONDecodeError, AttributeError, TypeError):
        return None, None


def run_judge(
    judge_name: str,
    judge_path: str,
    judge_args: list[str],
    judge_template: string.Template,
    result_paths: list[Path],
) -> None:
    print(f"\n--- judge: {judge_name} ---", flush=True)
    proc: subprocess.Popen | None = None
    try:
        proc = start_server(judge_path, judge_args)
        wait_until_ready(READY_TIMEOUT_S)
        ps_proc = psutil.Process(proc.pid)
        client = OpenAI(base_url=f"{BASE_URL}/v1", api_key="sk-no-key")
        for path in result_paths:
            record = json.loads(path.read_text(encoding="utf-8"))
            candidate_name = record.get("model", path.name)
            existing = record.get("judges", {}).get(judge_name)
            if existing and existing.get("score") is not None:
                print(
                    f"  [{judge_name}] {candidate_name}: already judged "
                    f"(score={existing['score']}), skipping",
                    flush=True,
                )
                continue
            if not record.get("output"):
                print(f"  [{judge_name}] skip {candidate_name} (no candidate output)", flush=True)
                continue
            eval_prompt = judge_template.substitute(
                task=record["input"],
                reference=record.get("reference", ""),
                candidate=record["output"],
            )
            entry: dict = {
                "model_path": judge_path,
                "rss_before_mb": None,
                "rss_after_mb": None,
                "rss_delta_mb": None,
                "reasoning_content": None,
            }
            try:
                print(
                    f"  [{judge_name}] >>> eval prompt for {candidate_name}:\n{eval_prompt}\n",
                    flush=True,
                )
                entry["rss_before_mb"] = rss_mb(ps_proc)
                t0 = time.perf_counter()
                resp = client.chat.completions.create(
                    model=judge_name,
                    messages=[{"role": "user", "content": eval_prompt}],
                    max_tokens=JUDGE_MAX_TOKENS,
                    response_format=JUDGE_RESPONSE_FORMAT,
                )
                entry["duration_seconds"] = round(time.perf_counter() - t0, 3)
                entry["rss_after_mb"] = rss_mb(ps_proc)
                if entry["rss_before_mb"] is not None and entry["rss_after_mb"] is not None:
                    entry["rss_delta_mb"] = round(entry["rss_after_mb"] - entry["rss_before_mb"], 1)
                raw, reasoning = extract_response(resp)
                entry["raw_output"] = raw
                entry["reasoning_content"] = reasoning or None
                entry["score"], entry["reason"] = parse_judge_output(raw)
                print(f"  [{judge_name}] <<< raw response:\n{raw}\n", flush=True)
                print(
                    f"  [{judge_name}] {candidate_name}: score={entry['score']}  "
                    f"rss {entry['rss_before_mb']}→{entry['rss_after_mb']} MB",
                    flush=True,
                )
            except Exception as e:
                entry["error"] = f"{type(e).__name__}: {e}"
                print(f"  [{judge_name}] {candidate_name} ERROR: {entry['error']}", flush=True)

            record.setdefault("judges", {})[judge_name] = entry
            path.write_text(
                json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
            )
    except Exception as e:
        print(f"[{judge_name}] judge server failed: {type(e).__name__}: {e}", flush=True)
    finally:
        if proc is not None:
            stop_server(proc)
            print(f"[{judge_name}] server stopped", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--judge-only",
        metavar="RUN_ID",
        help="Skip the candidate phase; only run judges against existing result JSONs "
        "for the given run_id (e.g. 20260604_122733). Skips any (candidate, judge) "
        "pairs that already have a non-null score.",
    )
    args = parser.parse_args()

    now_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    if args.judge_only:
        out_dir = RESULTS_DIR / args.judge_only[:8]
        if not out_dir.exists():
            print(f"No results folder for run {args.judge_only}", file=sys.stderr)
            return 1
        log_path = out_dir / f"{args.judge_only}_judge_{now_ts}.log"
    else:
        out_dir = RESULTS_DIR / now_ts[:8]
        out_dir.mkdir(parents=True, exist_ok=True)
        log_path = out_dir / f"{now_ts}.log"

    log_fh = open(log_path, "w", encoding="utf-8", buffering=1)
    sys.stdout = _Tee(sys.__stdout__, log_fh)
    print(f"log: {log_path}", flush=True)
    try:
        if args.judge_only:
            return _judge_only_run(args.judge_only, out_dir)
        return _run(now_ts, out_dir)
    finally:
        sys.stdout = sys.__stdout__
        log_fh.close()


def _judge_only_run(original_run_id: str, out_dir: Path) -> int:
    result_paths = sorted(out_dir.glob(f"{original_run_id}_*.json"))
    if not result_paths:
        print(f"No result JSONs matching {original_run_id}_*.json in {out_dir}", file=sys.stderr)
        return 1

    reference = (
        REFERENCE_PATH.read_text(encoding="utf-8").strip() if REFERENCE_PATH.exists() else ""
    )
    judge_template = (
        string.Template(JUDGE_PROMPT_PATH.read_text(encoding="utf-8"))
        if JUDGE_PROMPT_PATH.exists()
        else None
    )
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    defaults = config.get("defaults") or {}
    if not _set_llama_server(defaults):
        return 1
    model_root = Path(defaults.get("model_root", ""))
    default_args = list(defaults.get("args") or [])
    judges = config.get("judges") or []

    if not judges:
        print("No judges configured in models.yaml", file=sys.stderr)
        return 1

    print(f"judge-only run_id={original_run_id}  results={len(result_paths)}", flush=True)
    _judge_phase(judges, model_root, default_args, judge_template, reference, result_paths)
    return 0


def _run(run_id: str, out_dir: Path) -> int:
    prompt = PROMPT_PATH.read_text(encoding="utf-8").strip()
    reference = (
        REFERENCE_PATH.read_text(encoding="utf-8").strip()
        if REFERENCE_PATH.exists()
        else ""
    )
    judge_template = (
        string.Template(JUDGE_PROMPT_PATH.read_text(encoding="utf-8"))
        if JUDGE_PROMPT_PATH.exists()
        else None
    )

    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    defaults = config.get("defaults") or {}
    if not _set_llama_server(defaults):
        return 1
    model_root = Path(defaults.get("model_root", ""))
    default_args = list(defaults.get("args") or [])
    models = config.get("models") or []
    judges = config.get("judges") or []

    if not models:
        print("No models in models.yaml", file=sys.stderr)
        return 1

    print(f"run_id={run_id}  prompt={prompt!r}", flush=True)

    # --- Candidate phase ---
    result_paths: list[Path] = []
    for entry in models:
        name, model_path, server_args = resolve_entry(entry, model_root, default_args)
        record = run_candidate(name, model_path, server_args, prompt, reference, run_id)
        out_path = out_dir / f"{run_id}_{name}.json"
        out_path.write_text(
            json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"[{name}] wrote {out_path.relative_to(PROJECT_DIR)}", flush=True)
        result_paths.append(out_path)

    # --- Judge phase ---
    _judge_phase(judges, model_root, default_args, judge_template, reference, result_paths)
    return 0


def _judge_phase(
    judges: list[dict],
    model_root: Path,
    default_args: list[str],
    judge_template: string.Template | None,
    reference: str,
    result_paths: list[Path],
) -> None:
    if not judges:
        return
    if not reference or not judge_template:
        print(
            "Judges configured but reference.txt or judge_prompt.txt missing — skipping judges.",
            flush=True,
        )
        return

    print(
        f"\n=== JUDGING ({len(judges)} judge(s) × {len(result_paths)} result(s)) ===",
        flush=True,
    )
    for entry in judges:
        jname, jpath, jargs = resolve_entry(entry, model_root, default_args)
        run_judge(jname, jpath, jargs, judge_template, result_paths)


if __name__ == "__main__":
    raise SystemExit(main())
