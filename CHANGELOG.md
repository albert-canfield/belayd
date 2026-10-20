# Changelog

## 0.4.0 (2026-10-20)

Several agents in one project, safely: belayd now stops one agent from wrecking another's uncommitted work, shows who is working where, and asks when an agent starts another one with its safety off. Also a security fix (update soon if you use 0.3.0), OpenCode 2 support and much cheaper snapshots in big projects.

Upgrading: if you use OpenCode, run `belayd init --agent opencode` again. OpenCode 2 does not run the old plugin.

### New

- Agents that share a project no longer wreck each other's work. When one agent is about to throw away, stash, commit or write over changes that another agent made and has not committed yet (`git checkout -- .`, `git restore`, `git reset --hard`, `git stash`, `git add -A`, `git commit -a`, a branch switch, `rm`, a file write), belayd asks first and says which agent changed which files, and when. An agent counts as still working for 30 minutes after its last tool call, and a file belongs to the agent whose command last named it. Committed work and files Git ignores are left out. The rule `ask-other-agents-work` is final, so a learned or hand-written allow rule cannot switch it off, and it asks in every preset, `yolo-with-undo` included.
- `belayd ps` shows the agents working in a project right now: what each one did last, which of its changes are not committed, and files two of them both changed. `--watch` keeps it open, `--all` covers every project.
- An agent that starts another coding agent with its safety switched off now gets a question: `claude --dangerously-skip-permissions`, `codex --yolo` or `-s danger-full-access`, `gemini --yolo`, `copilot --allow-all-tools`, `opencode run --auto`, `cursor-agent --force`, `droid exec --auto high` and the like, also through `npx`, `ollama launch`, wrappers, variables and inline Python. The reason names the flag. Rule `ask-agent-without-safety`, match field `agentSafetyOff`.
- `belayd doctor` lists Claude Code mods that can overrule belayd: mods that handle `tool.check` (they can approve a call belayd blocked), belayd's own `classic.PreToolUse` event, or every event. It looks in installed plugins, the mods Claude writes during a session (`~/.claude/dev-mods`), skill folders that hold a plugin, and `CLAUDE_CODE_PLUGIN_DIRS`, and says when managed settings keep such a mod in check.
- Writing a mod (`~/.claude/dev-mods`, `~/.claude/plugins`, a skill folder's `hooks/` or `.claude-plugin/`) now counts as changing an agent's hook settings, and `claude plugin install`, `enable` and `marketplace add` ask first.
- New questions in `balanced`, each from a reported incident: skipping the project's Git hooks (`git commit --no-verify` or `-n`, `-c core.hooksPath=`), Git options that run a command (`core.fsmonitor`, `filter.*`), making a repository or gist public (`gh repo create --public`, `gh gist create --public`, `gh repo edit --visibility public`), changes to files that run code by themselves (CI workflows, `.vscode/tasks.json`, `.git/config`, `.git/hooks`), infrastructure changes without a plan review (`terraform apply -auto-approve`, `pulumi up --yes`, `cdk deploy --require-approval never`), cloud deletes (`gcloud ... delete`, `az ... delete`, `aws ... delete-*` and `terminate-*`) and database resets (`prisma db push --force-reset`, `prisma migrate reset`, `rails db:drop`, `supabase db reset`, `manage.py flush`).
- OpenCode 2: belayd's plugin now works there too. OpenCode 2 does not run plugins written for OpenCode 1, so until now belayd was silently off in it. The new plugin works in OpenCode 2 and in OpenCode 1 from 1.18.29, tried live with 2.1.1 and 1.19.3. If you use OpenCode, run `belayd init --agent opencode` again; `belayd doctor` points out the old plugin and an OpenCode too old to load the new one.

### Fixed

- Security: a repository with its own `.git/config` could make belayd run a command. To decide whether a script is committed, belayd ran `git status` in the project, and Git runs a `core.fsmonitor` command, filter drivers and some hooks named in that repository's config. belayd now runs Git in your projects with all three switched off, and without the `GIT_*` variables it inherited. `belayd init` and the Gemini setup used the same unsafe call. Affects 0.3.0 (checking scripts) and every version for `init`.
- A Git repository inside the project with no commit yet (a fresh `git init` in a subfolder) made every snapshot fail, so undo was off until that repository got a commit. Snapshots now leave it out and keep the rest.
- Snapshots are much cheaper in big projects: the first snapshot of a 30,000-file project went from over 20 seconds to about 4, and from 132 MB on disk to 19 MB. A step that changes files there costs about a third less, and files too big to keep no longer count as changed every time.

## 0.3.0 (2026-10-19)

Quieter on real work, and safe to undo when several agents share a project. No new misses in the differential test.

### New

- Several agents in one project: each step now owns only the files it changed. belayd checks every changed file against the other sessions' steps that ran at the same time, so `belayd undo` takes back one agent's work without touching another's, and `belayd replay` shows each agent only its own files. A file two agents may both have changed is left alone unless you pass `--force`. Before, undoing one agent either refused or, with `--force`, threw away the others' work.
- `belayd scan` replays your agents' past tool calls (Claude Code's and Codex's own history on this machine) and shows what belayd would have blocked or asked about. Nothing runs and nothing is sent.
- Your own committed scripts get the benefit of the doubt: in a script that is tracked by Git, unchanged, and not written by the agent this session, belayd still blocks what it can see, but what it cannot see is no longer a question. Checks on what the agent changed this session still apply inside them.
- A script written and run in the same command (`cat > t.py <<'EOF' ... EOF && python t.py`) is read when its text is known exactly, instead of always asking. Python code on stdin (`python3 - <<'EOF'`) is read like `python -c`.
- `folders:` in belayd.yaml (and the extra folders in your own Claude Code settings) count as part of the project.
- Snapshots are pruned after 30 days (`snapshots.keep`), once a day in the background; `belayd gc --snapshots-only` does it now, and `belayd doctor` shows their size.

### Fixes

- Counting, naming or checksumming a secrets file is not a read of it: `grep -c`, `grep -l`, `grep -q`, `wc`, `cut -d= -f1`, `sed` or `awk` that keep only key names, `git check-ignore`. Reads that show values are still blocked.
- `dirname`, `basename`, `pwd`, `${BASH_SOURCE[0]}` and `$(command -v x)` are followed in scripts, and a path built with `$(...)` is read like any other file. Since 0.2.0 such paths asked by mistake.
- `python3 - "$file" <<'EOF'` was read as running `$file`, which could even block it as downloaded code.
- The differential test now counts a secret read as dangerous when the value is shown or copied, not when the file is merely opened.
- Path rules are checked faster: plain paths and whole folders no longer go through regular expressions, which keeps the hook as fast as 0.2.0 with the longer list of protected agent settings.

## 0.2.0 (2026-10-15)

Fewer questions, more agents, and a test that runs every command for real.

### New

- `belayd tune` turns questions you keep approving into allow rules. A learned rule allows that exact command or file and nothing else, steps aside when the agent changed a script or hook it would run, and is never learned from a final rule or from something belayd could not see into.
- Python, Node, Ruby and Perl scripts the agent wrote in the session are read before they run, like `python -c` code: `python3 build.py` with `os.system("rm -rf ~")` inside is blocked. Scripts that were already in your project are judged by their command line, as before. `tsx` and `ts-node` count as Node.
- OpenCode support: `belayd init --agent opencode` installs a small plugin that checks every tool call before it runs, records what ran and snapshots it for undo. Tried live with OpenCode 1.19.0, directly and through `ollama launch opencode`.
- A GitHub Action (`uses: albert-canfield/belayd@v0.2.0`) for agents that run in CI: it installs belayd and its hooks, turns questions into a no (nobody is watching), and puts each session's timeline in the job summary. `fail-on-block: true` fails the job when belayd blocked something.
- A differential test (`pnpm differential`, in CI): about 650 commands run for real in a throwaway container, and the build fails if bash did something dangerous that belayd let through.
- Windows through WSL: belayd inside a WSL distribution works as on Linux, and CI now runs the whole test suite in Ubuntu on WSL.
- Two match fields: `argv` (the whole command, word for word) and `pathsOnly` (every path the action touches must be on the list).

### Fixes

- Found by the new differential test: code sourced from a process substitution was not read (`source <(echo 'rm -rf ~')` passed), and commands given to code as a list of words were not seen (`subprocess.run(["rm", "-rf", "/"])`, `spawnSync("rm", [...])`, Ruby's and Perl's `system("rm", "-rf", dir)`). Both are checked now. Code from `<(...)` that belayd cannot read gets a question.
- Commands started through environment runners were not checked: `uv run rm -rf ~` passed. belayd now follows `uv run`, `poetry run`, `pipenv run`, `pdm run`, `rye run`, `hatch run`, `pixi run`, `conda`/`mamba`/`micromamba run`, `bundle exec`, `devbox run`, `asdf`/`rbenv`/`pyenv`/`nodenv exec`, `mise exec`, `direnv exec`, `dotenv`, `dotenvx run`, `op run`, `doppler run`, `infisical run`, `aws-vault exec`, `chamber exec`, `nix-shell --run` and `nix develop -c`.
- Editing Copilot CLI's hook settings (`.github/hooks/`, `.github/copilot/settings*.json`, `~/.copilot/hooks/`) now asks first, like the other agents' settings. Before, an agent could switch belayd off for Copilot CLI without a question.
- `belayd tune` is on the list of commands an agent may not run.

## 0.1.0 (2026-10-14)

The first release. belayd sits between AI coding agents and your machine: one policy, one audit trail and one undo button for Claude Code, Codex, Copilot CLI, Gemini CLI and MCP servers.

Install it with `npm install -g belayd-cli`. The command is `belayd`.

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
- Copilot CLI: its own hooks, with held approvals (it refuses to ask in `copilot -p`).
- Gemini CLI: `BeforeTool` and `AfterTool` hooks, with held approvals (its hooks cannot ask).
- Cursor and the Claude desktop app: covered through the Claude Code hooks they run. The ChatGPT desktop app: covered through the Codex hooks it reads from `~/.codex`.
- Ollama: agents started with `ollama launch` (Claude Code, Codex, Copilot CLI) run their own belayd hooks.
- Every agent is an adapter in one registry, and a shared test suite holds them all to the same behaviour.
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
