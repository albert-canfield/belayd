# Landscape

Who else is working on agent safety, what they do well, and where the gap is. Surveyed 13 Oct 2026. Star counts come from the GitHub API on that date. Feature notes come from each project's README and docs; a "?" means we could not confirm it.

## The short version

Everyone has a piece of this, and nobody has all of it with real traction:

- **Guards** (dcg, cc-safety-net, nah) block dangerous commands well. None of them can undo anything, and most only block, so they cannot ask.
- **Sandboxes** (sandbox-runtime, nono, Agent Safehouse, Docker Sandboxes) contain the process. They are the right answer for hostile code, but they do not reason about individual tool calls, and most never ask you anything.
- **Session viewers** (agentsview, history viewers) show you what happened after the fact. They have no policy and no undo.
- **Native agent features** keep getting better, but each agent uses its own format, and their undo misses shell side effects. Claude Code `/rewind` and Cursor checkpoints both skip changes made by terminal commands.
- **The closest overall matches** are small. agentjail (96 stars) has allow/ask/deny with a SQLite audit and replay, but no undo and three agents. Kintsugi (5 stars) has almost exactly our pitch. nono (4,480 stars) has approvals, a tamper-evident audit and rollback, but it is a process wrapper, not a per-call policy.

## What the agents do natively

This is the platform risk. Every agent now has its own allow/ask/deny system, each in a different format.

