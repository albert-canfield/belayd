#!/usr/bin/env node
// Measures how long one `belayd hook claude-code` call takes, end to end, the way an
// agent runs it: a fresh Node process per tool call, JSON on stdin.
//
//   node scripts/bench-hook.mjs [--runs 40] [--max-p50 100]
//
// Exits non-zero when the median is above --max-p50 milliseconds, so CI can guard it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'bin.js');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const runs = opt('--runs', 40);
const maxP50 = opt('--max-p50', 100);

if (!fs.existsSync(bin)) {
  console.error('dist/bin.js not found. Run `pnpm build` first.');
  process.exit(1);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-bench-'));
const env = { ...process.env, BELAYD_HOME: path.join(workspace, '.belayd-home') };

const scenarios = {
  'Bash: simple': { tool_name: 'Bash', tool_input: { command: 'npm test' } },
  'Bash: obfuscated': {
    tool_name: 'Bash',
    tool_input: {
      command: 'cd / && X=rm; bash -c "$X -rf *" | tee log && echo cm0gLXJmIC8= | base64 -d | sh',
    },
  },
  'Write: file': {
    tool_name: 'Write',
    tool_input: { file_path: path.join(workspace, 'a.ts'), content: 'x' },
  },
  'Read: .env': { tool_name: 'Read', tool_input: { file_path: path.join(workspace, '.env') } },
};

function once(payload) {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    cwd: workspace,
    session_id: 'bench',
    ...payload,
  });
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [bin, 'hook', 'claude-code'], {
    input,
    env,
    encoding: 'utf8',
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
  return ms;
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Baseline: what a bare Node process costs on this machine.
const baseline = [];
for (let i = 0; i < Math.min(runs, 20); i++) {
  const start = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', ''], { env });
  baseline.push(Number(process.hrtime.bigint() - start) / 1e6);
}
baseline.sort((a, b) => a - b);

console.log(
  `belayd hook latency, ${runs} runs per scenario, Node ${process.versions.node} on ${process.platform}`,
);
console.log(`bare node startup: p50 ${pct(baseline, 50).toFixed(1)} ms\n`);

let worstP50 = 0;
for (const [name, payload] of Object.entries(scenarios)) {
  once(payload); // warm the compile cache
  const times = [];
  for (let i = 0; i < runs; i++) times.push(once(payload));
  times.sort((a, b) => a - b);
  const p50 = pct(times, 50);
  worstP50 = Math.max(worstP50, p50);
  console.log(
    `${name.padEnd(18)} p50 ${p50.toFixed(1).padStart(6)} ms   p95 ${pct(times, 95).toFixed(1).padStart(6)} ms   ` +
      `overhead over bare node ${(p50 - pct(baseline, 50)).toFixed(1).padStart(6)} ms`,
  );
}

fs.rmSync(workspace, { recursive: true, force: true });

if (worstP50 > maxP50) {
  console.error(`\nFAIL: worst p50 ${worstP50.toFixed(1)} ms is above the ${maxP50} ms budget`);
  process.exit(1);
}
console.log(`\nOK: worst p50 ${worstP50.toFixed(1)} ms is within the ${maxP50} ms budget`);
