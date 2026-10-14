# Plays a short Claude Code session through belayd's real hook, so `belayd replay`
# has something to show. Run inside the demo project with BELAYD_HOME and BELAYD_BIN set.
# Nothing here is dangerous: the two blocked commands never run.
hook() { node "$BELAYD_BIN" hook claude-code --timeout 30 >/dev/null; }
call() {
  printf '{"hook_event_name":"%s","session_id":"7f3a9c1e-demo","transcript_path":"/dev/null","cwd":"%s","tool_name":"%s","tool_use_id":"%s","tool_input":%s}' \
    "$1" "$PWD" "$3" "$2" "$4" | hook
}
step() {
  call PreToolUse "$1" "$2" "$3"
  [ -n "$4" ] && eval "$4"
  call PostToolUse "$1" "$2" "$3"
  sleep 1
}

step t1 Write "{\"file_path\":\"$PWD/src/greeting.ts\",\"content\":\"x\"}" \
  "printf 'export function greeting(name: string): string {\n  return \`hi \${name.toUpperCase()}!\`;\n}\n' > src/greeting.ts"
step t2 Bash '{"command":"rm -rf ~"}' ""
step t3 Bash '{"command":"cat .env"}' ""
step t4 Bash "{\"command\":\"sed -i '' 's/hi/bye/' src/greeting.ts && rm src/legacy.ts\"}" \
  "sed -i '' 's/hi/bye/' src/greeting.ts && rm src/legacy.ts"
