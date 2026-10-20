# belayd: architecture and plan

Status: M1 to M7 shipped as 0.1.0 on 14 Oct 2026, followed by 0.2.0 (15 Oct) and 0.3.0 (19 Oct). Sections 2 to 8 are the original plan, kept as the record of why things are built the way they are. Where belayd goes next is in [section 9](#9-direction-and-roadmap).

## 1. What we are building

A local safety and approval layer for AI coding agents. One policy file, one audit log and one undo command across Claude Code, Codex, Copilot CLI, Gemini CLI, OpenCode, Cursor and MCP servers.

```
npx belayd-cli init            # detect agents, install hooks, write belayd.yaml
belayd check 'rm -rf ~'    # dry-run a command against the policy
belayd log                 # audit trail
belayd replay <session>    # readable timeline
belayd undo <step>         # restore files changed by one step
belayd undo --session <id> # restore everything a session changed
```

belayd is a guardrail, not a sandbox. It sees what an agent asks to do through the agent's own hook system (or through the MCP gateway) and decides before the action runs. It does not stop a process that escapes those hooks. The README threat model must say this plainly.

Positioning, from `docs/landscape.md`: guards like dcg block commands, sandboxes like nono contain processes, viewers like agentsview show history. Nobody with traction combines one cross-agent policy, approvals, a replayable audit and an undo that covers shell commands. belayd is the **flight recorder and undo button for every coding agent**, with one readable policy in front. Since 19 Oct the lead is the multi-agent case: see [section 9](#9-direction-and-roadmap).

## 2. Architecture

```
  Claude Code     Codex      Cursor     Gemini CLI     any MCP client
       |            |           |            |               |
   hook (stdin JSON / stdout JSON, one short process per call)   belayd mcp -- <server>
       |            |           |            |               |
       +------------+-----+-----+------------+---------------+
                          |
                   adapters (per agent)          normalise to an Action, map Decision back
                          |
                   policy engine                 belayd.yaml + preset, shell analysis, secrets
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

Regex on the raw command string is the main weakness of existing hook packs. belayd parses the command and evaluates every program it would run.

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
- Interpreter one-liners (`python -c`, `node -e`, `perl -e`) are flagged as inline code. Balanced lets the agent's own permissions decide (agents use them constantly for small calculations, and asking every time would teach people to turn belayd off); strict asks. We cannot reason about arbitrary code and say so in the threat model.
- **Scripts are read before they run** (built in v0.1). `bash x.sh`, `./x.sh` with a shell shebang and `source x.sh` are parsed like typed commands, recursively, up to 256 KB. A script written earlier in the same command is asked about.
- **Write-then-execute** (built in v0.1, session memory in `$BELAYD_HOME/sessions`). The best objection to command allowlists is "allow `npm test` and the agent edits `package.json` to run anything". belayd sees both halves. It keeps the set of paths written in the current session, and when a command runs one of them (`./x.sh`, `bash x.sh`, `python x.py`) or is driven by one (`npm run` or `npm test` after a `package.json` write, `make` after a `Makefile` write, `git commit` after a hook file under `.git/hooks` changes), the verdict is raised to at least `ask` with a reason naming the file. Nobody in `docs/landscape.md` does this.

### 2.3 Policy file

`belayd.yaml` in the repo root (team mode later just means committing it). User rules sit on top of a preset.

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
3. Otherwise preset rules, most severe wins.
4. Preset rules marked `final` are a floor: they always apply, a user rule cannot lower them, and a stricter rule from either layer still wins over them. The only way around one is `disable: [id]` in `belayd.yaml`, which is visible and logged.
5. Otherwise the preset default: `pass` in balanced, `ask` in strict, `allow` in yolo-with-undo. `pass` means belayd logs the call and returns no decision, so the agent's own permission system decides as it did before. This matters: in Claude Code a hook `allow` skips the native permission prompt, so a blanket `allow` would make installing belayd reduce your safety. belayd only says `allow` when a rule explicitly says so.
6. Secret findings on outgoing content are a normal rule (`secrets: true`), `ask` in balanced and `deny` in strict.

Across the parts of one shell command the order is deny > ask > pass > allow, so one unchecked part never inherits an explicit `allow` from its neighbour.

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
| Inline interpreter code (`python -c`) | ask | pass | allow |
| Reading inside the project, read-only commands | allow | pass | allow |
| Any write | ask | pass, outside the project ask | allow, outside the project ask |
| Changes to belayd's policy or agent hook settings | ask (final) | ask (final) | ask (final) |
| Snapshots before writes | on | on | on (the point of the preset) |

The last row is self-protection: an agent that tries to edit `belayd.yaml`, `$BELAYD_HOME` or any agent's hook settings is always asked about it, so it cannot quietly switch belayd off.

### 2.4 Secret detection

- Known token formats: AWS access keys, GitHub (`ghp_`, `gho_`, `github_pat_`), GitLab, Slack (`xox*`), Stripe (`sk_live_`), OpenAI and Anthropic API keys, Google API keys, private key PEM headers, JWTs.
- Workspace values: read `.env*` files in the workspace once per session, keep salted hashes of values with 12 or more characters, and look for them in outgoing content (shell command lines that send data, fetch URLs and bodies, MCP arguments).
- Optional entropy heuristic, off by default to avoid noise.
- The same scanner redacts secrets before anything is written to the audit log.

### 2.5 Approval

`ask` resolves through the first available channel:
1. **native**: the agent can show its own prompt from a hook (Claude Code interactive sessions, Cursor shell and MCP hooks). belayd passes its reason through and records the outcome when the post-action event arrives. Fastest, nothing new to learn.
2. **held call**: everywhere else (Codex, headless `claude -p`, Cursor through the Claude Code hooks, the MCP gateway). The hook process does not answer yet. It writes a pending request to `$BELAYD_HOME/approvals/pending/<id>.json`, fires a desktop notification, and waits. Whoever answers first wins (the decision file is created with `O_EXCL`):
   - **tty**: the `belayd approve` console in a second terminal. We never draw over an agent's full-screen TUI.
   - **web**: `http://127.0.0.1:<port>` with a per-install random token. Good for long, unattended sessions.
3. The hook then returns a plain `allow` or `deny`. It never sends `ask` to an agent that does not support it: Codex, for example, treats `ask` as a failed hook and runs the tool.

Deadlines: no answer before `approval.timeout` means `onTimeout` (default `deny`). belayd's own deadline is always shorter than the agent's hook timeout, and `belayd init` sets the hook timeout to fit, so belayd answers `deny` itself instead of letting the agent time out and fail open.

### 2.6 Audit log

- One SQLite database at `$BELAYD_HOME/audit.db` (default `~/.belayd`), WAL mode, `busy_timeout` for parallel hook processes.
- Built on `node:sqlite` (Node 22.13+) instead of better-sqlite3. Measured cost per hook call is about 1.5 ms, and there is no native module, so installs never fail on a missing prebuilt binary or compiler. This is a deliberate change from the handover, for the two-minute first run.
- Append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers raise. Post-action results are new rows, not updates. Each row stores the hash of the previous row in its session, so tampering is detectable (`belayd log --verify`).
- Tables: `sessions`, `events` (session, step, phase pre/post, agent, tool, action kind, redacted input, verdict, reason, rule id, approval channel and outcome, snapshot refs, duration), `approvals`.
- `belayd log` (filterable, `--json`), `belayd replay <session>` (timeline with verdict colours, diffs per step from snapshots).
- `belayd gc --older-than 30d` is the only way rows are removed.

### 2.7 Snapshots and undo

Recommendation: a **shadow repository per workspace** at `$BELAYD_HOME/snapshots/<workspace-id>.git`, used with `GIT_DIR=<shadow> GIT_WORK_TREE=<workspace>` and its own index file.
- Never touches the user's `.git`: no refs, no objects, no index, no stash, nothing that `git push --mirror` or `git gc` could leak or break.
- Works in folders that are not Git repos.
- Respects the workspace `.gitignore` files, and belayd adds its own excludes (`node_modules`, build output) for non-Git folders.

Alternative from the handover: `refs/belayd/*` inside the user's repo. It is cheaper for huge repos (objects are shared), but it writes into the user's repo. Decided for the shadow repository (section 7).

Flow:
- **Pre-action**: for write tools with a known path, store that file's current blob (or a "did not exist" marker). For shell commands that are not on a read-only list (`ls`, `cat`, `grep`, `git status`, ...), commit the whole worktree using a persistent shadow index, so only changed files are rehashed.
- **Post-action**: commit again. The step's change set is the diff between pre and post.
- **`belayd undo <step>`**: restore exactly the paths that step changed to their pre-step content, delete files it created. If any of those paths changed again after the step, stop and show the conflict unless `--force`.
- **`belayd undo --session <id>`**: restore every path the session changed to its state at session start.
- Every undo is itself snapshotted, so undo can be undone.

Large repos: OpenCode's Git snapshots are known to be slow on big repos and submodules. belayd skips submodules, always excludes dependency and build folders, caps file size for snapshots (configurable, default 20 MB, larger files are recorded as "not restorable"), and measures snapshot time in the bench. This is the main differentiator against native checkpoints, which skip shell side effects entirely, so it has to be fast and boringly reliable.

### 2.8 Hook performance

Target from the handover: under 100 ms overhead per call.

Measured in M2 (M-series Mac, Node 22): bare `node -e ''` is 36 to 40 ms, a full hook call is 59 to 75 ms at p50, so belayd adds 18 to 32 ms. The first version took 120 to 135 ms; two changes fixed it:
- **Compiled-policy cache.** YAML parsing and zod validation cost about 60 ms of imports. The compiled policy is cached as JSON under `$BELAYD_HOME/cache`, keyed by a SHA-256 of the policy file, every preset file and the belayd version, so any edit is picked up and the hot path reads one JSON file. The parser and validator live in a separate chunk loaded only on a cache miss.
- **Everything bundled.** All dependencies are bundled into a few chunks, so a hook call does not resolve anything in `node_modules`. The published package has no runtime dependencies (about 270 KB packed).
- Plus `module.enableCompileCache()`.

`scripts/bench-hook.mjs` measures four scenarios and reports p50, p95 and overhead over bare Node. CI fails if the overhead is above 100 ms. A resident daemon is not needed.

### 2.9 Failing safe

- All hook code runs inside one top-level try/catch. Any error returns `deny` with the message `belayd failed: <reason>. Blocking by default.` and an audit row if the database is reachable.
- Agents fail open by default. In Claude Code a hook that crashes, times out, cannot start or prints invalid JSON is a "non-blocking error" and the tool call goes ahead. Claude Code v2.1.295 added `"onFailure": "block"` on command hooks, which turns every one of those failures into a block. `belayd init` always sets it, and `belayd doctor` warns when the installed Claude Code is older.
- For older Claude Code versions and for agents without an equivalent, the hook is installed as a shell command that blocks on any non-zero exit: `belayd hook claude-code || { echo "belayd unavailable, blocking" >&2; exit 2; }`. This also covers a missing binary (exit 127).
- Per agent, `init` turns on every fail-closed option that exists: Claude Code `onFailure: "block"`, Cursor `failClosed: true`, Goose `on_failure: "block"`, and our own OpenCode plugin throws when belayd is unreachable. Codex and Gemini have no such option, so belayd's own deadline is what protects them, and `docs/integrations.md` says so.
- `failMode: open` exists for people who want it. It is never the default and every fail-open is logged.

### 2.10 Agents reading each other's hooks

Cursor (by default) and Copilot CLI load Claude Code hooks from `.claude/settings*.json`, with their own tool names. So the Claude Code hook will run inside them.
- The hook detects the host (`cursor_version` in the payload, `CURSOR_VERSION` in the environment, Copilot equivalents). If a native belayd integration exists for that host, it does nothing. Otherwise it maps the tool names (Shell, Write, Read, `MCP:<tool>`) and evaluates, resolving `ask` as a held call.
- Every hook is installed with an explicit agent argument (`belayd hook codex`) rather than guessing from the payload.
- The audit log deduplicates on (agent, session, tool call id), so a call seen twice is recorded once.

This gives v0.1 partial Cursor coverage for free, labelled experimental.
- `belayd init` writes an absolute path to a stable install of belayd. A hook that points into an `npx` cache would break when the cache is cleared, so `init` offers `npm i -g belayd` when it detects an npx run.

### 2.11 CLI

| Command | Purpose |
|---|---|
| `belayd init` | Detect agents, choose preset, write `belayd.yaml`, install hooks (shows a diff of every config file and asks first) |
| `belayd hook <agent>` | Internal entry point the agents call |
| `belayd check '<command>'` | Dry-run the policy, prints verdict, rule and reason. Great for docs and testing |
| `belayd log`, `belayd replay`, `belayd sessions` | Audit |
| `belayd undo` | Restore by step or session |
| `belayd approve`, `belayd ui` | Terminal approval console and local web page |
| `belayd mcp -- <cmd ...>` | Run an MCP server behind the policy |
| `belayd doctor` | Check installs, hook wiring, versions, timing |
| `belayd uninstall` | Remove every hook belayd installed, restore config backups |

All commands honour `BELAYD_HOME`, and all agent installers take an explicit config dir, so tests and development never touch real global agent config.

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
- **CI**: GitHub Actions, Node 22 and 24, ubuntu-latest and macos-latest. Lint, typecheck, format, test, bench, and an `npm pack` smoke test that runs the tarball through `npx`. Node 20 reached end of life on 30 Apr 2026 and current tooling (vitest 5, better-sqlite3 13, commander 15) needs Node 22, so `engines` is `>=22.13` (the first Node 22 with `node:sqlite` unflagged).

## 5. Milestones

| | Scope | Done when |
|---|---|---|
| M1 | Research, integrations doc, landscape, name, this plan | Albert approves |
| M2 | Scaffold, policy engine, shell analysis, presets, secrets, `check`, Claude Code hook with native ask, fail-safe wrapper | Policy table green, hook p50 under 100 ms, works in a real Claude Code session using a test config |
| M3 | Approval broker, `belayd approve`, local web page, timeouts | Headless `claude -p` session waits for web approval and times out to deny |
| M4 | Audit log, hash chain, `log`, `replay`, `sessions`, redaction | Replay of a recorded session reads well, `--verify` catches tampering |
| M5 | Shadow snapshots, `undo` by step and session, conflict detection | E2E undo suite green on Linux and macOS |
| M6 | Codex adapter (held-call approval, `apply_patch` parsing, trust step), stdio MCP gateway, Cursor host detection | Same policy blocks the same command in Claude Code, Codex and through an MCP server; E2E in CI with `codex exec` |
| M7 | README, GIF, demo script, examples, release notes | Fresh machine to first block in under 2 minutes |

## 6. README and launch

The README is the product page. Its first job is to make someone want the tool. Its second job is to get them to a first blocked command in under two minutes. It must read as written by a person.

Structure, top to bottom:
1. **Hero banner.** A custom SVG banner (crisp at any size, separate light and dark variants through `<picture>` and `prefers-color-scheme`), with the name, a one-line promise and a small visual of a blocked command. A 1280x640 PNG of the same design becomes the GitHub social preview, so links shared on X, LinkedIn and Slack look finished.
2. **The pitch, in a few lines.** Start from the pain everyone running agents has felt (the agent ran something you would never have approved, and you found out later), then say what belayd does about it. Concrete, no buzzwords.
3. **The GIF.** Agent tries `rm -rf ~`, blocked. Agent reads `.env`, blocked. Agent makes a bad edit, `belayd undo 3`, fixed. Under 20 seconds. Exact steps in `docs/demo-script.md`.
4. **Install in one command**, then the three commands you will actually use.
5. **What it catches**: a short table of real commands and verdicts, generated from the policy test corpus so it can never drift from the code.
6. **Policy in 30 seconds**: one small `belayd.yaml` and the three presets.
7. **How it compares**: honest table against built-in agent permissions and the closest tools from `docs/landscape.md`.
8. **Threat model**: what belayd protects against and what it does not, in plain words.
9. Supported agents, FAQ, contributing, licence.

Voice rules: short concrete sentences, a bit of personality, no em-dashes, no "seamless", "robust", "leverage" or "empower", no walls of emoji bullets, no claim we cannot show. Every number in the README (latency, test count) comes from CI.

## 7. Decisions (approved 13 Oct 2026)

1. **Name**: belayd. See below.
2. **Snapshot storage**: a separate shadow repo per workspace under `$BELAYD_HOME/snapshots`. Nothing is ever written to the user's `.git`.
3. **Install path**: `npx belayd-cli init` installs belayd globally and pins an absolute hook path.
4. **Second agent**: Codex CLI. Cursor gets partial coverage in v0.1 through host detection.
5. **MCP gateway scope**: stdio servers only in v0.1. OAuth remote servers stay covered by agent hooks.

## 8. Decisions made during the build

- **Paths are judged as written and as they really are.** Every path is matched both literally and with symlinks resolved, and `{workspace}`, `{home}` and friends expand to both forms. A symlink in the project that points into `~/.ssh` is treated as `~/.ssh`; `/tmp` and `/private/tmp` on macOS are one place.
- **Unattended Claude Code sessions are detected with `CLAUDE_CODE_SESSION_ATTENDED=0`** (set by `claude -p`, observed in Claude Code 2.1.292, not documented). Anything else is treated as attended, which keeps the native prompt.
- **Approvals are files, not rows.** The approval broker works even when SQLite is broken, and needs no daemon.
- **The approval page** listens on 127.0.0.1:23529 ("BELAY" on a phone keypad), needs a per-install token, and checks the Host header, a SameSite=Strict cookie and a custom request header.
- **Snapshots** skip read-only commands, files over 20 MB, belayd's own folder, and agents running in the home folder or at `/`. An unchanged workspace costs one `git status`.
- **Codex** gets no `ask` and no plain `allow`: a held call answers deny, or nothing plus a `systemMessage`.
- **MCP tool calls** get file and shell rules: path-like arguments are reads or writes, and shell-style tools have their command analysed.

## 9. Direction and roadmap

Written 19 Oct 2026, after 0.3.0.

| Release | Date | What it added |
|---|---|---|
| 0.1.0 | 14 Oct | M1 to M7: policy, shell analysis, approvals, audit, undo, Claude Code, Codex, Copilot CLI, Gemini CLI, the MCP gateway |
| 0.2.0 | 15 Oct | `belayd tune`, checks inside scripts the agent wrote, environment runners (`uv run`, `poetry run`), OpenCode, the GitHub Action, the differential test |
| 0.3.0 | 19 Oct | `belayd scan`, undo per agent when several share a project, extra folders, snapshot retention, trust for committed and unchanged scripts |
| 0.4.0 | 20 Oct | A question before one agent wrecks another's uncommitted work, `belayd ps`, questions for agents started with their safety off, the mods check in `doctor`, questions for skipped Git hooks, public repositories, files that run code, cloud deletes and database resets, OpenCode 2, much cheaper snapshots in big projects, and a fix for a repository's Git config running code |

### What changed around us

The market check in [landscape.md](landscape.md) changed the plan more than any bug did:

- **Blocking is a commodity.** Perplexity and Gen Digital/Norton ship free hook guards, cc-safety-net gets about 59,000 npm downloads a month, and every agent now blocks and asks on its own. Being one more blocker gets belayd ignored.
- **Undo got rarer.** Codex removed it, node9 removed it after its store hit 378 GB, and Claude Code's `/rewind` still skips Bash.
- **Classifiers are the default.** Claude Code's auto mode is on for everyone, and Anthropic reports it misses 17% of real overeager actions. People keep it on. They want a floor under it, not a replacement.
- **People run several agents at once**, and nothing on the list handles that.
- **On 20 Oct a second check added more.** Agent issue trackers are full of parallel agents losing each other's work to `git stash` and `git checkout --` (claude-code #26264, #102465; codex #10681, which OpenAI called model behaviour it cannot fix in the harness). Cloned repositories now attack agents through their own Git config, subagent files and plugin updates. Models invent package names often enough that attackers register them. OpenCode 2 stopped running OpenCode 1 plugins. Sources are in [landscape.md](landscape.md#what-changed-since-19-oct).

### What belayd is for, from here

Be very good at a narrow job other tools can't do, rather than adequate at a broad one everyone does:

1. **Several agents, one project.** belayd sees every agent's calls in one log, so it is the one place that can tell them apart, stop one from wrecking another's work, and undo one without touching the others. This is the lead in the README and in every launch post.
2. **Undo that covers the shell**, tied to an audit row and bounded on disk.
3. **Asking where the agent can't**: Codex ignores `ask`, Cursor doesn't enforce it, Copilot's hooks fail open on timeout, and headless runs have nobody at the prompt.
4. **A quiet, readable floor under the classifiers.** Keep auto mode. belayd adds rules you can read, a log and an undo, and stays silent the rest of the time.

What it won't chase: pattern packs for their own sake, an account or a cloud service, a sandbox of its own, or a language model in the hook path.

### How the work is judged

- **Precision may only add findings, unless the set of values is provably complete.** A feature that turns a question into a quiet pass gets adversarial tests that try to abuse it before it is committed. The worst regressions found in the October security reviews came from features like these.
- **Quiet is measured, not claimed.** Every release replays real agent history with `belayd scan` and must not add questions without a reason.
- **Misses are measured too.** The differential test runs about 700 commands in real bash and fails on anything dangerous that belayd let through. When a precision change sits in the test's blind spot, the oracle gets sharper; belayd does not get looser.
- **The hook stays fast.** CI fails if belayd's overhead goes above 100 ms.

### Shipped in 0.4.0: agents that share a project

All four items shipped in 0.4.0: the collision guard (`ask-other-agents-work`, src/policy/clobber.ts, fed by a per-project ledger of which session's commands named which files), agents started with their safety off (`ask-agent-without-safety`, src/policy/unguarded.ts), the live view (`belayd ps`), and the mods check in `belayd doctor`. Each has corpus rows or end-to-end tests that try to get around it.

### 0.5: what a project brings with it

| | Scope | Done when |
|---|---|---|
| A look before the first command | When an agent starts work in a project, list what can run code or steer the agent there: command-running Git options in the project's own config, each agent's project hooks and plugins, subagent and skill files, MCP servers, editor tasks. Remember them, and ask when one is new or changed since belayd last saw it | A cloned repository with a planted `core.fsmonitor`, a project hook and a subagent file gets one question naming all three; an unchanged project gets none |
| Packages nobody has heard of | Ask before an agent installs a package that is not in the lockfile and is either brand new or missing from the registry (the shape of slopsquatting), across npm, pnpm, yarn, bun, pip, uv and cargo, through runners and wrappers | Corpus rows for each manager; a registry lookup that is cached, has a short deadline and asks when it cannot answer |
| Secrets that already reached an agent | `belayd scan` reports keys and tokens found in agents' past transcripts and tool output, by file and kind, never printing the value | Finds planted test keys in a fake history; prints none of them |
| Install as a Claude Code plugin | A marketplace in this repository, so `claude plugin install` sets belayd up | A fresh Claude Code installs it from the marketplace and blocks `cat .env` |

### Later

- **Easier installs.** Copilot CLI and Gemini CLI extension packages, the action listed on GitHub Marketplace, awesome-claude-code once the project is 14 days old, and a Homebrew tap until Homebrew core's star threshold is met.
- **The quiet tail.** Deletes of temporary paths belayd can't resolve, programs chosen through a variable, and `git update-ref` still ask more often than they need to.
- **More agents.** Antigravity CLI once its hooks settle, and Ollama's own agent once it has a hook point.
- **A page on using belayd alongside auto mode and a sandbox**, since that is how most people will run it.
- **An audit export** (JSONL and OpenTelemetry) for teams that keep agent logs centrally. Research in September showed agents in every major harness can delete their own traces; belayd's log already sits outside the agent's control.
- **Cross-agent write-then-run.** belayd asks when an agent runs a script it changed itself. The same question when one agent runs what another agent just wrote.

### Risks

- **Claude Code closes part of the gap.** A `/rewind` that tracks Bash, or Anthropic's sample `blast-radius` mod becoming a built-in feature, would cover single-agent undo on the biggest agent. The multi-agent work stays useful either way, which is one more reason to lead with it.
- **Mods can overrule hooks** on machines without managed settings. Documented in the README and SECURITY.md; `belayd doctor` lists such mods since 0.4.
- **Agents change their plugin and hook formats.** OpenCode 2 silently stopped running OpenCode 1 plugins. Every agent belayd supports gets a live check before a release that names it.
- **Name confusion** with other "belay" projects (see [landscape.md](landscape.md#risks-to-watch)).

## Name

**belayd.** A belayer lets a climber go hard and catches the fall. That is the product: let the agent work, and catch it when it slips, with approval before the risky move and undo after the bad one.

The working name was `leashd`. We dropped it because an active Python project with the same name, command and feature set already ships on PyPI, `leashd.io` and `leashd.dev` are taken, and the leash metaphor is crowded in this category (StrongDM Leash, open-leash, npm `leashed`, PyPI `leash` and `agent-leash`).

`belayd` was free on npm, PyPI and crates.io on 13 Oct 2026, with no same-name agent project. The nearest neighbour is [Agent Belay](https://github.com/mikepenz/agent-belay), a small Kotlin desktop app for approving Claude Code and Copilot actions. Different name and different form, but we mention it in the comparison.

At release npm refused `belayd` as too similar to the existing package `delay`, so the package is `belayd-cli` and the command it installs is still `belayd`. The same filter keeps anyone else from registering `belayd`.
