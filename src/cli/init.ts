import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import {
  belaydHooks,
  claudeTarget,
  detectClaudeVersion,
  excludeFromGit,
  ON_FAILURE_MIN_VERSION,
  readSettings,
  supportsOnFailure,
  withBelaydHook,
  writeSettings,
  type BelaydHooks,
} from '../integrations/claude-code/install.js';
import { codexDetected, codexHooks, codexTarget } from '../integrations/codex/install.js';
import { listPresets, POLICY_FILE } from '../policy/load.js';
import { tooBroad } from '../snapshots/capture.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

export interface InitOptions {
  preset?: string;
  global?: boolean;
  claudeConfigDir?: string;
  /** Comma-separated: claude-code, codex. Default: Claude Code plus any other agent found. */
  agent?: string;
  yes?: boolean;
  /** For tests: skip running `claude --version`. */
  claudeVersion?: string;
}

type AgentName = 'claude-code' | 'codex';
const AGENTS: AgentName[] = ['claude-code', 'codex'];
const NAMES: Record<AgentName, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

interface Plan {
  agent: AgentName;
  file: string;
  scope: 'project' | 'global';
  hooks: BelaydHooks | Record<string, unknown>;
  shown: unknown;
  warnings: string[];
  after: string;
}

export async function init(opts: InitOptions, cwd = process.cwd()): Promise<number> {
  const preset = opts.preset ?? 'balanced';
  if (!listPresets().includes(preset)) {
    console.error(`Unknown preset "${preset}". Pick one of: ${listPresets().join(', ')}`);
    return 64;
  }
  const agents = pickAgents(opts.agent);
  if (!agents) {
    console.error(`Unknown agent in "${opts.agent}". Supported: ${AGENTS.join(', ')}`);
    return 64;
  }

  const binPath = installedBinPath();
  if (/[\\/]_npx[\\/]/.test(binPath)) {
    console.error(
      [
        'belayd is running from a temporary npx folder, which npm can delete at any time.',
        'A hook pointing there would break later, so install belayd first:',
        '',
        '  npm install -g belayd',
        '  belayd init',
      ].join('\n'),
    );
    return 69;
  }

  const workspace = findWorkspace(cwd);
  if (!opts.global && tooBroad(workspace, os.homedir())) {
    console.error(
      [
        `${workspace} is not a project folder (it is your home folder or above it).`,
        'Run belayd init inside a project, or set belayd up for every project with:',
        '',
        '  belayd init --global',
      ].join('\n'),
    );
    return 64;
  }
  const plans = agents.map((a) => plan(a, opts, workspace, binPath));
  const policyFile = opts.global
    ? path.join(belaydHome(), POLICY_FILE)
    : path.join(workspace, POLICY_FILE);
  const writePolicy = !fs.existsSync(policyFile);

  console.log(pc.bold('belayd will:'));
  let n = 1;
  for (const p of plans) {
    console.log(
      `  ${n++}. Add ${NAMES[p.agent]} hooks (PreToolUse, PostToolUse) to ${pc.cyan(tilde(p.file))}` +
        (p.scope === 'project'
          ? pc.dim(' (this project only, not committed)')
          : pc.dim(' (every project)')),
    );
  }
  console.log(
    writePolicy
      ? `  ${n}. Create ${pc.cyan(tilde(policyFile))} using the ${pc.bold(preset)} preset`
      : `  ${n}. Keep your existing ${pc.cyan(tilde(policyFile))}`,
  );
  for (const p of plans) {
    console.log('');
    console.log(pc.dim(`  ${NAMES[p.agent]} PreToolUse hook:`));
    for (const line of JSON.stringify(p.shown, null, 2).split('\n'))
      console.log(pc.dim(`    ${line}`));
    for (const w of p.warnings) console.log(pc.yellow(`  ${w}`));
  }
  console.log('');
  for (const other of otherAgents(agents))
    console.log(pc.dim(`  ${other} found. belayd does not set it up yet.`));

  if (!(await confirm(opts.yes, 'Go ahead?'))) {
    console.log('Nothing changed.');
    return 1;
  }

  const backups: string[] = [];
  for (const p of plans) {
    const backup = writeSettings(
      p.file,
      withBelaydHook(readSettings(p.file), p.hooks as BelaydHooks),
    );
    if (backup) backups.push(backup);
    if (p.scope === 'project') excludeFromGit(workspace, p.file);
  }
  if (writePolicy) {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, policyTemplate(preset));
  }

  console.log('');
  console.log(pc.green(`✔ belayd is on for ${plans.map((p) => NAMES[p.agent]).join(' and ')}.`));
  for (const b of backups) console.log(pc.dim(`  Previous settings saved to ${tilde(b)}`));
  console.log('');
  console.log('  Try it:      belayd check "rm -rf ~"');
  console.log('  Health:      belayd doctor');
  console.log('  Turn it off: belayd uninstall' + (opts.global ? ' --global' : ''));
  console.log('');
  for (const p of plans) console.log(pc.dim(`  ${p.after}`));
  return 0;
}

