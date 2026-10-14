# Changelog

## 0.1.0 (unreleased)

The first release. belayd sits between AI coding agents and your machine: one policy, one audit trail and one undo button for Claude Code, Codex and MCP servers.

### Policy

- Shell commands are parsed, not pattern-matched. belayd follows quoting, variables and word splitting, `cd`, aliases, functions, `bash -c`, `eval`, command and process substitution, heredocs and here-strings, pipes into interpreters, base64-encoded scripts, downloads that are executed later, `find -exec` and `-delete`, `xargs`, `parallel`, `awk`'s `system()`, and wrappers such as `sudo`, `env`, `timeout`, `setsid`, `script`, `tmux`, `screen` and `at`. Anything it cannot see into gets a question.
- Three presets: `balanced` (default), `strict` and `yolo-with-undo`. Your `belayd.yaml` rules win over the preset; `final` preset rules can only be switched off explicitly. Even `yolo-with-undo` asks before deleting a path belayd cannot know, because it may lie outside the project, where undo cannot reach.
- Branches are followed: after `if`, `case`, `&&`, `||` and loops, belayd checks every folder or value a command could be working with.
- Rules match programs and subcommands, arguments, paths read or written (judged where they really point, through symlinks), network domains, code piped from the internet, and secrets in outgoing data.
- Shell scripts are read before they run (`bash x.sh`, `./x.sh`, `source x.sh`, `bash < x.sh`) and checked line by line, with `$1` and `"$@"` standing for the arguments they were given.
- belayd remembers which files the agent changed in a session, including through code it cannot read, and asks before running scripts or hooks from them (`npm test` or `npm install` after editing `package.json`, `make` after editing the `Makefile`, `git commit` after adding a Git, husky or pre-commit hook).
- MCP tool calls get the same file and shell rules.
- `belayd check` shows a decision without running anything.
- Your own `~/.belayd/belayd.yaml` applies everywhere, and a project `belayd.yaml` builds on it. A project file only counts in full after `belayd trust`. Until then it can add questions and blocks to your verdict, never take one away.
- belayd never hangs an agent: if checking a call ever takes longer than 20 seconds, the call is blocked and the reason logged.

### Agents

- Claude Code: PreToolUse and PostToolUse hooks, the native prompt in interactive sessions, held approvals in `claude -p`. Installs with `onFailure: "block"` on Claude Code 2.1.295 and later, and a crash guard on older versions.
- Codex CLI: hooks with held approvals (Codex cannot ask from a hook), `apply_patch` checked file by file.
- Cursor: covered through the Claude Code hooks it loads.
- MCP: `belayd mcp` runs any stdio MCP server behind the policy; `belayd mcp wrap` rewrites a config file.

### Approvals

- `belayd approve` (terminal console) and `belayd ui` (local web page) answer held calls. No answer before the timeout means no.
- A `dialog` channel: the waiting hook shows a native OS dialog and only that click counts, so nothing on disk can answer for you.
- Desktop notifications on macOS and Linux.

### Audit

- Append-only SQLite log with a hash chain, on Node's built-in `node:sqlite`.
- `belayd log`, `belayd sessions`, `belayd replay`, `belayd log --verify`, `belayd gc`.
- Secrets are redacted before anything is written.

### Undo

- Snapshots before and after every step that can change files, shell commands included, in a shadow Git repository that never touches your `.git`.
- `belayd undo` by step, range or whole session, and `belayd redo`. Both refuse to throw away newer work unless you pass `--force`, and neither writes or deletes through a symlink.

### Numbers

- Hook overhead of 20 to 50 ms on an M-series Mac (CI fails above 100 ms).
- About 1,200 automated tests, including 330 commands checked against every preset. The integrations were also checked by hand in live sessions with Claude Code 2.1.292 and Codex CLI 0.162.
