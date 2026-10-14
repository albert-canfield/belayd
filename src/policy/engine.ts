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
}

export function evaluate(
  action: Action,
  ctx: ActionContext,
  policy: CompiledPolicy,
  opts: EvaluateOptions,
): Decision {
  const subjects = buildSubjects(action, ctx);
  const env = createMatchEnv(ctx, opts.belaydHome, opts.sessionWrites);
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
  summary: SubjectVerdict;
}

function decideSubject(s: Subject, policy: CompiledPolicy, env: MatchEnv): SubjectResult {
  // Your rules override the preset. Final preset rules are a floor nobody can lower:
  // they always apply, and a stricter rule from either layer still wins over them.
  const floor = strongest(policy.rules.final, s, env);
  const chosen = strongest(policy.rules.user, s, env) ?? strongest(policy.rules.preset, s, env);
  const hit =
    floor && (!chosen || RULE_SEVERITY[floor.rule.decision] >= RULE_SEVERITY[chosen.rule.decision])
      ? floor
      : chosen;

  if (!hit)
    return {
      verdict: policy.default,
      summary: { label: s.label, verdict: policy.default, via: s.via },
    };

  const { rule, detail } = hit;
  const base = rule.reason ?? `matched rule ${rule.id}`;
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
    summary: { label: s.label, verdict: rule.decision, ruleId: rule.id, reason, via: s.via },
  };
}

function strongest(
  rules: LayeredRule[],
  s: Subject,
  env: MatchEnv,
): { rule: LayeredRule; detail?: string } | undefined {
  let best: { rule: LayeredRule; detail?: string } | undefined;
  for (const rule of rules) {
    const m = matches(rule.match, s, env);
    if (!m.matched) continue;
    if (!best || RULE_SEVERITY[rule.decision] > RULE_SEVERITY[best.rule.decision]) {
      best = { rule, ...(m.detail ? { detail: m.detail } : {}) };
    }
  }
  return best;
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
