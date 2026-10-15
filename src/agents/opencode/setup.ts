import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excludeFromGit, tilde } from '../common.js';
import type { AgentSetup, DoctorLine, SetupOptions } from '../types.js';
import { OPENCODE_MARK } from './hook.js';

/** belayd answers before this, so a slow approval ends in belayd's no. OpenCode has no limit. */
export const OPENCODE_HOOK_TIMEOUT_SECONDS = 180;
const POST_TIMEOUT_SECONDS = 30;
const PLUGIN_FILE = 'belayd.js';

/** OpenCode's global config folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(path.resolve(base), 'opencode');
}

export function opencodeTarget(opts: {
  global?: boolean;
  workspace: string;
  env: NodeJS.ProcessEnv;
}) {
  return opts.global
    ? {
        scope: 'global' as const,
        file: path.join(opencodeConfigDir(opts.env), 'plugins', PLUGIN_FILE),
      }
    : {
        scope: 'project' as const,
        file: path.join(opts.workspace, '.opencode', 'plugins', PLUGIN_FILE),
      };
}

/**
 * The plugin OpenCode loads. It sends every tool call to `belayd hook opencode` and
 * blocks the call when belayd says no or cannot answer. OpenCode skips a plugin that
 * fails to load (that would leave belayd off without a word), so it only uses what
 * any OpenCode runtime has: node:child_process and JSON.
 */
export function pluginSource(opts: { nodePath: string; binPath: string }): string {
  return `// ${OPENCODE_MARK}: checks every OpenCode tool call with belayd before it runs.
// Installed by \`belayd init\`, removed by \`belayd uninstall\`. belayd rewrites this file.
import { spawn } from 'node:child_process';

const NODE = ${JSON.stringify(opts.nodePath)};
const BIN = ${JSON.stringify(opts.binPath)};
const MARK = ${JSON.stringify(OPENCODE_MARK)};
const BROKEN =
  'belayd is not working, so this tool call was blocked. Ask the user to run \`belayd doctor\`.';

function belayd(payload, seconds) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(NODE, [BIN, 'hook', 'opencode', '--timeout', String(seconds)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), (seconds + 15) * 1000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export const Belayd = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    const r = await belayd(
      {
        source: MARK,
        event: 'before',
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        directory,
        args: output.args,
      },
      ${OPENCODE_HOOK_TIMEOUT_SECONDS},
    );
    if (r.code !== 0) throw new Error(\`\${BROKEN} \${r.stderr.trim().slice(0, 300)}\`.trim());
    if (r.stdout.trim() === '') return;
    let answer;
    try {
      answer = JSON.parse(r.stdout);
    } catch {
      throw new Error(BROKEN);
    }
    if (answer.decision !== 'allow') throw new Error(answer.reason || 'Blocked by belayd.');
  },
  'tool.execute.after': async (input) => {
    // Records what ran and snapshots the files it changed. Never fails the tool.
    await belayd(
      {
        source: MARK,
        event: 'after',
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        directory,
        args: input.args,
      },
      ${POST_TIMEOUT_SECONDS},
    );
  },
});
`;
}

/** The node and bin.js paths a plugin file runs. */
function pinned(source: string): string[] {
  return [/const NODE = ("[^"\n]*");/, /const BIN = ("[^"\n]*");/].flatMap((re) => {
    const m = re.exec(source);
    try {
      return m ? [JSON.parse(m[1]!) as string] : [];
    } catch {
      return [];
    }
  });
}

const ours = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(OPENCODE_MARK);
  } catch {
    return false;
  }
};

export const opencodeSetup: AgentSetup = {
  plan(opts) {
    const target = opencodeTarget(targetOptions(opts));
    const source = pluginSource(opts);
    const warnings: string[] = [];
    if (fs.existsSync(target.file) && !ours(target.file))
      warnings.push(
        `${tilde(target.file)} exists and is not belayd's. It is backed up and replaced.`,
      );
    return {
      file: target.file,
      scope: target.scope,
      shown: {
        plugin: target.file,
        runs: `${opts.nodePath} ${opts.binPath} hook opencode --timeout ${OPENCODE_HOOK_TIMEOUT_SECONDS}`,
      },
      warnings,
      after:
        target.scope === 'project'
          ? 'OpenCode: restart it in this folder so it loads the plugin.'
          : 'OpenCode: restart it so it loads the plugin.',
      apply: () => {
        fs.mkdirSync(path.dirname(target.file), { recursive: true });
        let backup: string | undefined;
        if (fs.existsSync(target.file) && fs.readFileSync(target.file, 'utf8') !== source) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          backup = `${target.file}.belayd-backup-${stamp}`;
          fs.copyFileSync(target.file, backup);
        }
        const tmp = `${target.file}.belayd-tmp`;
        fs.writeFileSync(tmp, source);
        fs.renameSync(tmp, target.file);
        if (target.scope === 'project') excludeFromGit(opts.workspace, target.file);
        return backup;
      },
    };
  },
  uninstall(opts) {
    const { file } = opencodeTarget(targetOptions(opts));
    if (!ours(file)) return [];
    return [
      {
        file,
        apply: () => {
          fs.rmSync(file, { force: true });
          return undefined;
        },
      },
    ];
  },
  doctor(opts) {
    const lines: DoctorLine[] = [];
    let installed = 0;
    for (const file of [
      opencodeTarget({ workspace: opts.workspace, env: opts.env }).file,
      opencodeTarget({ global: true, workspace: opts.workspace, env: opts.env }).file,
    ]) {
      if (!ours(file)) continue;
      installed++;
      const missing = pinned(fs.readFileSync(file, 'utf8')).filter((p) => !fs.existsSync(p));
      lines.push(
        missing.length > 0
          ? {
              status: 'fail',
              text: `OpenCode plugin in ${tilde(file)} points to files that no longer exist`,
              hint: `${missing.join(', ')}. Every tool call is being blocked. Run belayd init --agent opencode again.`,
            }
          : { status: 'ok', text: `OpenCode plugin installed in ${tilde(file)}` },
      );
    }
    if (installed === 0)
      lines.push({
        status: 'warn',
        text: 'OpenCode found, but no belayd plugin for it',
        hint: 'Run: belayd init --agent opencode',
      });
    return lines;
  },
};

function targetOptions(opts: SetupOptions) {
  return { ...(opts.global ? { global: true } : {}), workspace: opts.workspace, env: opts.env };
}
