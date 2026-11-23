import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'litmiq-ci.mjs');
const mcp = path.join(root, 'mcp/server.mjs');
const example = path.join(root, 'examples/refund-verification.suite.json');
const node = process.execPath;

function run(args, opts = {}) {
  return spawnSync(node, args, { encoding: 'utf8', cwd: root, ...opts });
}

function rpc(method, params, id = 1) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const msg = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
  const res = spawnSync(node, [mcp], { input: msg, encoding: 'utf8', cwd: root, timeout: 5000 });
  assert.equal(res.status, 0, res.stderr);
  const m = res.stdout.match(/Content-Length:\s*(\d+)\r\n\r\n([\s\S]*)/);
  assert.ok(m, 'MCP framing: ' + res.stdout);
  const body = m[2].slice(0, Number(m[1]));
  return JSON.parse(body);
}

const help = run([cli, '--help']);
assert.equal(help.status, 0);
assert.match(help.stdout, /--validate/);

const missing = run([cli]);
assert.equal(missing.status, 2);

const ok = run([cli, example, '--validate']);
assert.equal(ok.status, 0, ok.stderr + ok.stdout);
assert.match(ok.stdout, /ok: Refund verification/);

const badFile = path.join(root, 'tests/_not-a-suite.json');
fs.writeFileSync(badFile, '{"hello":true}\n');
const bad = run([cli, badFile, '--validate']);
fs.unlinkSync(badFile);
assert.equal(bad.status, 2);
assert.match(bad.stderr, /not a Litmiq suite/);

const init = rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
assert.equal(init.result.serverInfo.name, 'litmiq-ci');

const list = rpc('tools/list', {});
assert.deepEqual(list.result.tools.map((t) => t.name), ['validate_suite', 'run_suite', 'read_results']);

const validated = rpc('tools/call', { name: 'validate_suite', arguments: { path: example } });
assert.equal(validated.result.isError, false);
assert.match(validated.result.content[0].text, /ok: Refund verification/);

console.log('ok: offline tests passed');

import { findProblems, normalizeCi, postPrComment, pullRequestNumber, renderMarkdown, summarizeModel, MARKER } from '../compare.mjs';

const rows = [
  { model: 'gpt-4.1', overall: 8.2, scores: { accuracy: 9, tone: 8, helpfulness: 8, conciseness: 8 } },
  { model: 'gpt-4.1', overall: 7.8, scores: { accuracy: 8, tone: 8, helpfulness: 8, conciseness: 7 } }
];
const summary = { 'gpt-4.1': summarizeModel(rows, 7) };
assert.equal(summary['gpt-4.1'].scored, 2);
assert.equal(summary['gpt-4.1'].avg, 8);
assert.equal(summary['gpt-4.1'].pass_rate, 100);
assert.equal(summary['gpt-4.1'].metrics.accuracy.avg, 8.5);

const baselineOk = { summary: { 'gpt-4.1': { avg: 8.2, pass_rate: 100, metrics: { accuracy: { avg: 8.6, n: 2 } } } } };
assert.deepEqual(findProblems(summary, baselineOk, { max_avg_drop: 0.5, max_pass_rate_drop: 10, max_metric_drop: 0.8 }), []);

const dropped = { 'gpt-4.1': summarizeModel([
  { model: 'gpt-4.1', overall: 6.0, scores: { accuracy: 5.0 } },
  { model: 'gpt-4.1', overall: 6.2, scores: { accuracy: 5.2 } }
], 7) };
const problems = findProblems(dropped, baselineOk, { max_avg_drop: 0.5, max_pass_rate_drop: 10, max_metric_drop: 0.8, min_metrics: { accuracy: 7 } });
assert.ok(problems.some((p) => /average fell from 8.2 to 6.1/.test(p)), problems.join('\n'));
assert.ok(problems.some((p) => /pass rate fell from 100% to 0%/.test(p)), problems.join('\n'));
assert.ok(problems.some((p) => /accuracy average fell from 8.6 to 5.1/.test(p)), problems.join('\n'));
assert.ok(problems.some((p) => /accuracy average 5.1 is below the minimum 7/.test(p)), problems.join('\n'));

assert.equal(normalizeCi({}).pass_score, 7);
assert.equal(normalizeCi({ min_avg: '8' }).min_avg, 8);

const md = renderMarkdown({ suite: 'Demo', judge: 'gpt-5.4-mini', caseCount: 2, models: ['gpt-4.1'], summary: dropped, problems, baseline: baselineOk });
assert.match(md, /## Litmiq: Demo/);
assert.match(md, /accuracy/);
assert.match(md, /\*\*Regressions:\*\*/);

const evFile = path.join(root, 'tests/_event.json');
fs.writeFileSync(evFile, JSON.stringify({ pull_request: { number: 17 } }));
assert.equal(pullRequestNumber({ GITHUB_EVENT_PATH: evFile }), '17');
fs.unlinkSync(evFile);

const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
  if (String(url).includes('/comments?')) {
    return { ok: true, json: async () => [{ id: 1, body: MARKER + '\n old', url: 'https://api.github.com/repos/acme/app/issues/comments/9' }] };
  }
  return { ok: true, text: async () => '' };
};
const posted = await postPrComment({
  env: { GITHUB_TOKEN: 't-test', GITHUB_REPOSITORY: 'acme/app', LITMIQ_PR_NUMBER: '17' },
  body: md,
  fetchImpl: fakeFetch
});
assert.equal(posted.ok, true);
assert.equal(posted.updated, true);
assert.equal(calls[1].method, 'PATCH');
assert.match(JSON.parse(calls[1].body).body, new RegExp(MARKER));
assert.doesNotMatch(JSON.stringify(calls), /t-test/);

