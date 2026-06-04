// ─── State ────────────────────────────────────────────────────────────────────

let currentData = null;
let currentTab = 'overall';
let tableSort = { key: null, dir: 'asc' };
let currentHardware = {};

const JUDGE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#e879f9', '#38bdf8', '#fb923c'];

// ─── Init ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('modal-backdrop').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  window.addEventListener('hashchange', route);

  // Resize: re-render chart so bars fill new width
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentData) renderChart(currentTab, currentData);
    }, 150);
  });

  loadRunList().then(route);
});

// ─── Routing ──────────────────────────────────────────────────────────────────

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/runs/')) {
    showRun(decodeURIComponent(hash.slice('#/runs/'.length)));
  }
}

// ─── Run list ─────────────────────────────────────────────────────────────────

async function loadRunList() {
  const resp = await fetch('/api/runs').then(r => r.json()).catch(() => ({ runs: [], hardware: {} }));
  currentHardware = resp.hardware || {};
  renderRunList(resp.runs || []);
  return resp.runs || [];
}

function renderRunList(runs) {
  const el = document.getElementById('run-list');
  el.innerHTML = '';
  if (!runs.length) {
    el.innerHTML = '<div class="run-meta" style="padding:14px 16px">No runs found.</div>';
    return;
  }
  for (const run of runs) {
    const div = document.createElement('div');
    div.className = 'run-item';
    div.dataset.runId = run.run_id;
    const judgeLabel = run.judges.length
      ? ` · ${run.judges.length} judge${run.judges.length !== 1 ? 's' : ''}`
      : '';
    div.innerHTML = `
      <div class="run-id">${run.run_id}</div>
      <div class="run-meta">${run.date} ${run.time}</div>
      <div class="run-meta">${run.n_candidates} candidate${run.n_candidates !== 1 ? 's' : ''}${judgeLabel}</div>
    `;
    div.addEventListener('click', () => {
      location.hash = `#/runs/${encodeURIComponent(run.run_id)}`;
    });
    el.appendChild(div);
  }
  highlightActiveRun();
}

function highlightActiveRun() {
  const hash = location.hash || '#/';
  const activeId = hash.startsWith('#/runs/')
    ? decodeURIComponent(hash.slice('#/runs/'.length))
    : null;
  document.querySelectorAll('.run-item').forEach(el => {
    el.classList.toggle('active', el.dataset.runId === activeId);
  });
}

// ─── Run detail ───────────────────────────────────────────────────────────────

