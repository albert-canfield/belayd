#!/usr/bin/env bash
# Rebuilds docs/assets/demo.gif: an intro card, what belayd does, a recorded terminal
# session, and an install card. Everything in the terminal part is real belayd output.
#
# macOS only. Needs a built dist/ (pnpm build), Google Chrome, and:
#   brew install vhs ffmpeg gifsicle
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="$ROOT/docs/demo"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="${TMPDIR:-/tmp}"
WORK="${TMP%/}/belayd-demo-gif"

[ -f "$ROOT/dist/bin.js" ] || { echo "Run pnpm build first." >&2; exit 1; }
rm -rf -- "${TMP%/}/belayd-demo-gif"
mkdir -p "$WORK/home" "$WORK/my-app/src"

# A small project with a fake secret. Nothing in it is real.
(
  cd "$WORK/my-app"
  git init -q
  printf 'export function greeting(name: string): string {\n  return `hello, ${name}`;\n}\n' > src/greeting.ts
  printf 'export const legacy = true;\n' > src/legacy.ts
  printf 'PAYMENTS_API_KEY=sk_live_demo_not_a_real_key_000000\n' > .env
  echo .env > .gitignore
  git add -A
  git -c user.name=demo -c user.email=demo@example.com commit -qm "demo project"
  BELAYD_HOME="$WORK/home" BELAYD_BIN="$ROOT/dist/bin.js" bash "$DEMO/session.sh"
)

cat > "$WORK/setup.sh" <<SH
export BELAYD_HOME='$WORK/home'
export PS1='\[\e[38;2;234;88;12m\]❯\[\e[0m\] '
export BASH_SILENCE_DEPRECATION_WARNING=1
belayd() { node '$ROOT/dist/bin.js' "\$@"; }
cd '$WORK/my-app'
SH

cp "$DEMO/terminal.tape" "$WORK/"
(cd "$WORK" && vhs terminal.tape)

for card in intro value outro; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1280,720 --screenshot="$WORK/card-$card.png" \
    "file://$DEMO/cards.html?card=$card" 2>/dev/null
done

fade=0.5 intro=3.5 value=5 outro=4
term=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/terminal.mp4")
o1=$(echo "$intro - $fade" | bc)
o2=$(echo "$intro + $value - 2 * $fade" | bc)
o3=$(echo "$intro + $value + $term - 3 * $fade" | bc)

cd "$WORK"
ffmpeg -v error -y \
  -loop 1 -framerate 30 -t "$intro" -i card-intro.png \
  -loop 1 -framerate 30 -t "$value" -i card-value.png \
  -i terminal.mp4 \
  -loop 1 -framerate 30 -t "$outro" -i card-outro.png \
  -filter_complex "\
[0:v]format=yuv420p,setsar=1,fps=30[a];\
[1:v]format=yuv420p,setsar=1,fps=30[b];\
[2:v]format=yuv420p,setsar=1,fps=30,scale=1280:720[c];\
[3:v]format=yuv420p,setsar=1,fps=30[d];\
[a][b]xfade=transition=fade:duration=$fade:offset=$o1[ab];\
[ab][c]xfade=transition=fade:duration=$fade:offset=$o2[abc];\
[abc][d]xfade=transition=fade:duration=$fade:offset=$o3[out]" \
  -map "[out]" -c:v libx264 -crf 18 -pix_fmt yuv420p full.mp4

# No dithering: it shows up as streaks on the flat dark background.
ffmpeg -v error -y -i full.mp4 -vf "fps=10,palettegen=max_colors=128:stats_mode=full" palette.png
ffmpeg -v error -y -i full.mp4 -i palette.png \
  -lavfi "fps=10[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" raw.gif
gifsicle -O3 --lossy=15 raw.gif -o "$ROOT/docs/assets/demo.gif"
ls -la "$ROOT/docs/assets/demo.gif"
