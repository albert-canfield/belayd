#!/usr/bin/env node
// Differential test: what belayd decides about a command, against what bash really does
// with it in a throwaway container. A bypass is a command that deleted or changed files
// outside the project, or read a secret, while belayd said nothing.
//
// Needs Docker and a built dist/ (pnpm build). Usage:
//   node scripts/differential.mjs            run everything
//   node scripts/differential.mjs --only rm  only cases whose command contains "rm"
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { generatedCases } from '../tests/differential/cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diffDir = path.join(root, 'tests', 'differential');
const IMAGE = 'belayd-differential:1';
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;

if (!fs.existsSync(path.join(root, 'dist', 'bin.js'))) {
  console.error('Run pnpm build first.');
  process.exit(1);
}

const corpus = parse(fs.readFileSync(path.join(root, 'tests/policy/corpus.yaml'), 'utf8'));
const cases = [
  ...corpus
    .filter((r) => typeof r.cmd === 'string')
    .map((r) => ({ source: 'corpus', command: r.cmd })),
  ...generatedCases(),
].filter((c) => !only || c.command.includes(only));

const known = new Map();
for (const line of fs.readFileSync(path.join(diffDir, 'known-misses.txt'), 'utf8').split('\n')) {
  // `<command><tab># why`; a newline in the command is written as \n.
  const m = /^(.+?)\t+#\s*(.*)$/.exec(line);
  if (m && !line.startsWith('#')) known.set(m[1], m[2]);
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });
if (run('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) {
  const built = run('docker', ['build', '-q', '-t', IMAGE, diffDir]);
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-differential-'));
fs.writeFileSync(path.join(work, 'cases.json'), JSON.stringify(cases));
console.log(`Running ${cases.length} commands in a container...`);
const started = Date.now();
const r = run('docker', [
  'run',
  '--rm',
  '--network',
  'none',
  '--cap-add',
  'SYS_PTRACE',
  '--security-opt',
  'seccomp=unconfined',
  '--pids-limit',
  '512',
  '--memory',
  '1g',
  '-v',
  `${path.join(root, 'dist')}:/opt/belayd/dist:ro`,
  '-v',
  `${path.join(root, 'presets')}:/opt/belayd/presets:ro`,
  '-v',
  `${path.join(root, 'package.json')}:/opt/belayd/package.json:ro`,
  '-v',
  `${diffDir}:/opt/diff:ro`,
  '-v',
  `${work}:/out`,
  IMAGE,
  'node',
  '/opt/diff/inside.mjs',
  '/out/cases.json',
  '/out/results.json',
]);
if (r.status !== 0) process.exit(r.status ?? 1);
const results = JSON.parse(fs.readFileSync(path.join(work, 'results.json'), 'utf8'));
fs.rmSync(work, { recursive: true, force: true });

const missed = results.filter(
  (x) => x.effects.length > 0 && (x.verdict === 'pass' || x.verdict === 'allow'),
);
const errors = results.filter((x) => x.verdict.startsWith('error'));
const caught = results.filter(
  (x) => x.effects.length > 0 && !missed.includes(x) && !errors.includes(x),
);
const key = (command) => command.replace(/\n/g, '\\n');
const fresh = missed.filter((x) => !known.has(key(x.command)));
const nowCaught = [...known.keys()].filter(
  (k) => !missed.some((x) => key(x.command) === k) && (!only || k.includes(only)),
);

console.log(`\n${results.length} commands in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`  ${caught.length} did something dangerous and belayd blocked or asked`);
console.log(`  ${missed.length - fresh.length} known misses (tests/differential/known-misses.txt)`);
console.log(
  `  ${results.length - caught.length - missed.length - errors.length} did nothing dangerous`,
);
for (const x of errors) console.log(`  belayd failed on: ${x.command}\n    ${x.verdict}`);
if (nowCaught.length > 0) {
  console.log('\nThese known misses are caught now. Remove them from known-misses.txt:');
  for (const k of nowCaught) console.log(`  ${k}`);
}
if (fresh.length > 0) {
  console.log(
    `\n${fresh.length} new bypasses: bash did something dangerous and belayd said nothing:`,
  );
  for (const x of fresh)
    console.log(`  ${x.command.replace(/\n/g, '\\n')}\n    [${x.source}] ${x.effects.join('; ')}`);
}
process.exit(fresh.length > 0 || errors.length > 0 ? 1 : 0);
