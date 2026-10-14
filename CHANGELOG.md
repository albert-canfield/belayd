# Changelog

## 0.1.0 (unreleased)

The first release. belayd sits between AI coding agents and your machine: one policy, one audit trail and one undo button for Claude Code, Codex and MCP servers.

### Policy

- Shell commands are parsed, not pattern-matched. belayd follows quoting, variables, `cd`, aliases, functions, `bash -c`, `eval`, command and process substitution, heredocs and here-strings, pipes into interpreters, base64-encoded scripts, downloads that are executed later, `find -exec` and `-delete`, `xargs`, and wrappers such as `sudo`, `env`, `nice` and `timeout`.
- Three presets: `balanced` (default), `strict` and `yolo-with-undo`. Your `belayd.yaml` rules win over the preset; `final` preset rules can only be switched off explicitly.
- Rules match programs and subcommands, arguments, paths read or written (judged where they really point, through symlinks), network domains, code piped from the internet, and secrets in outgoing data.
- Shell scripts are read before they run (`bash x.sh`, `./x.sh`, `source x.sh`) and checked line by line.
- belayd remembers which files the agent changed in a session and asks before running scripts or hooks from them (`npm test` after editing `package.json`, `make` after editing the `Makefile`, `git commit` after adding a hook).
- MCP tool calls get the same file and shell rules.
- `belayd check` shows a decision without running anything.
- A project `belayd.yaml` only counts in full after `belayd trust`. Until then it can make belayd stricter, never weaker.

### Agents

- Claude Code: PreToolUse and PostToolUse hooks, the native prompt in interactive sessions, held approvals in `claude -p`. Installs with `onFailure: "block"` on Claude Code 2.1.295 and later, and a crash guard on older versions.
- Codex CLI: hooks with held approvals (Codex cannot ask from a hook), `apply_patch` checked file by file.
- Cursor: covered through the Claude Code hooks it loads.
- MCP: `belayd mcp` runs any stdio MCP server behind the policy; `belayd mcp wrap` rewrites a config file.

### Approvals

- `belayd approve` (terminal console) and `belayd ui` (local web page) answer held calls. No answer before the timeout means no.
- Desktop notifications on macOS and Linux.

### Audit

- Append-only SQLite log with a hash chain, on Node's built-in `node:sqlite`.
- `belayd log`, `belayd sessions`, `belayd replay`, `belayd log --verify`, `belayd gc`.
- Secrets are redacted before anything is written.

### Undo

- Snapshots before and after every step that can change files, shell commands included, in a shadow Git repository that never touches your `.git`.
- `belayd undo` by step, range or whole session, with conflict detection; `belayd redo`.

### Numbers

- Hook overhead of 20 to 50 ms on an M-series Mac (CI fails above 100 ms).
- About 850 automated tests, including 220 commands checked against every preset. The integrations were also checked by hand in live sessions with Claude Code 2.1.292 and Codex CLI 0.162.
