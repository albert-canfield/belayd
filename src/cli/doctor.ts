import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { listPending } from '../approval/store.js';
import { tooBroad } from '../snapshots/capture.js';
import { Shadow } from '../snapshots/shadow.js';
import { AuditLog } from '../audit/db.js';
import { readUiState } from '../approval/ui-state.js';
import { HOOK_TIMEOUT_SECONDS } from '../agents/claude-code/setup.js';
import { AGENTS, hookAgents, type AgentEntry } from '../agents/registry.js';
import { loadPolicy } from '../policy/load.js';
import { version } from '../version.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../util/paths.js';

type Status = 'ok' | 'warn' | 'fail';

const ICON: Record<Status, string> = { ok: pc.green('✔'), warn: pc.yellow('!'), fail: pc.red('✖') };

export async function doctor(cwd = process.cwd()): Promise<number> {
  let failed = false;
  const line = (status: Status, text: string, hint?: string) => {
    if (status === 'fail') failed = true;
    console.log(`${ICON[status]} ${text}`);
    if (hint) console.log(pc.dim(`  ${hint}`));
  };

  const workspace = findWorkspace(cwd);
  const state = belaydHome();
  let policyTimeoutMs: number | undefined;
  line('ok', `belayd ${version} on Node ${process.versions.node}`);
  // A BELAYD_HOME inside the project is one a repository could ship, pre-trusted policy
  // and all, or one the agent can edit like any project file.
  const realState = canonicalPath(state);
  const realWorkspace = canonicalPath(workspace);
  if (realState === realWorkspace || realState.startsWith(realWorkspace + path.sep)) {
    line(
      'warn',
      `belayd keeps its data inside this project (${state})`,
      'Point BELAYD_HOME outside the project, or unset it to use ~/.belayd.',
    );
  }

  try {
    const policy = await loadPolicy({ workspace, belaydHome: state, noCache: true });
    policyTimeoutMs = policy.approval.timeoutMs;
    // The hook trusts its compiled-policy cache. Make sure nobody changed it by hand.
    const cached = await loadPolicy({ workspace, belaydHome: state });
    if (JSON.stringify(cached) !== JSON.stringify(policy)) {
      fs.rmSync(path.join(state, 'cache'), { recursive: true, force: true });
      line(
        'fail',
        'The compiled policy cache did not match your policy files, so it was cleared',
        'If you did not edit ~/.belayd/cache yourself, something else did. Check belayd log.',
      );
    }
    const count = Object.values(policy.rules).reduce((n, rules) => n + rules.length, 0);
    line('ok', `Policy: ${policy.name} (${count} rules)`);
    for (const w of policy.warnings) line('warn', w);
  } catch (err) {
    line('fail', 'Policy has a problem', (err as Error).message.split('\n').join('\n  '));
  }

  // Every agent belayd can set up that is on this machine (Claude Code when none is).
  const found = hookAgents().filter((a) => a.detect(process.env));
  const checked = found.length > 0 ? found : hookAgents().slice(0, 1);
  const options = {
    workspace,
    global: false,
    env: process.env,
    nodePath: process.execPath,
    binPath: process.argv[1] ?? '',
  };
  for (const agent of checked)
    for (const l of (await agent.setup!()).doctor(options)) line(l.status, l.text, l.hint);
  for (const agent of AGENTS) {
    if (agent.support === 'hooks' || !agent.detect(process.env)) continue;
    if (agent.support === 'host')
      line('ok', `${agent.name} found: it runs the ${hostName(agent)} hooks`);
    else if (agent.support === 'launcher') {
      const names = agent.launches!.map((id) => AGENTS.find((a) => a.id === id)?.name ?? id);
      line(
        'ok',
        `${agent.name} found: agents it starts (${names.join(', ')}) use their own belayd hooks`,
        agent.gap,
      );
    } else line('warn', `${agent.name} found: belayd does not cover it yet`);
  }

  if (AuditLog.exists(state)) {
    try {
      const db = await AuditLog.open(state, { readOnly: true });
      const [latest] = db.events({ limit: 1 });
      const sessions = db.sessions().length;
      db.close();
      line(
        'ok',
        `Audit log: ${sessions} sessions${latest ? `, last event ${new Date(latest.at).toLocaleString()}` : ''}`,
      );
    } catch (err) {
      line('fail', 'Audit log cannot be read', (err as Error).message);
    }
  } else {
    line('ok', 'Audit log: empty so far');
  }
  const errors = recentErrors(state);
  if (errors.length > 0)
    line('warn', `Recent belayd errors (${path.join(state, 'errors.log')})`, errors.join('\n  '));

  if (!Shadow.available()) {
    line('warn', 'Git is not installed, so snapshots and undo are off');
  } else if (tooBroad(workspace, homeDir())) {
    line('ok', 'Snapshots: off here (this is your home folder, not a project)');
  } else {
    const shadow = new Shadow(state, workspace);
    if (shadow.exists() && shadow.tooBig()) {
      line(
        'warn',
        'Snapshots: off for this project, it has too many files',
        'Undo is not available here.',
      );
    } else {
      line(
        'ok',
        `Snapshots: ${shadow.exists() ? 'on, undo is available' : 'on, none taken in this project yet'}`,
      );
    }
  }

  const pending = listPending(state);
  const page = readUiState(state);
  line(
    'ok',
    `Approvals: ${pending.length} waiting · page ${page ? `running on port ${page.port}` : 'not running (starts when needed)'}`,
  );
  if (policyTimeoutMs !== undefined && policyTimeoutMs > (HOOK_TIMEOUT_SECONDS - 5) * 1000) {
    line(
      'warn',
      `approval.timeout is longer than the hook allows (${HOOK_TIMEOUT_SECONDS - 5}s)`,
      'belayd will stop waiting at the hook limit and deny.',
    );
  }

  // Each agent's own hook, fed the way that agent calls it, must block `rm -rf ~`.
  for (const agent of checked) {
    const smoke = await smokeTest(agent, workspace);
    if (smoke.ok) line('ok', `${agent.name} hook blocks "rm -rf ~" in ${smoke.ms} ms`);
    else line('fail', `${agent.name} hook smoke test failed`, smoke.detail);
  }

  return failed ? 1 : 0;
}

async function smokeTest(
  agent: AgentEntry,
  workspace: string,
): Promise<{ ok: boolean; ms: number; detail?: string }> {
  const dialect = await agent.dialect!();
  const start = performance.now();
  const r = spawnSync(
    process.execPath,
    [process.argv[1] ?? '', 'hook', agent.id, '--event', 'pre'],
    {
      input: JSON.stringify(dialect.sample('pre', 'rm -rf ~', workspace)),
      encoding: 'utf8',
    },
  );
  const ms = Math.round(performance.now() - start);
  const verdict = dialect.verdictOf({
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.status ?? 1,
  });
  if (verdict === 'deny') return { ok: true, ms };
  return {
    ok: false,
    ms,
    detail: `exit ${r.status}, stdout: ${r.stdout.trim() || '(empty)'}, stderr: ${r.stderr.trim()}`,
  };
}

function hostName(agent: AgentEntry): string {
  return AGENTS.find((a) => a.id === agent.runsHooksOf)?.name ?? String(agent.runsHooksOf);
}

function recentErrors(home: string): string[] {
  try {
    const lines = fs.readFileSync(path.join(home, 'errors.log'), 'utf8').trim().split('\n');
    const dayAgo = Date.now() - 86_400_000;
    return lines.filter((l) => Date.parse(l.slice(0, 24)) > dayAgo).slice(-3);
  } catch {
    return [];
  }
}