async function showRun(runId) {
  highlightActiveRun();

  let data;
  try {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (err) {
    const el = document.getElementById('detail-empty');
    el.textContent = `Could not load run: ${err.message}`;
    el.hidden = false;
    document.getElementById('detail-content').hidden = true;
    return;
  }

  currentData = data;
  document.getElementById('detail-empty').hidden = true;
  document.getElementById('detail-content').hidden = false;

  const judges = allJudges(data);

  // Header
  const first = data[0] || {};
  const judgeLabel = judges.length
    ? ` · ${judges.length} judge${judges.length !== 1 ? 's' : ''}`
    : '';
  const hw = [
    currentHardware.cpu && `CPU: ${currentHardware.cpu}`,
    currentHardware.gpu && `GPU: ${currentHardware.gpu}`,
    currentHardware.ram && `RAM: ${currentHardware.ram}`,
    currentHardware.os && `OS: ${currentHardware.os}`,
  ].filter(Boolean).join(' · ');

  document.getElementById('detail-header').innerHTML = `
    <h2>${esc(runId)}</h2>
    <div class="run-summary">${first.date || ''}${judgeLabel
      ? ` · ${data.length} candidate${data.length !== 1 ? 's' : ''}${judgeLabel}`
      : ` · ${data.length} candidate${data.length !== 1 ? 's' : ''}`}</div>
    ${hw ? `<div class="run-hardware">${esc(hw)}</div>` : ''}
  `;

  tableSort = { key: null, dir: 'asc' };
  renderTable(data, judges);

  // Defer chart render until the element is laid out (was hidden before)
  requestAnimationFrame(() => renderChart(currentTab, data));
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  if (currentData) renderChart(tab, currentData);
}

// ─── Charts ───────────────────────────────────────────────────────────────────

function chartHeight(data, tab) {
  const judges = allJudges(data);
  const barsPerModel = tab === 'scores' ? Math.max(judges.length, 1) : 1;
  const legendH = (tab === 'scores' && judges.length > 1) ? judges.length * 18 + 14 : 0;
  const mt = 16, mb = 32 + legendH;
  const barH = tab === 'overall' || 'scores' ? 22 : 36;   // overall bars are thinner — only one per model
  const gap = tab === 'overall' || 'scores' ? 6 : 10;
  const plotH = data.length * (barsPerModel * barH + gap);
  const cap = tab === 'overall' ? Math.floor(window.innerHeight * 0.55) : Infinity;
  return Math.min(Math.max(mt + mb + plotH, 160), cap);
}

function renderChart(tab, data) {
  const svgEl = document.getElementById('chart-svg');
  svgEl.closest('.chart-container').style.height = chartHeight(data, tab) + 'px';

  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();

  const rect = svgEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  if (tab === 'overall') renderOverall(data, svg, rect);
  else if (tab === 'scores') renderScores(data, svg, rect);
  else if (tab === 'speed') renderSpeed(data, svg, rect);
  else renderMemory(data, svg, rect);
}

// Estimate left margin from the longest model label
function labelWidth(models) {
  const max = Math.max(...models.map(m => m.length), 6);
  return Math.min(Math.max(Math.round(max * 6.2), 100), 230);
}

// Shared floating tooltip div (created once, reused)
function getTooltip() {
  let tip = document.getElementById('_chart_tip');
  if (!tip) {
    tip = Object.assign(document.createElement('div'), { id: '_chart_tip', className: 'chart-tooltip' });
    document.body.appendChild(tip);
  }
  return tip;
}

function showTip(tip, event, html) {
  tip.innerHTML = html;
  tip.style.display = 'block';
  tip.style.left = `${event.clientX + 14}px`;
  tip.style.top = `${event.clientY - 32}px`;
}

function hideTip(tip) { tip.style.display = 'none'; }

// ── Overall composite score ───────────────────────────────────────────────────

function computeOverall(data) {
  const judges = allJudges(data);

  function normalize(vals, higherIsBetter) {
    const valid = vals.filter(v => v != null);
    const lo = Math.min(...valid), hi = Math.max(...valid);
    return vals.map(v => {
      if (v == null) return null;
      const n = lo === hi ? 0.5 : (v - lo) / (hi - lo);
      return higherIsBetter ? n : 1 - n;
    });
  }

  const avgScores = data.map(row => {
    const scores = judges.map(j => row.judges?.[j]?.score).filter(s => s != null);
    return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  });

  const normScore = normalize(avgScores, true);
  const normSpeed = normalize(data.map(d => d.duration_seconds), false);
  const normMemory = normalize(data.map(d => d.rss_delta_mb), false);

  return data.map((row, i) => {
    const parts = [normScore[i], normSpeed[i], normMemory[i]].filter(v => v != null);
    const overall = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    return { model: row.model, overall, normScore: normScore[i], normSpeed: normSpeed[i], normMemory: normMemory[i] };
  });
}

function renderOverall(data, svg, rect) {
  const rows = computeOverall(data).filter(r => r.overall != null);
  const sorted = [...rows].sort((a, b) => b.overall - a.overall);
  const models = sorted.map(r => r.model);

  const ml = labelWidth(models);
  const mt = 16, mr = 56, mb = 32;
  const W = rect.width - ml - mr;
  const H = rect.height - mt - mb;
  const g = svg.append('g').attr('transform', `translate(${ml},${mt})`);

  const y = d3.scaleBand().domain(models).range([0, H]).paddingInner(0.3).paddingOuter(0.08);
  const x = d3.scaleLinear().domain([0, 1]).range([0, W]);

  g.append('g').attr('class', 'grid')
    .attr('transform', `translate(0,${H})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(-H).tickFormat(''));

  g.append('g').attr('transform', `translate(0,${H})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(v => `${Math.round(v * 100)}%`));
  g.append('g').call(d3.axisLeft(y));

  const tip = getTooltip();

  for (const row of sorted) {
    const cy = y(row.model) + y.bandwidth() / 2;
    // colour grades from red (worst) to green (best) via the same interpolator as speed
    const fill = d3.interpolateRgb('#ef4444', '#22c55e')(row.overall);

    g.append('rect')
      .attr('x', 0).attr('y', y(row.model))
      .attr('width', x(row.overall)).attr('height', y.bandwidth())
      .attr('fill', fill).attr('rx', 2)
      .on('mousemove', ev => {
        const pct = v => v != null ? `${Math.round(v * 100)}%` : '—';
        showTip(tip, ev,
          `<strong>${esc(row.model)}</strong><br>` +
          `Overall: ${pct(row.overall)}<br>` +
          `Judge score: ${pct(row.normScore)} &nbsp; Speed: ${pct(row.normSpeed)} &nbsp; Memory: ${pct(row.normMemory)}`
        );
      })
      .on('mouseleave', () => hideTip(tip));

    g.append('text')
      .attr('x', x(row.overall) + 4).attr('y', cy)
      .attr('dominant-baseline', 'middle').attr('font-size', 11).attr('fill', '#333')
      .text(`${Math.round(row.overall * 100)}%`);
  }
}

// ── Scores (horizontal grouped bars) ─────────────────────────────────────────

function renderScores(data, svg, rect) {
  const judges = allJudges(data);
  const models = data.map(d => d.model);
  const color = d3.scaleOrdinal(JUDGE_COLORS).domain(judges);
  const legendH = judges.length > 1 ? judges.length * 18 + 14 : 0;

  const ml = labelWidth(models);
  const mt = 16, mr = 40, mb = 32 + legendH;
  const W = rect.width - ml - mr;
  const H = rect.height - mt - mb;
  const g = svg.append('g').attr('transform', `translate(${ml},${mt})`);

  const y0 = d3.scaleBand().domain(models).range([0, H]).paddingInner(0.25).paddingOuter(0.08);
  const y1 = d3.scaleBand().domain(judges.length ? judges : ['_']).range([0, y0.bandwidth()]).padding(0.06);
  const x = d3.scaleLinear().domain([0, 10]).range([0, W]);

  // Vertical grid lines
  g.append('g').attr('class', 'grid')
    .attr('transform', `translate(0,${H})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(-H).tickFormat(''));

  g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(x).ticks(5));
  g.append('g').call(d3.axisLeft(y0));

  const tip = getTooltip();

  for (const row of data) {
    const gm = g.append('g').attr('transform', `translate(0,${y0(row.model)})`);

    if (!row.output) {
      gm.append('text')
        .attr('x', 4).attr('y', y0.bandwidth() / 2)
        .attr('dominant-baseline', 'middle').attr('font-size', 10).attr('fill', '#ef4444')
        .text('error');
      continue;
    }

    for (const jname of judges) {
      const j = row.judges?.[jname];
      const score = j?.score ?? null;
      const yPos = y1(jname);
      const bh = y1.bandwidth();

      if (score === null) {
        gm.append('text')
          .attr('x', 4).attr('y', yPos + bh / 2)
          .attr('dominant-baseline', 'middle').attr('font-size', 10).attr('fill', '#aaa')
          .text('—');
        continue;
      }

      gm.append('rect')
        .attr('x', 0).attr('y', yPos)
        .attr('width', x(score)).attr('height', bh)
        .attr('fill', color(jname)).attr('rx', 2)
        .on('mousemove', ev => {
          const speed = row.duration_seconds != null ? `${row.duration_seconds.toFixed(2)}s` : '—';
          const mem = row.rss_delta_mb != null ? `${row.rss_delta_mb > 0 ? '+' : ''}${row.rss_delta_mb} MB` : '—';
          showTip(tip, ev,
            `<strong>${esc(row.model)}</strong>` +
            `<br>⏱ ${speed} &nbsp; 💾 ${mem}` +
            `<br>${esc(jname)}: ${score}/10` +
            (j.reason ? `<br><em>${esc(j.reason)}</em>` : ''));
        })
        .on('mouseleave', () => hideTip(tip));

      gm.append('text')
        .attr('x', x(score) + 4).attr('y', yPos + bh / 2)
        .attr('dominant-baseline', 'middle').attr('font-size', 11).attr('fill', '#333')
        .text(score);
    }
  }

  // Legend below the x-axis
  if (judges.length > 1) {
    const lg = svg.append('g').attr('transform', `translate(${ml},${mt + H + 32})`);
    judges.forEach((j, i) => {
      const row = lg.append('g').attr('transform', `translate(${i * 200},0)`);
      row.append('rect').attr('width', 11).attr('height', 11).attr('rx', 2).attr('fill', color(j));
      row.append('text').attr('x', 15).attr('y', 10).attr('font-size', 11).attr('fill', '#444').text(j);
    });
  }
}

// ── Speed (horizontal bars) ───────────────────────────────────────────────────

function renderSpeed(data, svg, rect) {
  const models = data.map(d => d.model);
  const maxVal = d3.max(data, d => d.duration_seconds ?? 0) || 1;

  const ml = labelWidth(models);
  const mt = 16, mr = 48, mb = 32;
  const W = rect.width - ml - mr;
  const H = rect.height - mt - mb;
  const g = svg.append('g').attr('transform', `translate(${ml},${mt})`);

  const y = d3.scaleBand().domain(models).range([0, H]).paddingInner(0.3).paddingOuter(0.08);
  const x = d3.scaleLinear().domain([0, maxVal]).nice().range([0, W]);

  g.append('g').attr('class', 'grid')
    .attr('transform', `translate(0,${H})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(-H).tickFormat(''));

  g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(x).ticks(5).tickFormat(v => `${v}s`));
  g.append('g').call(d3.axisLeft(y));

  const tip = getTooltip();

  for (const row of data) {
    const dur = row.duration_seconds;
    const isError = !row.output && row.error;
    const cy = y(row.model) + y.bandwidth() / 2;

    if (dur == null || isError) {
      g.append('text')
        .attr('x', 4).attr('y', cy)
        .attr('dominant-baseline', 'middle').attr('font-size', 10).attr('fill', '#ef4444')
        .text(isError ? 'err' : '—');
      continue;
    }

    const fill = d3.interpolateRgb('#22c55e', '#ef4444')(maxVal > 0 ? dur / maxVal : 0);

    g.append('rect')
      .attr('x', 0).attr('y', y(row.model))
      .attr('width', x(dur)).attr('height', y.bandwidth())
      .attr('fill', fill).attr('rx', 2)
      .on('mousemove', ev => showTip(tip, ev, `<strong>${esc(row.model)}</strong><br>${dur.toFixed(2)}s`))
      .on('mouseleave', () => hideTip(tip));

    g.append('text')
      .attr('x', x(dur) + 4).attr('y', cy)
      .attr('dominant-baseline', 'middle').attr('font-size', 11).attr('fill', '#333')
      .text(`${dur.toFixed(1)}s`);
  }
}

