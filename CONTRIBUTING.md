# Contributing

Thanks for helping. The most useful contribution is small and concrete: a command belayd got wrong.

## Report a wrong decision

Open an issue with:

- the command or tool call
- what belayd decided and what you expected (`belayd check --explain '<command>'`)
- the preset or `belayd.yaml` you use

If you can, add a row to [`tests/policy/corpus.yaml`](tests/policy/corpus.yaml) in a pull request. That file is the heart of the test suite: every row is checked against all three presets, and every bug fix starts with a row that fails.

Ways around belayd that it should have caught are security reports. Please send those privately, see [SECURITY.md](SECURITY.md).

## Develop

You need Node 22.13 or newer, pnpm 10 and Git.

```sh
pnpm install
pnpm verify          # typecheck, lint, format check and tests
pnpm build           # bundles to dist/
node scripts/bench-hook.mjs   # hook latency, fails above 100 ms of overhead
```

Run your build against a real agent without touching your own setup:

```sh
export BELAYD_HOME=$(mktemp -d)           # belayd's data
export CLAUDE_CONFIG_DIR=$(mktemp -d)     # a throwaway Claude Code config
node dist/bin.js init --global --yes
```

Tests never write to your real agent configuration. The end-to-end tests run the built binary in a temporary home folder.

## Where things live

| Path | What |
|---|---|
| `src/policy/shell.ts` | Turns a shell command into the programs it runs |
| `src/policy/subjects.ts`, `match.ts`, `engine.ts` | What a rule is matched against, and how decisions combine |
| `presets/` | The built-in policies, in plain YAML |
| `src/hook/` | The hot path for every tool call, shared by all agents |
| `src/integrations/` | Claude Code, Codex and the MCP gateway |
| `src/approval/` | Held calls, the terminal console and the local web page |
| `src/audit/` | The append-only log |
| `src/snapshots/` | Shadow repository snapshots, undo and redo |
| `docs/` | Research, the plan, and the integration notes per agent |

## Style

- Small commits with [Conventional Commits](https://www.conventionalcommits.org) messages (`feat:`, `fix:`, `docs:`, `test:`).
- Keep the hook fast. Anything heavy on the hook path is a dynamic import, and the bench must stay green.
- Fail closed. If belayd is unsure, it asks; if belayd breaks, it blocks.
- Write messages for people. A reason belayd gives should tell the agent and the user what to do next.
- No em-dashes in docs.
