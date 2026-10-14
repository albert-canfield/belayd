import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.env.COPILOT_HOME = path.join(sb.dir, 'copilot-home');
});
afterEach(() => sb.cleanup());

const settingsFile = () => path.join(sb.project, '.github', 'copilot', 'settings.local.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Runs an installed hook entry the way Copilot CLI does: through bash, JSON on stdin. */
const runEntry = (entry: { bash: string }, payload: Record<string, unknown>) =>
  spawnSync('bash', ['-c', entry.bash], {
    cwd: sb.project,
    env: sb.env,
    encoding: 'utf8',
    input: JSON.stringify(payload),
  });

describe('belayd for Copilot CLI (built binary)', () => {
  it('installs hooks for each event Copilot CLI sends', () => {
    const r = belayd(sb, ['init', '--agent', 'copilot', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/trust this folder/);
    const hooks = read(settingsFile()).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['postToolUse', 'postToolUseFailure', 'preToolUse']);
  });

  it('the installed command blocks rm -rf ~ and stays quiet for npm test', () => {
    belayd(sb, ['init', '--agent', 'copilot', '--yes']);
    const pre = read(settingsFile()).hooks.preToolUse[0];
    const payload = (command: string) => ({
      sessionId: 's',
      timestamp: Date.now(),
      cwd: sb.project,
      toolName: 'bash',
      toolArgs: JSON.stringify({ command }),
    });
    const denied = runEntry(pre, payload('rm -rf ~'));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout)).toMatchObject({ permissionDecision: 'deny' });
    const quiet = runEntry(pre, payload('npm test'));
    expect(quiet).toMatchObject({ status: 0, stdout: '' });
  });

  it('is set up by default when Copilot CLI is found, and uninstall removes it', () => {
    fs.mkdirSync(sb.env.COPILOT_HOME!, { recursive: true });
    const r = belayd(sb, ['init', '--yes']);
    expect(r.stdout).toMatch(/belayd is on for Copilot CLI/);
    expect(belayd(sb, ['uninstall', '--yes']).status).toBe(0);
    expect(read(settingsFile()).hooks).toBeUndefined();
  });

  it('doctor checks the Copilot CLI hook and runs it', () => {
    fs.mkdirSync(sb.env.COPILOT_HOME!, { recursive: true });
    belayd(sb, ['init', '--agent', 'copilot', '--yes']);
    const r = belayd(sb, ['doctor']);
    expect(r.stdout).toMatch(/Copilot CLI hook installed/);
    expect(r.stdout).toMatch(/Copilot CLI hook blocks "rm -rf ~"/);
  });
});
