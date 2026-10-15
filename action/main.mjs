// The belayd GitHub Action, first half: installs belayd and its hooks for the agents
// that will run in this job. No dependencies: it runs straight from the repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const actionPath = process.env.GITHUB_ACTION_PATH ?? path.resolve(import.meta.dirname, '..');
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
const append = (file, line) => file && fs.appendFileSync(file, `${line}\n`);

try {
  const home = path.join(process.env.RUNNER_TEMP ?? '/tmp', 'belayd');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Every later step, the agent's included, uses this belayd home.
  append(process.env.GITHUB_ENV, `BELAYD_HOME=${home}`);
  append(process.env.GITHUB_STATE, `home=${home}`);
  const env = { BELAYD_HOME: home };

  const own = JSON.parse(fs.readFileSync(path.join(actionPath, 'package.json'), 'utf8')).version;
  const version = input('version') || own;
  // `local` installs this checkout (built with pnpm build), for testing the action itself.
  run('npm', [
    'install',
    '--global',
    '--no-fund',
    '--no-audit',
    version === 'local' ? actionPath : `belayd-cli@${version}`,
  ]);

  const policy = input('policy');
  const timeout = Math.max(1, Number(input('approval-timeout') || '1'));
  const text = policy
    ? fs.readFileSync(path.resolve(policy), 'utf8')
    : [
        '# Written by the belayd GitHub Action for this job.',
        'version: 1',
        `extends: ${input('preset') || 'balanced'}`,
        'approval:',
        `  timeout: ${timeout}s`,
        '  notify: false',
        '',
      ].join('\n');
  fs.writeFileSync(path.join(home, 'belayd.yaml'), text);

  const agents = input('agents') || 'claude-code,codex,copilot,gemini,opencode';
  run('belayd', ['init', '--global', '--yes', '--agent', agents], env);
} catch (err) {
  console.log(`::error::belayd could not be set up: ${err.message}`);
  process.exitCode = 1;
}
