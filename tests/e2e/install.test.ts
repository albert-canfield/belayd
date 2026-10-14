import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, bin, hookPayload, root, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => (sb = sandbox()));
afterEach(() => sb.cleanup());

const NEW = { BELAYD_CLAUDE_VERSION: '2.1.300' };
const OLD = { BELAYD_CLAUDE_VERSION: '2.1.100' };
const projectSettings = () => path.join(sb.project, '.claude', 'settings.local.json');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const handlers = (file: string) =>
  (read(file).hooks?.PreToolUse ?? []).flatMap((g: { hooks: unknown[] }) => g.hooks);

describe('belayd init and uninstall for Claude Code', () => {
  it('installs an exec-form hook that blocks on failure, pinned to this build', () => {
    const r = belayd(sb, ['init', '--yes'], { env: NEW });
    expect(r.status, r.stderr).toBe(0);
    const [h] = handlers(projectSettings());
    expect(h).toEqual({
      type: 'command',
      command: process.execPath,
      args: [fs.realpathSync(bin), 'hook', 'claude-code', '--timeout', '180'],
      timeout: 180,
      onFailure: 'block',
    });
    const all = read(projectSettings()).hooks;
    expect(Object.keys(all).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
    expect(all.PostToolUse[0].hooks[0].onFailure).toBeUndefined();
    expect(fs.existsSync(path.join(sb.project, 'belayd.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(sb.project, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.claude/settings.local.json',
    );
  });

  it('the installed hook really blocks when Claude Code runs it', () => {
    belayd(sb, ['init', '--yes'], { env: NEW });
    const [h] = handlers(projectSettings());
    const r = spawnSync(h.command, h.args, {
      input: hookPayload(sb, 'Bash', { command: 'rm -rf ~' }),
      env: sb.env,
      encoding: 'utf8',
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('falls back to a shell guard on older Claude Code', () => {
    belayd(sb, ['init', '--yes'], { env: OLD });
    const [h] = handlers(projectSettings());
    expect(h.args).toBeUndefined();
    expect(h.onFailure).toBeUndefined();
    expect(h.command).toMatch(/hook claude-code --timeout 180 \|\| \{ .* exit 2; \}$/);
    // The guard turns a crash into exit 2. Simulate a crash with a missing script.
    const broken = h.command.replace(fs.realpathSync(bin).replace(/'/g, ''), '/nonexistent/bin.js');
    const r = spawnSync('sh', ['-c', broken], { input: '{}', env: sb.env, encoding: 'utf8' });
    expect(r.status).toBe(2);
  });

  it('is idempotent and keeps other settings and hooks', () => {
    fs.mkdirSync(path.dirname(projectSettings()), { recursive: true });
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(
      projectSettings(),
      JSON.stringify({
        model: 'opus',
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] },
      }),
    );
    belayd(sb, ['init', '--yes'], { env: NEW });
    belayd(sb, ['init', '--yes'], { env: NEW });
    const settings = read(projectSettings());
    expect(settings.model).toBe('opus');
    const all = handlers(projectSettings());
    expect(all).toContainEqual(mine);
    expect(all.filter((h: { args?: string[] }) => h.args?.[2] === 'claude-code')).toHaveLength(1);
    const backups = fs
      .readdirSync(path.dirname(projectSettings()))
      .filter((f) => f.includes('belayd-backup'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('uninstall removes only belayd', () => {
    fs.mkdirSync(path.dirname(projectSettings()), { recursive: true });
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(
      projectSettings(),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } }),
    );
    belayd(sb, ['init', '--yes'], { env: NEW });
    const r = belayd(sb, ['uninstall', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(handlers(projectSettings())).toEqual([mine]);
  });

  it('--global writes to the Claude config dir and $BELAYD_HOME, never the project', () => {
    const r = belayd(sb, ['init', '--global', '--yes'], { env: NEW });
    expect(r.status, r.stderr).toBe(0);
    expect(handlers(path.join(sb.env.CLAUDE_CONFIG_DIR!, 'settings.json'))).toHaveLength(1);
    expect(fs.existsSync(path.join(sb.env.BELAYD_HOME!, 'belayd.yaml'))).toBe(true);
    expect(fs.existsSync(projectSettings())).toBe(false);
  });

  it('refuses to touch an invalid settings file', () => {
    fs.mkdirSync(path.dirname(projectSettings()), { recursive: true });
    fs.writeFileSync(projectSettings(), '{ not json');
    const r = belayd(sb, ['init', '--yes'], { env: NEW });
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(projectSettings(), 'utf8')).toBe('{ not json');
  });

  it('refuses to pin a hook into a temporary npx folder', () => {
    const fake = path.join(sb.dir, '_npx', 'abc', 'node_modules', 'belayd');
    fs.mkdirSync(fake, { recursive: true });
    fs.cpSync(path.join(root, 'dist'), path.join(fake, 'dist'), { recursive: true });
    fs.cpSync(path.join(root, 'presets'), path.join(fake, 'presets'), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fake, 'package.json'));
    const r = spawnSync(process.execPath, [path.join(fake, 'dist', 'bin.js'), 'init', '--yes'], {
      cwd: sb.project,
      env: { ...sb.env, ...NEW },
      encoding: 'utf8',
    });
    expect(r.status).toBe(69);
    expect(r.stderr).toMatch(/npm install -g belayd/);
    expect(fs.existsSync(projectSettings())).toBe(false);
  });

  it('doctor reports a healthy install', () => {
    belayd(sb, ['init', '--yes'], { env: NEW });
    const r = belayd(sb, ['doctor'], { env: NEW });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Claude Code hook blocks "rm -rf ~"/);
  });

  it('refuses to treat the home folder as a project', () => {
    const r = belayd(sb, ['init', '--yes'], { cwd: sb.env.HOME!, env: NEW });
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/belayd init --global/);
    expect(fs.existsSync(path.join(sb.env.HOME!, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('does not write through a belayd.yaml symlink that points nowhere', () => {
    const target = path.join(sb.dir, 'elsewhere.yaml');
    fs.symlinkSync(target, path.join(sb.project, 'belayd.yaml'));
    const r = belayd(sb, ['init', '--yes'], { env: NEW });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(r.stdout).toMatch(/not reviewed/);
  });
});
