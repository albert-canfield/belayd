import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, bin, hookPayload, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  fs.writeFileSync(
    path.join(sb.project, 'belayd.yaml'),
    'version: 1\napproval: { channels: [native, tty], notify: false }\n',
  );
});
afterEach(() => sb.cleanup());

function runHook(command: string, timeout = 180): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [bin, 'hook', 'claude-code', '--timeout', String(timeout)],
      {
        cwd: sb.project,
        env: { ...sb.env, CLAUDE_CODE_SESSION_ATTENDED: '0' },
      },
    );
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(hookPayload(sb, 'Bash', { command }));
  });
}

async function waitForRequest(): Promise<{ id: string; label: string }> {
  for (let i = 0; i < 100; i++) {
    const r = belayd(sb, ['approve', '--json']);
    const list = JSON.parse(r.stdout || '[]');
    if (list.length > 0) return list[0];
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('the hook never asked for approval');
}

const decision = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.permissionDecision;

describe('approvals in a headless session (built binary)', () => {
  it('waits for `belayd approve <id> --allow`', async () => {
    const hook = runHook('sudo ls');
    const req = await waitForRequest();
    expect(req.label).toBe('sudo ls');
    const answer = belayd(sb, ['approve', req.id, '--allow']);
    expect(answer.status).toBe(0);
    const r = await hook;
    expect(r.code).toBe(0);
    expect(decision(r.stdout)).toBe('allow');
  });

  it('passes a no back to the agent', async () => {
    const hook = runHook('sudo ls');
    const req = await waitForRequest();
    belayd(sb, ['approve', req.id, '--deny']);
    expect(decision((await hook).stdout)).toBe('deny');
  });

  it('denies on its own before the agent would time out', async () => {
    const started = Date.now();
    const r = await runHook('sudo ls', 7);
    expect(decision(r.stdout)).toBe('deny');
    expect(r.stdout).toMatch(/nobody answered/);
    expect(Date.now() - started).toBeLessThan(6500);
  });

  it('lists nothing once the request is answered', async () => {
    const hook = runHook('sudo ls');
    const req = await waitForRequest();
    belayd(sb, ['approve', req.id, '--allow']);
    await hook;
    expect(JSON.parse(belayd(sb, ['approve', '--json']).stdout)).toEqual([]);
  });
});

describe('approvals are for people', () => {
  it('belayd approve refuses to run inside an agent tool call', async () => {
    const hook = runHook('sudo ls', 15);
    const req = await waitForRequest();
    const r = belayd(sb, ['approve', req.id, '--allow'], {
      env: { CLAUDE_CODE_CHILD_SESSION: '1' },
    });
    expect(r.status).toBe(77);
    expect(r.stderr).toMatch(/must be run by a person/);
    belayd(sb, ['approve', req.id, '--deny']);
    expect(decision((await hook).stdout)).toBe('deny');
  });
});
