# Integrations

How belayd can see and stop an agent's actions before they run, per agent. Researched 13 Oct 2026 from official docs. Versions and dates are noted because these hook systems change fast.

## Summary

| Agent | Mechanism | Block before run | Native ask from hook | Rewrite input | Shell | Read | Write | MCP | Web | Hook crash or timeout | Fail-closed option | Plan |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | settings hooks | yes | yes | yes | yes | yes | yes | yes | yes | fails open | `onFailure: "block"` (v2.1.295+) | v0.1, first |
| Codex CLI | `hooks.json` / `[hooks]` | yes | **no**, `ask` fails open | yes | yes | via shell | yes (`apply_patch`) | yes | no (hosted search) | fails open | none, we answer before the timeout | v0.1, second |
| Cursor | `hooks.json` | yes | shell and MCP only | `preToolUse` only | yes | yes | yes | yes | ? | fails open | `failClosed: true` | next |
| Gemini CLI | `settings.json` hooks plus TOML policy | yes | no (policy engine can) | yes | yes | yes | yes | yes | yes | fails open | none | later |
| OpenCode | in-process TS plugin | yes (throw) | no (config can) | yes | yes | yes | yes | yes | yes | we control it | our plugin | later |
| Copilot CLI | `.github/hooks/*.json` | yes | yes, interactive only | yes | yes | yes | yes | ? | yes | crash closed, timeout open | partial | later |
| Factory Droid | Claude-style hooks | yes | yes | yes | yes | yes | yes | yes | yes | fails open | ? | cheap port |
| Windsurf / Devin Desktop | `hooks.json` | exit 2 only | no | no | yes | yes | yes | yes | ? | fails open | none | later |
| Goose, Amp, Cline, Kiro | plugins or hooks | yes | varies | varies | yes | ? | ? | ? | ? | mostly open | Goose `on_failure` | later |
| Aider | none | no | n/a | n/a | n/a | n/a | n/a | no MCP | n/a | n/a | n/a | not planned |

Three conclusions shape the design:

