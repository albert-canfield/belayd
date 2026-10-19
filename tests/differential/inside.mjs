// Runs inside the container, as root. For each command: reset the fixture, ask belayd
// what it would decide, then really run the command as the unprivileged user `node`
// under strace and record what it did. Usage: node inside.mjs cases.json results.json
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [casesFile, resultsFile] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));

const HOME = '/home/node';
const PROJECT = '/work/project';
const BIN = '/opt/belayd/dist/bin.js';
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Places belayd lets an agent write without asking. */
const QUIET_WRITES = ['/home/node/.cache/', '/home/node/.npm/', '/home/node/.claude/'];
const SECRETS = new Set(['.env', 'id_rsa']);
/** The secret values in the fixture. A read is dangerous when one of them gets out. */
const SECRET_VALUES = ['sk_test_not_a_real_key_0000000000', 'not-a-real-key'];

/** Files outside the secrets themselves that now hold a secret value (copies, redirects). */
function leakedCopies() {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !SECRETS.has(e.name)) {
        try {
          const text = fs.readFileSync(p, 'utf8');
          if (SECRET_VALUES.some((v) => text.includes(v))) hits.push(p);
        } catch {
          // unreadable: not something the agent can read either
        }
      }
    }
  };
  for (const d of [HOME, PROJECT, '/tmp']) walk(d);
  return hits;
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function resetFixture() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync('/work', { recursive: true, force: true });
  fs.rmSync('/tmp', { recursive: true, force: true });
  fs.mkdirSync('/tmp', { mode: 0o1777 });
  fs.chmodSync('/tmp', 0o1777);
  const files = {
    [`${HOME}/precious/keep.txt`]: 'keep me\n',
    [`${HOME}/notes.txt`]: 'my notes\n',
    [`${HOME}/.ssh/id_rsa`]:
      '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n',
    [`${HOME}/.bashrc`]: '# bashrc\n',
    [`${PROJECT}/.env`]: 'API_KEY=sk_test_not_a_real_key_0000000000\n',
    [`${PROJECT}/src/app.js`]: 'console.log("app")\n',
    [`${PROJECT}/package.json`]: '{"name":"app","scripts":{"test":"node src/app.js"}}\n',
    [`${PROJECT}/README.md`]: '# app\n',
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  sh('git', ['init', '-q', PROJECT]);
  sh('chown', ['-R', 'node:node', HOME, '/work']);
}

/** Every file under HOME with its content hash, except places writes are fine. */
function snapshot() {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (QUIET_WRITES.some((q) => (p + '/').startsWith(q))) continue;
      if (e.isDirectory()) walk(p);
      else {
        let hash = 'unreadable';
        try {
          hash = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
        } catch {
          // a FIFO or a file the command made unreadable still counts as there
        }
        out.set(p, hash);
      }
    }
  };
  walk(HOME);
  return out;
}

function verdictOf(command) {
  const r = sh('node', [BIN, 'check', '--', command], {
    cwd: PROJECT,
    env: { HOME, PATH: PATH_ENV, BELAYD_HOME: '/var/belayd', NO_COLOR: '1' },
    timeout: 20_000,
  });
  const m = /\b(deny|ask|pass|allow)\b/.exec(r.stdout.split('\n')[0] ?? '');
  return m ? m[1] : `error: ${(r.stderr || r.stdout).trim().slice(0, 200)}`;
}

function run(command) {
  const trace = '/var/trace.txt';
  fs.rmSync(trace, { force: true });
  const r = sh(
    'strace',
    [
      '-f',
      '-qq',
      '-s',
      '4096',
      '-o',
      trace,
      '-e',
      'trace=open,openat,creat,execve',
      'setpriv',
      '--reuid=node',
      '--regid=node',
      '--init-groups',
      '--',
      'timeout',
      '-s',
      'KILL',
      '5',
      'bash',
      '-c',
      command,
    ],
    {
      cwd: PROJECT,
      env: { HOME, PATH: PATH_ENV, USER: 'node', LANG: 'C.UTF-8' },
      timeout: 15_000,
      input: '',
    },
  );
  let lines = [];
  try {
    lines = fs.readFileSync(trace, 'utf8').split('\n');
  } catch {
    // strace could not start: no programs, no reads
  }
  const secretReads = [];
  const programs = new Set();
  for (const line of lines) {
    const exec = /execve\("([^"]+)"/.exec(line);
    if (exec && !/= -1/.test(line)) programs.add(path.basename(exec[1]));
    const open = /open(?:at)?\((?:AT_FDCWD|\d+[^,]*), "([^"]+)", ([A-Z_|]+)[^)]*\) = (\d+)/.exec(
      line,
    );
    if (open && SECRETS.has(path.basename(open[1]))) secretReads.push(open[1]);
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const shown = SECRET_VALUES.some((v) => output.includes(v));
  return { exit: r.status, programs: [...programs], secretReads, shown, copies: leakedCopies() };
}

const results = [];
for (const c of cases) {
  resetFixture();
  const verdict = verdictOf(c.command);
  resetFixture();
  const before = snapshot();
  const ran = run(c.command);
  const after = snapshot();
  const deleted = [...before.keys()].filter((p) => !after.has(p));
  const changed = [...after.entries()].filter(([p, h]) => before.get(p) !== h).map(([p]) => p);
  const effects = [];
  if (deleted.length > 0) effects.push(`deleted ${deleted.join(', ')}`);
  if (changed.length > 0) effects.push(`wrote ${changed.join(', ')}`);
  // Opening a secrets file is not the danger; its value reaching the agent is: in the
  // output, or in a copy the agent can read later (`cp`, a redirect).
  if (ran.secretReads.length > 0 && (ran.shown || ran.copies.length > 0))
    effects.push(
      `read ${[...new Set(ran.secretReads)].join(', ')}` +
        (ran.shown ? ' and showed it' : `, copied to ${ran.copies.join(', ')}`),
    );
  results.push({ ...c, verdict, effects, exit: ran.exit, programs: ran.programs });
}
fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1));
