import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.env.CODEX_HOME = path.join(sb.dir, 'codex-home');
});
afterEach(() => sb.cleanup());

const hooksFile = () => path.join(sb.project, '.codex', 'hooks.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('belayd for Codex (built binary)', () => {
  it('installs project hooks with a shell guard, since Codex fails open', () => {
    const r = belayd(sb, ['init', '--agent', 'codex', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/run \/hooks once/);
    const hooks = read(hooksFile()).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PreToolUse']);
    const pre = hooks.PreToolUse[0].hooks[0];
    expect(pre.command).toMatch(/hook codex --timeout 180 \|\| \{ .* exit 2; \}$/);
    expect(pre.timeout).toBe(180);
    expect(fs.readFileSync(path.join(sb.project, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.codex/hooks.json',
    );
  });

  it('the installed command blocks rm -rf ~ when Codex runs it', () => {
    belayd(sb, ['init', '--agent', 'codex', '--yes']);
    const pre = read(hooksFile()).hooks.PreToolUse[0].hooks[0];
    const r = spawnSync('sh', ['-c', pre.command], {
      cwd: sb.project,
      env: sb.env,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        cwd: sb.project,
        turn_id: 't',
        tool_name: 'Bash',
        tool_use_id: 'u',
        tool_input: { command: 'rm -rf ~' },
      }),
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('--global installs into CODEX_HOME', () => {
    belayd(sb, ['init', '--agent', 'codex', '--global', '--yes']);
    expect(read(path.join(sb.env.CODEX_HOME!, 'hooks.json')).hooks.PreToolUse).toHaveLength(1);
  });

  it('is set up automatically when Codex is found, and uninstall removes both', () => {
    fs.mkdirSync(sb.env.CODEX_HOME!, { recursive: true });
    const r = belayd(sb, ['init', '--yes'], { env: { BELAYD_CLAUDE_VERSION: '2.1.300' } });
    expect(r.stdout).toMatch(/Claude Code and Codex/);
    expect(belayd(sb, ['uninstall', '--yes']).status).toBe(0);
    expect(read(hooksFile()).hooks).toBeUndefined();
  });

  it('undoes an apply_patch that touched several files', () => {
    execFileSync('git', ['init', '-q'], { cwd: sb.project });
    fs.mkdirSync(path.join(sb.project, 'src'));
    fs.writeFileSync(path.join(sb.project, 'src/a.ts'), 'a1\n');
    fs.writeFileSync(path.join(sb.project, 'src/b.ts'), 'b1\n');
    const patch =
      '*** Begin Patch\n*** Update File: src/a.ts\n*** Delete File: src/b.ts\n*** Add File: src/c.ts\n*** End Patch';
    const payload = (event: string) =>
      JSON.stringify({
        hook_event_name: event,
        session_id: 'cx',
        cwd: sb.project,
        turn_id: 't',
        tool_name: 'apply_patch',
        tool_use_id: 'p1',
        tool_input: { command: patch },
      });
    belayd(sb, ['hook', 'codex'], { input: payload('PreToolUse') });
    fs.writeFileSync(path.join(sb.project, 'src/a.ts'), 'a2\n');
    fs.rmSync(path.join(sb.project, 'src/b.ts'));
    fs.writeFileSync(path.join(sb.project, 'src/c.ts'), 'c\n');
    belayd(sb, ['hook', 'codex'], { input: payload('PostToolUse') });
    const r = belayd(sb, ['undo']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(sb.project, 'src/a.ts'), 'utf8')).toBe('a1\n');
    expect(fs.readFileSync(path.join(sb.project, 'src/b.ts'), 'utf8')).toBe('b1\n');
    expect(fs.existsSync(path.join(sb.project, 'src/c.ts'))).toBe(false);
  });
});
