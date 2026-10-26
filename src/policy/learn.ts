import crypto from 'node:crypto';
import path from 'node:path';
import { findAgent } from '../agents/registry.js';
import type { Dialect } from '../agents/types.js';
import type { StoredEvent } from '../audit/db.js';
import { judgeSubjects } from './engine.js';
import type { CompiledPolicy, LayeredRule } from './load.js';
import type { Match, Rule } from './schema.js';
import type { Subject } from './subjects.js';
import type { ActionContext, AgentId } from './types.js';

/**
 * `belayd tune`: turns questions you keep answering with yes into allow rules.
 *
 * A learned rule allows exactly what you approved and nothing more: the same words in
 * the same order, touching the same paths. User rules override preset rules, so anything
 * looser would also switch off unrelated preset checks for similar commands.
 *
 * Never learned:
 * - questions from final rules (an allow cannot lower them anyway) or from an untrusted
 *   project file (an allow cannot lower those either)
 * - questions about things belayd could not see into: dynamic commands, unresolved
 *   values, inline code, code piped in, parse errors, remote MCP servers
 * - questions from the session and secret checks themselves (`npm test` after the agent
 *   edited package.json, a secret leaving the machine)
 * - anything whose words or paths contain wildcard characters, or redacted secrets
 *
 * A learned shell rule also carries `changedRunner: false`, `changedScript: false` and
 * `secrets: false`. Your rules override the preset, so without them an allowed
 * `git push` would also skip the check on a Git hook the agent just wrote. With them,
 * the rule steps aside in exactly those cases and the preset asks as before.
 */

export const DEFAULT_MIN_APPROVALS = 3;

export interface Suggestion {
  /** Stable for the same command in the same workspace. */
  key: string;
  workspace: string;
  /** What to show a person. */
  label: string;
  count: number;
  lastAt: number;
  /** The rule that kept asking. */
  askedBy: string;
  rule: Rule;
}

export interface LearnOptions {
  events: StoredEvent[];
  belaydHome: string;
  home: string;
  /** How many approvals make a suggestion. */
  min: number;
  /** Write paths inside the workspace as `{workspace}/...` (for a project's own belayd.yaml). */
  relativeToWorkspace: boolean;
  policyFor(workspace: string): Promise<CompiledPolicy>;
  /** For the rule's reason. */
  today?: string;
}

/** Calls you approved: belayd asked and you said yes, or the agent's own prompt let it run. */
export function approvedQuestions(events: StoredEvent[]): StoredEvent[] {
  const ran = new Set<string>();
  for (const e of events) if (e.phase === 'post') ran.add(`${e.session}\0${e.step}`);
  return events.filter(
    (e) =>
      e.phase === 'pre' &&
      e.verdict === 'ask' &&
      ((e.decision === 'allow' && !!e.answeredBy && e.answeredBy !== 'timeout') ||
        (e.decision === 'ask' && ran.has(`${e.session}\0${e.step}`))),
  );
}

