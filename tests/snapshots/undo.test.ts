import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, sandbox, type Sandbox } from '../e2e/helpers.js';

let sb: Sandbox;
let n = 0;

beforeEach(() => {
  sb = sandbox();
  fs.rmSync(path.join(sb.project, '.git'), { recursive: true, force: true });
  git('init', '-q');
  write('src/app.ts', 'export const greet = () => "hello";\n');
  write('src/util.ts', 'export const add = (a: number, b: number) => a + b;\n');
  write('docs/notes with spaces é.md', '# Notes\n');
  fs.writeFileSync(path.join(sb.project, 'logo.bin'), crypto.randomBytes(4096));
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  n = 0;
});
afterEach(() => sb.cleanup());

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: sb.project, encoding: 'utf8' });
}
function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(sb.project, rel)), { recursive: true });
  fs.writeFileSync(path.join(sb.project, rel), content);
}
function read(rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(sb.project, rel), 'utf8');
  } catch {
    return undefined;
  }
}
/** Every file in the project except .git, with a hash of its bytes. */
function state(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'belayd.yaml') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else
        out[path.relative(sb.project, full)] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(full))
          .digest('hex');
    }
  };
  walk(sb.project);
  return out;
}
/** Hashes of everything in the project's own .git that matters. */
function gitFingerprint(): string {
  const parts = [
    'index',
    'HEAD',
    'packed-refs',
    'refs/heads/main',
    'refs/heads/master',
    'refs/stash',
  ].map((f) => {
    try {
      return crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(sb.project, '.git', f)))
        .digest('hex');
    } catch {
      return '-';
    }
  });
  return parts.join(',') + git('status', '--porcelain');
}

/** One agent step: PreToolUse hook, the change itself, PostToolUse hook. */
function step(tool: string, input: Record<string, unknown>, change: () => void): void {
  const id = `t${++n}`;
  const payload = (event: string) =>
    JSON.stringify({
      hook_event_name: event,
      session_id: 'undo-test',
      cwd: sb.project,
      tool_name: tool,
      tool_use_id: id,
      tool_input: input,
    });
  const pre = belayd(sb, ['hook', 'claude-code'], { input: payload('PreToolUse') });
  expect(pre.status).toBe(0);
  change();
  belayd(sb, ['hook', 'claude-code'], { input: payload('PostToolUse') });
}

const writeStep = (rel: string, content: string) =>
  step('Write', { file_path: path.join(sb.project, rel), content }, () => write(rel, content));
const shellStep = (command: string) =>
  step('Bash', { command }, () => execFileSync('sh', ['-c', command], { cwd: sb.project }));

