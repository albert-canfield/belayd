import type { HookResult } from '../hook/types.js';
import type { Action, AgentId } from '../policy/types.js';

/**
 * What belayd needs to know about an agent. Every agent is one adapter, and everything
 * belayd does (hooks, init, uninstall, doctor, the audit log) goes through this
 * contract, so adding an agent never means touching the policy engine or the CLI.
 */

/** What belayd finally tells the agent. */
export type Answer = 'allow' | 'ask' | 'deny' | 'pass';

/** One tool call, as any agent describes it. */
export interface ToolEvent {
  /** Before the tool runs, after it ran, after it failed, or something belayd ignores. */
  phase: 'pre' | 'post' | 'failed' | 'other';
  tool: string;
  input: unknown;
  cwd?: string;
  sessionId?: string;
  toolUseId?: string;
}

/** How one agent speaks the hook protocol. Loaded on every tool call, so keep it small. */
export interface Dialect {
  /**
   * Reads the agent's JSON. `event` is the `--event` argument the hook was installed
   * with, for agents that do not name the event in the payload.
   */
  parse(payload: Record<string, unknown>, event: string | undefined): ToolEvent;
  /** The agent that really sent this: another one may be running this agent's hooks. */
  agent(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): AgentId;
  toAction(tool: string, input: unknown, cwd: string): Action;
  /** The project root, when the agent tells us. */
  workspace?(env: NodeJS.ProcessEnv): string | undefined;
  /**
   * True for a call another adapter already checks natively (Copilot CLI also runs
   * Claude Code's hooks). belayd then answers nothing here, so it checks the call once.
   */
  handledElsewhere?(agent: AgentId, event: ToolEvent, env: NodeJS.ProcessEnv): boolean;
  /** Whether answering `ask` makes the agent show its own prompt to a person. */
  canAskNatively(agent: AgentId, env: NodeJS.ProcessEnv): boolean;
  /** Turns belayd's answer into what this agent reads. */
  respond(
    answer: Answer,
    reason: string,
    detail: { approvedBy?: string; agent?: AgentId },
  ): HookResult;
  /**
   * A payload asking to run a shell command, as this agent would send it. Used by
   * `belayd doctor` and the shared test suite to exercise every agent the same way.
   */
  sample(phase: 'pre' | 'post', command: string, cwd: string): Record<string, unknown>;
  /** What a response from `respond` tells the agent, read back the way the agent would. */
  verdictOf(result: HookResult): Answer;
}

export interface SetupOptions {
  workspace: string;
  /** User-level settings for every project, instead of this project only. */
  global: boolean;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  binPath: string;
  /** Claude Code only: its config folder, and its version when known (tests). */
  claudeConfigDir?: string;
  claudeVersion?: string;
}

export interface InstallPlan {
  file: string;
  scope: 'project' | 'global';
  /** What `init` shows the person before asking. */
  shown: unknown;
  warnings: string[];
  /** What to do after installing, such as restarting the agent. */
  after: string;
  /** Writes the hooks. Returns the backup of the file it replaced, if any. */
  apply(): string | undefined;
}

export interface Removal {
  file: string;
  /** Removes belayd's hooks. Returns the backup of the file it changed, if any. */
  apply(): string | undefined;
}

export interface DoctorLine {
  status: 'ok' | 'warn' | 'fail';
  text: string;
  hint?: string;
}

/** Installing, removing and checking an agent's hooks. Loaded only by the CLI. */
export interface AgentSetup {
  /** The hooks `init` would add, and where. */
  plan(opts: SetupOptions): InstallPlan;
  /** belayd's hooks to remove, where there are any. */
  uninstall(opts: SetupOptions): Removal[];
  /** What `belayd doctor` reports for this agent. */
  doctor(opts: SetupOptions): DoctorLine[];
}
