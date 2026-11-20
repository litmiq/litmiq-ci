#!/usr/bin/env node
// litmiq-ci.mjs: run a Litmiq suite in CI with your own API keys (https://litmiq.com). No dependencies; Node 18+.
// Usage: node litmiq-ci.mjs litmiq-suite.json [--validate] [--out litmiq-results.json] [--baseline litmiq-baseline.json] [--update-baseline]
// Env: OPENAI_API_KEY (OpenAI models / judge), ANTHROPIC_API_KEY (Claude models / judge),
//      LITMIQ_ALERT_WEBHOOK (optional Slack-compatible incoming webhook, posted to only when a regression is found),
//      OPENAI_BASE_URL / ANTHROPIC_BASE_URL (optional, for proxies or tests).
// Exit codes: 0 = pass, 1 = regression or threshold miss, 2 = usage/config error, 3 = provider errors on every call.
// Scoring mirrors the Litmiq app: one judge call per output, metrics 0-10, "pass" = overall >= 7. Missing scores are never invented.
import fs from 'node:fs';

const JUDGE_SYSTEM = `You are an expert LLM output evaluator. Given a system prompt, user input, model output, and scoring criteria, evaluate the output on each metric and return a JSON object.

Return ONLY valid JSON in this exact format:
{
  "scores": {
    "accuracy": <0-10>,
    "tone": <0-10>,
    "helpfulness": <0-10>,
    "conciseness": <0-10>
  },
  "overall": <0-10 weighted average>,
  "reasoning": "<2-3 sentence explanation>"
}`;

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const USAGE = 'usage: node litmiq-ci.mjs <suite.json> [--validate] [--out file] [--baseline file] [--update-baseline]';
if (flag('--help') || flag('-h')) {
  console.log(`litmiq-ci — run a Litmiq suite in CI with your own API keys (https://litmiq.com).

${USAGE}

  --validate          Check the suite file and exit. No provider calls, no keys required.
  --out file          Write results JSON (default: litmiq-results.json)
  --baseline file     Baseline to compare (default: litmiq-baseline.json)
  --update-baseline   Write a new baseline when this run has no regressions

Exit codes: 0 = pass, 1 = regression or threshold miss, 2 = usage/config error, 3 = provider errors on every call.
Env: OPENAI_API_KEY, ANTHROPIC_API_KEY, optional OPENAI_BASE_URL / ANTHROPIC_BASE_URL, optional LITMIQ_ALERT_WEBHOOK.
Scoring mirrors the Litmiq app: one judge call per output, metrics 0-10, pass = overall >= 7. Missing scores are never invented.`);
  process.exit(0);
}
const suitePath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--out', '--baseline'].includes(args[i - 1])));
if (!suitePath) { console.error(USAGE); process.exit(2); }
let suite;
try { suite = JSON.parse(fs.readFileSync(suitePath, 'utf8')); }
catch (e) { console.error('could not read suite:', e.message); process.exit(2); }
if (!suite || !suite.litmiq_fields || !Array.isArray(suite.cases) || !suite.cases.length) { console.error('not a Litmiq suite (litmiq-suite/1)'); process.exit(2); }
if (flag('--validate')) {
  const models = (suite.models && suite.models.length ? suite.models : ['gpt-6.1-terra']);
  const judge = suite.judge_model || 'gpt-5.4-mini';
  console.log(`ok: ${suite.name || 'Litmiq suite'} · ${suite.cases.length} case(s) · ${models.length} model(s) · judge ${judge}`);
  process.exit(0);
}
const models = (suite.models && suite.models.length ? suite.models : ['gpt-6.1-terra']).slice(0, 12);
const judge = suite.judge_model || 'gpt-5.4-mini';
const ci = Object.assign({ pass_score: 7, max_avg_drop: 0.5, max_pass_rate_drop: 10, min_avg: null }, suite.ci || {});
const outPath = flag('--out') || 'litmiq-results.json';
const basePath = flag('--baseline') || 'litmiq-baseline.json';
const provider = (m) => /^claude-/.test(String(m)) ? 'anthropic' : 'openai';
const OPENAI = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const ANTHROPIC = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, '');
for (const p of new Set(models.map(provider).concat([provider(judge)]))) {
  const k = p === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[k]) { console.error(`missing ${k} (add it as a repository secret)`); process.exit(2); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, headers, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error && data.error.message) || `API error ${res.status}`);
    return data;
  }
}
async function call(model, system, user, json) {
  if (provider(model) === 'anthropic') {
    const d = await post(ANTHROPIC + '/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: json ? 4096 : 8192, system, messages: [{ role: 'user', content: user }] });
    const t = (d.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    if (!t) throw new Error('Empty response from model'); return t;
  }
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (json) body.response_format = { type: 'json_object' };
  const d = await post(OPENAI + '/chat/completions', { authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body);
  const c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (typeof c !== 'string' || !c) throw new Error('Empty response from model'); return c;
}
const score = (v) => { const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN); return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null; };
async function judgeOne(c, output) {
  const sp = suite.litmiq_fields.system_prompt || '', crit = suite.litmiq_fields.scoring_criteria || '';
  const msg = `System prompt: "${sp}"\n\nUser input: "${c.user_input}"\n\n${c.expected_behavior ? `Expected behavior: "${c.expected_behavior}"\n\n` : ''}Model output: "${output}"\n\nScoring criteria: ${crit || 'Score on accuracy, tone, helpfulness, and conciseness — each 0 to 10.'}`;
  const raw = await call(judge, JUDGE_SYSTEM, msg, true);
  let s = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  if (s[0] !== '{' && s.indexOf('{') >= 0) s = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  const j = JSON.parse(s); const sc = {};
  Object.entries(j.scores || {}).forEach(([k, v]) => { const n = score(v); if (n !== null) sc[String(k).slice(0, 60)] = n; });
  if (!Object.keys(sc).length) throw new Error('Judge returned no readable scores');
  let overall = score(j.overall); if (overall === null) { const v = Object.values(sc); overall = v.reduce((a, b) => a + b, 0) / v.length; }
  return { scores: sc, overall, reasoning: typeof j.reasoning === 'string' ? j.reasoning : '' };
}

const jobs = []; suite.cases.forEach((c, ci_) => models.forEach((m) => jobs.push({ c, ci: ci_, m })));
const results = []; let errors = 0;
async function worker() {
  while (jobs.length) {
    const { c, ci: idx, m } = jobs.shift(); const r = { case: c.id || 'C-' + (idx + 1), model: m, overall: null, scores: {}, error: null };
    try { const out = await call(m, suite.litmiq_fields.system_prompt || '', c.user_input, false); r.output = out.slice(0, 4000);
      try { Object.assign(r, await judgeOne(c, out)); } catch (e) { r.error = 'judge: ' + e.message; errors++; } }
    catch (e) { r.error = e.message; errors++; }
    results.push(r);
  }
}
await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));