// ── Memory (horizontal bars, signed) ─────────────────────────────────────────

function renderMemory(data, svg, rect) {
  const models = data.map(d => d.model);
  const vals = data.map(d => d.rss_delta_mb).filter(v => v != null);
  const minVal = Math.min(0, d3.min(vals) ?? 0);
  const maxVal = Math.max(0, d3.max(vals) ?? 1, 1);

  const ml = labelWidth(models);
  const mt = 16, mr = 56, mb = 32;
  const W = rect.width - ml - mr;
  const H = rect.height - mt - mb;
  const g = svg.append('g').attr('transform', `translate(${ml},${mt})`);

  const y = d3.scaleBand().domain(models).range([0, H]).paddingInner(0.3).paddingOuter(0.08);
  const x = d3.scaleLinear().domain([minVal, maxVal]).nice().range([0, W]);

  g.append('g').attr('class', 'grid')
    .attr('transform', `translate(0,${H})`)
    .call(d3.axisBottom(x).ticks(6).tickSize(-H).tickFormat(''));

  g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(x).ticks(6).tickFormat(v => `${v} MB`));
  g.append('g').call(d3.axisLeft(y));

  // Zero line (vertical)
  const zeroX = x(0);
  if (zeroX > 0 && zeroX < W) {
    g.append('line')
      .attr('x1', zeroX).attr('x2', zeroX).attr('y1', 0).attr('y2', H)
      .attr('stroke', '#999').attr('stroke-dasharray', '4,3');
  }

  const tip = getTooltip();

  for (const row of data) {
    const val = row.rss_delta_mb;
    const isError = !row.output && row.error;
    const cy = y(row.model) + y.bandwidth() / 2;

    if (val == null || isError) {
      g.append('text')
        .attr('x', zeroX + 4).attr('y', cy)
        .attr('dominant-baseline', 'middle').attr('font-size', 10).attr('fill', '#ef4444')
        .text(isError ? 'err' : '—');
      continue;
    }

    const isNeg = val < 0;
    const barX = isNeg ? x(val) : zeroX;
    const barW = Math.max(Math.abs(x(val) - zeroX), 1);
    const fill = isNeg ? '#60a5fa' : '#4f6ef7';

    g.append('rect')
      .attr('x', barX).attr('y', y(row.model))
      .attr('width', barW).attr('height', y.bandwidth())
      .attr('fill', fill).attr('rx', 2)
      .on('mousemove', ev => showTip(tip, ev,
        `<strong>${esc(row.model)}</strong><br>RSS Δ: ${val > 0 ? '+' : ''}${val} MB`))
      .on('mouseleave', () => hideTip(tip));

    g.append('text')
      .attr('x', isNeg ? x(val) - 4 : x(val) + 4).attr('y', cy)
      .attr('text-anchor', isNeg ? 'end' : 'start')
      .attr('dominant-baseline', 'middle').attr('font-size', 11).attr('fill', '#333')
      .text(`${val > 0 ? '+' : ''}${val}`);
  }
}

