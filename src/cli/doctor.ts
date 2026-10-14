import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { listPending } from '../approval/store.js';
import { codexDetected, codexHome } from '../integrations/codex/install.js';
import { AuditLog } from '../audit/db.js';
import { readUiState } from '../approval/ui-state.js';
import {
  claudeConfigDir,
  HOOK_TIMEOUT_SECONDS,
  detectClaudeVersion,
  findInstalledHandler,
  ON_FAILURE_MIN_VERSION,
  readSettings,
  supportsOnFailure,
} from '../integrations/claude-code/install.js';
import { loadPolicy } from '../policy/load.js';
import { version } from '../version.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

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

  try {
    const policy = await loadPolicy({ workspace, belaydHome: state, noCache: true });
    policyTimeoutMs = policy.approval.timeoutMs;
    const count = policy.rules.final.length + policy.rules.user.length + policy.rules.preset.length;
    line('ok', `Policy: ${policy.name} (${count} rules)`);
  } catch (err) {
    line('fail', 'Policy has a problem', (err as Error).message.split('\n').join('\n  '));
  }

  const claudeVersion = detectClaudeVersion();
  if (!claudeVersion) line('warn', 'Claude Code: `claude` command not found on PATH');
  else if (supportsOnFailure(claudeVersion)) line('ok', `Claude Code ${claudeVersion}`);
  else {
    line(
      'warn',
      `Claude Code ${claudeVersion} is older than ${ON_FAILURE_MIN_VERSION}`,
      'Hook timeouts are not blocked on this version. Update Claude Code, then run belayd init again.',
    );
  }

  const files = [
    path.join(workspace, '.claude', 'settings.local.json'),
    path.join(workspace, '.claude', 'settings.json'),
    path.join(claudeConfigDir(undefined, process.env), 'settings.json'),
  ];
  let installed = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let handler;
    try {
      handler = findInstalledHandler(readSettings(file));
    } catch (err) {
      line('fail', `Cannot read ${tilde(file)}`, (err as Error).message);
      continue;
    }
    if (!handler) continue;
    installed++;
    const pinned = handler.args
      ? [handler.command, handler.args[0]!]
      : pathsInShellCommand(handler.command);
    const missing = pinned.filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      line(
        'fail',
        `Hook in ${tilde(file)} points to files that no longer exist`,
        `${missing.join(', ')}. Every tool call is being blocked. Run belayd init again.`,
      );
    } else {
      const guard = handler.onFailure === 'block' ? 'blocks on failure' : 'shell guard';
      line('ok', `Claude Code hook installed in ${tilde(file)} (${guard})`);
    }
  }
  if (installed === 0) line('warn', 'No belayd hook found for Claude Code', 'Run: belayd init');

  if (codexDetected()) {
    let codexInstalled = 0;
    for (const file of [
      path.join(workspace, '.codex', 'hooks.json'),
      path.join(codexHome(), 'hooks.json'),
    ]) {
      if (!fs.existsSync(file)) continue;
      let handler;
      try {
        handler = findInstalledHandler(readSettings(file));
      } catch (err) {
        line('fail', `Cannot read ${tilde(file)}`, (err as Error).message);
        continue;
      }
      if (!handler) continue;
      codexInstalled++;
      const missing = pathsInShellCommand(handler.command).filter((p) => !fs.existsSync(p));
      if (missing.length > 0) {
        line(
          'fail',
          `Codex hook in ${tilde(file)} points to files that no longer exist`,
          `${missing.join(', ')}. Run belayd init --agent codex again.`,
        );
      } else {
        line(
          'ok',
          `Codex hook installed in ${tilde(file)}`,
          'Codex skips new or changed hooks until you trust them: run /hooks in Codex once.',
        );
      }
    }
    if (codexInstalled === 0) {
      line('warn', 'Codex found, but no belayd hook for it', 'Run: belayd init --agent codex');
    }
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

  const smoke = smokeTest(workspace);
  if (smoke.ok) line('ok', `Hook blocks "rm -rf ~" in ${smoke.ms} ms`);
  else line('fail', 'Hook smoke test failed', smoke.detail);

  return failed ? 1 : 0;
}

function smokeTest(workspace: string): { ok: boolean; ms: number; detail?: string } {
  const bin = process.argv[1] ?? '';
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf ~' },
    cwd: workspace,
    session_id: 'belayd-doctor',
  });
  const start = performance.now();
  const r = spawnSync(process.execPath, [bin, 'hook', 'claude-code'], {
    input: payload,
    encoding: 'utf8',
  });
  const ms = Math.round(performance.now() - start);
  try {
    const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    if (out.hookSpecificOutput?.permissionDecision === 'deny') return { ok: true, ms };
  } catch {
    // fall through
  }
  return {
    ok: false,
    ms,
    detail: `exit ${r.status}, stdout: ${r.stdout.trim() || '(empty)'}, stderr: ${r.stderr.trim()}`,
  };
}

function pathsInShellCommand(command: string): string[] {
  const quoted = [...command.matchAll(/'([^']+)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '');
  return quoted.slice(0, 2).filter((p) => p.startsWith('/'));
}

function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
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
