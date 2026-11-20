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