// ─── Table ────────────────────────────────────────────────────────────────────

function avgScore(row, judges) {
  const scores = judges.map(j => row.judges?.[j]?.score).filter(s => s != null);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function sortedRows(data, judges) {
  if (!tableSort.key) return data;
  const key = tableSort.key;
  const dir = tableSort.dir === 'asc' ? 1 : -1;
  const val = row => {
    if (key === 'model') return row.model ?? '';
    if (key === 'duration') return row.duration_seconds ?? Infinity;
    if (key === 'memory') return row.rss_delta_mb ?? Infinity;
    if (key === 'avg') return avgScore(row, judges) ?? -Infinity;
    if (key.startsWith('judge:')) return row.judges?.[key.slice(6)]?.score ?? -Infinity;
    return 0;
  };
  return [...data].sort((a, b) => {
    const av = val(a), bv = val(b);
    return typeof av === 'string' ? dir * av.localeCompare(bv) : dir * (av - bv);
  });
}

function renderTable(data, judges) {
  const container = document.getElementById('table-container');
  const table = document.createElement('table');
  table.className = 'results-table';

  const colDefs = [
    { label: 'Model', key: 'model' },
    { label: 'Time', key: 'duration' },
    { label: 'Memory', key: 'memory' },
    ...judges.map(j => ({ label: j, key: `judge:${j}`, center: true })),
    ...(judges.length > 1 ? [{ label: 'Avg', key: 'avg', center: true }] : []),
  ];

  // Header with sort indicators and click handlers
  const hr = table.createTHead().insertRow();
  colDefs.forEach(({ label, key, center }) => {
    const th = document.createElement('th');
    if (center) th.className = 'judge-col';
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    const arrow = tableSort.key === key ? (tableSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    th.textContent = label + arrow;
    th.addEventListener('click', () => {
      tableSort = tableSort.key === key
        ? { key, dir: tableSort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' };
      renderTable(data, judges);
    });
    hr.appendChild(th);
  });

  // Pre-compute rank sets on original data (stable highlighting regardless of sort order)
  const timeRank = rankSets(data, 'duration_seconds', 3);
  const memRank = rankSets(data, 'rss_delta_mb', 3);

  // Body — iterate sorted rows; rank sets use original index for stable colour
  const tbody = table.createTBody();
  sortedRows(data, judges).forEach(row => {
    const i = data.indexOf(row);
    const tr = tbody.insertRow();
    tr.className = 'row-clickable';
    tr.addEventListener('click', () => openModal(row, judges));

    // Model
    const tdModel = tr.insertCell();
    tdModel.className = 'cell-model';
    tdModel.textContent = row.model;
    if (row.error) {
      const badge = Object.assign(document.createElement('span'), {
        className: 'badge-error', textContent: 'error',
      });
      tdModel.appendChild(badge);
    }

    // Time
    const tdTime = tr.insertCell();
    tdTime.className = 'cell-num';
    tdTime.innerHTML = ranked(
      row.duration_seconds != null ? `${row.duration_seconds.toFixed(2)}s` : '—',
      i, timeRank,
    );

    // Memory
    const tdMem = tr.insertCell();
    tdMem.className = 'cell-num';
    tdMem.innerHTML = ranked(
      row.rss_delta_mb != null ? `${row.rss_delta_mb > 0 ? '+' : ''}${row.rss_delta_mb} MB` : '—',
      i, memRank,
    );

    // Per-judge columns
    for (const jname of judges) {
      const j = row.judges?.[jname];
      const td = tr.insertCell();
      td.className = 'judge-col';
      if (j?.score != null) {
        td.innerHTML =
          `<span class="score">${j.score}</span>` +
          (j.duration_seconds != null ? `<br><span class="judge-time">(${j.duration_seconds.toFixed(1)}s)</span>` : '');
      } else {
        td.textContent = '—';
      }
    }

    // Avg judge score (only when multiple judges)
    if (judges.length > 1) {
      const tdAvg = tr.insertCell();
      tdAvg.className = 'judge-col';
      const avg = avgScore(row, judges);
      tdAvg.innerHTML = avg != null ? `<span class="score">${avg.toFixed(1)}</span>` : '—';
    }

  });

  container.innerHTML = '';
  container.appendChild(table);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal(row, judges) {
  const sections = [];

  // Metadata
  const chips = (row.server_args || [])
    .map(a => `<span class="chip">${esc(a)}</span>`)
    .join('');
  sections.push(`
    <section>
      <h3>Metadata</h3>
      <dl class="meta-dl">
        <dt>Model path</dt><dd>${esc(row.model_path || '—')}</dd>
        <dt>Date / Time</dt><dd>${esc(row.date || '')} ${esc(row.time || '')}</dd>
        <dt>Duration</dt><dd>${row.duration_seconds != null ? row.duration_seconds + 's' : '—'}</dd>
        <dt>RSS</dt><dd>${row.rss_before_mb ?? '—'} → ${row.rss_after_mb ?? '—'} MB
          (Δ ${row.rss_delta_mb != null ? (row.rss_delta_mb > 0 ? '+' : '') + row.rss_delta_mb + ' MB' : '—'})</dd>
        <dt>Server args</dt><dd class="chips">${chips || '—'}</dd>
        ${row.error ? `<dt>Error</dt><dd class="error-text">${esc(row.error)}</dd>` : ''}
      </dl>
    </section>
  `);

  // Input
  sections.push(`
    <section>
      <h3>Input</h3>
      <pre class="modal-pre">${esc(row.input || '')}</pre>
    </section>
  `);

  // Output
  sections.push(`
    <section>
      <h3>Output</h3>
      <pre class="modal-pre">${esc(row.output || '(no output)')}</pre>
      ${row.reasoning_content ? `
        <details>
          <summary>Reasoning content</summary>
          <pre class="modal-pre">${esc(row.reasoning_content)}</pre>
        </details>` : ''}
    </section>
  `);

  // Per-judge sections
  for (const jname of judges) {
    const j = row.judges?.[jname];
    if (!j) continue;
    sections.push(`
      <section>
        <h3>${esc(jname)}</h3>
        <dl class="meta-dl">
          <dt>Score</dt><dd>${j.score ?? '—'} / 10</dd>
          <dt>Reason</dt><dd>${esc(j.reason || '—')}</dd>
          <dt>Duration</dt><dd>${j.duration_seconds != null ? j.duration_seconds + 's' : '—'}</dd>
          <dt>RSS delta</dt><dd>${j.rss_delta_mb != null ? j.rss_delta_mb + ' MB' : '—'}</dd>
        </dl>
        ${(j.raw_output || j.reasoning_content) ? `
          <details>
            <summary>Raw output / reasoning</summary>
            ${j.raw_output ? `<pre class="modal-pre">${esc(j.raw_output)}</pre>` : ''}
            ${j.reasoning_content ? `<pre class="modal-pre">${esc(j.reasoning_content)}</pre>` : ''}
          </details>` : ''}
      </section>
    `);
  }

  document.getElementById('modal-body').innerHTML = sections.join('\n');
  document.getElementById('modal-backdrop').hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal() {
  document.getElementById('modal-backdrop').hidden = true;
  document.body.classList.remove('modal-open');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns sets of row indices for the n lowest and n highest values of data[key].
// Overlap (same value appears in both) is excluded from both sets.
function rankSets(data, key, n) {
  const valid = data
    .map((d, i) => ({ val: d[key], i }))
    .filter(x => x.val != null)
    .sort((a, b) => a.val - b.val);
  const low = new Set(valid.slice(0, n).map(x => x.i));
  const high = new Set(valid.slice(-n).map(x => x.i));
  for (const i of low) if (high.has(i)) { low.delete(i); high.delete(i); }
  return { low, high };
}

function ranked(text, i, { low, high }) {
  const cls = low.has(i) ? 'val-best' : high.has(i) ? 'val-worst' : '';
  return cls ? `<span class="${cls}">${text}</span>` : text;
}

function allJudges(data) {
  return [...new Set(data.flatMap(d => Object.keys(d.judges || {})))].sort();
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
