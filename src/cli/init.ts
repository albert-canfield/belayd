import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import {
  claudeTarget,
  detectClaudeVersion,
  excludeFromGit,
  hookHandler,
  ON_FAILURE_MIN_VERSION,
  readSettings,
  supportsOnFailure,
  withBelaydHook,
  writeSettings,
} from '../integrations/claude-code/install.js';
import { listPresets, POLICY_FILE } from '../policy/load.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

export interface InitOptions {
  preset?: string;
  global?: boolean;
  claudeConfigDir?: string;
  yes?: boolean;
  /** For tests: skip running `claude --version`. */
  claudeVersion?: string;
}

export async function init(opts: InitOptions, cwd = process.cwd()): Promise<number> {
  const preset = opts.preset ?? 'balanced';
  if (!listPresets().includes(preset)) {
    console.error(`Unknown preset "${preset}". Pick one of: ${listPresets().join(', ')}`);
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
  const target = claudeTarget({
    ...(opts.global ? { global: true } : {}),
    ...(opts.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
    workspace,
    env: process.env,
  });
  const claudeVersion = opts.claudeVersion ?? detectClaudeVersion();
  const handler = hookHandler({ nodePath: process.execPath, binPath, claudeVersion });
  const policyFile = opts.global
    ? path.join(belaydHome(), POLICY_FILE)
    : path.join(workspace, POLICY_FILE);
  const writePolicy = !fs.existsSync(policyFile);

  console.log(pc.bold('belayd will:'));
  console.log(
    `  1. Add a PreToolUse hook for Claude Code to ${pc.cyan(tilde(target.settingsFile))}` +
      (target.scope === 'project'
        ? pc.dim(' (this project only, not committed)')
        : pc.dim(' (every project)')),
  );
  console.log(
    writePolicy
      ? `  2. Create ${pc.cyan(tilde(policyFile))} using the ${pc.bold(preset)} preset`
      : `  2. Keep your existing ${pc.cyan(tilde(policyFile))}`,
  );
  console.log('');
  console.log(pc.dim('  The hook:'));
  for (const line of JSON.stringify(handler, null, 2).split('\n'))
    console.log(pc.dim(`    ${line}`));
  console.log('');

  if (!supportsOnFailure(claudeVersion)) {
    console.log(
      pc.yellow(
        claudeVersion
          ? `  Claude Code ${claudeVersion} is older than ${ON_FAILURE_MIN_VERSION}.`
          : '  Could not find the `claude` command to check its version.',
      ),
    );
    console.log(
      pc.yellow(
        `  Using a shell guard that blocks when belayd crashes. Update Claude Code to ${ON_FAILURE_MIN_VERSION}+ and run init again to also block on hook timeouts.`,
      ),
    );
    console.log('');
  }

  for (const other of otherAgents())
    console.log(pc.dim(`  ${other} found. Support is coming; it is not set up yet.`));

  if (!(await confirm(opts.yes, 'Go ahead?'))) {
    console.log('Nothing changed.');
    return 1;
  }

  const settings = readSettings(target.settingsFile);
  const backup = writeSettings(target.settingsFile, withBelaydHook(settings, handler));
  if (target.scope === 'project') excludeFromGit(workspace, target.settingsFile);
  if (writePolicy) {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, policyTemplate(preset));
  }

  console.log('');
  console.log(pc.green('✔ belayd is on.'));
  if (backup) console.log(pc.dim(`  Previous settings saved to ${tilde(backup)}`));
  console.log('');
  console.log('  Try it:      belayd check "rm -rf ~"');
  console.log('  Health:      belayd doctor');
  console.log('  Turn it off: belayd uninstall' + (opts.global ? ' --global' : ''));
  console.log('');
  console.log(pc.dim('  Restart Claude Code (or open /hooks) so it picks up the new hook.'));
  return 0;
}

export async function uninstall(opts: InitOptions, cwd = process.cwd()): Promise<number> {
  const workspace = findWorkspace(cwd);
  const target = claudeTarget({
    ...(opts.global ? { global: true } : {}),
    ...(opts.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
    workspace,
    env: process.env,
  });
  if (!fs.existsSync(target.settingsFile)) {
    console.log(`Nothing to remove: ${tilde(target.settingsFile)} does not exist.`);
    return 0;
  }
  const settings = readSettings(target.settingsFile);
  const next = withBelaydHook(settings, undefined);
  if (JSON.stringify(next) === JSON.stringify(settings)) {
    console.log(`No belayd hook in ${tilde(target.settingsFile)}.`);
    return 0;
  }
  if (!(await confirm(opts.yes, `Remove the belayd hook from ${tilde(target.settingsFile)}?`))) {
    console.log('Nothing changed.');
    return 1;
  }
  const backup = writeSettings(target.settingsFile, next);
  console.log(pc.green(`✔ Removed the belayd hook from ${tilde(target.settingsFile)}.`));
  if (backup) console.log(pc.dim(`  Previous settings saved to ${tilde(backup)}`));
  console.log(pc.dim('  Your belayd.yaml was left in place.'));
  return 0;
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

function otherAgents(): string[] {
  const home = os.homedir();
  const found: string[] = [];
  if (fs.existsSync(path.join(home, '.codex'))) found.push('Codex');
  if (fs.existsSync(path.join(home, '.cursor'))) found.push('Cursor');
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
