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
