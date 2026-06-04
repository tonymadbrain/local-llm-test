# local-llm-test

Minimal harness for comparing local `.gguf` models served by [`llama-server`](https://github.com/ggerganov/llama.cpp).

For each configured **candidate** model it:
1. Starts `llama-server` with that model.
2. Sends the prompt in `prompts/prompt.txt` via the OpenAI-compatible API on `127.0.0.1:8080`.
3. Stops the server and writes the answer + timing to `results/YYYYMMDD/<run_id>_<model>.json`.

Then, for each configured **judge** model it:
1. Starts `llama-server` with that judge.
2. Scores every candidate result against `prompts/reference.txt` using `prompts/judge_prompt.txt`.
3. Appends `{ score, reason, raw_output, duration_seconds }` back into each candidate's JSON under `judges.<judge_name>`.

All candidate runs from one invocation share the same `run_id` (start-of-script timestamp), so they're easy to group and diff.

## Get started

Requires:
* [`mise`](https://mise.jdx.dev/)
* built [`llama-server`](https://github.com/ggerganov/llama.cpp) binary

Steps:
1. Copy `config/models.yaml.example` to `config/models.yaml` and set `defaults.llama_server` to your built `llama-server` binary path
2. Set up your models in `config/models.yaml`
3. Set up your prompts in `prompts/`
4. Install dependencies
  ```bash
  make install   # uv sync — install dependencies
  ```
5. Describe your hardware in `config/hardware.yaml`
  ```yaml
  cpu: Apple M3 Max
  gpu: Apple M3 Max (GPU cores)
  ram: 64 GB
  os: MacOS Tahoe 26.5
  ```
6. Run the framework
  ```bash
  make run       # uv run main.py — run the framework
  ```
7. Browse results
  ```bash
  make serve     # uv run python serve.py — open http://127.0.0.1:8765
  ```

## Viewer

```bash
make serve          # http://127.0.0.1:8765
# or
python serve.py --port 9000   # custom port
```

Opens a browser UI that reads from `results/`. Left pane lists every run (newest first); clicking a run shows:

* **Chart panel** — tabs: Overall composite rank, Judge scores (grouped), Speed (green→red), Memory. Hover any bar for details.
* **Results table** — model, duration, RSS delta, per-judge score, average score. Click a row for a full drill-down (input, output, reasoning, per-judge reason). Columns are sortable.
* **Hardware** — CPU / GPU / RAM shown in the run header, sourced from `config/hardware.yaml`.

The viewer is read-only and stateless; hit ⟳ to pick up new runs without restarting the server. Run URLs (`#/runs/<run_id>`) are bookmarkable.

## Layout

```
config/
  models.yaml         # defaults + list of candidate models + list of judges
prompts/
  prompt.txt          # the prompt sent to every candidate
  reference.txt       # gold answer the judges score candidates against
  judge_prompt.txt    # judge template ($task, $reference, $candidate placeholders)
main.py               # the whole framework
serve.py              # results viewer — stdlib HTTP server (no extra deps)
frontend/             # viewer HTML/CSS/JS (served by serve.py)
results/YYYYMMDD/     # one JSON per (run_id, model) + one .log per run_id
```

## Configure

Edit `config/hardware.yaml` to describe the machine running the benchmarks:

```yaml
cpu: Apple M3 Max
gpu: Apple M3 Max (GPU cores)
ram: 64 GB
os: MacOS Tahoe 26.5
```

Leave any field blank to omit it from the viewer. The file is re-read on every request, so changes take effect without restarting `serve.py`.

Copy `config/models.yaml.example` to `config/models.yaml` and edit:

```yaml
defaults:
  llama_server: /Users/you/bin/llama.cpp/llama-server
  model_root: /Users/you/ai_models
  args: ["--host", "127.0.0.1", "--port", "8080", "--n-gpu-layers", "999", "--flash-attn", "on"]

models:
  - name: gemma-3-1b
    file: google/gemma-3-1b-it-Q4_K_M.gguf
    args: ["--ctx-size", "32768"]      # appended after defaults; last occurrence of a flag wins

judges:
  - name: judge-llama-3.1-8b
    file: meta/llama-3.1-8b-instruct-q5_k_m.gguf
```

The full `.gguf` path is `model_root + "/" + file`. Per-entry `args` is appended after `defaults.args`.

Copy `prompts/prompt.txt.example` to `prompts/prompt.txt` and `prompts/reference.txt.example` to `prompts/reference.txt`, then edit both to match the task you're benchmarking. (And rarely, tweak `prompts/judge_prompt.txt`.) If `judges` is empty or `prompts/reference.txt` is missing, the judge phase is skipped.

The path to the `llama-server` binary is set in `config/models.yaml` under `defaults.llama_server`.

## Run

```bash
uv run main.py                              # candidates + judges
uv run main.py --judge-only 20260604_122733 # judges only, against an existing run
```

`--judge-only` skips the candidate phase entirely and re-runs the configured judges over the existing result JSONs for that `run_id`. Any `(candidate, judge)` pair that already has a non-null `score` is skipped, so you can also use it to resume a judge phase that crashed partway through. Useful when you tweak `prompts/judge_prompt.txt` or add a new judge to `models.yaml` and want to re-score without re-running expensive candidate inference.

Output for each candidate ends up at `results/<date>/<run_id>_<model>.json` and contains: `run_id`, `date`, `time`, `model`, `model_path`, `server_args`, `input`, `reference`, `output`, `duration_seconds`, `rss_before_mb` / `rss_after_mb` / `rss_delta_mb` (RSS of `llama-server` snapshotted around the request via `psutil`), and `judges` (each judge entry carries its own `rss_*` fields too).
