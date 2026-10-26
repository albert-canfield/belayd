import path from 'node:path';
import pc from 'picocolors';
import { findAgent } from '../agents/registry.js';
import type { Dialect } from '../agents/types.js';
import { evaluate } from '../policy/engine.js';
import { actionLabel } from '../policy/label.js';
import { loadPolicy, type CompiledPolicy } from '../policy/load.js';
import type { AgentId, Verdict } from '../policy/types.js';
import {
  kindName,
  PLACE_NAMES,
  SecretTally,
  TranscriptSecrets,
  type Place,
  type SecretSummary,
} from '../scan/secrets.js';
import { readHistory, sessionFiles, sources, type Source } from '../scan/sources.js';
import { loadEnvValues, redact } from '../secrets/detect.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../util/paths.js';

export interface ScanOptions {
  since?: string;
  all?: boolean;
  preset?: string;
  json?: boolean;
  examples?: string;
  secrets?: boolean;
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
  const inProject = new Map<string, boolean>();
  const keep = (cwd: string) => {
    if (opts.all) return true;
    if (!cwd) return false;
    let yes = inProject.get(cwd);
    if (yes === undefined) {
      const c = canonicalPath(cwd);
      inProject.set(cwd, (yes = c === here || c.startsWith(here + path.sep)));
    }
    return yes;
  };
  const span =
    days >= 86_400_000
      ? `${Math.round(days / 86_400_000)} days`
      : `${Math.round(days / 3_600_000)} hours`;
  const where = opts.all ? 'every project' : path.basename(here);
  const finder = new TranscriptSecrets();
  const tally = new SecretTally();
  const progress = process.stderr.isTTY && !opts.json;

  if (opts.secrets) {
    const files = sources().map((s) => [s, sessionFiles(s, since)] as const);
    const total = files.reduce((n, [, f]) => n + f.length, 0);
    let read = 0;
    for (const [source, list] of files) {
      for (const file of list) {
        for await (const entry of readHistory(source, file, since, {
          calls: false,
          secrets: finder,
          keep,
        })) {
          if (entry.secret) tally.add(entry.secret);
        }
        if (progress && ++read % 50 === 0)
          process.stderr.write(
            `\r  ${read.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} transcripts read...`,
          );
      }
    }
    if (progress) process.stderr.write('\r\x1b[K');
    return secretsReport(tally.list(), { ...opts, here, days, where, span, home });
  }

  const state = belaydHome();
  const policies = new Map<string, Promise<CompiledPolicy>>();
  const envValues = new Map<string, Map<string, string>>();
  const dialects = new Map<AgentId, Promise<Dialect | undefined>>();
  const writes = new Map<string, Set<string>>();
  const rules = new Map<string, RuleCount>();
  const verdicts: Record<Verdict, number> = { pass: 0, allow: 0, ask: 0, deny: 0 };
  const sessions = new Set<string>();
  const agents = new Map<string, number>();
  const max = Math.max(0, Number(opts.examples ?? '2') || 0);
  let calls = 0;

