# Frontend plan — local-llm-test results viewer

## Context

`main.py` writes one JSON per `(run_id, model)` into `results/<YYYYMMDD>/<run_id>_<model>.json`, plus a per-run log. After a run finishes there's no good way to see how candidates compared — you read 30 JSON files by hand. This frontend gives a fast visual answer to "of this run, which models did best, fastest, smallest?" and a drill-down to the raw text when needed.

## Requirements (user spec)

* List every run found under `results/`.
* Clicking a run opens that run's view: a single chart panel above a result table.
* Chart panel has tabs — **Judge scores**, **Speed**, **Memory** — only one chart is rendered at a time; switching tabs swaps the chart.
* Table below shows the same data flattened: model name, time spent, memory used, then per-judge `score (time spent)` columns.
* Each table row has a 3-dot menu that opens a deep-dive view: the model's input, its output, and each judge's reason.
* As simple as possible; beautiful charts.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backend | `serve.py` using stdlib `http.server` | Zero new deps. Scans `results/` on every request so the run list stays fresh. |
| Chart library | **d3 v7 via CDN** | User preference. Hand-rolled SVG charts; more code per chart than Chart.js but full visual control. |
| Frontend assets | `frontend/` folder | Clean separation from the testing framework. |
| Memory metric | `rss_delta_mb` | Isolates this prompt's KV-cache cost. Used for both chart and table. |
| Routing | Hash-based (`#/runs/<run_id>`) | Bookmarkable, no server-side routing logic. |
| State | Plain JS module globals | No framework. ~300–500 lines of JS total. |
| Build step | **None** | Plain HTML/CSS/JS + CDN d3. |

## File layout

```
serve.py                 # new — tiny stdlib HTTP server (~80 lines)
frontend/
  PLAN.md                # this file
  index.html             # shell: header, run-list pane, run-detail pane, modal
  app.js                 # routing, fetch, chart rendering, table rendering, modal
  style.css              # layout + theme (single, small)
```

## Backend: `serve.py`

Single-process stdlib `ThreadingHTTPServer`. Routing is a small `if/elif` ladder in the request handler.

### Routes

| Method + path | Returns |
|---|---|
| `GET /` | `frontend/index.html` |
| `GET /app.js`, `GET /style.css` | static asset |
| `GET /api/runs` | run summaries (see below) |
| `GET /api/runs/<run_id>` | full data for one run |

### Run discovery

```python
def list_runs() -> list[dict]:
    runs = {}  # run_id -> {date, time, files: [...]}
    for date_dir in sorted((RESULTS_DIR).iterdir()):
        if not date_dir.is_dir(): continue
        for p in date_dir.glob("*.json"):
            # filename: <RUN_ID>_<model>.json where RUN_ID = YYYYMMDD_HHMMSS
            stem = p.stem
            run_id = "_".join(stem.split("_", 2)[:2])  # take first two _-segments
            runs.setdefault(run_id, []).append(p)
    out = []
    for run_id, paths in sorted(runs.items(), reverse=True):
        # Peek at first JSON to count judges
        first = json.loads(paths[0].read_text())
        judge_names = set()
        for p in paths:
            judge_names.update(json.loads(p.read_text()).get("judges", {}).keys())
        out.append({
            "run_id": run_id,
            "date": run_id[:4] + "-" + run_id[4:6] + "-" + run_id[6:8],
            "time": run_id[9:11] + ":" + run_id[11:13] + ":" + run_id[13:15],
            "n_candidates": len(paths),
            "judges": sorted(judge_names),
        })
    return out
```

### Run detail

`GET /api/runs/<run_id>` returns an array of the raw result JSONs (already in the right shape — no transformation needed). One element per candidate.

### CLI

```bash
uv run python serve.py            # serves on http://127.0.0.1:8765
uv run python serve.py --port 9000
```

Port `8765` (not 8080, which collides with `llama-server`).

## Frontend

### Layout

