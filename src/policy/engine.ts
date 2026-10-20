import { createMatchEnv, matches, type MatchEnv } from './match.js';
import type { CompiledPolicy, LayeredRule } from './load.js';
import { buildSubjects, type Subject } from './subjects.js';
import type {
  Action,
  ActionContext,
  Decision,
  Finding,
  RuleDecision,
  SubjectVerdict,
  Verdict,
} from './types.js';

/** Across the parts of one action, the strictest wins. `allow` only wins if every part is allowed. */
const ACTION_SEVERITY: Record<Verdict, number> = { allow: 0, pass: 1, ask: 2, deny: 3 };
/** Among rules matching the same part, the strictest wins. */
const RULE_SEVERITY: Record<RuleDecision, number> = { allow: 0, ask: 1, deny: 2 };

export interface EvaluateOptions {
  belaydHome: string;
  /** Files the agent changed earlier in this session. */
  sessionWrites?: Set<string>;
  /** Another live agent's uncommitted work a subject would clobber (src/policy/clobber.ts). */
  othersWork?: (s: Subject) => string | undefined;
}

export function evaluate(
  action: Action,
  ctx: ActionContext,
  policy: CompiledPolicy,
  opts: EvaluateOptions,
): Decision {
  const subjects = buildSubjects(action, ctx, opts.sessionWrites);
  const env = createMatchEnv(
    withFolders(ctx, policy),
    opts.belaydHome,
    opts.sessionWrites,
    opts.othersWork,
  );
  const results = subjects.map((s) => decideSubject(s, policy, env));

  if (results.length === 0) {
    return { verdict: 'pass', reason: 'nothing to check', findings: [], subjects: [] };
  }

  let worst = results[0]!;
  for (const r of results)
    if (ACTION_SEVERITY[r.verdict] > ACTION_SEVERITY[worst.verdict]) worst = r;

  const findings = results.flatMap((r) => (r.finding ? [r.finding] : []));
  return {
    verdict: worst.verdict,
    reason: worst.finding
      ? describe(worst.finding, subjects.length > 1)
      : defaultReason(worst.verdict),
    ...(worst.finding ? { ruleId: worst.finding.ruleId } : {}),
    findings,
    subjects: results.map((r) => r.summary),
  };
}

interface SubjectResult {
  verdict: Verdict;
  finding?: Finding;
  /** The rule that decided, if any. */
  rule?: LayeredRule;
  summary: SubjectVerdict;
}

/** Each part of an action with the verdict and rule that decided it, for `belayd tune`. */
export function judgeSubjects(
  action: Action,
  ctx: ActionContext,
  policy: CompiledPolicy,
  opts: EvaluateOptions,
): { subject: Subject; verdict: Verdict; rule?: LayeredRule }[] {
  const env = createMatchEnv(
    withFolders(ctx, policy),
    opts.belaydHome,
    opts.sessionWrites,
    opts.othersWork,
  );
  return buildSubjects(action, ctx, opts.sessionWrites).map((subject) => {
    const r = decideSubject(subject, policy, env);
    return { subject, verdict: r.verdict, ...(r.rule ? { rule: r.rule } : {}) };
  });
}

function decideSubject(s: Subject, policy: CompiledPolicy, env: MatchEnv): SubjectResult {
  // Your rules override the preset. Final preset rules are a floor nobody can lower:
  // they always apply, and a stricter rule from either layer still wins over them.
  const floor = strongest(policy.rules.final, s, env);
  const chosen = strongest(policy.rules.user, s, env) ?? strongest(policy.rules.preset, s, env);
  const own =
    floor && (!chosen || RULE_SEVERITY[floor.rule.decision] >= RULE_SEVERITY[chosen.rule.decision])
      ? floor
      : chosen;
  // Rules from a project file you have not trusted come last and only count when they
  // are stricter than what your own policy decided. They can never lower a verdict.
  const extra = strongest(policy.rules.project ?? [], s, env, true);
  const hit =
    extra &&
    ACTION_SEVERITY[extra.rule.decision] > ACTION_SEVERITY[own?.rule.decision ?? policy.default]
      ? extra
      : own;

  // Inside your own committed script, only blocks apply; a question there falls back to
  // the default (quiet in balanced, a question in strict). Questions about what the agent
  // changed this session (a script or package.json the script runs) still count: they are
  // about the agent's work, not yours.
  const ownCode =
    s.trusted &&
    hit !== undefined &&
    hit.rule.decision !== 'deny' &&
    hit.rule.match.changedRunner === undefined &&
    hit.rule.match.changedScript === undefined &&
    hit.rule.match.othersWork === undefined;
  if (!hit || ownCode)
    return {
      verdict: policy.default,
      summary: { label: s.label, verdict: policy.default, via: s.via },
    };

  const { rule, detail } = hit;
  const base =
    (rule.layer === 'project'
      ? "From this project's belayd.yaml, which you have not trusted: "
      : '') + (rule.reason ?? `matched rule ${rule.id}`);
  const note = rule.match.dynamic || rule.match.parseError ? s.note : undefined;
  const reason = detail ? `${base} (${detail})` : note ? `${base} (${note})` : base;
  const finding: Finding = {
    ruleId: rule.id,
    decision: rule.decision,
    reason,
    subject: s.label,
    layer: rule.layer,
  };
  return {
    verdict: rule.decision,
    finding,
    rule,
    summary: { label: s.label, verdict: rule.decision, ruleId: rule.id, reason, via: s.via },
  };
}

/** `untrusted`: a rule that fails to evaluate counts as matching, so it cannot be used to break checks. */
function strongest(
  rules: LayeredRule[],
  s: Subject,
  env: MatchEnv,
  untrusted = false,
): { rule: LayeredRule; detail?: string } | undefined {
  let best: { rule: LayeredRule; detail?: string } | undefined;
  for (const rule of rules) {
    let m: ReturnType<typeof matches>;
    try {
      m = matches(rule.match, s, env);
    } catch (err) {
      if (!untrusted) throw err;
      m = { matched: true, detail: 'the rule could not be checked' };
    }
    if (!m.matched) continue;
    if (!best || RULE_SEVERITY[rule.decision] > RULE_SEVERITY[best.rule.decision]) {
      best = { rule, ...(m.detail ? { detail: m.detail } : {}) };
    }
  }
  return best;
}

/** The folders your policy names count as part of the project, with the agent's own. */
function withFolders(ctx: ActionContext, policy: CompiledPolicy): ActionContext {
  const folders = [...(ctx.folders ?? []), ...(policy.folders ?? [])];
  return folders.length > 0 ? { ...ctx, folders } : ctx;
}

function describe(f: Finding, multiple: boolean): string {
  const where = multiple ? ` In: ${truncate(f.subject, 120)}` : '';
  return `${f.reason}${where}`;
}

function defaultReason(v: Verdict): string {
  switch (v) {
    case 'pass':
      return 'no belayd rule applies, so the agent decides as usual';
    case 'allow':
      return 'allowed by default';
    case 'ask':
      return 'no rule allows this, and the policy asks by default';
    case 'deny':
      return 'denied by default';
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
}
