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
