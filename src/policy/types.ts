export type AgentId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'gemini'
  | 'opencode'
  | 'ollama'
  | 'claude-desktop'
  | 'chatgpt'
  | 'mcp'
  | 'cli';

/** What an agent wants to do, independent of which agent asked. */
export type Action =
  | { kind: 'shell'; command: string }
  | {
      kind: 'read';
      path: string;
      /** Search tools: only files matching this glob. */ glob?: string;
    }
  | { kind: 'write'; path: string; content?: string }
  | { kind: 'fetch'; url: string; method?: string; body?: string }
  | { kind: 'patch'; files: PatchFile[] }
  | { kind: 'mcp'; server: string; tool: string; args: unknown }
  | { kind: 'tool'; name: string; input: unknown };

export type ActionKind = Action['kind'];

/** One file in a multi-file edit (Codex apply_patch). */
export interface PatchFile {
  path: string;
  op: 'add' | 'update' | 'delete';
  /** New location when the file is moved. */
  to?: string;
}

export interface ActionContext {
  agent: AgentId;
  /** The agent's own name for the tool, e.g. `Bash`, `Write`, `mcp__github__create_issue`. */
  toolName?: string;
  sessionId?: string;
  toolUseId?: string;
  cwd: string;
  /** Repository root, used for "outside the workspace" rules. */
  workspace: string;
  home: string;
}

export type RuleDecision = 'allow' | 'ask' | 'deny';

/** `pass` means no opinion: the agent's own permission system decides. */
export type Verdict = RuleDecision | 'pass';

export interface Finding {
  ruleId: string;
  decision: RuleDecision;
  reason: string;
  /** The part of the action the rule matched, e.g. one command inside a pipeline. */
  subject: string;
  layer: 'final' | 'user' | 'preset' | 'project';
}

export interface SubjectVerdict {
  label: string;
  verdict: Verdict;
  ruleId?: string;
  reason?: string;
  via: string[];
}

export interface Decision {
  verdict: Verdict;
  reason: string;
  ruleId?: string;
  findings: Finding[];
  /** One entry per thing that was checked, for `belayd check --explain`. */
  subjects: SubjectVerdict[];
}
