import { execFileSync } from 'node:child_process';
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

async function before(tool, sessionID, callID, directory, args) {
  const r = await belayd(
    { source: MARK, event: 'before', tool, sessionID, callID, directory, args },
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
}

// Records what ran and snapshots the files it changed. Never fails the tool.
async function after(tool, sessionID, callID, directory, args) {
  await belayd(
    { source: MARK, event: 'after', tool, sessionID, callID, directory, args },
    ${POST_TIMEOUT_SECONDS},
  );
}

function hooks(directory) {
  return {
    'tool.execute.before': async (input, output) =>
      before(input.tool, input.sessionID, input.callID, directory, output.args),
    'tool.execute.after': async (input) =>
      after(input.tool, input.sessionID, input.callID, directory, input.args),
  };
}

// OpenCode 2 runs setup(); OpenCode 1 (1.18.29 and later) runs server(). OpenCode 2 does
// not run OpenCode 1 plugins, and OpenCode 1 rejects a file whose exports are not all
// functions, so one default export carries both. The plugin API comes with OpenCode 2.
let v2 = {};
try {
  const { Plugin } = await import('@opencode/plugin');
  v2 = Plugin.define({
    id: 'belayd',
    async setup(ctx) {
      const directory = ctx.location?.directory ?? process.cwd();
      await ctx.tool.hook('execute.before', (event) =>
        before(event.tool, event.sessionID, event.id, directory, event.input),
      );
      await ctx.tool.hook('execute.after', (event) =>
        after(event.tool, event.sessionID, event.id, directory, event.input),
      );
    },
  });
} catch {
  // OpenCode 1 without the OpenCode 2 plugin API
}

export default {
  id: 'belayd',
  ...v2,
  async server({ directory }) {
    return hooks(directory);
  },
};
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
      const source = fs.readFileSync(file, 'utf8');
      const missing = pinned(source).filter((p) => !fs.existsSync(p));
      lines.push(
        missing.length > 0
          ? {
              status: 'fail',
              text: `OpenCode plugin in ${tilde(file)} points to files that no longer exist`,
              hint: `${missing.join(', ')}. Every tool call is being blocked. Run belayd init --agent opencode again.`,
            }
          : !source.includes('async server(')
            ? {
                status: 'warn',
                text: `OpenCode plugin in ${tilde(file)} is from an older belayd, and OpenCode 2 does not run it`,
                hint: 'Run belayd init --agent opencode again: the new plugin works with OpenCode 1 and 2.',
              }
            : { status: 'ok', text: `OpenCode plugin installed in ${tilde(file)}` },
      );
    }
    const version = opencodeVersion(opts.env);
    if (version && olderThan(version, PLUGIN_MIN_VERSION))
      lines.push({
        status: 'warn',
        text: `OpenCode ${version} is older than ${PLUGIN_MIN_VERSION} and does not load belayd's plugin`,
        hint: 'belayd is off in OpenCode until you update it.',
      });
    if (installed === 0)
      lines.push({
        status: 'warn',
        text: 'OpenCode found, but no belayd plugin for it',
        hint: 'Run: belayd init --agent opencode',
      });
    else
      lines.push({
        status: 'note',
        text: 'Commands you type yourself with ! in OpenCode run without belayd.',
        hint: "OpenCode sends them straight to the shell, not through a tool. The agent's own commands are all checked.",
      });
    return lines;
  },
};

/** The first OpenCode 1 that loads a plugin's `server()`, the form that also works in OpenCode 2. */
const PLUGIN_MIN_VERSION = '1.18.29';

/** `opencode --version`, or undefined when it is not on PATH. */
export function opencodeVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BELAYD_OPENCODE_VERSION) return env.BELAYD_OPENCODE_VERSION;
  try {
    const out = execFileSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

function olderThan(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

function targetOptions(opts: SetupOptions) {
  return { ...(opts.global ? { global: true } : {}), workspace: opts.workspace, env: opts.env };
}