function plan(agent: AgentName, opts: InitOptions, workspace: string, binPath: string): Plan {
  if (agent === 'claude-code') {
    const target = claudeTarget({
      ...(opts.global ? { global: true } : {}),
      ...(opts.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
      workspace,
      env: process.env,
    });
    const claudeVersion = opts.claudeVersion ?? detectClaudeVersion();
    const hooks = belaydHooks({ nodePath: process.execPath, binPath, claudeVersion });
    const warnings: string[] = [];
    if (!supportsOnFailure(claudeVersion)) {
      warnings.push(
        claudeVersion
          ? `Claude Code ${claudeVersion} is older than ${ON_FAILURE_MIN_VERSION}.`
          : 'Could not find Claude Code to check its version.',
        `Using a shell guard that blocks when belayd crashes. Update Claude Code to ${ON_FAILURE_MIN_VERSION}+ and run init again to also block on hook timeouts.`,
      );
    }
    return {
      agent,
      file: target.settingsFile,
      scope: target.scope,
      hooks,
      shown: hooks.PreToolUse,
      warnings,
      after: 'Claude Code: restart it (or open /hooks) so it picks up the new hooks.',
    };
  }
  const target = codexTarget({
    ...(opts.global ? { global: true } : {}),
    workspace,
    env: process.env,
  });
  const hooks = codexHooks({ nodePath: process.execPath, binPath });
  return {
    agent,
    file: target.hooksFile,
    scope: target.scope,
    hooks,
    shown: hooks.PreToolUse,
    warnings:
      target.scope === 'project'
        ? ['Codex only loads project hooks when you trust the project in Codex.']
        : [],
    after:
      'Codex: open it and run /hooks once to review and trust the belayd hooks. Codex skips hooks until you do.',
  };
}

export async function uninstall(opts: InitOptions, cwd = process.cwd()): Promise<number> {
  const workspace = findWorkspace(cwd);
  const agents = opts.agent ? pickAgents(opts.agent) : AGENTS;
  if (!agents) {
    console.error(`Unknown agent in "${opts.agent}". Supported: ${AGENTS.join(', ')}`);
    return 64;
  }
  const files = agents.map((a) =>
    a === 'claude-code'
      ? claudeTarget({
          ...(opts.global ? { global: true } : {}),
          ...(opts.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
          workspace,
          env: process.env,
        }).settingsFile
      : codexTarget({ ...(opts.global ? { global: true } : {}), workspace, env: process.env })
          .hooksFile,
  );
  const changes = files
    .filter((f) => fs.existsSync(f))
    .map((f) => {
      const settings = readSettings(f);
      const next = withBelaydHook(settings, undefined);
      return { file: f, next, changed: JSON.stringify(next) !== JSON.stringify(settings) };
    })
    .filter((c) => c.changed);
  if (changes.length === 0) {
    console.log('No belayd hooks found, nothing to remove.');
    return 0;
  }
  const list = changes.map((c) => tilde(c.file)).join(', ');
  if (!(await confirm(opts.yes, `Remove the belayd hooks from ${list}?`))) {
    console.log('Nothing changed.');
    return 1;
  }
  for (const c of changes) {
    const backup = writeSettings(c.file, c.next);
    console.log(pc.green(`✔ Removed the belayd hooks from ${tilde(c.file)}.`));
    if (backup) console.log(pc.dim(`  Previous settings saved to ${tilde(backup)}`));
  }
  console.log(pc.dim('  Your belayd.yaml, audit log and snapshots were left in place.'));
  return 0;
}

function pickAgents(arg: string | undefined): AgentName[] | undefined {
  if (!arg) return codexDetected() ? ['claude-code', 'codex'] : ['claude-code'];
  const names = arg.split(',').map((s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^claude$/, 'claude-code'),
  );
  if (!names.every((n): n is AgentName => (AGENTS as string[]).includes(n))) return undefined;
  return [...new Set(names)];
}

export function policyTemplate(preset: string): string {
  return `# belayd policy for this project.
# Presets: balanced (default), strict, yolo-with-undo. Read them with \`belayd presets\`.
# Check a command against this file without running it: belayd check "git push --force"

version: 1
extends: ${preset}

rules: []
# Your rules win over the preset. A few examples:
#
#  - id: allow-clean-build
#    match: { command: rm, writes: '{workspace}/dist/**' }
#    decision: allow
#
#  - id: no-production-database
#    match: { command: psql, args: { any: ['*prod*'] } }
#    decision: deny
#    reason: Production database access is not allowed from agents.
#
#  - id: ask-before-deploys
#    match: { command: [fly deploy, vercel] }
#    decision: ask
`;
}

function installedBinPath(): string {
  const script = process.argv[1] ?? '';
  try {
    return fs.realpathSync(script);
  } catch {
    return path.resolve(script);
  }
}

function otherAgents(chosen: AgentName[]): string[] {
  const home = os.homedir();
  const found: string[] = [];
  if (!chosen.includes('codex') && codexDetected())
    found.push('Codex (add it with --agent claude-code,codex)');
  if (fs.existsSync(path.join(home, '.cursor')))
    found.push('Cursor (it runs the Claude Code hooks)');
  if (fs.existsSync(path.join(home, '.gemini'))) found.push('Gemini CLI');
  return found;
}

async function confirm(yes: boolean | undefined, question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error('Not running in a terminal. Run again with --yes to confirm.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
