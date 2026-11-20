// Pure helpers for litmiq-ci. No network at import time. No dependencies.
import fs from 'node:fs';

const MARKER = '<!-- litmiq-ci-comment -->';

export function metricAverages(rows) {
  const acc = {};
  for (const r of rows) {
    const scores = r && r.scores && typeof r.scores === 'object' ? r.scores : {};
    for (const [k, v] of Object.entries(scores)) {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
      if (n === null) continue;
      const key = String(k).slice(0, 60);
      if (!acc[key]) acc[key] = { sum: 0, n: 0 };
      acc[key].sum += n;
      acc[key].n += 1;
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(acc)) {
    out[k] = { n: v.n, avg: +(v.sum / v.n).toFixed(2) };
  }
  return out;
}

export function summarizeModel(rows, passScore = 7) {
  const rs = (rows || []).filter((r) => r && r.overall !== null && Number.isFinite(r.overall));
  if (!rs.length) return { scored: 0, avg: null, pass_rate: null, metrics: {} };
  const avg = +(rs.reduce((a, r) => a + r.overall, 0) / rs.length).toFixed(2);
  const pass_rate = Math.round(100 * rs.filter((r) => r.overall >= passScore).length / rs.length);
  return { scored: rs.length, avg, pass_rate, metrics: metricAverages(rs) };
}

export function normalizeCi(raw = {}) {
  const num = (v, fallback) => {
    if (v == null || v === '') return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const mapNums = (obj) => {
    const out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      const n = num(v, null);
      if (n !== null) out[String(k).slice(0, 60)] = n;
    }
    return out;
  };
  return {
    pass_score: num(raw.pass_score, 7),
    max_avg_drop: num(raw.max_avg_drop, 0.5),
    max_pass_rate_drop: num(raw.max_pass_rate_drop, 10),
    min_avg: raw.min_avg == null || raw.min_avg === '' ? null : num(raw.min_avg, null),
    min_pass_rate: raw.min_pass_rate == null || raw.min_pass_rate === '' ? null : num(raw.min_pass_rate, null),
    max_metric_drop: raw.max_metric_drop == null || raw.max_metric_drop === '' ? null : num(raw.max_metric_drop, null),
    min_metrics: mapNums(raw.min_metrics),
    max_metric_drops: mapNums(raw.max_metric_drops)
  };
}

export function findProblems(summary, baseline, ciInput) {
  const ci = normalizeCi(ciInput);
  const problems = [];
  const models = Object.keys(summary || {});
  for (const m of models) {
    const s = summary[m] || {};
    if (s.avg === null || s.avg === undefined) {
      problems.push(`${m}: no scored outputs`);
      continue;
    }
    if (ci.min_avg !== null && s.avg < ci.min_avg) {
      problems.push(`${m}: average ${s.avg} is below the minimum ${ci.min_avg}`);
    }
    if (ci.min_pass_rate !== null && s.pass_rate !== null && s.pass_rate < ci.min_pass_rate) {
      problems.push(`${m}: pass rate ${s.pass_rate}% is below the minimum ${ci.min_pass_rate}%`);
    }
    const b = baseline && baseline.summary && baseline.summary[m];
    if (b && b.avg != null && s.avg < b.avg - ci.max_avg_drop) {
      problems.push(`${m}: average fell from ${b.avg} to ${s.avg}`);
    }
    if (b && b.pass_rate != null && s.pass_rate !== null && s.pass_rate < b.pass_rate - ci.max_pass_rate_drop) {
      problems.push(`${m}: pass rate fell from ${b.pass_rate}% to ${s.pass_rate}%`);
    }
    const metrics = s.metrics || {};
    const baseMetrics = (b && b.metrics) || {};
    const names = new Set([...Object.keys(metrics), ...Object.keys(baseMetrics), ...Object.keys(ci.min_metrics), ...Object.keys(ci.max_metric_drops)]);
    for (const name of names) {
      const cur = metrics[name];
      const floor = Object.prototype.hasOwnProperty.call(ci.min_metrics, name) ? ci.min_metrics[name] : null;
      if (floor != null && cur && cur.avg < floor) {
        problems.push(`${m}: ${name} average ${cur.avg} is below the minimum ${floor}`);
      }
      const drop = Object.prototype.hasOwnProperty.call(ci.max_metric_drops, name)
        ? ci.max_metric_drops[name]
        : ci.max_metric_drop;
      const prev = baseMetrics[name];
      if (drop != null && prev && prev.avg != null && cur && cur.avg < prev.avg - drop) {
        problems.push(`${m}: ${name} average fell from ${prev.avg} to ${cur.avg}`);
      }
    }
  }
  return problems;
}

export function renderMarkdown({ suite, judge, caseCount, models, summary, problems, baseline }) {
  const lines = [
    `## Litmiq: ${suite}`,
    '',
    `Judge: ${judge} · ${caseCount} cases · ${models.length} models`,
    '',
    '| Model | Scored | Average | Pass rate |',
    '|---|---:|---:|---:|'
  ];
  for (const m of models) {
    const s = summary[m] || {};
    lines.push(`| ${m} | ${s.scored ?? 0} | ${s.avg ?? 'n/a'} | ${s.pass_rate === null || s.pass_rate === undefined ? 'n/a' : s.pass_rate + '%'} |`);
  }
  const metricNames = new Set();
  for (const m of models) {
    Object.keys((summary[m] && summary[m].metrics) || {}).forEach((k) => metricNames.add(k));
  }
  if (metricNames.size) {
    const cols = ['Model', ...metricNames];
    lines.push('', '| ' + cols.join(' | ') + ' |', '|' + cols.map((c, i) => (i === 0 ? '---' : '---:')).join('|') + '|');
    for (const m of models) {
      const metrics = (summary[m] && summary[m].metrics) || {};
      lines.push('| ' + [m, ...[...metricNames].map((n) => (metrics[n] ? metrics[n].avg : 'n/a'))].join(' | ') + ' |');
    }
  }
  lines.push('');
  if (problems.length) {
    lines.push('**Regressions:**', ...problems.map((p) => '- ' + p), '');
  } else {
    lines.push(baseline ? 'No regression against the baseline.' : 'No baseline yet: this run was saved as the baseline.', '');
  }
  return lines.join('\n');
}

export function pullRequestNumber(env = process.env) {
  if (env.LITMIQ_PR_NUMBER) return String(env.LITMIQ_PR_NUMBER);
  const evPath = env.GITHUB_EVENT_PATH;
  if (!evPath) return null;
  try {
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    if (ev.pull_request && ev.pull_request.number) return String(ev.pull_request.number);
    if (ev.issue && ev.issue.pull_request && ev.issue.number) return String(ev.issue.number);
  } catch (_) {}
  return null;
}

export async function postPrComment({ env = process.env, body, fetchImpl } = {}) {
  const fetchFn = fetchImpl || fetch;
  if (env.LITMIQ_NO_PR_COMMENT === '1') return { skipped: 'disabled' };
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) return { skipped: 'no token' };
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { skipped: 'no repo' };
  const number = pullRequestNumber(env);
  if (!number) return { skipped: 'not a pull request' };
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const headers = {
    authorization: 'Bearer ' + token,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'litmiq-ci',
    'x-github-api-version': '2022-11-28'
  };
  const text = MARKER + '\n' + body;
  const listUrl = `${api}/repos/${repo}/issues/${number}/comments?per_page=100`;
  let existing = null;
  try {
    const listed = await fetchFn(listUrl, { headers });
    if (listed.ok) {
      const comments = await listed.json();
      if (Array.isArray(comments)) {
        existing = comments.find((c) => c && typeof c.body === 'string' && c.body.includes(MARKER) && c.url);
      }
    }
  } catch (_) {}
  const url = existing && existing.url
    ? existing.url
    : `${api}/repos/${repo}/issues/${number}/comments`;
  const method = existing && existing.url ? 'PATCH' : 'POST';
  const res = await fetchFn(url, { method, headers, body: JSON.stringify({ body: text }) });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const safe = String(errText).replace(token, '[token removed]').slice(0, 200);
    return { error: `GitHub comment failed (${res.status}): ${safe}` };
  }
  return { ok: true, updated: Boolean(existing && existing.url) };
}

export { MARKER };
