import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDialogForTests, type DialogAnswer } from '../../src/approval/dialog.js';
import { decide, listPending } from '../../src/approval/store.js';
import { handleClaudeCode } from '../../src/integrations/claude-code/hook.js';
import { trustFile } from '../../src/policy/trust.js';

let ws: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-dialog-')));
  fs.mkdirSync(path.join(ws, '.git'));
  env = { HOME: '/home/dev', BELAYD_HOME: path.join(ws, '.bh'), CLAUDE_CODE_SESSION_ATTENDED: '0' };
});
afterEach(() => {
  setDialogForTests(undefined);
  fs.rmSync(ws, { recursive: true, force: true });
});

const policy = (channels: string) => {
  fs.writeFileSync(
    path.join(ws, 'belayd.yaml'),
    `version: 1\napproval: { channels: [${channels}], notify: false }\n`,
  );
  trustFile(env.BELAYD_HOME!, path.join(ws, 'belayd.yaml'));
};
const ask = (answer: DialogAnswer, timeoutSec = 20, extra: NodeJS.ProcessEnv = {}) => {
  setDialogForTests(() => Promise.resolve(answer));
  return handleClaudeCode(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: ws,
      tool_name: 'Bash',
      tool_input: { command: 'sudo ls' },
    }),
    { env: { ...env, ...extra }, timeoutSec },
  );
};
const decision = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.permissionDecision;

describe('the dialog channel', () => {
  it('takes the answer from the dialog, with no request on disk to forge', async () => {
    policy('native, dialog');
    const r = await ask('allow');
    expect(decision(r.stdout)).toBe('allow');
    expect(r.stdout).toMatch(/approved by the user \(dialog\)/);
    expect(fs.existsSync(path.join(env.BELAYD_HOME!, 'approvals', 'pending'))).toBe(false);
  });

  it('a no in the dialog is a no', async () => {
    policy('native, dialog');
    expect(decision((await ask('deny')).stdout)).toBe('deny');
  });

  it('an unanswered dialog is a no when it is the only channel', async () => {
    policy('dialog');
    const r = await ask('timeout');
    expect(decision(r.stdout)).toBe('deny');
    expect(r.stdout).toMatch(/nobody answered/);
  });

  it('works alongside the console when both are enabled', async () => {
    policy('dialog, tty');
    const pending = ask('timeout');
    let req;
    for (let i = 0; i < 100 && !req; i++) {
      await new Promise((r) => setTimeout(r, 30));
      [req] = listPending(env.BELAYD_HOME!);
    }
    decide(env.BELAYD_HOME!, req!.id, 'allow', 'tty');
    expect(decision((await pending).stdout)).toBe('allow');
  });

  it('keeps waiting on the console when the dialog cannot be shown', async () => {
    policy('dialog, tty');
    const pending = ask('unavailable');
    let req;
    for (let i = 0; i < 100 && !req; i++) {
      await new Promise((r) => setTimeout(r, 30));
      [req] = listPending(env.BELAYD_HOME!);
    }
    decide(env.BELAYD_HOME!, req!.id, 'allow', 'tty');
    expect(decision((await pending).stdout)).toBe('allow');
  });
});