export async function suggestRules(opts: LearnOptions): Promise<Suggestion[]> {
  const dialects = new Map<string, Promise<Dialect | undefined>>();
  const policies = new Map<string, Promise<CompiledPolicy>>();
  const found = new Map<string, Suggestion>();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  for (const e of approvedQuestions(opts.events)) {
    const dialect = await memo(dialects, e.agent, async () => {
      const entry = findAgent(e.agent);
      return entry?.dialect ? entry.dialect() : undefined;
    });
    if (!dialect || !e.tool || !e.input) continue;
    let input: unknown;
    try {
      input = JSON.parse(e.input);
    } catch {
      continue; // shortened in the log, so it cannot be checked again
    }
    const cwd = e.cwd ?? e.workspace;
    const ctx: ActionContext = {
      agent: e.agent as AgentId,
      toolName: e.tool,
      cwd,
      workspace: e.workspace,
      home: opts.home,
    };
    let judged: ReturnType<typeof judgeSubjects>;
    try {
      const policy = await memo(policies, e.workspace, () => opts.policyFor(e.workspace));
      judged = judgeSubjects(dialect.toAction(e.tool, input, cwd), ctx, policy, {
        belaydHome: opts.belaydHome,
      });
    } catch {
      continue;
    }

    const seen = new Set<string>();
    for (const { subject, verdict, rule } of judged) {
      if (verdict !== 'ask' || !rule || !learnableRule(rule) || !learnableSubject(subject))
        continue;
      const words = subject.kind === 'shell' ? [subject.program!, ...subject.argv.slice(1)] : [];
      const paths = [...new Set(subject.paths)].sort();
      const key = JSON.stringify([e.workspace, subject.kind, words, paths]);
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = found.get(key);
      if (prev) {
        prev.count++;
        prev.lastAt = Math.max(prev.lastAt, e.at);
        continue;
      }
      found.set(key, {
        key,
        workspace: e.workspace,
        label: subject.label,
        count: 1,
        lastAt: e.at,
        askedBy: rule.id,
        rule: { id: '', match: {}, decision: 'allow' },
      });
      found.get(key)!.rule = buildRule(subject, words, paths, e.workspace, opts, key);
    }
  }

  const out = [...found.values()].filter((s) => s.count >= opts.min);
  for (const s of out)
    s.rule.reason = `Learned with belayd tune on ${today}: you approved it ${s.count} times (asked by ${s.askedBy}).`;
  return out.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

const UNSEEN: (keyof Match)[] = [
  'dynamic',
  'unresolved',
  'inlineCode',
  'parseError',
  'remote',
  'codeFrom',
  'changedRunner',
  'changedScript',
  'secrets',
  'othersWork',
  'projectSetup',
  'unknownPackage',
];

function learnableRule(rule: LayeredRule): boolean {
  if (rule.final || rule.layer === 'final' || rule.layer === 'project') return false;
  return UNSEEN.every((k) => rule.match[k] === undefined);
}

/** Characters that are wildcards in rule patterns, so a value with them cannot be pinned exactly. */
const PATTERN_CHARS = /[*?[\]{}()!+@\\]/;

function learnableSubject(s: Subject): boolean {
  if (s.kind !== 'shell' && s.kind !== 'write' && s.kind !== 'read') return false;
  if (s.kind === 'shell' && !s.program) return false;
  if (s.dynamic || s.unresolved || s.inlineCode || s.remote || s.parseError) return false;
  if (s.codeFrom.length > 0) return false;
  const words = s.kind === 'shell' ? [s.program!, ...s.argv.slice(1)] : [];
  if (words.some((w) => /[*?]/.test(w) || w.includes('[redacted:'))) return false;
  if (s.paths.some((p) => PATTERN_CHARS.test(p))) return false;
  if (s.kind !== 'shell' && s.paths.length === 0) return false;
  return true;
}

function buildRule(
  s: Subject,
  words: string[],
  paths: string[],
  workspace: string,
  opts: LearnOptions,
  key: string,
): Rule {
  const shown = paths.map((p) => pathPattern(p, workspace, opts.relativeToWorkspace));
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 6);
  if (s.kind === 'shell') {
    return {
      id: `learned-${slug(words.slice(0, 3).join(' '))}-${hash}`,
      match: {
        argv: words,
        pathsOnly: shown,
        changedRunner: false,
        changedScript: false,
        secrets: false,
      },
      decision: 'allow',
    };
  }
  const kind = s.kind as 'read' | 'write';
  return {
    id: `learned-${kind}-${slug(path.basename(paths[0]!))}-${hash}`,
    match: { tool: [kind], [kind === 'write' ? 'writes' : 'reads']: shown, pathsOnly: shown },
    decision: 'allow',
  };
}

function pathPattern(p: string, workspace: string, relative: boolean): string {
  if (!relative) return p;
  if (p === workspace) return '{workspace}';
  const rel = path.relative(workspace, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `{workspace}/${rel}` : p;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'command'
  );
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let v = cache.get(key);
  if (!v) cache.set(key, (v = make()));
  return v;
}
