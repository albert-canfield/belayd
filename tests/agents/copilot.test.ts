import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/db.js';
import { claudeDialect } from '../../src/agents/claude-code/hook.js';
import { copilotDialect, toCopilotAction } from '../../src/agents/copilot/hook.js';
import { copilotHooks, copilotSetup } from '../../src/agents/copilot/setup.js';
import { handleToolHook } from '../../src/hook/handle.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-copilot-')));
  fs.mkdirSync(path.join(dir, '.git'));
  env = {
    HOME: path.join(dir, 'home'),
    BELAYD_HOME: path.join(dir, 'belayd-home'),
    COPILOT_HOME: path.join(dir, 'copilot-home'),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const call = (payload: Record<string, unknown>, event: string) =>
  handleToolHook(JSON.stringify(payload), { env, timeoutSec: 30, event }, copilotDialect);

describe('Copilot CLI tool mapping', () => {
  it.each([
    ['bash', { command: 'ls' }, { kind: 'shell', command: 'ls' }],
    ['view', { path: '/a/b.ts' }, { kind: 'read', path: '/a/b.ts' }],
    [
      'create',
      { path: '/a/c.ts', file_text: 'x' },
      { kind: 'write', path: '/a/c.ts', content: 'x' },
    ],
    ['edit', { path: '/a/c.ts', old_str: 'a', new_str: 'b' }, { kind: 'write', path: '/a/c.ts' }],
    ['str_replace_editor', { command: 'view', path: '/a/c.ts' }, { kind: 'read', path: '/a/c.ts' }],
    ['web_fetch', { url: 'https://x.dev' }, { kind: 'fetch', url: 'https://x.dev' }],
  ])('%s', (tool, input, action) => {
    expect(toCopilotAction(tool, input, '/a')).toEqual(action);
  });

  it('treats a patch it cannot read as code it cannot see', () => {
    expect(toCopilotAction('apply_patch', { patch: '???' }, '/a')).toEqual({
      kind: 'shell',
      command: '$UNREADABLE_PATCH',
    });
  });

  it('reads toolArgs sent as JSON text', () => {
    const e = copilotDialect.parse(
      { toolName: 'bash', toolArgs: '{"command":"rm -rf ~"}' },
      'preToolUse',
    );
    expect(e.input).toEqual({ command: 'rm -rf ~' });
  });
});

describe('Copilot CLI hook', () => {
  it('denies in the form Copilot CLI reads', async () => {
    const r = await call(
      { toolName: 'view', toolArgs: { path: `${dir}/.env` }, cwd: dir },
      'preToolUse',
    );
    expect(JSON.parse(r.stdout)).toMatchObject({ permissionDecision: 'deny' });
    expect(r.exitCode).toBe(0);
  });

  it('pairs before and after without a call id, so undo knows each step', async () => {
    const payload = {
      sessionId: 's',
      cwd: dir,
      toolName: 'bash',
      toolArgs: { command: 'npm test' },
    };
    await call(payload, 'preToolUse');
    await call({ ...payload, toolResult: { resultType: 'success' } }, 'postToolUse');
    const db = await AuditLog.open(env.BELAYD_HOME!, { readOnly: true });
    const events = db.events({});
    db.close();
    const [pre, post] = [
      events.find((e) => e.phase === 'pre'),
      events.find((e) => e.phase === 'post'),
    ];
    expect(pre?.toolUseId).toBeTruthy();
    expect(post?.toolUseId).toBe(pre?.toolUseId);
    expect(post?.step).toBe(pre?.step);
  });

  it('leaves the Claude Code hooks Copilot CLI also runs out of it once its own are installed', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      timestamp: new Date().toISOString(),
      cwd: dir,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ~' },
    };
    const before = await handleToolHook(JSON.stringify(payload), { env }, claudeDialect);
    expect(before.exitCode).toBe(2);
    copilotSetup
      .plan({ workspace: dir, global: false, env, nodePath: '/usr/bin/node', binPath: '/x/bin.js' })
      .apply();
    const after = await handleToolHook(JSON.stringify(payload), { env }, claudeDialect);
    expect(after).toMatchObject({ stdout: '', exitCode: 0 });
  });
});

describe('Copilot CLI setup', () => {
  const opts = () => ({
    workspace: dir,
    global: false,
    env,
    nodePath: '/usr/bin/node',
    binPath: '/opt/belayd/dist/bin.js',
  });

  it('installs into the per-person settings file, with the event on the command line', () => {
    const plan = copilotSetup.plan(opts());
    expect(plan.file).toBe(path.join(dir, '.github', 'copilot', 'settings.local.json'));
    plan.apply();
    const hooks = JSON.parse(fs.readFileSync(plan.file, 'utf8')).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['postToolUse', 'postToolUseFailure', 'preToolUse']);
    expect(hooks.preToolUse[0].bash).toMatch(
      /hook copilot --timeout 180 --event preToolUse \|\| \{/,
    );
    expect(hooks.preToolUse[0].timeoutSec).toBe(180);
    expect(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.github/copilot/settings.local.json',
    );
  });

  it('keeps other hooks, is idempotent, and uninstall removes only belayd', () => {
    const file = path.join(dir, '.github', 'copilot', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mine = { type: 'command', bash: './audit.sh', timeoutSec: 5 };
    fs.writeFileSync(file, JSON.stringify({ model: 'x', hooks: { preToolUse: [mine] } }));
    copilotSetup.plan(opts()).apply();
    copilotSetup.plan(opts()).apply();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.preToolUse).toHaveLength(2);
    for (const r of copilotSetup.uninstall(opts())) r.apply();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      model: 'x',
      hooks: { preToolUse: [mine] },
    });
  });

  it('puts user-level hooks in a file of its own, removed on uninstall', () => {
    const global = { ...opts(), global: true };
    const plan = copilotSetup.plan(global);
    expect(plan.file).toBe(path.join(env.COPILOT_HOME!, 'hooks', 'belayd.json'));
    plan.apply();
    expect(JSON.parse(fs.readFileSync(plan.file, 'utf8')).version).toBe(1);
    for (const r of copilotSetup.uninstall(global)) r.apply();
    expect(fs.existsSync(plan.file)).toBe(false);
  });

  it('reports the hook in doctor, and a hook whose files moved as broken', () => {
    const bin = path.join(dir, 'bin.js');
    fs.writeFileSync(bin, '');
    const real = { ...opts(), nodePath: process.execPath, binPath: bin };
    copilotSetup.plan(real).apply();
    expect(copilotSetup.doctor(real).some((l) => /Copilot CLI hook installed/.test(l.text))).toBe(
      true,
    );
    // Copilot CLI lets a timed-out hook through: said plainly, as a note.
    expect(copilotSetup.doctor(real).find((l) => l.status === 'note')?.text).toMatch(
      /lets a tool run when its hook times out/,
    );
    fs.rmSync(bin);
    expect(copilotSetup.doctor(real).some((l) => l.status === 'fail')).toBe(true);
  });

  it('uses the same hook entries for every event it needs', () => {
    const hooks = copilotHooks({ nodePath: '/n', binPath: '/b' });
    expect(hooks.postToolUse.bash).not.toMatch(/\|\|/);
  });
});
