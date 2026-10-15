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
pnpm differential    # needs Docker: runs every command for real and compares
```

`pnpm differential` is the test that keeps the shell analysis honest. It runs each command of the corpus, plus generated variants that hide a dangerous action in many ways, in a container with no network, as an unprivileged user, and records what bash really deleted, wrote and read. Anything dangerous that belayd let through fails the run, unless it is listed with a reason in `tests/differential/known-misses.txt`. Add a disguise to `tests/differential/cases.mjs` when you think of one: if it fails, you found a bypass. `--only <text>` runs just the commands containing that text.

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
| `src/agents/` | One adapter per agent, and the registry that lists them |
| `src/integrations/mcp/` | The MCP gateway |
| `src/approval/` | Held calls, the terminal console and the local web page |
| `src/audit/` | The append-only log |
| `src/snapshots/` | Shadow repository snapshots, undo and redo |
| `docs/` | Research, the plan, and the integration notes per agent |

## Add an agent

Every agent is one adapter in `src/agents/<id>/` and one entry in `src/agents/registry.ts`. Nothing in the policy engine, the CLI or the audit log needs to change.

1. Read the agent's hook documentation and write down, in `docs/integrations.md`: where hook files live, the payload it sends, the answer it reads, whether it can ask, and whether a failed or timed-out hook blocks or lets the tool run.
2. Write `hook.ts` with a `Dialect` (`src/agents/types.ts`): `parse` turns the agent's JSON into a `ToolEvent`, `toAction` maps its tool names to belayd actions, `respond` answers in its format, and `sample` and `verdictOf` let the shared tests drive it.
3. Write `setup.ts` with an `AgentSetup`: where `init` writes the hooks, how `uninstall` removes only belayd's entries, and what `belayd doctor` checks.
4. Add the entry to the registry. `tests/agents/conformance.test.ts` then runs the same checks against it as against every other agent: it must block `rm -rf ~`, stay quiet for `npm test`, block on input it cannot read, never let a question through unanswered, and record what ran.
5. If the agent cannot show a prompt from a hook, answer `false` from `canAskNatively`: belayd then holds the call and asks the person itself. If a hook timeout lets the tool run, keep the hook's `--timeout` below the agent's limit so belayd answers first.
6. Try it in a real session, with a throwaway config folder, before calling it supported.

## Style

- Small commits with [Conventional Commits](https://www.conventionalcommits.org) messages (`feat:`, `fix:`, `docs:`, `test:`).
- Keep the hook fast. Anything heavy on the hook path is a dynamic import, and the bench must stay green.
- Fail closed. If belayd is unsure, it asks; if belayd breaks, it blocks.
- Write messages for people. A reason belayd gives should tell the agent and the user what to do next.
- No em-dashes in docs.
