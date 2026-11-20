#!/usr/bin/env node
// Minimal stdio MCP server for Litmiq CI. No dependencies. Node 18+.
// Tools: validate_suite, run_suite, read_results. Provider calls use the same
// litmiq-ci.mjs CLI and the keys already in this process environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'litmiq-ci.mjs');

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function result(id, text, isError) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: String(text) }], isError: !!isError },
  };
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: process.env, cwd: process.cwd() });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, out, err });
    });
  });
}

const TOOLS = [
  {
    name: 'validate_suite',
    description: 'Check that a file is a Litmiq suite (litmiq-suite/1). No provider calls and no API keys required.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to a Litmiq suite JSON file.' } },
      required: ['path'],
    },
  },
  {
    name: 'run_suite',
    description: 'Run a Litmiq regression suite with the keys already in the environment (OPENAI_API_KEY and/or ANTHROPIC_API_KEY). Fails if scores drop against the baseline. Uses the same CLI as the GitHub Action.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a Litmiq suite JSON file.' },
        out: { type: 'string', description: 'Where to write results JSON.' },
        baseline: { type: 'string', description: 'Baseline file to compare against.' },
        update_baseline: { type: 'boolean', description: 'Write a new baseline when the run has no regressions.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_results',
    description: 'Read a litmiq-results/1 JSON file and return the summary plus any regressions.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to a results JSON file.' } },
      required: ['path'],
    },
  },
];

async function callTool(name, args) {
  args = args && typeof args === 'object' ? args : {};
  if (name === 'validate_suite') {
    if (!args.path) return { text: 'path is required', error: true };
    const r = await runCli([args.path, '--validate']);
    return { text: (r.out + r.err).trim() || `exit ${r.code}`, error: r.code !== 0 };
  }
  if (name === 'run_suite') {
    if (!args.path) return { text: 'path is required', error: true };
    const cliArgs = [args.path];
    if (args.out) cliArgs.push('--out', String(args.out));
    if (args.baseline) cliArgs.push('--baseline', String(args.baseline));
    if (args.update_baseline) cliArgs.push('--update-baseline');
    const r = await runCli(cliArgs);
    return { text: (r.out + r.err).trim() || `exit ${r.code}`, error: r.code !== 0 };
  }
  if (name === 'read_results') {
    if (!args.path) return { text: 'path is required', error: true };
    try {
      const data = JSON.parse(fs.readFileSync(args.path, 'utf8'));
      const lines = [`${data.suite || 'Litmiq results'} · judge ${data.judge_model || 'n/a'} · ${data.ran_at || ''}`];
      const summary = data.summary || {};
      for (const m of Object.keys(summary)) {
        const s = summary[m] || {};
        lines.push(`${m}: avg ${s.avg ?? 'n/a'}, pass ${s.pass_rate == null ? 'n/a' : s.pass_rate + '%'}, scored ${s.scored ?? 0}`);
      }
      const regs = data.regressions || [];
      if (regs.length) lines.push('Regressions:', ...regs.map((p) => '- ' + p));
      else lines.push('No regressions listed.');
      return { text: lines.join('\n'), error: false };
    } catch (e) {
      return { text: 'could not read results: ' + e.message, error: true };
    }
  }
  return { text: 'unknown tool: ' + name, error: true };
}

let pending = 0;
let ended = false;
function maybeExit() { if (ended && pending === 0) process.exit(0); }

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'litmiq-ci', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const out = await callTool(name, params && params.arguments);
    send(result(id, out.text, out.error));
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (typeof id !== 'undefined') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const header = buf.slice(0, sep).toString('utf8');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = Number(m[1]);
    const start = sep + 4;
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString('utf8');
    buf = buf.slice(start + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    pending++;
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && typeof msg.id !== 'undefined') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
      }
    }).finally(() => { pending--; maybeExit(); });
  }
});

process.stdin.on('end', () => { ended = true; maybeExit(); });