1. **belayd needs its own approval channel.** Native ask from a hook is missing in Codex, Gemini, OpenCode, Windsurf and Goose, and partial in Cursor. Where it is missing, the hook holds the call, belayd asks through the terminal console or the local web page, and the hook answers allow or deny before the agent's timeout.
2. **Almost everything fails open by default.** belayd turns on every fail-closed option that exists, answers within its own deadline (shorter than the agent's timeout), and says honestly in the docs where an agent still fails open.
3. **Agents read each other's hooks.** Cursor (on by default) and Copilot CLI load Claude Code hooks from `.claude/settings*.json`. Our Claude Code hook will run inside them with different tool names. The hook must detect the host and handle or skip the call, and the audit log must deduplicate on (agent, session, tool call id).

## Claude Code

Status: shipped in v0.1, verified live with Claude Code 2.1.292 (deny in bypassPermissions mode, held approval in `claude -p`, undo after a real session). Source: [Hooks reference](https://code.claude.com/docs/en/hooks), [Permissions](https://code.claude.com/docs/en/permissions), [Environment variables](https://code.claude.com/docs/en/env-vars), [CLI reference](https://code.claude.com/docs/en/cli-reference).

### Mechanism

Command hooks declared in settings JSON. Claude Code spawns the command, writes one JSON object to stdin and reads the decision from stdout and the exit code. All matching hooks run in parallel.

| Event | Use in belayd |
|---|---|
| `PreToolUse` | The gate. Fires for every tool call (Bash, Write, Edit, Read, Glob, Grep, WebFetch, WebSearch, Agent, MCP tools, ...) before the permission prompt, including inside subagents. |
| `PostToolUse` | Record the outcome, take the post-action snapshot, learn whether a delegated `ask` was approved. |
| `PermissionRequest` | Fires when Claude Code is about to show its own prompt. In sessions that cannot prompt (background subagents in `-p` mode) the call is denied unless a hook decides. Useful for headless approval through the belayd web page. |
| `SessionStart`, `SessionEnd` | Open and close the audit session. |

### Configuration

| File | Scope |
|---|---|
| `~/.claude/settings.json` | User, all projects |
| `.claude/settings.json` | Project, committed |
| `.claude/settings.local.json` | Project, not committed |
| Managed policy settings | Organisation, cannot be disabled by users |
| Plugin `hooks/hooks.json` | While the plugin is enabled |

Hook entries merge across levels instead of replacing each other. `CLAUDE_CONFIG_DIR` relocates the whole user config directory (settings, sessions, plugins), and `--settings <file|json>` adds settings for one run. Both give us an isolated config for tests, so development never touches `~/.claude`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/to/belayd",
            "args": ["hook", "claude-code"],
            "timeout": 180,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

The exec form (`command` plus `args`) skips the shell, which saves a few milliseconds per call.

### Input

Common fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode` (`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`), `hook_event_name`, and `agent_id` / `agent_type` inside subagents. `PreToolUse` adds `tool_name`, `tool_input` and `tool_use_id`.

| Tool | `tool_input` |
|---|---|
| Bash | `command`, `description`, `timeout`, `run_in_background` |
| Write | `file_path` (absolute), `content` |
| Edit | `file_path`, `old_string`, `new_string`, `replace_all` |
| Read | `file_path` (plus optional range fields) |
| WebFetch | `url`, `prompt` |
| MCP tools | the tool's own arguments; `tool_name` is `mcp__<server>__<tool>` and the input carries `mcp_server` `{ name, source }` (v2.1.274+) |

### Output

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "belayd: force push to main is blocked (rule no-force-push)"
  }
}
```

- `permissionDecision`: `allow` skips the prompt, `deny` blocks, `ask` forces Claude Code's own prompt, `defer` only works in `-p` mode. With several hooks, precedence is deny > defer > ask > allow.
- `permissionDecisionReason`: for `deny` it is shown to the model, so the agent learns why and can adapt. For `ask` it is shown to the user inside the native prompt.
- `updatedInput` can rewrite the tool input. belayd does not use it in v0.1 (rewriting commands silently is surprising).
- The user's own deny and ask rules are still evaluated after a hook `allow`, so belayd can never weaken the user's existing Claude Code permissions.
- `ask` from a hook also forces a prompt in auto mode.
- The old top-level `decision: approve|block` is deprecated for `PreToolUse`.

Exit codes: 0 means the JSON applies. 2 blocks, and stderr becomes the reason. Anything else is a non-blocking error and the call goes ahead.

### Failure behaviour

By default a hook that crashes, times out (default timeout 600 s), cannot start, or prints invalid JSON does not block: the call continues through the normal permission flow. Since v2.1.295, `"onFailure": "block"` on a command or HTTP hook turns every one of those failures into a block. belayd always sets it. For older versions we fall back to a shell wrapper that exits 2 on any failure.

### Gaps and caveats

- `@file` references in the user's prompt are inserted without a tool call, so no hook sees them. Only Claude Code's own `Read` deny rules cover that path. `belayd init` can add matching deny rules for `.env` and key files.
- A Claude Code "mod" that handles `tool.check` runs after hooks and can approve a call a `PreToolUse` hook blocked, unless the hook lives in managed settings. A team that needs belayd to be non-bypassable should install it through managed settings.
- `disableAllHooks` turns off user and project hooks.
- MCP tools marked `requiresUserInteraction` still prompt even when a hook returns `allow`. That is fine for us.
- Hooks are cooperative. They see the tool call, not what a script does after it starts. `python build.py` is evaluated as `python build.py`, not as the contents of `build.py`.

### belayd strategy

1. `belayd init` writes hooks into `.claude/settings.local.json` by default (project scope, not committed, easy to remove), or `~/.claude/settings.json` with `--global`. It shows the diff first and keeps a backup.
2. One `PreToolUse` hook with matcher `*`, plus `PostToolUse`, `SessionStart` and `SessionEnd`.
3. `ask` is delegated to Claude Code's native prompt with belayd's reason in it. In headless runs (`claude -p`) belayd holds the call and waits for the web approval page.
4. Contract tests replay recorded payloads per Claude Code version from `tests/fixtures/claude-code/`.

5. **Who answers an ask.** Claude Code sets `CLAUDE_CODE_SESSION_ATTENDED` (undocumented, observed in 2.1.292): `1` in interactive sessions, `0` in `claude -p`. Only an explicit `0` makes belayd hold the call itself; anything else keeps Claude Code's native prompt, so older versions without the variable keep working as before. For the strongest guarantee in unattended runs, use `approval: { channels: [native, dialog] }` (see SECURITY.md).
6. **Host detection.** Cursor loads `.claude/settings*.json` hooks by default and maps tool names (Bash becomes Shell, Edit becomes Write), and Copilot CLI reads the repo's `.claude/settings*.json` too. The hook checks for `cursor_version` in the payload or `CURSOR_VERSION` in the environment (and the Copilot equivalents). If a native belayd integration is installed for that host, it does nothing. Otherwise it evaluates with the mapped tool names and resolves `ask` out of band, because Cursor does not enforce `ask` on `preToolUse`.

Effort: about 3 to 4 days including tests, on top of the policy engine.

## Codex CLI

Status: shipped in v0.1, verified live with Codex CLI 0.162.0-alpha.2 (`cat .env` blocked through PreToolUse, a real `apply_patch` edit undone). Latest stable `rust-v0.162.1` (9 Oct 2026). Sources: [Hooks](https://developers.openai.com/codex/hooks), [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference.md), [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md), [Sandboxing](https://learn.chatgpt.com/docs/sandboxing.md), [Managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration.md), [Releases](https://github.com/openai/codex/releases).

### Mechanism

Lifecycle hooks, stable and on by default since v0.124 (23 Apr 2026). The contract is close to Claude Code's: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop` and others, with `hookSpecificOutput.permissionDecision`, exit 2 to block, and MCP tools named `mcp__<server>__<tool>`. The old `notify` setting only fires at the end of a turn and is useless for control.

### Configuration

- User: `~/.codex/hooks.json` or inline `[hooks]` in `~/.codex/config.toml`. `CODEX_HOME` relocates `~/.codex` (the directory must exist), which gives us an isolated config for tests.
- Project: `<repo>/.codex/hooks.json` or `.codex/config.toml`, loaded only when the project's `.codex/` layer is trusted.
- Managed: `/etc/codex/requirements.toml` with `allow_managed_hooks_only`.
- All layers run. Matching hooks run concurrently, so belayd installs exactly one hook per event.
- **Trust review:** non-managed hooks must be approved once in `/hooks`. Trust is tied to a hash of the hook definition, so belayd keeps its hook entry byte-identical across upgrades. `--dangerously-bypass-hook-trust` skips the review, which is what our CI uses.

### Contract

Input: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, plus `turn_id`, `tool_name` (`Bash`, `apply_patch`, `mcp__srv__tool`, other function tools), `tool_use_id`, `tool_input` (`tool_input.command` holds the shell command or the patch text).

Output: the same `hookSpecificOutput` deny shape as Claude Code. `updatedInput` with `allow` works since v0.131.

**`ask` is not supported.** From the docs: `permissionDecision: "ask"` and `continue: false` are "parsed but not supported yet. Codex marks the hook run as failed, reports the error, and continues the tool call." So belayd never sends `ask` to Codex. It resolves the question itself and answers `allow` or `deny`.

`PermissionRequest` fires only when Codex itself would prompt (sandbox escalation, network, a rules `prompt`). A hook can answer allow or deny there, and if it says nothing Codex shows its own prompt.

### Coverage and gaps

- Shell and unified exec as `Bash`, file edits as `apply_patch` (matchable as `Edit|Write`), MCP tools, and local function tools. Hosted WebSearch is not covered. File reads happen through shell commands, so read rules come from shell parsing.
- A `PreToolUse` error, timeout or malformed response fails open. The docs also say some specialised tool paths can skip hooks. Codex calls hooks "a useful guardrail, not a complete enforcement boundary", and so do we.
- `apply_patch` input is a patch envelope (`*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:`). belayd parses it to get target paths for write rules and pre-edit snapshots.
- Native layers worth composing with: sandbox modes (`read-only`, `workspace-write` default, `danger-full-access`), Starlark `.rules` with `prefix_rule` (allow, prompt, forbidden), per-tool MCP approval modes. `approval_policy = "untrusted"` was retired in v0.149.

### belayd strategy

1. `belayd init` writes one entry per event into `~/.codex/hooks.json` (`PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `SessionEnd`) running `belayd hook codex`, then walks the user through the one-time `/hooks` trust step.
2. `ask` becomes a held call: belayd asks through its console or web page, and answers `deny` itself if nobody responds before its deadline, which is set below the hook timeout.
3. Optional later: compile prefix-style belayd rules into `~/.codex/rules/belayd.rules` with `decision = "prompt"` to get Codex's native prompt for simple cases.
4. Recommend `workspace-write` as the sandbox in our docs.
5. E2E tests drive `codex exec --dangerously-bypass-hook-trust` with `CODEX_HOME` pointing at a temp dir.

Effort: adapter 4 to 6 days, E2E harness 2 to 3 days.

## Cursor

Sources: [Hooks](https://cursor.com/docs/hooks), [Third-party hooks](https://cursor.com/docs/reference/third-party-hooks), [CLI permissions](https://cursor.com/docs/cli/reference/permissions).

- Native `hooks.json` at `~/.cursor/hooks.json`, `<project>/.cursor/hooks.json` (trusted workspaces) and enterprise paths. Events include `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse`, `afterFileEdit`, `afterShellExecution`, `stop`.
- `beforeShellExecution` and `beforeMCPExecution` return `permission: allow | deny | ask`, so native ask works for shell and MCP. `preToolUse` accepts `ask` in its schema but does not enforce it today. `beforeReadFile` is allow or deny.
- Fails open on crash or timeout unless the hook sets `failClosed: true`.
- Loads Claude Code hooks from `.claude/settings*.json` by default (Settings, Agents, Third-Party Imports) with mapped tool names. See host detection above.
- Reported bugs worth testing against: hook `ask` broken in 2.4.21, and historical gaps where some hooks did not fire in `cursor-agent`.

Strategy: native hooks with `failClosed: true`, native `ask` for shell and MCP, out-of-band approval for writes, `afterFileEdit` and `afterShellExecution` for audit and snapshots. Effort: 4 to 6 days plus 2 to 3 days E2E (headless `cursor-agent`, manual QA for the editor).

## Gemini CLI

Update 14 Oct 2026: the Gemini CLI docs now say that unpaid-tier and Google One users were moved to a new Antigravity CLI on 18 June 2026. Gemini CLI remains for paid and API users. Its hook contract below is still accurate (checked against the hooks reference: `BeforeTool` returns `{"decision": "deny", "reason": ...}`, exit 2 blocks, other exit codes warn and continue, timeouts are in milliseconds, there is no tool call id). belayd v0.1 does not ship a Gemini adapter; the next step is to look at Antigravity CLI's extension points and support whichever has the users.

Sources: [Hooks](https://geminicli.com/docs/hooks/), [Hooks reference](https://geminicli.com/docs/hooks/reference/), [Policy engine](https://geminicli.com/docs/reference/policy-engine/), [Trusted folders](https://geminicli.com/docs/cli/trusted-folders/). Stable v0.63.0 (6 Oct 2026).

- Hooks in `~/.gemini/settings.json` and `.gemini/settings.json`, on by default since v0.26. `BeforeTool` can deny (`{"decision": "deny", "reason": ...}` or exit 2) and rewrite arguments, but cannot ask. Timeouts are in milliseconds, default 60000.
- A separate TOML policy engine supports `allow`, `deny` and `ask_user`, from `~/.gemini/policies/*.toml`. The workspace policy tier is currently broken (issue #18186).
- Tools: `run_shell_command`, `read_file`, `read_many_files`, `write_file`, `replace`, `glob`, `grep_search`, `web_fetch`, `google_web_search`, and MCP tools as `mcp_<server>_<tool>`.
- Non-zero exits other than 2 and polluted stdout fail open.
- Has its own `/restore` checkpointing (shadow Git repo, off by default).

Strategy: `BeforeTool` and `AfterTool` hooks running `belayd hook gemini`, out-of-band approval for ask, optional compile of ask rules into `~/.gemini/policies/belayd.toml`. Effort: 3 to 5 days plus 2 days E2E.

## Ollama

Checked 14 Oct 2026. Sources: [Ollama integrations](https://docs.ollama.com/integrations), [Claude Code with Ollama](https://docs.ollama.com/integrations/claude-code), [Copilot CLI with Ollama](https://docs.ollama.com/integrations/copilot-cli), coverage of the v0.32 agent mode.

- `ollama launch <agent>` starts Claude Code, Codex, Copilot CLI, OpenCode and others against a local or cloud model, by setting the agent's API environment variables (for Claude Code: `ANTHROPIC_BASE_URL=http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama`; for Copilot CLI: `COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL`). Nothing in the docs moves the agent's config folder, so the agent loads its usual settings and belayd's hooks with them. belayd therefore covers Ollama-launched Claude Code, Codex and Copilot CLI through their own adapters. Not yet confirmed in a live session.
- Since v0.32 (July 2026), the bare `ollama` command is an interactive agent with skills for files, git, web fetch and the terminal. It runs commands and edits files with the user's permissions. Its docs describe no hooks, approval prompts, policy file or extension point that an outside program could use, so belayd cannot check its tool calls yet. `belayd init` and `belayd doctor` say so when Ollama is installed.
- Possible later: if the agent runs commands through `$SHELL`, a belayd shell shim could check them; that would not cover its file edits. Worth looking at once Ollama documents how the agent executes tools.

## OpenCode

Sources: [Plugins](https://opencode.ai/docs/plugins/), [Permissions](https://opencode.ai/docs/permissions/), source at [v1.19.0](https://github.com/anomalyco/opencode/tree/v1.19.0).

- In-process TypeScript plugins. `tool.execute.before` can block by throwing and can rewrite arguments by mutating `output.args` in place. Plugins cannot ask: `permission.ask` is declared but never called (issue #47674). Native ask exists only in the `permission` config.
- Several open bugs where plugin hooks are bypassed or throws are swallowed, and a V2 plugin API in progress. Expect churn.

Strategy: a small `@belayd/opencode` plugin that calls belayd and throws on deny or when belayd is unreachable, so it fails closed by construction. Effort: 4 to 6 days plus ongoing maintenance.

## Others

- **Copilot CLI** (supported since 14 Oct 2026, not yet tried in a live session). Hooks live in `.github/hooks/*.json`, `.github/copilot/settings(.local).json` and `~/.copilot/hooks/`. Payload: camelCase `sessionId`, `timestamp` (ms), `cwd`, `toolName`, `toolArgs` (object, or JSON text), and `toolResult` after the call; the event name is not in the payload, so belayd installs one entry per event with `--event`. Answer: top-level `permissionDecision` (`allow`, `deny`, `ask`) and `permissionDecisionReason`. Exit 2 and other non-zero exits deny; a timeout lets the tool run. `ask` is denied in `copilot -p`, so belayd holds the call and asks the person itself. There is no tool call id, so belayd pairs before and after events itself for undo. Tools: `bash`/`powershell` (`command`), `view` (`path`), `create` (`path`, `file_text`), `edit`/`str_replace_editor` (`path`, `old_str`, `new_str`), `apply_patch`, `grep`/`rg`, `glob`, `web_fetch` (`url`). belayd installs into `.github/copilot/settings.local.json` (kept out of Git) or `~/.copilot/hooks/belayd.json`. Copilot CLI also runs `.claude/settings*.json` hooks with a Claude-shaped payload but reads only a top-level `permissionDecision`; belayd's Claude hook recognises that payload, denies with exit 2, and stays out of the way when the native Copilot hooks are installed.
- **Factory Droid**: Claude-style hooks with `permissionDecision` and `updatedInput`. Tool names differ (`Execute`, `Create`, `ApplyPatch`, `FetchUrl`). A cheap port.
- **Windsurf** (now documented as Devin Desktop): `pre_run_command`, `pre_write_code`, `pre_read_code`, `pre_mcp_tool_use` can block with exit 2 only. No ask, no rewrite, fails open.
- **Goose**: plugin hooks, `PreToolUse` can block, `on_failure: "block"` available. **Amp**: TS plugins with `tool.call` and a native confirm dialog; note that project plugins override user plugins. **Cline**: SDK plugins with `beforeTool`, 3 s timeout, fail-open by default. **Kiro**: `.kiro/hooks/*.json`, `PreToolUse` blocks with exit 2, schema unverified.
- **Aider**: no hooks and no MCP, and no release since Aug 2025. Not planned.

## MCP gateway

Source: [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [Elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).

Claude Code, Codex and Cursor hooks already see MCP tool calls, so for those agents MCP is covered by the hook integration. The gateway is for everything else: agents whose hooks miss MCP, MCP clients that are not coding agents, and people who want policy on a specific server regardless of agent.

### Spec state

The current revision is 2026-07-28. It is stateless (no `initialize` handshake, no session id), replaces server-initiated requests such as `elicitation/create` with multi round-trip results (`resultType: "input_required"`), and adds `Mcp-Method` and `Mcp-Name` headers on HTTP. Most deployed clients still speak 2025-06-18 or 2025-11-25, so the proxy must handle both eras. `tools/call` has the same name in both.

### Design: `belayd mcp --name <id> -- <original command>`

1. Spawn the real server and relay newline-delimited JSON-RPC both ways, forwarding stderr, exit codes and signals.
2. Intercept `tools/call`, evaluate `params.name` and `params.arguments` as an `mcp` action.
3. On deny, answer locally with a normal result carrying `isError: true` and a text block `Blocked by belayd: <reason>`, so the model sees why and can adapt.
4. On ask, use belayd's out-of-band approval. MCP elicitation is an optional extra: support is uneven across clients, and Codex can route elicitations to an AI reviewer, so it is not a reliable human channel.
5. Optionally hide denied tools from `tools/list` and refresh on `notifications/tools/list_changed`.
6. Audit every call, correlating request and response by id.

`belayd init` rewrites each agent's MCP config to run servers through the gateway (`command: "belayd"`, `args: ["mcp", "--name", "X", "--", ...original]`), idempotently and with a backup, and `belayd uninstall` reverses it. Servers bundled inside plugins or extensions cannot be wrapped, so they rely on agent hooks.

### Scope for v0.1

Stdio servers only. Remote HTTP servers with OAuth cannot be proxied transparently (tokens are bound to the original server URL), so for those we rely on agent hooks. A non-OAuth HTTP proxy and an OAuth bridge are later work.

Effort: stdio proxy with policy and audit 5 to 7 days, legacy elicitation 2 to 3 days if we want it.

## Recommendation: second agent

**Codex CLI.** Its hook contract is almost the Claude Code dialect, so most of the adapter is shared. It covers shell, file edits and MCP, it has been stable since April 2026, it is open source so we can read the code when docs are unclear, and it runs headless in CI. Its weak spots (no `ask`, fail-open on errors, the trust step) are exactly what belayd's out-of-band approval and own deadline are built to cover, which makes it a good showcase.

Cursor is the strong third choice: large user base, native ask for shell and MCP, and `failClosed`. It is closed source with known parity bugs, and since it already runs Claude Code hooks, v0.1 gets partial Cursor coverage through host detection anyway.

## Open questions to verify hands-on

- Cursor: `preToolUse` coverage of WebFetch, current CLI parity, `failClosed` behaviour.
- Gemini: whether a hook `allow` suppresses a policy `ask_user`, timeout behaviour, folder trust default.
- OpenCode: whether a throw in `tool.execute.before` blocks on each release.
- Copilot CLI: whether `preToolUse` covers MCP tools.
- Which MCP protocol revision each agent's client speaks today.
