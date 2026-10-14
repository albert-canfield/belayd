import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import { tilde } from '../agents/common.js';
import { AGENTS, findAgent, hookAgents, type AgentEntry } from '../agents/registry.js';
import type { InstallPlan, SetupOptions } from '../agents/types.js';
import { listPresets, POLICY_FILE } from '../policy/load.js';
import { isTrusted, trustFile } from '../policy/trust.js';
import { tooBroad } from '../snapshots/capture.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

export interface InitOptions {
  preset?: string;
  global?: boolean;
  claudeConfigDir?: string;
  /** Comma-separated agent names. Default: every agent belayd finds on this machine. */
  agent?: string;
  yes?: boolean;
  /** For tests: skip running `claude --version`. */
  claudeVersion?: string;
}

interface Plan {
  agent: AgentEntry;
  plan: InstallPlan;
}

export async function init(opts: InitOptions, cwd = process.cwd()): Promise<number> {
  const preset = opts.preset ?? 'balanced';
  if (!listPresets().includes(preset)) {
    console.error(`Unknown preset "${preset}". Pick one of: ${listPresets().join(', ')}`);
    return 64;
  }
  const agents = pickAgents(opts.agent);
  if (typeof agents === 'string') {
    console.error(agents);
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
  const setupOptions = toSetupOptions(opts, workspace, binPath);
  const plans: Plan[] = [];
  for (const agent of agents)
    plans.push({ agent, plan: (await agent.setup!()).plan(setupOptions) });
  const policyFile = opts.global
    ? path.join(belaydHome(), POLICY_FILE)
    : path.join(workspace, POLICY_FILE);
  // lstat, not exists: a dangling symlink in its place is not a free spot to write to.
  const writePolicy = !lstatOrUndefined(policyFile);

  console.log(pc.bold('belayd will:'));
  let n = 1;
  for (const p of plans) {
    console.log(
      `  ${n++}. Add ${p.agent.name} hooks to ${pc.cyan(tilde(p.plan.file))}` +
        (p.plan.scope === 'project'
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
    console.log(pc.dim(`  ${p.agent.name} hook that checks each tool call:`));
    for (const line of JSON.stringify(p.plan.shown, null, 2).split('\n'))
      console.log(pc.dim(`    ${line}`));
    for (const w of p.plan.warnings) console.log(pc.yellow(`  ${w}`));
  }
  console.log('');
  for (const note of otherAgents(agents, process.env)) console.log(pc.dim(`  ${note}`));

  if (!(await confirm(opts.yes, 'Go ahead?'))) {
    console.log('Nothing changed.');
    return 1;
  }

  const backups: string[] = [];
  for (const p of plans) {
    const backup = p.plan.apply();
    if (backup) backups.push(backup);
  }
  if (writePolicy) {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    const text = policyTemplate(preset);
    // `wx` never follows a symlink planted where the file should go.
    fs.writeFileSync(policyFile, text, { flag: 'wx' });
    // You just created it, so it is yours to trust.
    if (!opts.global) trustFile(belaydHome(), policyFile, text);
  } else if (!opts.global && !isTrusted(belaydHome(), policyFile)) {
    console.log(
      pc.yellow(
        `  This project already has a belayd.yaml you have not reviewed. Until you run belayd trust, only its stricter rules apply.`,
      ),
    );
  }

  console.log('');
  console.log(pc.green(`✔ belayd is on for ${listNames(plans.map((p) => p.agent.name))}.`));
  for (const b of backups) console.log(pc.dim(`  Previous settings saved to ${tilde(b)}`));
  console.log('');
  console.log('  Try it:      belayd check "rm -rf ~"');
  console.log('  Health:      belayd doctor');
  console.log('  Turn it off: belayd uninstall' + (opts.global ? ' --global' : ''));
  console.log('');
  for (const p of plans) console.log(pc.dim(`  ${p.plan.after}`));
  return 0;
}

function toSetupOptions(opts: InitOptions, workspace: string, binPath: string): SetupOptions {
  return {
    workspace,
    global: opts.global === true,
    env: process.env,
    nodePath: process.execPath,
    binPath,
    ...(opts.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
    ...(opts.claudeVersion ? { claudeVersion: opts.claudeVersion } : {}),
  };
}

function listNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export async function uninstall(opts: InitOptions, cwd = process.cwd()): Promise<number> {
  const workspace = findWorkspace(cwd);
  const agents = opts.agent ? pickAgents(opts.agent) : hookAgents();
  if (typeof agents === 'string') {
    console.error(agents);
    return 64;
  }
  const setupOptions = toSetupOptions(opts, workspace, installedBinPath());
  const changes = [];
  for (const agent of agents) changes.push(...(await agent.setup!()).uninstall(setupOptions));
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
    const backup = c.apply();
    console.log(pc.green(`✔ Removed the belayd hooks from ${tilde(c.file)}.`));
    if (backup) console.log(pc.dim(`  Previous settings saved to ${tilde(backup)}`));
  }
  console.log(pc.dim('  Your belayd.yaml, audit log and snapshots were left in place.'));
  return 0;
}

/**
 * The agents to set up: the ones named, or every agent found on this machine. A host
 * such as Cursor stands for the agent whose hooks it runs. Returns an error message for
 * a name belayd does not know or cannot set up yet.
 */
function pickAgents(arg: string | undefined): AgentEntry[] | string {
  if (!arg) {
    const found = hookAgents().filter((a) => a.detect(process.env));
    return found.length > 0 ? found : [findAgent('claude-code')!];
  }
  const picked: AgentEntry[] = [];
  for (const name of arg.split(',')) {
    const agent = findAgent(name);
    const target = agent?.runsHooksOf ? findAgent(agent.runsHooksOf) : agent;
    if (!agent || !target?.setup)
      return agent
        ? `belayd cannot set up ${agent.name} yet. Supported: ${supportedList()}`
        : `Unknown agent "${name.trim()}". Supported: ${supportedList()}`;
    if (!picked.includes(target)) picked.push(target);
  }
  return picked;
}

function supportedList(): string {
  return AGENTS.filter((a) => a.support !== 'planned')
    .map((a) => a.id)
    .join(', ');
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

/** What `init` says about the other agents on this machine. */
function otherAgents(chosen: AgentEntry[], env: NodeJS.ProcessEnv): string[] {
  const notes: string[] = [];
  for (const agent of AGENTS) {
    if (chosen.includes(agent) || !agent.detect(env)) continue;
    if (agent.support === 'hooks') {
      const all = [...chosen.map((a) => a.id), agent.id].join(',');
      notes.push(`${agent.name} found. Add it with --agent ${all}`);
    } else if (agent.support === 'host') {
      const via = findAgent(agent.runsHooksOf!)!;
      notes.push(
        chosen.includes(via)
          ? `${agent.name} found. It runs the ${via.name} hooks, so it is covered too.`
          : `${agent.name} found. It runs ${via.name}'s hooks: add --agent ${via.id} to cover it.`,
      );
    } else notes.push(`${agent.name} found. belayd does not set it up yet.`);
  }
  return notes;
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

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}
