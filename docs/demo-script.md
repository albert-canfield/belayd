# The README demo

`docs/assets/demo.gif` is built by a script, so anyone can check that it shows real output and rebuild it after a change to the CLI's wording.

```sh
brew install vhs ffmpeg gifsicle      # plus Google Chrome, for the cards
pnpm build
bash scripts/make-demo-gif.sh
```

It takes about a minute and works in a fresh folder under `$TMPDIR`. Nothing touches your own agents or `~/.belayd`.

## What's in it

1. **Intro card** (`docs/demo/cards.html?card=intro`): the name, the tagline and the agents it covers.
2. **What it does** (`?card=value`): blocked, asks you, undo.
3. **The terminal** (`docs/demo/terminal.tape`, recorded with VHS):
   - `belayd check` on a curl-to-bash install, then on `rm -rf ~` hidden behind a variable and `bash -c`.
   - `belayd replay` of a short Claude Code session. `docs/demo/session.sh` plays that session through belayd's real Claude Code hook beforehand: a file edit, `rm -rf ~` (blocked), `cat .env` (blocked), and a `sed` plus `rm` that breaks the code.
   - `belayd undo`, which puts both files back.
4. **Install card** (`?card=outro`): the two commands and the line `belayd init` prints.

The cards are a plain HTML page. Open it in a browser with `?card=intro`, `?card=value` or `?card=outro` to edit one.

## Encoding

The GIF is 1280x720 at 10 frames per second, with a 128-colour palette and no dithering (dithering shows up as streaks on the dark background), then `gifsicle --lossy=15`. That keeps it under 2 MB.

## Social preview

`docs/assets/social-preview.png` (1280x640) is for the repository settings on GitHub, under Settings, General, Social preview.
