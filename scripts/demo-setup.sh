#!/usr/bin/env bash
# Creates ~/belayd-demo: a tiny project with a fake secret, ready for the README recording.
# Nothing here is real. Run it again to start from a clean slate.
set -euo pipefail

DEMO="${BELAYD_DEMO_DIR:-$HOME/belayd-demo}"
case "$DEMO" in
  "$HOME" | "$HOME/" | "/" | "") echo "Refusing to use $DEMO as the demo folder." >&2; exit 1 ;;
esac

rm -rf -- "$DEMO"
mkdir -p "$DEMO/src"
cd "$DEMO"
git init -q
cat > src/greeting.ts <<'TS'
export function greeting(name: string): string {
  return `hello, ${name}`;
}
TS
cat > .env <<'ENV'
# Fake values for the demo
PAYMENTS_API_KEY=sk_live_demo_not_a_real_key_000000
ENV
echo ".env" > .gitignore
git add -A
git -c user.name=demo -c user.email=demo@example.com commit -qm "demo project"
belayd init --yes > /dev/null
echo "Demo project ready in $DEMO"
