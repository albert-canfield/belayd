import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteCall } from '../../src/audit/live.js';
import { makeClobberCheck } from '../../src/policy/clobber.js';
import { evaluate } from '../../src/policy/engine.js';
import { loadPolicy } from '../../src/policy/load.js';
import type { Action, ActionContext } from '../../src/policy/types.js';
import { canonicalPath } from '../../src/util/paths.js';

/**
 * Codex works in the project and has not committed yet. Claude Code, in its own session,
 * is about to throw that work away, stash it, commit it or write over it.
 */
let root: string;
let ws: string;
let home: string;
const ME = 'claude-code:mine';
const CODEX = 'codex:theirs';
const MIN = 60_000;

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: ws,
    stdio: 'ignore',
  });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
};
/** A finished tool call by `session` that said it changes these files. */
const note = (session: string, files: string[], ago = 2 * MIN) =>
  noteCall(
    home,
    ws,
    { session, agent: session.split(':')[0]!, writes: files.map((f) => path.join(ws, f)) },
    Date.now() - ago,
  );

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-clobber-'));
  ws = canonicalPath(path.join(root, 'app'));
  fs.mkdirSync(ws);
  ws = canonicalPath(ws);
  home = path.join(root, 'home');
  git('init', '-q');
  write('a.ts', 'a\n');
  write('b.ts', 'b\n');
  write('src/c.ts', 'c\n');
  write('.gitignore', 'dist/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  // Codex changed a.ts and src/c.ts, and wrote a build file Git ignores.
  write('a.ts', 'a, by codex\n');
  write('src/c.ts', 'c, by codex\n');
  write('dist/out.js', 'built\n');
  note(CODEX, ['a.ts', 'src/c.ts', 'dist/out.js']);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function decide(action: Action, preset = 'balanced') {
  const ctx: ActionContext = { agent: 'claude-code', cwd: ws, workspace: ws, home: root };
  const policy = await loadPolicy({ workspace: ws, belaydHome: home, preset, noCache: true });
  return evaluate(action, ctx, policy, {
    belaydHome: home,
    othersWork: makeClobberCheck({ belaydHome: home, workspace: ws, session: ME, cwd: ws }),
  });
}
const sh = (command: string) => ({ kind: 'shell' as const, command });

describe("another agent's uncommitted work", () => {
  it.each([
    ['git checkout -- .', 'throw away'],
    ['git checkout .', 'throw away'],
    ['git restore src', 'throw away'],
    ['git reset --hard', 'throw away'],
    ['git switch -f main', 'throw away'],
    ['git stash', 'stash'],
    ['git stash push -m wip', 'stash'],
    ['git add -A', 'sweep into a commit'],
    ['git add . && git commit -m mine', 'sweep into a commit'],
    ['git commit -am mine', 'sweep into a commit'],
    ['git checkout -b other', 'carry onto another branch'],
    ['rm -rf src', 'overwrite'],
    ['echo x > a.ts', 'overwrite'],
  ])('%s asks, naming the agent and its files', async (command, does) => {
    const d = await decide(sh(command));
    expect(d.verdict).toBe('ask');
    expect(d.ruleId).toBe('ask-other-agents-work');
    expect(d.reason).toContain(`this would ${does} uncommitted work: Codex changed`);
    expect(d.reason).toMatch(/2 min ago/);
  });

  it('asks before the file tools write over it, and lists every file', async () => {
    const d = await decide({ kind: 'write', path: path.join(ws, 'a.ts') });
    expect(d.ruleId).toBe('ask-other-agents-work');
    expect((await decide(sh('git stash'))).reason).toContain('Codex changed a.ts, src/c.ts');
  });

  it('stays out of the way of files and commands that leave their work alone', async () => {
    for (const command of [
      'git status',
      'git diff',
      'git add b.ts',
      'git stash list',
      'git restore --staged a.ts',
      'git clean -n',
      'echo x > b.ts',
      'rm -rf dist',
    ]) {
      expect((await decide(sh(command))).ruleId, command).not.toBe('ask-other-agents-work');
    }
    expect((await decide({ kind: 'write', path: path.join(ws, 'b.ts') })).verdict).toBe('pass');
    // Discarding only your own changes is your business: quiet, as before.
    write('b.ts', 'b, mine\n');
    note(ME, ['b.ts'], MIN);
    expect((await decide(sh('git checkout -- b.ts'))).verdict).toBe('pass');
  });

  it('lets go once their work is committed, or once you changed the file after them', async () => {
    git('commit', '-qam', 'codex is done');
    expect((await decide(sh('git reset --hard'))).ruleId).toBe('ask-discard-work');
    expect((await decide({ kind: 'write', path: path.join(ws, 'a.ts') })).verdict).toBe('pass');
  });

  it('takes over a file you changed after them', async () => {
    note(ME, ['a.ts', 'src/c.ts'], MIN);
    expect((await decide(sh('git stash'))).ruleId).not.toBe('ask-other-agents-work');
  });

  it('forgets an agent that has been quiet for half an hour', async () => {
    fs.rmSync(path.join(home, 'live'), { recursive: true });
    note(CODEX, ['a.ts', 'src/c.ts'], 31 * MIN);
    expect((await decide(sh('git stash'))).ruleId).not.toBe('ask-other-agents-work');
  });

  it('still asks in yolo-with-undo, which otherwise allows discarding work', async () => {
    expect((await decide(sh('git checkout -- .'), 'yolo-with-undo')).verdict).toBe('ask');
    git('commit', '-qam', 'codex is done');
    expect((await decide(sh('git checkout -- .'), 'yolo-with-undo')).verdict).toBe('allow');
  });

  it('cannot be switched off by a learned or user allow rule (it is final)', async () => {
    fs.writeFileSync(
      path.join(home, 'belayd.yaml'),
      'version: 1\nrules:\n  - id: allow-stash\n    match: { argv: [git, stash] }\n    decision: allow\n',
    );
    expect((await decide(sh('git stash'))).ruleId).toBe('ask-other-agents-work');
  });
});

describe('outside Git', () => {
  it('counts every file another agent changed, since nothing tells what is committed', async () => {
    fs.rmSync(path.join(ws, '.git'), { recursive: true });
    expect((await decide({ kind: 'write', path: path.join(ws, 'a.ts') })).ruleId).toBe(
      'ask-other-agents-work',
    );
    expect((await decide(sh('git stash'))).ruleId).not.toBe('ask-other-agents-work');
  });
});
