# Landscape

Who else is working on agent safety, what they do well, and where the gap is. First surveyed 13 Oct 2026, updated 19 Oct 2026. Star counts and release dates come from the GitHub API on 19 Oct; rows marked † were not re-checked and show 13 Oct figures. Feature notes come from each project's README and docs; a "?" means we could not confirm it.

## The short version

Blocking is now a commodity. Undo is not, and running several agents at once is barely covered.

- **Every agent blocks and asks on its own now**, three of them through an LLM classifier. Claude Code's auto mode is the default, and Anthropic's own figures say it misses 17% of real overeager actions. None of the agents shares a policy with the others, keeps a replayable local log, or confirms undo of what a shell command did.
- **Guards** are crowded. Perplexity ([Numbat](https://github.com/perplexityai/numbat)) and Gen Digital/Norton ([Sage](https://github.com/gendigitalinc/sage)) ship free hook guards, and cc-safety-net gets about 59,000 npm downloads a month. A new tool that only blocks `rm -rf` reads as the twentieth one.
- **Undo got less crowded.** Codex removed its undo in April. node9 removed its shadow-git undo in August after the store reached 378 GB on one machine. Claude Code's `/rewind` still skips Bash. Only wrap-the-agent runtimes (nono, agentsh) roll back shell changes.
- **Sandboxes** contain the process. They are the right answer for hostile code, but they don't reason about single tool calls and mostly never ask.
- **Several agents in one project** is the open space. Nobody we found tells you which agent changed a file, undoes one agent's work while another keeps going, or warns before one agent throws away another's uncommitted changes.

## What changed since 13 Oct

- Codex removed undo: [PR #19481](https://github.com/openai/codex/pull/19481), merged 28 Apr 2026, made it "a no-op that reports the feature is unavailable".
- node9 removed its shadow-git undo on 22 Aug 2026. Its own code says the store "grew ~19 MB per minute of active agent work and took one machine to 378 GB" ([undo.ts](https://github.com/node9-ai/node9-proxy/blob/main/src/cli/commands/undo.ts)).
- Copilot CLI added `/undo` for the files Copilot changed.
- Claude Code added mods (v2.1.287+), JavaScript handlers that can overrule a PreToolUse hook on machines without managed settings.
- New neighbours: node9, Numbat, Sage, Fence, ryk, Dippy, pipelock, agentsh.
- [leashd](https://github.com/vmehera123/leashd), whose name we nearly took, now calls itself "Run Claude Code as a daemon. Drive it from your phone."

## What the agents do natively

| Agent | Blocks and asks | Ask from a hook | Undo | Notes |
|---|---|---|---|---|
| Claude Code 2.1.303 | Rules, hooks, auto mode (LLM classifier, the default from v2.1.283), Bash-only sandbox off by default | Yes | `/rewind` skips files changed by Bash, most subagent edits and linked files; swept after about 30 days ([docs](https://code.claude.com/docs/en/checkpointing)) | Auto mode misses 17% of real overeager actions (n=52) with 0.4% false positives ([Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)). Mods can approve a call a hook blocked, and even override deny rules, unless managed settings are in place ([permissions](https://code.claude.com/docs/en/permissions)) |
| Codex CLI 0.163.0 | Sandbox modes, approval modes, optional `auto_review` agent | No: `ask` is "parsed but not supported yet" ([hooks](https://learn.chatgpt.com/docs/hooks)) | None since April 2026 | Hooks must be trusted before they run |
| Copilot CLI 1.0.100 | Approval prompts, `--allow-tool` and `--deny-tool`, `/yolo`, local sandbox off by default | Yes, but hook timeouts "are fail-open for every event" ([reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference)) | `/undo` restores "only the files that Copilot changed", skips files over 10 MB and turns over 500 files; shell changes not stated ([rollback](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/cancel-and-roll-back)) | |
| Gemini CLI 0.64.0 | TOML policy engine, sandbox off by default | Yes | Checkpointing off by default, only on `write_file` and `replace` ([docs](https://geminicli.com/docs/cli/checkpointing/)) | Changed project hooks count as untrusted |
| Cursor | Auto-review classifier (Gemini 3.5 Flash Lite, Haiku 4.5 as fallback), hooks | Accepted by the schema "but not enforced" ([hooks](https://cursor.com/docs/agent/hooks)) | Checkpoints cover Agent changes; a third-party guide says terminal side effects are skipped | Hooks fail open unless `failClosed` is set |
| OpenCode 1.19.3 | allow, ask, deny with wildcards; `.env` reads denied by default | Through plugins | `/undo` through Git, needs a Git repository ([tui](https://opencode.ai/docs/tui/)) | |

## Guardrails and policy hooks

| Project | Stars | Licence | How it works | Agents | Decisions | Audit | Undo |
|---|---|---|---|---|---|---|---|
| [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) | 6,189 | MIT plus a rider barring OpenAI and Anthropic | Regex packs, AST for heredocs and inline scripts | about 15 | block, ask where the host allows | opt-in history | no |
| [cc-safety-net](https://github.com/kenryu42/cc-safety-net) | 1,687 | MIT | Parses commands, sees through `bash -c` and wrappers | 16 | block | ? | no |
| [Numbat](https://github.com/perplexityai/numbat) (Perplexity) | 1,132 | Apache-2.0 | CEL rules, blocking opt-in and off by default | about 28 | block | NDJSON, forensics | no |
| [nah](https://github.com/manuelschipper/nah) | 487 | MIT | Maps calls to typed effects, never returns allow | Claude, Codex, Cursor, Pi and more | block, defer to host | `nah log` | no |
| [Sage](https://github.com/gendigitalinc/sage) (Gen Digital) | 317 | Apache-2.0 | 300+ YAML patterns, cloud URL reputation; errors allow | Claude (plugin), Cursor, VS Code, OpenClaw, OpenCode | block, ask | yes | no |
| [Cupcake](https://github.com/eqtylab/cupcake) † | 297 | Apache-2.0 | Rego compiled to Wasm, one policy per agent | 4 | allow, deny, review, modify | enriched audit | no |
| [Dippy](https://github.com/ldayton/Dippy) | 242 | MIT | Its own bash parser | Claude | block, ask | ? | no |
| [Sondera hooks](https://github.com/sondera-ai/sondera-coding-agent-hooks) † | 228 | MIT | gRPC daemon, Cedar and YARA, fail-closed, per-agent capability matrix | 10 | allow, deny, escalate | trajectory TUI | no |
| [node9](https://github.com/node9-ai/node9-proxy) | 219 | Apache-2.0 | Shell AST, MCP gateway, GitHub Action, paid tier | 12 | block, ask (chat or team) | yes | removed Aug 2026 |
| [Gryph](https://github.com/safedep/gryph) † | 176 | Apache-2.0 | YAML and CEL rules | 8 | block, warn, guide, allow | SQLite, replay, session diffs | no |
| [agentjail](https://github.com/LuD1161/agentjail) † | 96 | Apache-2.0 | Daemon, OPA/Rego, optional Landlock or Seatbelt, MITM proxy | 3 | allow, ask, deny | SQLite, replay | no |
| [ryk](https://github.com/christopherkarani/ryk) | 42 | Apache-2.0 | 86 pattern packs, Seatbelt or Landlock | 7 plus Cursor | block, ask | yes, with replay | ? |
| [Fence](https://github.com/hoophq/fence) (hoop.dev) | 21 | MIT | Semantic parse; commands it can't parse run | Claude, Codex, OpenCode | block, ask | ? | no |
| [agent-belay](https://github.com/mikepenz/agent-belay) | 9 | Apache-2.0 | Desktop review queue, rules, optional AI risk score | Claude, Copilot, OpenCode, Pi | block, ask | history | no |
| [Kintsugi](https://github.com/arrowassassin/kintsugi) † | 5 | MIT | Hooks and a PATH shim, Bash AST, unparseable commands held | 8 | hold, deny | hash-chained | before destructive operations |
| [leashd](https://github.com/vmehera123/leashd) | 5 | Apache-2.0 | Splits commands, handles `bash -c` and eval | Claude Code (as a daemon) | block, ask (web, phone) | jsonl | no |
| [rulesync](https://github.com/dyoshikawa/rulesync) † | 1,514 | MIT | Compiles one permissions file into each agent's format, no runtime check | many | native | no | no |

Commercial products are mostly hook-based too. Pillar's 2 Oct 2026 roundup lists Pillar, CrowdStrike, Microsoft Defender, Palo Alto (Koi), Noma, Zenity, Straiker, Backslash and Knostic, with no public pricing ([Pillar](https://www.pillar.security/blog/best-ai-coding-agent-security-tools-for-the-enterprise-2026)). Endor Labs launched hook-based governance for coding agents ([Endor](https://www.endorlabs.com/learn/introducing-agent-governance-using-hooks-to-bring-visibility-to-ai-coding-agents)). Snyk bought Invariant Labs in June 2025; its successor, [Agent Scan](https://github.com/snyk/agent-scan), only scans.

What Hacker News says about this category (threads on nah, 127 points, and cc-safety-net, 61 points): "wrong layer, just use a container", "a deny list with extra steps", and "if you allow `npm test` the agent can edit `package.json` to get around you". All three are fair. The README answers them: belayd is not a sandbox and says so, it parses rather than matches, and it asks before running scripts the agent just changed.

## Checkpoints and undo

| Project | Mechanism | Covers shell side effects | Several agents at once |
|---|---|---|---|
| Claude Code `/rewind` | file snapshots per prompt | no | its own edits only |
| Codex | none since April 2026 | | |
| Copilot CLI `/undo` | restores files Copilot changed | not stated | its own edits only |
| Cursor checkpoints | local snapshots of Agent changes | no, per a third-party guide | ? |
| Gemini CLI checkpointing | shadow Git repo, off by default, `write_file` and `replace` only | no | ? |
| OpenCode `/undo` | Git snapshot of the working tree | yes, needs Git | no: the whole tree |
| node9 | shadow Git | removed Aug 2026 after a 378 GB store | |
| [nono](https://github.com/nolabs-ai/nono) `--rollback` (4,578 stars) | content-addressed snapshots of a wrapped process | yes | ? |
| [agentsh](https://github.com/canyonroad/agentsh) (395 stars) | shell gateway, checkpoint before `rm`, `mv`, `git reset` | yes | ? |
| [container-use](https://github.com/dagger/container-use) (4,073 stars) | container and Git branch per agent | discard the branch | yes, by keeping agents apart |
| [Entire CLI](https://github.com/entireio/cli) † (5,178 stars) | session provenance in `refs/entire/*`, `entire blame` | no file-level undo | ? |
| [unf](https://www.unfudged.io/) † (46 stars) | daemon snapshotting every text file save | yes, any tool | no attribution |
| [ccundo](https://github.com/RonitSachdev/ccundo) † (1,401 stars) | replays Claude session files | no | no |

The lesson from node9: snapshots without a size limit and a cleanup schedule don't survive real use. belayd keeps 30 days, prunes daily and shows the size in `belayd doctor`.

## MCP gateways

| Project | Stars | Policy | Human approval | Audit | Local |
|---|---|---|---|---|---|
| [agentgateway](https://github.com/agentgateway/agentgateway) † | 5,313 | authorisation policies | no | OTel | self-host |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) † | 4,622 | plugins, RBAC | ? | yes | self-host |
| [ToolHive](https://github.com/stacklok/toolhive) † | 2,279 | containers, permission profiles | no | yes | desktop and K8s |
| [Docker MCP Gateway](https://github.com/docker/mcp-gateway) † | 1,599 | per-profile tool enablement, interceptors | no | `--log-calls` | yes |
| [Obot](https://github.com/obot-platform/obot) † | 1,106 | access policies, filters | through filters | yes | self-host |
| [Claw Patrol](https://github.com/denoland/clawpatrol) † | 1,079 | wire-level rules, HCL and CEL | yes | yes | self-host |
| [pipelock](https://github.com/pipelab-org/pipelock) | 938 | egress and MCP rules for Claude, Codex, Cursor | no | signed receipts | yes |
| [Lasso MCP Gateway](https://github.com/lasso-security/mcp-gateway) † | 395 | secret and PII masking | no | yes | yes |
| [mcp-guardian](https://github.com/eqtylab/mcp-guardian) † | 201 | proxy plus desktop app | yes | yes | yes, inactive since Aug 2025 |
| [Preloop](https://github.com/preloop/preloop) † | 77 | YAML and CEL | yes, mobile, Slack, email | yes | Docker or cloud |

MCP gateways are mostly server-side and identity-centric. Local, per-developer approval of MCP calls barely exists. Claude Code hooks already see MCP calls as `mcp__<server>__<tool>`, so the gateway matters for agents whose hooks don't cover MCP.

## Sandboxes

| Project | Stars | Mechanism | Ask | Audit | Undo |
|---|---|---|---|---|---|
| [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | 5,595 | Seatbelt, bubblewrap, seccomp, domain allowlist; powers Claude Code's sandbox | no | violations | no |
| [nono](https://github.com/nolabs-ai/nono) | 4,578 | Landlock or Seatbelt capabilities with a supervisor, L7 network filtering | enterprise, "in development" | cryptographic | yes |
| [container-use](https://github.com/dagger/container-use) | 4,073 | container and Git branch per agent | no | command log | discard the branch |
| [Agent Safehouse](https://github.com/eugene1g/agent-safehouse) † | 2,105 | macOS sandbox-exec profiles, 823 points on HN | no | no | no |
| [StrongDM Leash](https://github.com/strongdm/leash) | 593 | container, eBPF, Cedar, MITM proxy; quiet since April | toggles in UI | yes | no |
| Docker Sandboxes | product | microVM per agent | no | ? | disposable |

These are complements, not competitors. belayd recommends pairing with one of them for untrusted code.

## Session audit and replay

[agentsview](https://github.com/kenn-io/agentsview) † (6,095 stars, local SQLite, replay, 50+ agents) leads this group, followed by [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) † (2,247), [specstory](https://github.com/specstoryai/getspecstory) † (1,352) and [agents-observe](https://github.com/simple10/agents-observe) † (694). None of them enforce policy or undo anything.

## Why people want this

**Incidents.** Each of these made the news or a large thread:

- Jul 2025: Replit's agent deleted SaaStr's production database ([Register](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/)).
- Aug 2025: the Nx "s1ngularity" malware ran local AI CLIs with their skip-permission flags to hunt for secrets ([Wiz](https://www.wiz.io/blog/s1ngularity-supply-chain-attack)).
- Dec 2025: Claude Code's `rm -rf ... ~/` wiped a Mac home folder ([Willison](https://simonwillison.net/2025/Dec/9/claude/)). Antigravity wiped a user's D: drive ([Register](https://www.theregister.com/2025/12/01/google_antigravity_wipes_d_drive/)).
- Feb 2026: Claude Code ran `terraform destroy` on a production stack ([post](https://aishippingblog.com/p/how-i-dropped-our-production-database)).
- Mar 2026: the Codex Windows app deleted about 370 GB outside the project ([forum](https://community.openai.com/t/critical-data-loss-issue-in-codex-app-for-windows-agent-executed-file-deletion-outside-project-directory/1375894)). Claude Code force-pushed over a private repository's history ([#33402](https://github.com/anthropics/claude-code/issues/33402)).
- Apr 2026: a Cursor agent deleted a company's production volume and its backups ([ABC7](https://abc7news.com/post/rogue-ai-agent-san-francisco-based-cursor-goes-haywire-deletes-tech-companys-database/19007153/)); 860 points on [HN](https://news.ycombinator.com/item?id=47911524).
- Aug 2026: Codex ran `rm -rf $HOME`, taken from its own safety examples ([#36937](https://github.com/openai/codex/issues/36937)).
- Commits made with Claude Code leak secrets at 3.2%, against a 1.5% baseline ([GitGuardian 2026](https://gitguardian.com/state-of-secrets-sprawl-report-2026)).

**Prompt fatigue.** Anthropic reports that users approve 93% to 97% of prompts, and that in a study of 1,053 testers people caught 13.6% of dangerous commands where auto mode caught 89% ([Anthropic](https://claude.com/blog/auto-mode-default-in-claude-code)). A safety layer that adds prompts loses. One that stays quiet and catches what the classifier misses has a place.

**Guidance.** OWASP's Top 10 for Agentic Applications ([OWASP](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)) covers tool misuse, privilege abuse, unexpected code execution and human-agent trust. CISA, the NSA and Five Eyes partners published "Careful Adoption of Agentic AI Services" on 1 May 2026 ([CISA](https://www.cisa.gov/resources-tools/resources/careful-adoption-agentic-ai-services)).

## Gaps we can own

1. **Undo of shell side effects, tied to an audit row, across agents.** This is the headline, not "blocks `rm -rf`". Native undo skips Bash or is gone, and node9 dropped it. belayd snapshots before and after every step that can change files, keeps the store bounded, and undoes one step, a range or a session.
2. **Several agents in one project.** belayd already attributes each changed file to the agent that changed it and undoes one agent's work without touching another's. Next: warn before one agent's `git reset --hard` or `git checkout -- .` throws away another agent's uncommitted work, flag an agent that starts another agent with its safety switched off (the s1ngularity pattern), and show which agents are working in a project right now.
3. **Asking where the agent can't.** Codex ignores `ask`, Cursor doesn't enforce it, and Copilot's hooks fail open on timeout. belayd holds the call and asks through its own channel, and no answer means no.
4. **A readable floor under the classifiers.** Auto mode is the default and misses about one in six. The pitch is "keep auto mode, add rules you can read and an undo", not "replace your prompts".
5. **Unparseable means ask.** Fence runs commands it can't parse and Sage allows on errors. belayd asks.
6. **Write-then-execute.** belayd sees the agent change `package.json` and then run `npm test` in the same session, and asks. It reads scripts the agent wrote before they run.
7. **Honesty.** A published threat model and a per-agent capability matrix, plus a differential test that runs about 700 commands in real bash and fails the build on a miss.

## Positioning

Not another command blocker, and not a sandbox. belayd is the **undo button and flight recorder for every coding agent you run, including when you run several at once**, with one readable policy in front:

- a snapshot before every change, shell commands included, so any step, range or session can be undone, per agent
- one short allow/ask/deny file across Claude Code, Codex, Copilot CLI, Gemini CLI, OpenCode and MCP servers
- real shell parsing, where anything it can't understand becomes a question
- its own approval channel wherever an agent's native ask is missing or broken
- every call and decision in a local timeline you can replay
- quiet by default: it measures itself against your own agent history with `belayd scan` before you turn it on

The threat model says it plainly: guardrail, recorder and recovery, not a containment boundary. For untrusted code, pair it with a sandbox.

## Risks to watch

- **Claude Code closes the gap.** A `/rewind` that tracks Bash, or Anthropic's sample `blast-radius` mod (holds `rm -rf` or a force push and shows what would change) becoming a built-in feature, would cover the biggest agent. Watch the changelog. The multi-agent case stays open either way.
- **Mods can overrule hooks.** On a machine without managed settings, a Claude Code mod that handles `tool.check` can approve a call belayd blocked. The README and SECURITY.md say so, and `belayd doctor` should flag such mods.
- **Name confusion.** A "Belay" agent firewall (AGPL plus an enterprise tier, 11 agents, [developersdigest](https://www.developersdigest.tech/blog/ai-coding-agent-firewalls-compared-2026); we could not find its repository), the npm package [@fathomforge/belay](https://www.npmjs.com/package/@fathomforge/belay) (spend caps) and [agent-belay](https://github.com/mikepenz/agent-belay) all sit nearby. Always write the name as belayd, with the d.

## Similar names

[Agent Belay](https://github.com/mikepenz/agent-belay) (9 stars, Kotlin, Apache-2.0, desktop app, pre-built for macOS only) is the closest name to ours. It shows Claude Code, Copilot, OpenCode and Pi hook requests in a review queue, runs them through a built-in "Protection Engine" (per-module block, ask, auto-correct or log), supports persistent "Always Allow" patterns and optional AI risk scoring, and keeps a searchable SQLite history. It has no user-written policy file and no undo. A fair comparison for the approval part.
