import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClaudeCode, toAction } from '../../src/integrations/claude-code/hook.js';

let workspace: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-cc-'));
  env = {
    HOME: '/home/dev',
    BELAYD_HOME: path.join(workspace, '.belayd-home'),
    CLAUDE_PROJECT_DIR: workspace,
  };
});
afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

const call = (payload: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}) =>
  handleClaudeCode(
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: workspace, ...payload }),
    { env: { ...env, ...extraEnv } },
  );

const decisionOf = (stdout: string) =>
  stdout === '' ? 'pass' : (JSON.parse(stdout).hookSpecificOutput.permissionDecision as string);

describe('Claude Code tool mapping', () => {
  it.each([
    ['Bash', { command: 'ls' }, { kind: 'shell', command: 'ls' }],
    [
      'Write',
      { file_path: '/a/b.ts', content: 'x' },
      { kind: 'write', path: '/a/b.ts', content: 'x' },
    ],
    [
      'Edit',
      { file_path: '/a/b.ts', old_string: 'a', new_string: 'b' },
      { kind: 'write', path: '/a/b.ts' },
    ],
    ['NotebookEdit', { notebook_path: '/a/n.ipynb' }, { kind: 'write', path: '/a/n.ipynb' }],
    ['Read', { file_path: '/a/.env' }, { kind: 'read', path: '/a/.env' }],
    ['Grep', { pattern: 'x', path: '/a/src' }, { kind: 'read', path: '/a/src' }],
    ['Glob', { pattern: '**/*.ts' }, { kind: 'read', path: '/cwd' }],
    ['WebFetch', { url: 'https://x.dev', prompt: 'p' }, { kind: 'fetch', url: 'https://x.dev' }],
    ['Shell', { command: 'ls' }, { kind: 'shell', command: 'ls' }],
  ])('%s', (tool, input, expected) => {
    expect(toAction(tool, input, '/cwd')).toEqual(expected);
  });

  it('maps MCP tools from Claude Code and Cursor', () => {
    expect(toAction('mcp__github__create_issue', { title: 't' }, '/cwd')).toEqual({
      kind: 'mcp',
      server: 'github',
      tool: 'create_issue',
      args: { title: 't' },
    });
    expect(toAction('MCP:create_issue', {}, '/cwd')).toMatchObject({
      kind: 'mcp',
      tool: 'create_issue',
    });
  });

  it('keeps unknown tools as generic tools', () => {
    expect(toAction('TodoWrite', { todos: [] }, '/cwd')).toEqual({
      kind: 'tool',
      name: 'TodoWrite',
      input: { todos: [] },
    });
  });
});

describe('Claude Code hook output', () => {
  it('denies with a reason the agent can act on', async () => {
    const r = await call({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/belayd blocked this/);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/no-delete-system-or-home/);
  });

  it('asks through the native Claude Code prompt', async () => {
    const r = await call({
      tool_name: 'Bash',
      tool_input: { command: 'git push --force-with-lease' },
    });
    expect(decisionOf(r.stdout)).toBe('ask');
  });

  it('says nothing when no rule applies, so Claude Code decides as usual', async () => {
    const r = await call({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(r).toEqual({ stdout: '', exitCode: 0 });
  });

  it('allows only what a rule explicitly allows', async () => {
    fs.writeFileSync(
      path.join(workspace, 'belayd.yaml'),
      'version: 1\nrules:\n  - id: ok-tests\n    match: { command: npm test }\n    decision: allow\n',
    );
    const r = await call({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(decisionOf(r.stdout)).toBe('allow');
  });

  it('blocks reads of secret files from the Read tool', async () => {
    const r = await call({
      tool_name: 'Read',
      tool_input: { file_path: path.join(workspace, '.env') },
    });
    expect(decisionOf(r.stdout)).toBe('deny');
  });

  it('ignores events other than PreToolUse', async () => {
    const r = await handleClaudeCode(JSON.stringify({ hook_event_name: 'PostToolUse' }), { env });
    expect(r).toEqual({ stdout: '', exitCode: 0 });
  });

  it('fails closed on input it cannot read', async () => {
    const r = await handleClaudeCode('not json', { env });
    expect(decisionOf(r.stdout)).toBe('deny');
  });

  it('fails closed on a broken policy file', async () => {
    fs.writeFileSync(path.join(workspace, 'belayd.yaml'), 'version: 1\nrules: [\n');
    const r = await call({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(decisionOf(r.stdout)).toBe('deny');
    expect(r.stdout).toMatch(/belayd doctor/);
  });

  it('turns ask into deny inside Cursor, which does not enforce ask from this hook', async () => {
    const r = await call({
      tool_name: 'Shell',
      tool_input: { command: 'sudo ls' },
      cursor_version: '2.5.0',
    });
    expect(decisionOf(r.stdout)).toBe('deny');
    expect(r.stdout).toMatch(/Cursor cannot ask/);
  });
});
