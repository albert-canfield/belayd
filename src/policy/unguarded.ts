/**
 * Coding agents started with their own safety switched off: `claude
 * --dangerously-skip-permissions`, `codex --yolo`, `gemini --approval-mode yolo`. The
 * agent that runs such a command hands its work to a second agent that asks nobody.
 *
 * Flags were read from each agent's `--help` or reference docs (20 Oct 2026).
 */

interface AgentFlags {
  /** Flags that switch safety off on their own. */
  flags: string[];
  /** Options that switch safety off with one of these values. */
  values?: Record<string, string[]>;
}

const CODEX_CONFIG = ['sandbox_mode=danger-full-access', 'approval_policy=never'];
const GEMINI: AgentFlags = { flags: ['--yolo', '-y'], values: { '--approval-mode': ['yolo'] } };

const AGENTS: Record<string, AgentFlags> = {
  claude: {
    flags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
    values: { '--permission-mode': ['bypassPermissions'] },
  },
  codex: {
    flags: [
      '--dangerously-bypass-approvals-and-sandbox',
      '--yolo',
      '--dangerously-bypass-hook-trust',
    ],
    values: {
      '-s': ['danger-full-access'],
      '--sandbox': ['danger-full-access'],
      '-a': ['never'],
      '--ask-for-approval': ['never'],
      '-c': CODEX_CONFIG,
      '--config': CODEX_CONFIG,
    },
  },
  gemini: GEMINI,
  qwen: GEMINI,
  copilot: {
    flags: ['--allow-all', '--yolo', '--allow-all-tools', '--allow-all-paths', '--allow-all-urls'],
  },
  opencode: { flags: ['--auto'] },
  'cursor-agent': { flags: ['--force', '-f', '--yolo', '--approve-mcps'] },
  droid: { flags: ['--skip-permissions-unsafe'], values: { '--auto': ['high'] } },
  amp: { flags: ['--dangerously-allow-all'] },
  crush: { flags: ['--yolo', '-y'] },
  aider: { flags: ['--yes-always'] },
  q: { flags: ['--trust-all-tools'] },
  'kiro-cli': { flags: ['--trust-all-tools'] },
};

/** `ollama launch <agent>` names agents by these words. */
const OLLAMA_AGENTS: Record<string, string> = { claude: 'claude', 'claude-code': 'claude' };

/**
 * The agent and the flag that switch its safety off (`claude
 * --dangerously-skip-permissions`), or undefined. `raw` is the argument list after the
 * program name, as written.
 */
export function safetyOff(program: string | undefined, raw: string[]): string | undefined {
  if (!program) return undefined;
  if (program === 'ollama' && raw[0] === 'launch') {
    // `ollama launch claude --model m -- --dangerously-skip-permissions`: only the words
    // after `--` reach the agent.
    let name: string | undefined;
    for (let i = 1; i < raw.length && raw[i] !== '--'; i++) {
      if (raw[i] === '--model' || raw[i] === '-m') i++;
      else if (!raw[i]!.startsWith('-')) {
        name = raw[i];
        break;
      }
    }
    const split = raw.indexOf('--');
    if (!name || split < 0) return undefined;
    return safetyOff(OLLAMA_AGENTS[name] ?? name, raw.slice(split + 1));
  }
  const agent = AGENTS[program];
  if (!agent) return undefined;
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i]!;
    // After `--` come prompts and files, not options.
    if (word === '--') break;
    if (agent.flags.includes(word)) return `${program} ${word}`;
    const values = agent.values;
    if (!values) continue;
    let option: string | undefined;
    let value: string | undefined;
    const eq = word.indexOf('=');
    if (word.startsWith('--') && eq > 0) {
      option = word.slice(0, eq);
      value = word.slice(eq + 1);
    } else if (values[word]) {
      option = word;
      value = raw[i + 1];
    } else if (/^-[A-Za-z]./.test(word) && values[word.slice(0, 2)]) {
      // `-sdanger-full-access` and `-s=danger-full-access`
      option = word.slice(0, 2);
      value = word.slice(2).replace(/^=/, '');
    }
    if (option === undefined || value === undefined) continue;
    const bad = values[option];
    if (bad?.includes(normal(value))) return `${program} ${option} ${value}`;
  }
  return undefined;
}

/** `sandbox_mode = "danger-full-access"` and `sandbox_mode=danger-full-access` are the same. */
function normal(value: string): string {
  return value.replace(/["'\s]/g, '');
}