describe('undo', () => {
  it('undoes a Write byte for byte', () => {
    const before = read('src/app.ts');
    writeStep('src/app.ts', 'broken();\n');
    expect(belayd(sb, ['undo']).status).toBe(0);
    expect(read('src/app.ts')).toBe(before);
  });

  it('undoes what a shell command changed, created and deleted', () => {
    const before = state();
    shellStep(
      'echo "// edited" >> src/app.ts && rm src/util.ts && mkdir -p gen && echo x > gen/out.json',
    );
    expect(read('gen/out.json')).toBe('x\n');
    const r = belayd(sb, ['undo']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(state()).toEqual(before);
  });

  it('handles odd file names and binary files', () => {
    const before = state();
    shellStep(`rm "docs/notes with spaces é.md" logo.bin`);
    expect(belayd(sb, ['undo']).status).toBe(0);
    expect(state()).toEqual(before);
  });

  it('undoes one step in the middle and leaves later steps alone', () => {
    writeStep('src/app.ts', 'step one\n');
    writeStep('src/util.ts', 'step two\n');
    writeStep('README.md', 'step three\n');
    expect(belayd(sb, ['undo', '2']).status).toBe(0);
    expect(read('src/util.ts')).toBe('export const add = (a: number, b: number) => a + b;\n');
    expect(read('src/app.ts')).toBe('step one\n');
    expect(read('README.md')).toBe('step three\n');
  });

  it('refuses to throw away newer changes unless forced', () => {
    writeStep('src/app.ts', 'agent version\n');
    write('src/app.ts', 'my own edit after the agent\n');
    const r = belayd(sb, ['undo', '1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/changed again after step 1/);
    expect(read('src/app.ts')).toBe('my own edit after the agent\n');
    expect(belayd(sb, ['undo', '1', '--force']).status).toBe(0);
    expect(read('src/app.ts')).toBe('export const greet = () => "hello";\n');
  });

  it('undoes a whole session back to where it started', () => {
    const before = state();
    writeStep('src/app.ts', 'one\n');
    shellStep('rm src/util.ts && echo new > src/new.ts');
    writeStep('src/new.ts', 'two\n');
    shellStep('mv docs/"notes with spaces é.md" docs/renamed.md');
    const r = belayd(sb, ['undo', '--whole-session']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(state()).toEqual(before);
  });

  it('can redo an undo', () => {
    writeStep('src/app.ts', 'agent version\n');
    belayd(sb, ['undo']);
    expect(read('src/app.ts')).toBe('export const greet = () => "hello";\n');
    expect(belayd(sb, ['redo']).status).toBe(0);
    expect(read('src/app.ts')).toBe('agent version\n');
  });

  it('never touches the project own .git', () => {
    git('stash', 'list');
    const before = gitFingerprint();
    // Leave the work tree as it was so git status is comparable.
    writeStep('src/app.ts', 'temporary\n');
    shellStep('echo tmp > scratch.txt');
    belayd(sb, ['undo', '--whole-session']);
    expect(gitFingerprint()).toBe(before);
    expect(git('for-each-ref')).not.toMatch(/belayd/);
  });

  it('does not snapshot read-only commands', () => {
    shellStep('ls -la && git status && cat src/app.ts');
    const events = JSON.parse(belayd(sb, ['log', '--json']).stdout) as { snapshot?: string }[];
    expect(events.every((e) => !e.snapshot)).toBe(true);
  });

  it('works in a folder that is not a Git repository', () => {
    fs.rmSync(path.join(sb.project, '.git'), { recursive: true, force: true });
    const before = state();
    shellStep('rm src/app.ts');
    expect(belayd(sb, ['undo']).status).toBe(0);
    expect(state()).toEqual(before);
  });

  it('skips files over the size limit and says so', () => {
    write('belayd.yaml', 'version: 1\nsnapshots: { maxFileSize: 1KB }\n');
    shellStep('head -c 5000 /dev/zero > big.dat && echo small > small.txt');
    const r = belayd(sb, ['undo']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/skip\s+big\.dat\s+\(too big/);
    expect(read('small.txt')).toBeUndefined();
    expect(fs.existsSync(path.join(sb.project, 'big.dat'))).toBe(true);
  });

  it('copes with parallel tool calls', async () => {
    const { spawn } = await import('node:child_process');
    const { bin } = await import('../e2e/helpers.js');
    const runs = Array.from(
      { length: 6 },
      (_, i) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, [bin, 'hook', 'claude-code'], {
            cwd: sb.project,
            env: sb.env,
          });
          child.on('close', resolve);
          child.stdin.end(
            JSON.stringify({
              hook_event_name: 'PreToolUse',
              session_id: 'p',
              cwd: sb.project,
              tool_name: 'Bash',
              tool_use_id: `p${i}`,
              tool_input: { command: `echo ${i} > f${i}.txt` },
            }),
          );
        }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(fs.existsSync(path.join(sb.env.BELAYD_HOME!, 'errors.log'))).toBe(false);
  });
});

describe('snapshot safety', () => {
  it('keeps belayd data out of snapshots when it lives inside the project', () => {
    // Spell the path the way users often have it: on macOS /var is really /private/var.
    const inside = path.join(sb.project.replace(/^\/private\//, '/'), '.belayd-home');
    const env = { BELAYD_HOME: inside };
    for (let i = 0; i < 3; i++) {
      const payload = (event: string) =>
        JSON.stringify({
          hook_event_name: event,
          session_id: 's',
          cwd: sb.project,
          tool_name: 'Bash',
          tool_use_id: `i${i}`,
          tool_input: { command: `echo ${i} > f.txt` },
        });
      belayd(sb, ['hook', 'claude-code'], { input: payload('PreToolUse'), env });
      write('f.txt', `${i}\n`);
      belayd(sb, ['hook', 'claude-code'], { input: payload('PostToolUse'), env });
    }
    const r = belayd(sb, ['replay', '--json'], { env });
    const events = JSON.parse(r.stdout) as { snapshot?: string }[];
    expect(events.filter((e) => e.snapshot).length).toBe(6);
    const undo = belayd(sb, ['undo', '--dry-run'], { env });
    expect(undo.stdout).not.toMatch(/\.belayd-home/);
    const shadow = fs.readdirSync(path.join(inside, 'snapshots'))[0]!;
    const tracked = execFileSync('git', ['ls-files'], {
      env: {
        ...process.env,
        GIT_DIR: path.join(inside, 'snapshots', shadow),
        GIT_WORK_TREE: sb.project,
        GIT_INDEX_FILE: path.join(inside, 'snapshots', shadow, 'index'),
      },
      encoding: 'utf8',
    });
    expect(tracked).not.toMatch(/\.belayd-home/);
  });

  it('does not snapshot an agent running in the home folder', async () => {
    const { tooBroad } = await import('../../src/snapshots/capture.js');
    expect(tooBroad('/home/dev', '/home/dev')).toBe(true);
    expect(tooBroad('/', '/home/dev')).toBe(true);
    expect(tooBroad('/home', '/home/dev')).toBe(true);
    expect(tooBroad('/home/dev/code/app', '/home/dev')).toBe(false);
  });
});

describe('new files', () => {
  it('undoes a Write that created a file by deleting it', () => {
    writeStep('src/brand-new.ts', 'export {};\n');
    expect(read('src/brand-new.ts')).toBe('export {};\n');
    expect(belayd(sb, ['undo']).status).toBe(0);
    expect(read('src/brand-new.ts')).toBeUndefined();
  });
});
