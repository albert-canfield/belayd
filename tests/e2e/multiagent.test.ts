import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  for (const f of ['a.txt', 'b.txt', 'shared.txt'])
    fs.writeFileSync(path.join(sb.project, f), 'orig\n');
  execFileSync('git', ['init', '-q'], { cwd: sb.project });
});
afterEach(() => sb.cleanup());

/** One side of a tool call from agent `who`, through the real Claude Code hook. */
function hook(who: string, id: string, event: 'PreToolUse' | 'PostToolUse', command: string): void {
  const r = belayd(sb, ['hook', 'claude-code', '--timeout', '30'], {
    input: JSON.stringify({
      hook_event_name: event,
      session_id: who,
      cwd: sb.project,
      tool_name: 'Bash',
      tool_use_id: id,
      tool_input: { command },
      ...(event === 'PostToolUse' ? { tool_response: {} } : {}),
    }),
  });
  expect(r.status, r.stderr).toBe(0);
}
const append = (file: string, text: string) => fs.appendFileSync(path.join(sb.project, file), text);
const read = (file: string) => fs.readFileSync(path.join(sb.project, file), 'utf8');

describe('several agents in one project at once', () => {
  it("asks before one agent stashes another agent's uncommitted work", () => {
    execFileSync('git', ['add', '.'], { cwd: sb.project });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: sb.project,
    });
    hook('agent-a', 'a1', 'PreToolUse', 'echo A >> a.txt');
    append('a.txt', 'A\n');
    hook('agent-a', 'a1', 'PostToolUse', 'echo A >> a.txt');

    const ask = (who: string, command: string) =>
      belayd(sb, ['hook', 'claude-code', '--timeout', '30'], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: who,
          cwd: sb.project,
          tool_name: 'Bash',
          tool_use_id: `${who}-stash`,
          tool_input: { command },
        }),
      }).stdout;
    const theirs = ask('agent-b', 'git stash');
    expect(theirs).toMatch(/"permissionDecision":\s*"ask"/);
    expect(theirs).toMatch(/this would stash uncommitted work: Claude Code changed a\.txt/);
    // The agent that made the change can stash it.
    expect(ask('agent-a', 'git stash')).not.toMatch(/uncommitted work/);
  });

  it('shows who is working in the project, and the files two agents both changed', () => {
    execFileSync('git', ['add', '.'], { cwd: sb.project });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: sb.project,
    });
    expect(belayd(sb, ['ps']).stdout).toMatch(/No agent has worked here/);
    for (const [who, id, command, file] of [
      ['agent-a', 'a1', 'echo A >> a.txt', 'a.txt'],
      ['agent-b', 'b1', 'echo B >> shared.txt', 'shared.txt'],
      ['agent-a', 'a2', 'echo A >> shared.txt', 'shared.txt'],
    ] as const) {
      hook(who, id, 'PreToolUse', command);
      append(file, 'x\n');
      hook(who, id, 'PostToolUse', command);
    }

    const out = belayd(sb, ['ps']).stdout;
    expect(out).toMatch(/2 agents working/);
    expect(out).toMatch(/agent-a[\s\S]*last\s+echo A >> shared\.txt/);
    expect(out).toMatch(/changed\s+a\.txt, shared\.txt · not committed/);
    expect(out).toMatch(/! shared\.txt was also changed by Claude Code agent-b/);
    const json = JSON.parse(belayd(sb, ['ps', '--json']).stdout) as {
      sessions: { session: string; files: { path: string; uncommitted: boolean }[] }[];
    }[];
    expect(json[0]!.sessions.map((s) => s.session).sort()).toEqual([
      'claude-code:agent-a',
      'claude-code:agent-b',
    ]);
    expect(belayd(sb, ['ps', '--all'], { cwd: sb.env.HOME! }).stdout).toMatch(/2 agents working/);
  });

  it("undoes one agent's step without touching what another wrote at the same time", () => {
    // Both steps are running when both files change.
    hook('agent-a', 'a1', 'PreToolUse', 'echo A >> a.txt');
    hook('agent-b', 'b1', 'PreToolUse', 'echo B >> b.txt');
    append('b.txt', 'B\n');
    append('a.txt', 'A\n');
    hook('agent-b', 'b1', 'PostToolUse', 'echo B >> b.txt');
    hook('agent-a', 'a1', 'PostToolUse', 'echo A >> a.txt');

    const replay = belayd(sb, ['replay', 'agent-a']).stdout;
    expect(replay).toMatch(/M a\.txt/);
    expect(replay).not.toMatch(/b\.txt/);

    const undo = belayd(sb, ['undo', '--session', 'agent-a']);
    expect(undo.status, undo.stdout).toBe(0);
    expect(read('a.txt')).toBe('orig\n');
    expect(read('b.txt')).toBe('orig\nB\n');
  });

  it('leaves a file both agents may have written alone unless forced', () => {
    // Neither command says it writes shared.txt: belayd cannot tell who did.
    const touch = `node -e "require('fs').appendFileSync('shared.txt', 'x')"`;
    const mine = `echo A >> a.txt && ${touch}`;
    hook('agent-a', 'a1', 'PreToolUse', mine);
    hook('agent-b', 'b1', 'PreToolUse', touch);
    append('shared.txt', 'x');
    append('a.txt', 'A\n');
    hook('agent-b', 'b1', 'PostToolUse', touch);
    hook('agent-a', 'a1', 'PostToolUse', mine);

    const undo = belayd(sb, ['undo', '--session', 'agent-a']);
    expect(undo.stdout).toMatch(/left alone\s+shared\.txt/);
    expect(read('shared.txt')).toBe('orig\nx');
    expect(read('a.txt')).toBe('orig\n');

    belayd(sb, ['redo']);
    const forced = belayd(sb, ['undo', '--session', 'agent-a', '--force']);
    expect(forced.status, forced.stdout).toBe(0);
    expect(read('shared.txt')).toBe('orig\n');
  });

  it('still keeps a file that only one agent wrote, even when the other was running', () => {
    hook('agent-a', 'a1', 'PreToolUse', 'npm run build');
    hook('agent-b', 'b1', 'PreToolUse', 'ls');
    append('a.txt', 'built\n');
    hook('agent-b', 'b1', 'PostToolUse', 'ls');
    hook('agent-a', 'a1', 'PostToolUse', 'npm run build');
    expect(belayd(sb, ['replay', 'agent-a']).stdout).toMatch(/M a\.txt/);
  });
});