  for (const source of sources()) {
    for (const file of sessionFiles(source, since)) {
      for await (const entry of readHistory(source, file, since, { secrets: finder, keep })) {
        if (entry.secret) {
          tally.add(entry.secret);
          continue;
        }
        const call = entry.call;
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
        let label: string;
        try {
          const action = d.toAction(call.tool, call.input, call.cwd);
          label = actionLabel(action, workspace);
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
          // The whole command, as the person would recognise it, without the project's secrets.
          let env = envValues.get(workspace);
          if (!env) envValues.set(workspace, (env = loadEnvValues(workspace)));
          const shown = oneLine(redact(label, env), 90);
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
          secrets: tally.size,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(pc.bold(`belayd scan · ${where} · last ${span}`));
  if (calls === 0) {
    console.log(`No agent tool calls found${opts.all ? '' : ' for this project'} in that time.`);
    console.log(pc.dim(`  Looked in ${lookedIn(home)}.`));
    secretsLine(tally.size);
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
  secretsLine(tally.size);
  return 0;
}

function lookedIn(home: string): string {
  return sources()
    .filter((s) => !s.archive)
    .map((s) => tilde(s.dir, home))
    .join(' and ');
}

/** The one line plain `belayd scan` adds when transcripts hold secrets. */
function secretsLine(n: number): void {
  if (n === 0) return;
  console.log(
    pc.yellow(
      `${n} ${n === 1 ? 'secret' : 'secrets'} (keys or tokens) found in these transcripts. See which to rotate: belayd scan --secrets`,
    ),
  );
}

interface ReportContext extends ScanOptions {
  here: string;
  days: number;
  where: string;
  span: string;
  home: string;
}

/**
 * `belayd scan --secrets`. Shows each secret by kind and fingerprint; the summaries it
 * gets carry no values, so nothing here can print one.
 */
function secretsReport(list: SecretSummary[], ctx: ReportContext): number {
  if (ctx.json) {
    const iso = (t: number) => new Date(t).toISOString();
    console.log(
      JSON.stringify(
        {
          project: ctx.all ? null : ctx.here,
          days: ctx.days / 86_400_000,
          secrets: list.map((s) => ({
            kind: kindName(s.kinds),
            fingerprint: s.fingerprint,
            detectors: s.kinds.filter((k) => !k.startsWith('env:')),
            env: s.kinds.filter((k) => k.startsWith('env:')).map((k) => k.slice(4)),
            count: s.count,
            places: s.places,
            first: iso(s.first),
            last: iso(s.last),
            transcripts: s.transcripts.map((t) => ({
              ...t,
              first: iso(t.first),
              last: iso(t.last),
            })),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(pc.bold(`belayd scan --secrets · ${ctx.where} · last ${ctx.span}`));
  if (list.length === 0) {
    console.log(
      `No keys or tokens found in your agents' transcripts${ctx.all ? '' : ' for this project'} in that time.`,
    );
    console.log(pc.dim(`  Looked in ${lookedIn(ctx.home)}.`));
    return 0;
  }
  const n = list.length;
  console.log(
    `${n} ${n === 1 ? 'secret reached your agents and is' : 'secrets reached your agents and are'} still in their transcripts. ` +
      pc.dim('Shown by fingerprint, never the value.'),
  );
  for (const s of list) {
    console.log('');
    console.log(`  ${pc.red('✖')} ${pc.bold(kindName(s.kinds))}  ${pc.dim(s.fingerprint)}`);
    const places = Object.keys(s.places).map((p) => PLACE_NAMES[p as Place]);
    const when = day(s.first) === day(s.last) ? day(s.last) : `${day(s.first)} to ${day(s.last)}`;
    console.log(`    ${s.count} ${s.count === 1 ? 'time' : 'times'}, in ${list2(places)}, ${when}`);
    const names = Math.max(...s.transcripts.slice(0, 3).map((t) => agentName(t.agent).length));
    for (const t of s.transcripts.slice(0, 3))
      console.log(
        pc.dim(
          `    ${agentName(t.agent).padEnd(names)}  ${day(t.last).padEnd(6)}  ${tilde(t.file, ctx.home)}`,
        ),
      );
    if (s.transcripts.length > 3)
      console.log(pc.dim(`    and ${s.transcripts.length - 3} more transcripts`));
  }

  const agents = new Set(list.flatMap((s) => s.transcripts.map((t) => t.agent)));
  const dirs = new Map<string, Source>(sources().map((s) => [s.archive ? 'archive' : s.agent, s]));
  console.log('');
  console.log(pc.bold('What to do'));
  console.log(
    '  1. Rotate each key where it was issued: make a new one, switch to it, then revoke the old one.',
  );
  console.log('     Deleting it from a file is not enough: copies already exist.');
  console.log(
    '  2. Delete the transcripts that hold copies. Malware that steals keys reads these files.',
  );
  if (agents.has('claude-code')) {
    const settings = path.join(path.dirname(dirs.get('claude-code')!.dir), 'settings.json');
    console.log(
      `     Claude Code deletes transcripts older than cleanupPeriodDays in ${tilde(settings, ctx.home)}`,
    );
    console.log(
      '     (default 30) when it starts. Lower it, or delete the files yourself (--json lists them all).',
    );
  }
  if (agents.has('codex'))
    console.log(
      `     Codex keeps them until you delete them, in ${tilde(dirs.get('codex')!.dir, ctx.home)} and ${tilde(dirs.get('archive')!.dir, ctx.home)}.`,
    );
  console.log('');
  console.log(
    pc.dim(
      `The fingerprint is the start of the value's SHA-256. Check a key with: printf %s "$KEY" | shasum -a 256`,
    ),
  );
  return 0;
}

function agentName(agent: string): string {
  return findAgent(agent as AgentId)?.name ?? agent;
}

function day(t: number): string {
  const d = new Date(t);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

function list2(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
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
