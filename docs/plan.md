# leashd: architecture and plan

Status: draft for review (M1). Working name `leashd`, see [Name](#name) for an open question.

## 1. What we are building

A local safety and approval layer for AI coding agents. One policy file, one audit log and one undo command across Claude Code, Codex, Cursor, Gemini CLI and MCP servers.

```
npx leashd init            # detect agents, install hooks, write leashd.yaml
leashd check 'rm -rf ~'    # dry-run a command against the policy
leashd log                 # audit trail
leashd replay <session>    # readable timeline
leashd undo <step>         # restore files changed by one step
leashd undo --session <id> # restore everything a session changed
```

leashd is a guardrail, not a sandbox. It sees what an agent asks to do through the agent's own hook system (or through the MCP gateway) and decides before the action runs. It does not stop a process that escapes those hooks. The README threat model must say this plainly.

Positioning, from `docs/landscape.md`: guards like dcg block commands, sandboxes like nono contain processes, viewers like agentsview show history. Nobody with traction combines one cross-agent policy, approvals, a replayable audit and an undo that covers shell commands. leashd is the **flight recorder and undo button for every coding agent**, with one readable policy in front.

## 2. Architecture

```
  Claude Code     Codex      Cursor     Gemini CLI     any MCP client
       |            |           |            |               |
   hook (stdin JSON / stdout JSON, one short process per call)   leashd mcp -- <server>
       |            |           |            |               |
       +------------+-----+-----+------------+---------------+
                          |
                   adapters (per agent)          normalise to an Action, map Decision back
                          |
                   policy engine                 leashd.yaml + preset, shell analysis, secrets
                          |
          +---------------+----------------+
          |               |                |
     approval broker   audit log        snapshots
     native/tty/web    SQLite, WAL,     shadow git repo,
                       hash chain       undo by step/session
```

### 2.1 Canonical action

Every adapter turns an agent event into one shape, so the engine never knows which agent it is serving.

```ts
type Action =
  | { kind: 'shell'; command: string }
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string; content?: string }      // create, overwrite, edit
  | { kind: 'fetch'; url: string; method?: string; body?: string }
  | { kind: 'mcp'; server: string; tool: string; args: unknown }
  | { kind: 'tool'; name: string; input: unknown };         // anything we do not model yet

interface ActionContext {
  agent: 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'mcp';
  sessionId: string;
  toolUseId?: string;
  cwd: string;
  workspace: string;   // repo root, used for "outside the workspace" rules
}

interface Decision {
  verdict: 'allow' | 'ask' | 'deny' | 'pass';  // pass = no opinion, the agent's own permissions decide
  reason: string;      // shown to the user and returned to the agent
  ruleId?: string;
  findings: Finding[]; // matched rules, secrets, parse warnings
}
```

### 2.2 Shell analysis

Regex on the raw command string is the main weakness of existing hook packs. leashd parses the command and evaluates every program it would run.

- Parser: [unbash](https://github.com/webpro-nl/unbash) (TypeScript, zero dependencies, Bash 5.3 grammar, tolerant, built for permission classification). Benchmarked on 13 Oct 2026, cold process, M-series Mac:

  | Parser | Median cold run | Note |
  |---|---|---|
  | none (bare `node`) | 59 ms | baseline |
  | shell-quote | 65 ms | tokeniser only, no AST |
  | unbash | 80 ms | full AST, quote removal works |
  | sh-syntax (mvdan/sh WASM) | 109 ms | accurate, too slow to load |
  | web-tree-sitter + bash | 568 ms | far too slow for a hook |

- The command becomes a flat list of invocations (argv after quote removal), most severe verdict wins:
  - lists, pipelines, `&&`, `||`, `;`, subshells, groups, functions defined inline
  - command and process substitution, `$(...)`, backticks, `<(...)`
  - re-parse string arguments of `bash|sh|zsh|dash -c`, `eval`, `su -c`, `ssh host '...'`
  - unwrap prefix programs: `sudo`, `env`, `command`, `builtin`, `exec`, `nice`, `nohup`, `timeout`, `time`, `xargs`, `find -exec/-execdir/-delete`, `git -c`, `npx`, `pnpm dlx`
  - normalise flags (`-rf` equals `-r -f`, `--force=true`), resolve `~`, `$HOME`, `..` against cwd
  - pipelines into interpreters (`curl ... | sh`, `base64 -d | bash`, `| python`) are their own pattern
  - a command name that cannot be resolved statically (`$X -rf /`, `$(echo rm)`) becomes `ask` with the reason "dynamic command"
  - parse errors become `ask` (balanced) or `deny` (strict)
- Interpreter one-liners (`python -c`, `node -e`, `perl -e`) are `ask` in balanced. We cannot reason about arbitrary code and will say so.
- **Write-then-execute.** The best objection to command allowlists is "allow `npm test` and the agent edits `package.json` to run anything". leashd sees both halves. It keeps the set of paths written in the current session, and when a command runs one of them (`./x.sh`, `bash x.sh`, `python x.py`) or is driven by one (`npm run` or `npm test` after a `package.json` write, `make` after a `Makefile` write, `git commit` after a hook file under `.git/hooks` changes), the verdict is raised to at least `ask` with a reason naming the file. Nobody in `docs/landscape.md` does this.

### 2.3 Policy file

`leashd.yaml` in the repo root (team mode later just means committing it). User rules sit on top of a preset.

```yaml
version: 1
extends: balanced            # strict | balanced | yolo-with-undo

approval:
  timeout: 120s
  onTimeout: deny
  channels: [native, web]    # native = the agent's own prompt when it has one

rules:
  - id: allow-clean-build
    match: { command: rm, args: { all: [-r] }, path: "{workspace}/dist/**" }
    decision: allow

  - id: no-prod-db
    match: { command: psql, args: { any: ["*prod*"] } }
    decision: deny
    reason: Production database access is not allowed from agents.

  - id: ask-unknown-domains
    match: { domain: "!{github.com,*.npmjs.org,registry.yarnpkg.com}" }
    decision: ask

disable: [ask-on-npm-install]   # turn off a preset rule by id, visibly
```

Match keys (all optional, all must match): `tool` (canonical kind or agent tool name glob, for example `mcp__github__*`), `command` (program plus optional subcommand, matched on parsed argv), `args` (`any`, `all`, `none` with globs), `path` (globs with `{workspace}`, `{home}`, negation for "outside"), `domain` (globs on hosts from URLs in curl, wget, fetch tools and MCP args), `secrets` (true when the secret scanner fires).

Evaluation:
1. Normalise the action. For shell, expand into invocations and evaluate each.
2. User rules first. If any user rule matches, the most severe matching user verdict wins.
3. Otherwise preset rules, most severe wins. Preset rules marked `final` can only be removed through `disable`, which is logged with the policy hash.
4. Otherwise the preset default: `pass` in balanced, `ask` in strict, `allow` in yolo-with-undo. `pass` means leashd logs the call and returns no decision, so the agent's own permission system decides as it did before. This matters: in Claude Code a hook `allow` skips the native permission prompt, so a blanket `allow` would make installing leashd reduce your safety. leashd only says `allow` when a rule explicitly says so.
5. Secret findings on outgoing content raise the verdict to at least `ask` (`deny` in strict).

Presets:
| | strict | balanced (default) | yolo-with-undo |
|---|---|---|---|
| Default when no rule matches | ask | pass (agent decides) | allow |
| Destructive outside workspace (`rm -rf ~`, `/`) | deny | deny | deny |
| Force push, history rewrite on shared branches | deny | deny | ask |
| `curl \| sh` and friends | deny | deny | ask |
| Read `.env`, keys, `~/.ssh`, cloud credentials | deny | deny | ask |
| Write outside workspace | deny | ask | ask |
| Secrets in outgoing content | deny | ask | ask |
| Network to unknown domains | ask | allow | allow |
| Snapshots before writes | on | on | on (the point of the preset) |

### 2.4 Secret detection

- Known token formats: AWS access keys, GitHub (`ghp_`, `gho_`, `github_pat_`), GitLab, Slack (`xox*`), Stripe (`sk_live_`), OpenAI and Anthropic API keys, Google API keys, private key PEM headers, JWTs.
- Workspace values: read `.env*` files in the workspace once per session, keep salted hashes of values with 12 or more characters, and look for them in outgoing content (shell command lines that send data, fetch URLs and bodies, MCP arguments).
- Optional entropy heuristic, off by default to avoid noise.
- The same scanner redacts secrets before anything is written to the audit log.

### 2.5 Approval

`ask` resolves through the first available channel:
1. **native**: the agent can show its own prompt from a hook (Claude Code interactive sessions, Cursor shell and MCP hooks). leashd passes its reason through and records the outcome when the post-action event arrives. Fastest, nothing new to learn.
2. **held call**: everywhere else (Codex, Gemini, OpenCode, headless `claude -p`, Cursor writes). The hook process does not answer yet. It writes a pending approval to SQLite, fires a desktop notification, and waits. Whoever answers first wins:
   - **tty**: the `leashd approve` console in a second terminal. We never draw over an agent's full-screen TUI.
   - **web**: `http://127.0.0.1:<port>` with a per-install random token. Good for long, unattended sessions.
3. The hook then returns a plain `allow` or `deny`. It never sends `ask` to an agent that does not support it: Codex, for example, treats `ask` as a failed hook and runs the tool.

Deadlines: no answer before `approval.timeout` means `onTimeout` (default `deny`). leashd's own deadline is always shorter than the agent's hook timeout, and `leashd init` sets the hook timeout to fit, so leashd answers `deny` itself instead of letting the agent time out and fail open.

### 2.6 Audit log

- One SQLite database at `$LEASHD_HOME/leashd.db` (default `~/.leashd`), WAL mode, `busy_timeout` for parallel hook processes.
- Append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers raise. Post-action results are new rows, not updates. Each row stores the hash of the previous row in its session, so tampering is detectable (`leashd log --verify`).
- Tables: `sessions`, `events` (session, step, phase pre/post, agent, tool, action kind, redacted input, verdict, reason, rule id, approval channel and outcome, snapshot refs, duration), `approvals`.
- `leashd log` (filterable, `--json`), `leashd replay <session>` (timeline with verdict colours, diffs per step from snapshots).
- `leashd gc --older-than 30d` is the only way rows are removed.

### 2.7 Snapshots and undo

Recommendation: a **shadow repository per workspace** at `$LEASHD_HOME/snapshots/<workspace-id>.git`, used with `GIT_DIR=<shadow> GIT_WORK_TREE=<workspace>` and its own index file.
- Never touches the user's `.git`: no refs, no objects, no index, no stash, nothing that `git push --mirror` or `git gc` could leak or break.
- Works in folders that are not Git repos.
- Respects the workspace `.gitignore` files, and leashd adds its own excludes (`node_modules`, build output) for non-Git folders.

Alternative from the handover: `refs/leashd/*` inside the user's repo. It is cheaper for huge repos (objects are shared), but it writes into the user's repo. Decision needed, see open questions.

Flow:
- **Pre-action**: for write tools with a known path, store that file's current blob (or a "did not exist" marker). For shell commands that are not on a read-only list (`ls`, `cat`, `grep`, `git status`, ...), commit the whole worktree using a persistent shadow index, so only changed files are rehashed.
- **Post-action**: commit again. The step's change set is the diff between pre and post.
- **`leashd undo <step>`**: restore exactly the paths that step changed to their pre-step content, delete files it created. If any of those paths changed again after the step, stop and show the conflict unless `--force`.
- **`leashd undo --session <id>`**: restore every path the session changed to its state at session start.
- Every undo is itself snapshotted, so undo can be undone.

Large repos: OpenCode's Git snapshots are known to be slow on big repos and submodules. leashd skips submodules, always excludes dependency and build folders, caps file size for snapshots (configurable, default 20 MB, larger files are recorded as "not restorable"), and measures snapshot time in the bench. This is the main differentiator against native checkpoints, which skip shell side effects entirely, so it has to be fast and boringly reliable.

### 2.8 Hook performance

Target from the handover: under 100 ms overhead per call. Bare Node startup on this machine is already about 60 ms, so the budget is tight.
- The hook entry point is a separate tsup bundle with only the hot path. SQLite, the approval UI and the snapshot code are loaded lazily.
- `module.enableCompileCache()` on Node 22.1+ (no-op on Node 20).
- Policy is compiled once and cached as JSON keyed by file hash.
- `scripts/bench-hook.mjs` runs 100 hook calls per scenario and CI fails if p50 is above 100 ms. We report p50 and p95 in the README.
- If we miss the budget: an optional resident process (`leashd daemon`) on a Unix socket that keeps the policy and database warm. Not in v0.1 unless needed.

### 2.9 Failing safe

- All hook code runs inside one top-level try/catch. Any error returns `deny` with the message `leashd failed: <reason>. Blocking by default.` and an audit row if the database is reachable.
- Agents fail open by default. In Claude Code a hook that crashes, times out, cannot start or prints invalid JSON is a "non-blocking error" and the tool call goes ahead. Claude Code v2.1.295 added `"onFailure": "block"` on command hooks, which turns every one of those failures into a block. `leashd init` always sets it, and `leashd doctor` warns when the installed Claude Code is older.
- For older Claude Code versions and for agents without an equivalent, the hook is installed as a shell command that blocks on any non-zero exit: `leashd hook claude-code || { echo "leashd unavailable, blocking" >&2; exit 2; }`. This also covers a missing binary (exit 127).
- Per agent, `init` turns on every fail-closed option that exists: Claude Code `onFailure: "block"`, Cursor `failClosed: true`, Goose `on_failure: "block"`, and our own OpenCode plugin throws when leashd is unreachable. Codex and Gemini have no such option, so leashd's own deadline is what protects them, and `docs/integrations.md` says so.
- `failMode: open` exists for people who want it. It is never the default and every fail-open is logged.

### 2.10 Agents reading each other's hooks

Cursor (by default) and Copilot CLI load Claude Code hooks from `.claude/settings*.json`, with their own tool names. So the Claude Code hook will run inside them.
- The hook detects the host (`cursor_version` in the payload, `CURSOR_VERSION` in the environment, Copilot equivalents). If a native leashd integration exists for that host, it does nothing. Otherwise it maps the tool names (Shell, Write, Read, `MCP:<tool>`) and evaluates, resolving `ask` as a held call.
- Every hook is installed with an explicit agent argument (`leashd hook codex`) rather than guessing from the payload.
- The audit log deduplicates on (agent, session, tool call id), so a call seen twice is recorded once.

This gives v0.1 partial Cursor coverage for free, labelled experimental.
- `leashd init` writes an absolute path to a stable install of leashd. A hook that points into an `npx` cache would break when the cache is cleared, so `init` offers `npm i -g leashd` when it detects an npx run.

### 2.11 CLI

| Command | Purpose |
|---|---|
| `leashd init` | Detect agents, choose preset, write `leashd.yaml`, install hooks (shows a diff of every config file and asks first) |
| `leashd hook <agent>` | Internal entry point the agents call |
| `leashd check '<command>'` | Dry-run the policy, prints verdict, rule and reason. Great for docs and testing |
| `leashd log`, `leashd replay`, `leashd sessions` | Audit |
| `leashd undo` | Restore by step or session |
| `leashd approve`, `leashd ui` | Terminal approval console and local web page |
| `leashd mcp -- <cmd ...>` | Run an MCP server behind the policy |
| `leashd doctor` | Check installs, hook wiring, versions, timing |
| `leashd uninstall` | Remove every hook leashd installed, restore config backups |

All commands honour `LEASHD_HOME`, and all agent installers take an explicit config dir, so tests and development never touch real global agent config.

## 3. Repository layout

```
src/
  cli/            commander entry, one file per command
  hook/           hot-path entry (bundled separately)
  policy/         schema (zod), loader, matcher, presets, shell analysis
  integrations/   claude-code, codex, mcp-gateway
  approval/       broker, tty console, local web
  audit/          sqlite store, replay renderer
  snapshots/      shadow repo, undo
  secrets/        detectors, redaction
presets/          strict.yaml, balanced.yaml, yolo-with-undo.yaml
examples/         sample policies, demo repo
docs/
tests/            policy tables, adapter contract fixtures, e2e undo, bench
```

## 4. Quality bar and tests

- **Policy table**: a YAML corpus of 300+ commands with the expected verdict per preset, including obfuscation (quotes, escapes, `$(...)`, backticks, `bash -c`, `eval`, `env`, `xargs`, `find -exec`, aliases defined inline, variables, base64 pipes, here-strings). Every bug report becomes a row.
- **Adapter contract tests**: recorded hook payloads per agent version in `tests/fixtures/<agent>/`, asserting the exact JSON we return.
- **Undo end to end**: temp repo, simulated agent edits and shell writes, undo by step and by session, byte-for-byte comparison. Non-Git folder variant.
- **Fail-safe tests**: corrupt policy, unreadable database, thrown errors, missing binary; each must block.
- **Bench**: hook latency in CI as above.
- **CI**: GitHub Actions, Node 20 and 22, ubuntu-latest and macos-latest. Lint, typecheck, test, bench, `npm pack` smoke test that runs `npx ./leashd-*.tgz check 'rm -rf /'`.

## 5. Milestones

| | Scope | Done when |
|---|---|---|
| M1 | Research, integrations doc, landscape, name, this plan | Albert approves |
| M2 | Scaffold, policy engine, shell analysis, presets, secrets, `check`, Claude Code hook with native ask, fail-safe wrapper | Policy table green, hook p50 under 100 ms, works in a real Claude Code session using a test config |
| M3 | Approval broker, `leashd approve`, local web page, timeouts | Headless `claude -p` session waits for web approval and times out to deny |
| M4 | Audit log, hash chain, `log`, `replay`, `sessions`, redaction | Replay of a recorded session reads well, `--verify` catches tampering |
| M5 | Shadow snapshots, `undo` by step and session, conflict detection | E2E undo suite green on Linux and macOS |
| M6 | Codex adapter (held-call approval, `apply_patch` parsing, trust step), stdio MCP gateway, Cursor host detection | Same policy blocks the same command in Claude Code, Codex and through an MCP server; E2E in CI with `codex exec` |
| M7 | README, GIF, demo script, examples, release notes | Fresh machine to first block in under 2 minutes |

## 6. README and launch

The README is the product page. Its first job is to make someone want the tool. Its second job is to get them to a first blocked command in under two minutes. It must read as written by a person.

Structure, top to bottom:
1. **Hero banner.** A custom SVG banner (crisp at any size, separate light and dark variants through `<picture>` and `prefers-color-scheme`), with the name, a one-line promise and a small visual of a blocked command. A 1280x640 PNG of the same design becomes the GitHub social preview, so links shared on X, LinkedIn and Slack look finished.
2. **The pitch, in a few lines.** Start from the pain everyone running agents has felt (the agent ran something you would never have approved, and you found out later), then say what leashd does about it. Concrete, no buzzwords.
3. **The GIF.** Agent tries `rm -rf ~`, blocked. Agent reads `.env`, blocked. Agent makes a bad edit, `leashd undo 3`, fixed. Under 20 seconds. Exact steps in `docs/demo-script.md`.
4. **Install in one command**, then the three commands you will actually use.
5. **What it catches**: a short table of real commands and verdicts, generated from the policy test corpus so it can never drift from the code.
6. **Policy in 30 seconds**: one small `leashd.yaml` and the three presets.
7. **How it compares**: honest table against built-in agent permissions and the closest tools from `docs/landscape.md`.
8. **Threat model**: what leashd protects against and what it does not, in plain words.
9. Supported agents, FAQ, contributing, licence.

Voice rules: short concrete sentences, a bit of personality, no em-dashes, no "seamless", "robust", "leverage" or "empower", no walls of emoji bullets, no claim we cannot show. Every number in the README (latency, test count) comes from CI.

## 7. Open questions for review

1. **Name.** See below.
2. **Snapshot storage**: separate shadow repo (recommended) or `refs/leashd/*` in the user's repo?
3. **Install path**: `npx leashd init` that installs globally and pins an absolute hook path (recommended), or keep everything npx-based and accept slower, fragile hooks?
4. **Second agent**: Codex CLI (recommended, see `docs/integrations.md`). Its hook contract is nearly the Claude Code dialect, it covers shell, edits and MCP, it is open source and runs headless in CI. Cursor is third and gets partial coverage in v0.1 through host detection.
5. **MCP gateway scope**: stdio servers only in v0.1 (recommended). OAuth remote servers stay covered by agent hooks.

## Name

Recommendation: **rename before the first public commit.** Details in `docs/landscape.md`.

Why `leashd` is a problem (checked 13 Oct 2026):
- [vmehera123/leashd](https://github.com/vmehera123/leashd) is an active Python project in exactly our space, published on PyPI as `leashd` (v2.3.0, 51 releases since March 2026, about 800 downloads a month) with the same `leashd` command, Claude Code hooks, YAML allow/deny/approval rules and an audit trail.
- `leashd.io` and `leashd.dev` are taken by AI-agent spend-governance products.
- The leash metaphor is saturated in this category: StrongDM Leash (592 stars, `leash` CLI, agent sandbox with policy), open-leash ("The open-source safety layer for AI agents"), npm `@melihmucuk/leash`, npm `leashed`, PyPI `leash` and `agent-leash`. Searching "leash ai agent" finds StrongDM first.
- npm `leashd` is still free, so keeping it is possible, but we would launch into confusion with a same-feature project.

Candidates, all free on npm, PyPI and crates.io on 13 Oct 2026, none with a same-name agent project:

| Name | Idea | Notes |
|---|---|---|
| **belayd** (recommended) | A belayer lets a climber go hard and catches the fall. That is exactly approval plus undo: "Let your agent climb. belayd catches the fall." | No DNS for belayd.dev, .sh, .com or .io (registrar check still needed). Closest neighbour: [mikepenz/agent-belay](https://github.com/mikepenz/agent-belay), a 9-star Kotlin desktop approval app, different name and form |
| curbd | Curb: restrain, keep in check | Plain, less memorable |
| heeld | "Heel": the dog walks beside you, under control | Still in the dog family, a bit cute |
| vetod | You can veto any action | `veto` itself is crowded (13 agent repos) |

Before deciding: a USPTO or EUIPO search on the final name, and registering the npm package, GitHub org and domain on the same day.