```
┌────────────────────────────────────────────────────────────────────┐
│  local-llm-test viewer                              [⟳ refresh]    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│   RUNS                       │   RUN 20260604_122733               │
│  ──────────                  │   2026-06-04 12:27:33               │
│  ▸ 20260604_122733           │   6 candidates · 2 judges           │
│     2026-06-04 12:27         │                                     │
│     6 candidates             │   ┌── Scores ── Speed ── Memory ──┐ │
│  ▸ 20260604_111805           │   │                              │ │
│     2026-06-04 11:18         │   │       [d3 chart]             │ │
│     29 candidates            │   │                              │ │
│  ▸ ...                       │   └──────────────────────────────┘ │
│                              │                                     │
│                              │   ┌── Results table ─────────────┐ │
│                              │   │ Model  Time  Mem  J1  J2  ⋮  │ │
│                              │   │ ...                          │ │
│                              │   └──────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

Two-column flex layout (run list left, detail right). On narrow screens stacks vertically.

### Tabs and charts (d3 v7)

One shared `<svg>` element. Tab click → `svg.selectAll("*").remove()` then call the relevant render function with the run data and the svg selection.

Three render functions, each ~70–100 lines:

- **`renderScores(data, svg)`** — grouped bar chart. x = candidate model names (band scale), y = score 1–10 (linear), one bar group per judge (color scale). Tooltip on hover shows full reason.
- **`renderSpeed(data, svg)`** — bar chart. x = model names, y = `duration_seconds` (linear). Single series. Color-grade slowest red.
- **`renderMemory(data, svg)`** — bar chart. x = model names, y = `rss_delta_mb`. Single series. Negative deltas (KV evictions) get a distinct color/pattern so they pop visually.

All three reuse small helpers: `makeAxes(svg, x, y)`, `barTooltip(g)`.

Errored candidates (no `output`, `error` set) appear at the right of the x-axis with a "—" placeholder bar and a red label.

### Results table

| Column | Source | Notes |
|---|---|---|
| Model | `record.model` | left-aligned, bold |
| Time | `record.duration_seconds` | right-aligned, "Xs" |
| Memory | `record.rss_delta_mb` | right-aligned, "X MB" |
| (per judge) Score | `record.judges[judge].score` | "—" if null |
| (per judge) Time | `record.judges[judge].duration_seconds` | small grey text under the score, "(Xs)" |
| ⋮ | button | opens modal |

One column per judge (column count is dynamic). The set of judges comes from the run summary, not per-row, so all rows align even if some judgments are missing.

### Drilldown modal

Triggered by the row's ⋮ button. Modal contains, in collapsible sections:

1. **Metadata** — `model_path`, `server_args` (chip list), `date`/`time`, `duration_seconds`, `rss_*_mb`, `error` (if any).
2. **Input** — `<pre>` of `record.input`.
3. **Output** — `<pre>` of `record.output`. Show `reasoning_content` underneath in a collapsed `<details>` if non-null.
4. **Per-judge sections** — one `<section>` per judge with: `score`, `reason`, `duration_seconds`, `rss_delta_mb`, and a collapsed `<details>` for `raw_output` and `reasoning_content`.

Closes on backdrop click, X button, or Escape.

## Implementation steps

1. **`serve.py`** — write the request handler, run discovery, route table. Manually test `curl localhost:8765/api/runs` against the existing `results/` folder.
2. **`frontend/index.html`** — page shell, hash-routed views (`#/` list, `#/runs/<id>` detail), CDN d3 v7 tag.
3. **`frontend/style.css`** — minimal layout (CSS grid for the split pane), small modal styles.
4. **`frontend/app.js`** —
   1. Fetch + render run list.
   2. Fetch + render run detail (table first — easier signal that data flows).
   3. Add tab bar + `renderScores` (most important chart per user).
   4. Add `renderSpeed`, `renderMemory`.
   5. Wire the 3-dot button → modal.
5. **Manual polish** — typography, color palette (one accent color + neutral grays + one red for errors), responsive tweaks.

## Verification

1. Start the server: `uv run python serve.py`. Open `http://127.0.0.1:8765/` — run list shows every `run_id` in `results/`, newest first.
2. Click a run — chart panel + table appear. Counts match the JSON files for that run.
3. Click each tab — chart redraws to scores / speed / memory. Hover bars to confirm tooltip text matches the underlying JSON (e.g. judge `reason`).
4. Click ⋮ on a row — modal opens with input, output, and one section per judge. Each judge section shows score + reason. Close via X, backdrop, and Escape.
5. Open a previously-judged + currently-failed run (e.g. one with null scores) — null cells render as "—" and don't crash the chart.
6. Trigger a new `uv run main.py` while the viewer is open — click the ⟳ button, new run appears at the top of the list.
7. Bookmark `#/runs/<run_id>`, close the tab, reopen — lands directly on that run's detail view.
