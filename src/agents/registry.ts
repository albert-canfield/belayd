import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId } from '../policy/types.js';
import type { AgentSetup, Dialect } from './types.js';

/**
 * Every agent belayd knows about, in one place. `belayd hook <id>`, init, uninstall,
 * doctor and the audit log all work from this list, so supporting a new agent means
 * adding an adapter folder and an entry here, nothing else.
 *
 * This module is loaded on every tool call: keep it to metadata, and load the hook
 * dialect and the setup code lazily.
 */
export interface AgentEntry {
  id: AgentId;
  name: string;
  /** Other names accepted by `--agent`. */
  aliases: string[];
  /**
   * `hooks`: belayd installs its own hooks into this agent.
   * `host`: the agent runs another agent's hook files (Cursor runs Claude Code's), so it
   * is covered through that agent's hooks.
   * `planned`: recognised, not supported yet.
   */
  support: 'hooks' | 'host' | 'planned';
  /** For a host: the agent whose hook files it runs. */
  runsHooksOf?: AgentId;
  /** A cheap guess at whether this agent is installed: its config folder exists. */
  detect(env: NodeJS.ProcessEnv): boolean;
  dialect?(): Promise<Dialect>;
  setup?(): Promise<AgentSetup>;
}

const home = (env: NodeJS.ProcessEnv) => env.HOME || os.homedir();
const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

export const AGENTS: readonly AgentEntry[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    aliases: ['claude'],
    support: 'hooks',
    detect: (env) => exists(env.CLAUDE_CONFIG_DIR ?? path.join(home(env), '.claude')),
    dialect: () => import('./claude-code/hook.js').then((m) => m.claudeDialect),
    setup: () => import('./claude-code/setup.js').then((m) => m.claudeSetup),
  },
  {
    id: 'codex',
    name: 'Codex',
    aliases: ['codex-cli'],
    support: 'hooks',
    detect: (env) => exists(env.CODEX_HOME ?? path.join(home(env), '.codex')),
    dialect: () => import('./codex/hook.js').then((m) => m.codexDialect),
    setup: () => import('./codex/setup.js').then((m) => m.codexSetup),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    aliases: [],
    support: 'host',
    runsHooksOf: 'claude-code',
    detect: (env) => exists(home(env), '.cursor'),
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    aliases: ['copilot-cli', 'github-copilot'],
    support: 'hooks',
    detect: (env) => exists(env.COPILOT_HOME ?? path.join(home(env), '.copilot')),
    dialect: () => import('./copilot/hook.js').then((m) => m.copilotDialect),
    setup: () => import('./copilot/setup.js').then((m) => m.copilotSetup),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    aliases: ['gemini-cli'],
    support: 'planned',
    detect: (env) => exists(home(env), '.gemini'),
  },
  {
    id: 'ollama',
    name: 'Ollama',
    aliases: [],
    support: 'planned',
    detect: (env) => exists(env.OLLAMA_MODELS ?? path.join(home(env), '.ollama')),
  },
];

/** The agent for an id or alias, if belayd knows it. */
export function findAgent(name: string): AgentEntry | undefined {
  const n = name.trim().toLowerCase();
  return AGENTS.find((a) => a.id === n || a.aliases.includes(n));
}

/** Agents belayd can install its own hooks into. */
export function hookAgents(): AgentEntry[] {
  return AGENTS.filter((a) => a.support === 'hooks');
}

/** A person-readable name for anything that can appear as the agent of a tool call. */
export function agentName(id: string): string {
  if (id === 'mcp') return 'MCP client';
  if (id === 'cli') return 'belayd';
  return AGENTS.find((a) => a.id === id)?.name ?? id;
}

/** Every agent id with its name, for code that runs outside Node (the approval page). */
export function agentNames(): Record<string, string> {
  const names: Record<string, string> = { mcp: agentName('mcp'), cli: agentName('cli') };
  for (const a of AGENTS) names[a.id] = a.name;
  return names;
}
