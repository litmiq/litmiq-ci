// Compliance evidence records for litmiq-ci. No dependencies. No network at import time.
// Same file format as the Litmiq app's evidence pack (litmiq-compliance-evidence-file v1):
//   { kind, version, sha256, record }  where sha256 = SHA-256 of JSON.stringify(record).
// This is evidence of testing, not a certification, and not a legal or audit opinion.
import crypto from 'node:crypto';
import { pullRequestNumber } from './compare.mjs';

export const KIND = 'litmiq-compliance-evidence';
export const FILE_KIND = 'litmiq-compliance-evidence-file';

export const sha256hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
export const canonicalString = (record) => JSON.stringify(record);

const SECRET = /(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g;
export const scrub = (s) => String(s == null ? '' : s).replace(SECRET, '[secret removed]');

export function gitContext(env = process.env) {
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
  const repo = env.GITHUB_REPOSITORY || null;
  const runId = env.GITHUB_RUN_ID || null;
  return {
    repository: repo,
    commit_sha: env.LITMIQ_COMMIT_SHA || env.GITHUB_SHA || null,
    ref: env.GITHUB_REF || null,
    event: env.GITHUB_EVENT_NAME || null,
    pull_request: pullRequestNumber(env),
    workflow: env.GITHUB_WORKFLOW || null,
    run_id: runId,
    run_attempt: env.GITHUB_RUN_ATTEMPT || null,
    run_url: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
    actor: env.GITHUB_ACTOR || null
  };
}

// Approved reviews on the pull request at run time. null = unknown (not a PR, no token, or the API failed).
export async function prApprovals({ env = process.env, fetchImpl } = {}) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const number = pullRequestNumber(env);
  if (!token || !number || !repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  try {
    const res = await (fetchImpl || fetch)(`${api}/repos/${repo}/pulls/${number}/reviews?per_page=100`, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'litmiq-ci', 'x-github-api-version': '2022-11-28' }
    });
    if (!res.ok) return null;
    const reviews = await res.json();
    if (!Array.isArray(reviews)) return null;
    const latest = {};
    for (const r of reviews) {
      const login = r && r.user && r.user.login;
      if (!login || !r.state || r.state === 'COMMENTED') continue;
      latest[login] = r;
    }
    return Object.values(latest).filter((r) => r.state === 'APPROVED')
      .map((r) => ({ reviewer: r.user.login, submitted_at: r.submitted_at || null, commit_sha: r.commit_id || null }));
  } catch (_) { return null; }
}

export function buildCiRecord({ suite, suiteText, judge, models, ci, summary, problems, results, baseline, baselineText, baselineUpdated, approvals, env = process.env, ranAt }) {
  const f = (suite && suite.litmiq_fields) || {};
  const sp = scrub(f.system_prompt || '');
  const cases = (suite.cases || []).map((c, i) => {
    const id = c.id || 'C-' + (i + 1);
    return {
      idx: i + 1,
      id,
      input: scrub(c.user_input || ''),
      expected: scrub(c.expected_behavior || ''),
      outputs: models.map((m) => {
        const r = (results || []).find((x) => x.case === id && x.model === m) || {};
        return {
          model: m,
          output: scrub(r.output != null ? r.output : ''),
          score: Number.isFinite(r.overall) ? r.overall : null,
          scores: r.scores || {},
          reasoning: scrub(r.reasoning || ''),
          error: r.error ? scrub(r.error) : null
        };
      })
    };
  });
  return {
    kind: KIND,
    version: 1,
    source: 'litmiq-ci',
    created_at: String(ranAt || new Date().toISOString()),
    run_timestamp: String(ranAt || ''),
    suite_name: scrub(suite.name || 'Litmiq suite'),
    prompt_version: {
      suite_sha256: sha256hex(suiteText),
      system_prompt_sha256: sha256hex(f.system_prompt || ''),
      scoring_criteria_sha256: sha256hex(f.scoring_criteria || '')
    },
    git: gitContext(env),
    judge_model: scrub(judge || ''),
    system_prompt: sp,
    scoring_criteria: scrub(f.scoring_criteria || ''),
    pass_threshold: ci.pass_score,
    gate: {
      verdict: problems.length ? 'fail' : 'pass',
      thresholds: ci,
      problems: problems.map(scrub),
      baseline_sha256: baselineText ? sha256hex(baselineText) : null,
      baseline_ran_at: baseline && baseline.ran_at ? String(baseline.ran_at) : null,
      baseline_updated: Boolean(baselineUpdated)
    },
    approvals: approvals === undefined ? null : approvals,
    models: models.map((m) => {
      const s = summary[m] || {};
      const n = (results || []).filter((r) => r.model === m).length;
      const pass_n = (results || []).filter((r) => r.model === m && Number.isFinite(r.overall) && r.overall >= ci.pass_score).length;
      return { model: m, avg: s.avg == null ? null : s.avg, pass_n, pass_rate: s.pass_rate == null ? null : s.pass_rate, scored: s.scored || 0, n, metrics: s.metrics || {} };
    }),
    cases,
    note: 'Evidence of testing produced by litmiq-ci in your CI with your own provider keys. Not a certification, not a legal determination, and not an audit opinion. Litmiq does not receive or store this file.'
  };
}

export function filePayload(record) {
  return { kind: FILE_KIND, version: 1, sha256: sha256hex(canonicalString(record)), record };
}

// Works for app packs and CI records: recompute SHA-256 of JSON.stringify(record).
export function verifyPayload(payload) {
  if (!payload || payload.kind !== FILE_KIND || !payload.record || typeof payload.sha256 !== 'string') {
    return { ok: false, error: 'not a Litmiq evidence file (kind litmiq-compliance-evidence-file)' };
  }
  const actual = sha256hex(canonicalString(payload.record));
  return { ok: actual === payload.sha256.toLowerCase(), expected: payload.sha256, actual };
}
