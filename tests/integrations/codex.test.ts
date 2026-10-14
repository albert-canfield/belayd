import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, listPending } from '../../src/approval/store.js';
import { handleCodex, toCodexAction } from '../../src/integrations/codex/hook.js';
import { parseApplyPatch } from '../../src/integrations/codex/patch.js';

const PATCH = `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Update File: src/old-name.ts
*** Move to: src/new-name.ts
*** Add File: docs/notes.md
+# Notes
*** Delete File: tmp/scratch.txt
*** End Patch`;

describe('apply_patch parsing', () => {
  it('finds every file and what happens to it', () => {
    expect(parseApplyPatch(PATCH)).toEqual([
      { path: 'src/app.ts', op: 'update' },
      { path: 'src/old-name.ts', op: 'update', to: 'src/new-name.ts' },
      { path: 'docs/notes.md', op: 'add' },
      { path: 'tmp/scratch.txt', op: 'delete' },
    ]);
  });

  it('works when the patch is wrapped in a heredoc', () => {
    expect(parseApplyPatch(`apply_patch <<'EOF'\n${PATCH}\nEOF`)).toHaveLength(4);
  });
});

describe('Codex tool mapping', () => {
  it('maps Bash, including argv arrays', () => {
    expect(toCodexAction('Bash', { command: 'ls -la' })).toEqual({
      kind: 'shell',
      command: 'ls -la',
    });
    expect(toCodexAction('Bash', { command: ['bash', '-lc', 'rm -rf ~'] })).toEqual({
      kind: 'shell',
      command: "bash -lc 'rm -rf ~'",
    });
  });

  it('maps apply_patch to a multi-file write', () => {
    const a = toCodexAction('apply_patch', { command: PATCH });
    expect(a.kind).toBe('patch');
  });

  it('maps MCP tools', () => {
    expect(toCodexAction('mcp__fs__write_file', { path: '/x' })).toEqual({
      kind: 'mcp',
      server: 'fs',
      tool: 'write_file',
      args: { path: '/x' },
    });
  });
});

describe('Codex hook output', () => {
  let workspace: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-codex-')));
    fs.mkdirSync(path.join(workspace, '.git'));
    fs.writeFileSync(
      path.join(workspace, 'belayd.yaml'),
      'version: 1\napproval: { channels: [tty], notify: false }\n',
    );
    env = { HOME: '/home/dev', BELAYD_HOME: path.join(workspace, '.belayd-home') };
  });
  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const call = (tool: string, input: unknown, timeoutSec?: number) =>
    handleCodex(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'c1',
        cwd: workspace,
        turn_id: 't',
        tool_name: tool,
        tool_use_id: 'u1',
        tool_input: input,
      }),
      { env, ...(timeoutSec ? { timeoutSec } : {}) },
    );

  it('denies with the Codex PreToolUse shape', async () => {
    const r = await call('Bash', { command: 'rm -rf ~' });
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
  });

  it('never answers ask: holds the call and passes an approval on as a system message', async () => {
    const pending = call('Bash', { command: 'sudo ls' });
    let req;
    for (let i = 0; i < 100 && !req; i++) {
      await new Promise((r) => setTimeout(r, 30));
      [req] = listPending(env.BELAYD_HOME!);
    }
    expect(req?.agent).toBe('codex');
    decide(env.BELAYD_HOME!, req!.id, 'allow', 'test');
    const r = await pending;
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.systemMessage).toMatch(/approved by the user/);
  });

  it('denies when nobody answers in time', async () => {
    const r = await call('Bash', { command: 'sudo ls' }, 6);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('judges each file in a patch', async () => {
    const r = await call(
      'apply_patch',
      { command: '*** Begin Patch\n*** Add File: .env\n+X=1\n*** End Patch' },
      6,
    );
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const ok = await call('apply_patch', {
      command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch',
    });
    expect(ok.stdout).toBe('');
  });
});