const summary = {};
for (const m of models) {
  const rs = results.filter((r) => r.model === m && r.overall !== null);
  summary[m] = rs.length ? { scored: rs.length, avg: +(rs.reduce((a, r) => a + r.overall, 0) / rs.length).toFixed(2), pass_rate: Math.round(100 * rs.filter((r) => r.overall >= ci.pass_score).length / rs.length) } : { scored: 0, avg: null, pass_rate: null };
}
let baseline = null; try { baseline = JSON.parse(fs.readFileSync(basePath, 'utf8')); } catch (_) {}
const problems = [];
for (const m of models) {
  const s = summary[m];
  if (s.avg === null) { problems.push(`${m}: no scored outputs`); continue; }
  if (ci.min_avg !== null && s.avg < ci.min_avg) problems.push(`${m}: average ${s.avg} is below the minimum ${ci.min_avg}`);
  const b = baseline && baseline.summary && baseline.summary[m];
  if (b && b.avg !== null && s.avg < b.avg - ci.max_avg_drop) problems.push(`${m}: average fell from ${b.avg} to ${s.avg}`);
  if (b && b.pass_rate !== null && s.pass_rate < b.pass_rate - ci.max_pass_rate_drop) problems.push(`${m}: pass rate fell from ${b.pass_rate}% to ${s.pass_rate}%`);
}
const report = { schema: 'litmiq-results/1', suite: suite.name || 'Litmiq suite', judge_model: judge, ran_at: new Date().toISOString(), summary, regressions: problems, results };
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
if (flag('--update-baseline') || (!baseline && !problems.length)) fs.writeFileSync(basePath, JSON.stringify({ schema: 'litmiq-baseline/1', ran_at: report.ran_at, summary }, null, 2) + '\n');

const md = [`## Litmiq: ${report.suite}`, '', `Judge: ${judge} · ${suite.cases.length} cases · ${models.length} models`, '', '| Model | Scored | Average | Pass rate |', '|---|---:|---:|---:|',
  ...models.map((m) => `| ${m} | ${summary[m].scored} | ${summary[m].avg ?? 'n/a'} | ${summary[m].pass_rate === null ? 'n/a' : summary[m].pass_rate + '%'} |`), '',
  problems.length ? '**Regressions:**\n' + problems.map((p) => '- ' + p).join('\n') : (baseline ? 'No regression against the baseline.' : 'No baseline yet: this run was saved as the baseline.'), ''].join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
if (problems.length && process.env.LITMIQ_ALERT_WEBHOOK) {
  try { await fetch(process.env.LITMIQ_ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `Litmiq regression in "${report.suite}":\n` + problems.join('\n') }) }); } catch (_) {}
}
if (errors && errors === results.length) process.exit(3);
process.exit(problems.length ? 1 : 0);
