import { execFileSync } from 'node:child_process';

/** Git's well-known empty tree. Attributes read from it name no filter driver. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Runs git in a repository belayd does not own: the user's project, or one an agent
 * cloned or unpacked. Such a repository's own `.git/config` can name a command for
 * `core.fsmonitor`, a hook or a filter driver, and a plain `git status` runs it. For this
 * call all three are off: fsmonitor and hooks through `-c`, filters by reading attributes
 * from the empty tree. `GIT_OPTIONAL_LOCKS=0` keeps `git status` from taking the index
 * lock while an agent is committing, and inherited `GIT_*` variables are dropped so they
 * cannot point git somewhere else.
 *
 * Git older than 2.40 rejects `--attr-source`; the call then throws, like any other
 * failure, and every caller treats that as "don't know".
 */
export function untrustedGit(args: string[], opts: { cwd: string; timeout?: number }): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      `--attr-source=${EMPTY_TREE}`,
      ...args,
    ],
    {
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: opts.timeout ?? 2000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}