const skipped = await postPrComment({ env: { LITMIQ_NO_PR_COMMENT: '1', GITHUB_TOKEN: 't-test', GITHUB_REPOSITORY: 'acme/app', LITMIQ_PR_NUMBER: '17' }, body: md, fetchImpl: fakeFetch });
assert.equal(skipped.skipped, 'disabled');

const help2 = run([cli, '--help']);
assert.match(help2.stdout, /--max-metric-drop/);
assert.match(help2.stdout, /GITHUB_TOKEN/);

console.log('ok: threshold and comment tests passed');

// v1.2.0: evidence records (fake OpenAI-compatible server, no real provider calls)
{
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { buildCiRecord, filePayload, verifyPayload, prApprovals, sha256hex } = await import('../evidence.mjs');
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const content = body.response_format
        ? JSON.stringify({ scores: { accuracy: 8, tone: 8, helpfulness: 8, conciseness: 8 }, overall: 8, reasoning: 'ok' })
        : 'Sure. Refund policy reply.';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(root, 'tests/_ev-'));
  const evPath = path.join(tmp, 'litmiq-evidence.json');
  const env = { ...process.env, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, ANTHROPIC_API_KEY: 'test-key',
    GITHUB_REPOSITORY: 'acme/app', GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '42', GITHUB_REF: 'refs/pull/7/merge', LITMIQ_NO_PR_COMMENT: '1',
    GITHUB_STEP_SUMMARY: '', GITHUB_TOKEN: '' };
  const code = await new Promise((resolve) => {
    const p = spawn(node, [cli, example, '--out', path.join(tmp, 'r.json'), '--baseline', path.join(tmp, 'b.json'), '--evidence', evPath], { cwd: root, env, stdio: 'ignore' });
    p.on('exit', resolve);
  });
  server.close();
  assert.equal(code, 0);
  const payload = JSON.parse(fs.readFileSync(evPath, 'utf8'));
  assert.equal(payload.kind, 'litmiq-compliance-evidence-file');
  assert.equal(payload.record.source, 'litmiq-ci');
  assert.equal(payload.record.git.commit_sha, 'abc123');
  assert.equal(payload.record.git.run_url, 'https://github.com/acme/app/actions/runs/42');
  assert.equal(payload.record.gate.verdict, 'pass');
  assert.equal(payload.record.gate.baseline_updated, true);
  assert.equal(payload.record.approvals, null);
  assert.equal(payload.record.prompt_version.suite_sha256, sha256hex(fs.readFileSync(example, 'utf8')));
  assert.equal(verifyPayload(payload).ok, true);
  const good = run([cli, '--verify-evidence', evPath]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /ok: SHA-256 matches/);
  payload.record.gate.verdict = 'fail';
  fs.writeFileSync(evPath, JSON.stringify(payload));
  const tampered = run([cli, '--verify-evidence', evPath]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /MISMATCH/);
  fs.writeFileSync(evPath, '{"hello":1}');
  assert.equal(run([cli, '--verify-evidence', evPath]).status, 2);
  fs.rmSync(tmp, { recursive: true, force: true });

  const rec = buildCiRecord({ suite: { name: 'S', litmiq_fields: { system_prompt: 'key sk-abcdefghijklmnop123' }, cases: [{ user_input: 'hi' }] }, suiteText: '{}', judge: 'j', models: ['m'], ci: { pass_score: 7 }, summary: {}, problems: [], results: [], baseline: null, baselineText: null, baselineUpdated: false, approvals: [], env: {} });
  assert.ok(!rec.system_prompt.includes('sk-abcdefghijklmnop123'));
  assert.deepEqual(rec.approvals, []);
  assert.equal(verifyPayload(filePayload(rec)).ok, true);

  const reviews = async () => ({ ok: true, json: async () => [
    { user: { login: 'ana' }, state: 'CHANGES_REQUESTED', submitted_at: '1', commit_id: 'a' },
    { user: { login: 'ana' }, state: 'APPROVED', submitted_at: '2', commit_id: 'b' },
    { user: { login: 'bo' }, state: 'COMMENTED' },
    { user: { login: 'cy' }, state: 'APPROVED', submitted_at: '3', commit_id: 'b' },
    { user: { login: 'cy' }, state: 'DISMISSED' }
  ] });
  const ap = await prApprovals({ env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app', LITMIQ_PR_NUMBER: '7' }, fetchImpl: reviews });
  assert.deepEqual(ap, [{ reviewer: 'ana', submitted_at: '2', commit_sha: 'b' }]);
  assert.equal(await prApprovals({ env: {} }), null);
}
console.log('ok: evidence tests passed');