| Agent | Policy | Ask | Undo | Notes |
|---|---|---|---|---|
| Claude Code | `permissions` allow/ask/deny, hooks, `/sandbox` | Yes | `/rewind` checkpoints | Checkpoints do not track files changed by Bash (`rm`, `mv`, `cp`), subagent edits or linked files ([docs](https://code.claude.com/docs/en/checkpointing)). Auto mode (an LLM classifier) is the default starting mode from v2.1.283 |
| Codex CLI | Sandbox modes, approval policies, `.rules` files with `prefix_rule` ([docs](https://developers.openai.com/codex/rules)) | Yes | `/undo` shipped in 2025 | Current status of `/undo` not confirmed |
| Gemini CLI | TOML policy engine with allow, deny, ask_user and priorities ([docs](https://geminicli.com/docs/reference/policy-engine/)) | Yes | Shadow Git checkpointing in `~/.gemini/history`, off by default | |
| Cursor | Hooks returning allow, deny or ask ([docs](https://cursor.com/docs/agent/hooks)) | Yes | Checkpoints cover agent edits, not terminal commands | Reported bugs: hook `ask` broken in 2.4.21, malformed hook JSON lets the command run |
| OpenCode | Permissions | Yes | `/undo` and `/redo` through an internal Git snapshot | Needs a Git repo, slow on large repos and submodules |

## Guardrails and policy hooks

| Project | Stars | Licence | Language | How it works | Agents | Decisions | Audit | Undo |
|---|---|---|---|---|---|---|---|---|
| [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) | 6,165 | custom | Rust | Hook with regex packs (Aho-Corasick), heredoc and inline script scanning, 50+ packs | about 15 | deny, warn, log, ask | logged, format undocumented | no |
| [cc-safety-net](https://github.com/kenryu42/cc-safety-net) | 1,615 | MIT | TS | Hook with semantic parsing that sees through `bash -c` and wrappers, strict and paranoid presets | 15+ | block only | ? | no |
| [nah](https://github.com/manuelschipper/nah) | 485 | MIT | Rust | Hook that maps calls to typed effects, 48 guards, explicit threat model, never returns allow | 15+ | block, delegate | `nah log`, `nah why` | no |
| [Cupcake](https://github.com/eqtylab/cupcake) | 297 | Apache-2.0 | Rust | Hooks plus Rego compiled to Wasm, separate policies per agent | 4 | allow, deny, review, modify | enriched audit | no |
| [Sondera hooks](https://github.com/sondera-ai/sondera-coding-agent-hooks) | 228 | MIT | Rust | Hook adapters to a gRPC daemon, Cedar and YARA, fail-closed, publishes a per-agent capability matrix | 10 | allow, deny, escalate | trajectory TUI | no |
| [Gryph](https://github.com/safedep/gryph) | 176 | Apache-2.0 | Go | Hooks with YAML and CEL rules | 8 | block, warn, guide, allow | local SQLite, replay, session diffs | no |
| [agentjail](https://github.com/LuD1161/agentjail) | 96 | Apache-2.0 | Go | Hooks, daemon, OPA/Rego, optional Landlock or Seatbelt shield, MITM proxy | 3 | allow, ask, deny | SQLite plus `agentjail replay` | no |
| [Kintsugi](https://github.com/arrowassassin/kintsugi) | 5 | MIT | Rust | Hooks and a PATH shim, Bash AST, unparseable commands are held | 8 | hold, deny | hash-chained log | yes, before destructive operations |
| [claude-code-damage-control](https://github.com/disler/claude-code-damage-control) | 480 | none | Python | Regex patterns and path tiers | Claude Code | block, ask | no | no |
| [rulesync](https://github.com/dyoshikawa/rulesync) | 1,514 | MIT | TS | Compiles one permissions file into each agent's native format, no runtime enforcement | many | native | no | no |

What Hacker News says about this category (threads on nah, 127 points, and cc-safety-net, 61 points): "wrong layer, just use a container", "a deny list with extra steps", and "if you allow `npm test` the agent can edit `package.json` to get around you". All three are fair, and our README should answer them directly.

## Checkpoints and undo

| Project | Stars | Mechanism | Covers shell side effects |
|---|---|---|---|
| Claude Code `/rewind` | native | file snapshots per prompt | no |
| Cursor checkpoints | native | local snapshots | no |
| Gemini CLI checkpointing | native | shadow Git repo, off by default | not confirmed |
| OpenCode `/undo` | native | Git snapshot of the working tree | yes, needs Git, slow on big repos |
| [ccundo](https://github.com/RonitSachdev/ccundo) | 1,401 | replays Claude session files | no, and largely superseded by `/rewind` |
| [Entire CLI](https://github.com/entireio/cli) | 5,178 | session provenance stored in `refs/entire/*`, `entire blame` | no file-level undo today, well funded, could move here |
| [nono](https://github.com/nolabs-ai/nono) `--rollback` | 4,480 | content-addressed snapshots | yes |
| [unf](https://www.unfudged.io/) | 46 | daemon snapshotting every text file save | yes, any tool |

## MCP gateways

| Project | Stars | Policy | Human approval | Audit | Local |
|---|---|---|---|---|---|
| [agentgateway](https://github.com/agentgateway/agentgateway) | 5,313 | authorisation policies | no | OTel | self-host |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) | 4,622 | plugins, RBAC | ? | yes | self-host |
| [ToolHive](https://github.com/stacklok/toolhive) | 2,279 | containers, permission profiles | no | yes | desktop and K8s |
| [Docker MCP Gateway](https://github.com/docker/mcp-gateway) | 1,599 | per-profile tool enablement, interceptors | no | `--log-calls` | yes |
| [Obot](https://github.com/obot-platform/obot) | 1,106 | access policies, filters | through filters | yes | self-host |
| [Claw Patrol](https://github.com/denoland/clawpatrol) | 1,079 | wire-level rules, HCL and CEL | yes | yes | self-host |
| [Lasso MCP Gateway](https://github.com/lasso-security/mcp-gateway) | 395 | secret and PII masking | no | yes | yes |
| [mcp-guardian](https://github.com/eqtylab/mcp-guardian) | 201 | proxy plus desktop app | yes | yes | yes, but inactive since Aug 2025 |
| [Preloop](https://github.com/preloop/preloop) | 77 | YAML and CEL | yes, mobile, Slack, email | yes | Docker or cloud |

MCP gateways are mostly server-side and identity-centric. Local, per-developer approval of MCP calls barely exists. Note that Claude Code hooks already see MCP calls as `mcp__<server>__<tool>`, so for Claude Code we can cover MCP through hooks alone. The gateway matters for agents whose hooks do not cover MCP.

## Sandboxes

| Project | Stars | Mechanism | Ask | Audit | Undo |
|---|---|---|---|---|---|
| [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | 5,532 | Seatbelt, bubblewrap, seccomp, domain allowlist, powers Claude Code `/sandbox` | no | violations | no |
| [nono](https://github.com/nolabs-ai/nono) | 4,480 | Landlock or Seatbelt capabilities with a supervisor, L7 network filtering | Linux only | hash-chained | yes |
| [container-use](https://github.com/dagger/container-use) | 4,068 | container and Git branch per agent | no | command log | discard the branch |
| [Agent Safehouse](https://github.com/eugene1g/agent-safehouse) | 2,105 | macOS sandbox-exec profiles, 823 points on HN | no | no | no |
| [StrongDM Leash](https://github.com/strongdm/leash) | 592 | container, eBPF, Cedar, MITM proxy, control UI | toggles in UI | yes | no |
| Docker Sandboxes | product | microVM per agent | no | ? | disposable |

These are complements, not competitors. leashd should recommend pairing with one of them for untrusted code.

## Session audit and replay

[agentsview](https://github.com/kenn-io/agentsview) (6,095 stars, local SQLite, replay, 50+ agents) leads this group, followed by [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) (2,247), [specstory](https://github.com/specstoryai/getspecstory) (1,352) and [agents-observe](https://github.com/simple10/agents-observe) (694). None of them enforce policy or undo anything.

## Gaps we can own

1. **All four in one local tool.** One policy, ask, audit with replay, and undo, across agents. Nobody with traction does this.
2. **Undo that covers shell commands.** Native checkpoints skip Bash and terminal changes. A snapshot before every mutating call, Bash included, linked to its audit row, makes "undo step 7" and "undo this session" real.
3. **Parsing, with unparseable meaning ask.** Most hook packs match regex on the raw string. Only Kintsugi treats "cannot parse" as "hold".
4. **A policy file people can read.** The alternatives are Rego, Cedar, CEL, or a separate format per agent.
5. **Consistent approval.** Several agents cannot ask from a hook, and Cursor has `ask` bugs and fails open on malformed hook output. leashd brings its own approval channel with a fail-closed timeout.
6. **Honesty.** Publish a threat model and a per-agent capability matrix (what we can intercept, ask about and undo for each agent). Sondera does the matrix well. This turns the "wrong layer" criticism into a point in our favour.
7. **Write-then-execute awareness.** The HN `package.json` objection: if the agent edits a script and then runs it, a command allowlist is meaningless. leashd sees both the write and the run in the same session and can raise the run to `ask`. No one in this list does that.

## Positioning

Not another command blocker, not another sandbox. leashd is the local **flight recorder and undo button** for every coding agent, with one readable policy in front:

- one short allow/ask/deny file, enforced through each agent's own hooks
- real shell parsing, where anything it cannot understand becomes a question
- its own approval channel wherever an agent's native ask is missing or broken
- every call and decision in a local timeline you can replay
- a snapshot before every change, shell commands included, so any step or whole session can be undone

The threat model says it plainly: guardrail, recorder and recovery, not a containment boundary. For untrusted code, pair it with a sandbox.

## Name conflicts

The name `leashd` is a problem.

| Project | What it is | Risk |
|---|---|---|
| [vmehera123/leashd](https://github.com/vmehera123/leashd) | PyPI `leashd`, v2.3.0, 51 releases since March 2026, about 800 downloads a month. Claude Code daemon with YAML allow/deny/approval rules, web and Telegram approvals, audit trail, `leashd` CLI | High: same name, same category, same features |
| leashd.io, leashd.dev ([brainbytes-dev/leashd](https://github.com/brainbytes-dev/leashd)) | AI agent spend governance | Medium: the obvious domains are gone |
| [StrongDM Leash](https://github.com/strongdm/leash) | 592 stars, `leash` CLI, npm `@strongdm/leash`, agent sandbox with policy | Medium: "leashd" reads as "the Leash daemon" |
| [open-leash/leash](https://github.com/open-leash/leash) | "The open-source safety layer for AI agents", approvals and history | Medium: near-identical tagline |
| npm `@melihmucuk/leash`, npm `leashed`, PyPI `leash`, PyPI `agent-leash` | Guardrails, policy and sandboxes for agents | Low each, high together |

The leash metaphor is saturated in this exact category. See `docs/plan.md` for alternatives.
