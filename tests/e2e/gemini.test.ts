import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.env.GEMINI_CLI_HOME = path.join(sb.dir, 'gemini-home');
});
afterEach(() => sb.cleanup());

const userSettings = () => path.join(sb.env.GEMINI_CLI_HOME!, '.gemini', 'settings.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('belayd for Gemini CLI (built binary)', () => {
  it('installs BeforeTool and AfterTool hooks under GEMINI_CLI_HOME', () => {
    const r = belayd(sb, ['init', '--agent', 'gemini', '--global', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(read(userSettings()).hooks).sort()).toEqual(['AfterTool', 'BeforeTool']);
  });

  it('the installed command blocks rm -rf ~ the way Gemini CLI runs it', () => {
    belayd(sb, ['init', '--agent', 'gemini', '--global', '--yes']);
    const entry = read(userSettings()).hooks.BeforeTool[0].hooks[0];
    const r = spawnSync('sh', ['-c', entry.command], {
      cwd: sb.project,
      env: sb.env,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'BeforeTool',
        session_id: 's',
        cwd: sb.project,
        tool_name: 'run_shell_command',
        tool_input: { command: 'rm -rf ~' },
      }),
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'deny' });
  });

  it('is set up by default when Gemini CLI is found, and uninstall removes it', () => {
    fs.mkdirSync(path.join(sb.env.GEMINI_CLI_HOME!, '.gemini'), { recursive: true });
    const r = belayd(sb, ['init', '--yes']);
    expect(r.stdout).toMatch(/belayd is on for Gemini CLI/);
    expect(belayd(sb, ['uninstall', '--yes']).status).toBe(0);
    expect(read(path.join(sb.project, '.gemini', 'settings.json')).hooks).toBeUndefined();
  });
});
