import path from 'node:path';
import pc from 'picocolors';
import { findAgent } from '../agents/registry.js';
import type { Dialect } from '../agents/types.js';
import { evaluate } from '../policy/engine.js';
import { loadPolicy, type CompiledPolicy } from '../policy/load.js';
import type { AgentId, Verdict } from '../policy/types.js';
import { readCalls, sessionFiles, sources } from '../scan/sources.js';
import { redact } from '../secrets/detect.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../util/paths.js';

export interface ScanOptions {
  since?: string;
  all?: boolean;
  preset?: string;
  json?: boolean;
  examples?: string;
}

interface RuleCount {
  rule: string;
  verdict: Verdict;
  count: number;
  reason: string;
  examples: string[];
}

/**
 * `belayd scan`: what belayd would have done with the tool calls your agents already
 * made. Reads their session history on this machine, runs nothing, sends nothing.
 */
export async function scan(opts: ScanOptions): Promise<number> {
  const days = parseSince(opts.since ?? '30d');
  if (days === undefined) {
    console.error('--since takes a number of days, hours or weeks, for example 30d, 12h or 2w.');
    return 64;
  }
  const since = Date.now() - days;
  const home = canonicalPath(homeDir());
  const here = canonicalPath(findWorkspace(process.cwd()));
  if (!opts.all && (here === home || here === path.parse(here).root)) {
    console.error('Run belayd scan inside a project, or use --all for every project.');
    return 64;
  }
  const keep = (cwd: string) => {
    if (opts.all) return true;
    const c = canonicalPath(cwd);
    return c === here || c.startsWith(here + path.sep);
  };

  const state = belaydHome();
  const policies = new Map<string, Promise<CompiledPolicy>>();
  const dialects = new Map<AgentId, Promise<Dialect | undefined>>();
  const writes = new Map<string, Set<string>>();
  const rules = new Map<string, RuleCount>();
  const verdicts: Record<Verdict, number> = { pass: 0, allow: 0, ask: 0, deny: 0 };
  const sessions = new Set<string>();
  const agents = new Map<string, number>();
  const max = Math.max(0, Number(opts.examples ?? '2') || 0);
  const progress = process.stderr.isTTY && !opts.json;
  let calls = 0;

  for (const source of sources()) {
    for (const file of sessionFiles(source, since)) {
      for await (const call of readCalls(source, file, since)) {
        if (!call.cwd || !keep(call.cwd)) continue;
        let dialect = dialects.get(call.agent);
        if (!dialect) {
          const entry = findAgent(call.agent);
          dialects.set(
            call.agent,
            (dialect = entry?.dialect ? entry.dialect() : Promise.resolve(undefined)),
          );
        }
        const d = await dialect;
        if (!d) continue;
        const workspace = findWorkspace(call.cwd);
        let policy = policies.get(workspace);
        if (!policy) {
          policy = loadPolicy({
            workspace,
            belaydHome: state,
            ...(opts.preset ? { preset: opts.preset } : {}),
          });
          policies.set(workspace, policy);
        }
        const sessionKey = `${call.agent}:${call.session}`;
        let written = writes.get(sessionKey);
        if (!written) writes.set(sessionKey, (written = new Set()));

        let decision;
        try {
          const action = d.toAction(call.tool, call.input, call.cwd);
          decision = evaluate(
            action,
            {
              agent: call.agent,
              toolName: call.tool,
              cwd: call.cwd,
              workspace,
              home,
              ...(d.folders ? { folders: d.folders(process.env) } : {}),
            },
            await policy,
            { belaydHome: state, sessionWrites: written },
          );
          if (action.kind === 'write') written.add(path.resolve(call.cwd, action.path));
          if (action.kind === 'patch')
            for (const f of action.files) written.add(path.resolve(call.cwd, f.path));
        } catch {
          continue;
        }
        calls++;
        sessions.add(sessionKey);
        agents.set(call.agent, (agents.get(call.agent) ?? 0) + 1);
        verdicts[decision.verdict]++;
        if ((decision.verdict === 'ask' || decision.verdict === 'deny') && decision.ruleId) {
          const r = rules.get(decision.ruleId) ?? {
            rule: decision.ruleId,
            verdict: decision.verdict,
            count: 0,
            reason:
              decision.findings.find((f) => f.ruleId === decision.ruleId)?.reason ??
              decision.reason,
            examples: [],
          };
          r.count++;
          const subject =
            decision.findings.find((f) => f.ruleId === decision.ruleId)?.subject ?? '';
          const shown = oneLine(redact(subject), 90);
          if (r.examples.length < max && shown && !r.examples.includes(shown))
            r.examples.push(shown);
          rules.set(decision.ruleId, r);
        }
        if (progress && calls % 2000 === 0)
          process.stderr.write(`\r  ${calls.toLocaleString('en-US')} tool calls read...`);
      }
    }
  }
  if (progress) process.stderr.write('\r\x1b[K');

  const sorted = [...rules.values()].sort((a, b) => b.count - a.count);
  const quiet = verdicts.pass + verdicts.allow;
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project: opts.all ? null : here,
          days: days / 86_400_000,
          calls,
          sessions: sessions.size,
          agents: Object.fromEntries(agents),
          quiet,
          ask: verdicts.ask,
          deny: verdicts.deny,
          rules: sorted,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const where = opts.all ? 'every project' : path.basename(here);
  const span =
    days >= 86_400_000
      ? `${Math.round(days / 86_400_000)} days`
      : `${Math.round(days / 3_600_000)} hours`;
  console.log(pc.bold(`belayd scan · ${where} · last ${span}`));
  if (calls === 0) {
    console.log(`No agent tool calls found${opts.all ? '' : ' for this project'} in that time.`);
    console.log(
      pc.dim(
        `  Looked in ${sources()
          .map((s) => tilde(s.dir, home))
          .join(' and ')}.`,
      ),
    );
    return 0;
  }
  const by = [...agents.entries()]
    .map(([a, n]) => `${findAgent(a)?.name ?? a} ${n.toLocaleString('en-US')}`)
    .join(', ');
  console.log(
    `${calls.toLocaleString('en-US')} tool calls in ${sessions.size} ${sessions.size === 1 ? 'session' : 'sessions'} (${by}). ` +
      pc.dim('Read on this machine; nothing ran and nothing was sent.'),
  );
  console.log('');
  const row = (label: string, n: number, color: (s: string) => string) =>
    console.log(
      `  ${color(label.padEnd(9))} ${n.toLocaleString('en-US').padStart(9)}  ${pct(n, calls).padStart(6)}`,
    );
  row('quiet', quiet, pc.dim);
  row('asked', verdicts.ask, pc.yellow);
  row('blocked', verdicts.deny, pc.red);

  for (const verdict of ['deny', 'ask'] as const) {
    const list = sorted.filter((r) => r.verdict === verdict);
    if (list.length === 0) continue;
    console.log('');
    console.log(pc.bold(verdict === 'deny' ? 'Would have blocked' : 'Would have asked about'));
    const width = Math.max(...list.map((r) => r.rule.length));
    for (const r of list.slice(0, 12)) {
      const mark = verdict === 'deny' ? pc.red('✖') : pc.yellow('?');
      console.log(
        `  ${mark} ${String(r.count).padStart(6)}  ${r.rule.padEnd(width)}  ${pc.dim(oneLine(r.reason, 70))}`,
      );
      for (const e of r.examples) console.log(pc.dim(`             e.g. ${e}`));
    }
    if (list.length > 12) console.log(pc.dim(`  and ${list.length - 12} more rules`));
  }
  console.log('');
  console.log(
    pc.dim(
      'See why with belayd check --explain "<command>". Once belayd is on, belayd tune turns questions you keep approving into rules.',
    ),
  );
  return 0;
}

function parseSince(s: string): number | undefined {
  const m = /^(\d+)\s*([hdw])$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n * { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as 'h' | 'd' | 'w'];
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  const p = (100 * n) / total;
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
}

function oneLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function tilde(p: string, home: string): string {
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
