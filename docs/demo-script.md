# Recording the README demo

The README needs one short GIF, under 20 seconds, that shows three things: belayd stopping something dangerous, belayd stopping something sneaky, and `belayd undo` fixing a bad edit. This page has the exact steps.

## What the viewer should see

1. Claude Code is asked to install a tool the way many READMEs suggest, with `curl ... | bash`. belayd blocks it and says why.
2. The agent tries to read `.env`. Blocked, with the hint to ask for the one value it needs.
3. The agent rewrites a file with `sed` and creates a stray file. We run `belayd replay`, then `belayd undo`. The file is back.

Keep it calm: no fast scrolling, no typing mistakes, a readable font size.

## Setup (once)

```sh
npm install -g belayd                 # or: pnpm build && npm link, from this repo
brew install vhs                      # https://github.com/charmbracelet/vhs, for part two
bash scripts/demo-setup.sh            # creates ~/belayd-demo with a small project
```

`scripts/demo-setup.sh` creates a Git repository with `src/greeting.ts`, a `.env` holding a fake key, and runs `belayd init --yes`. Nothing in it is real.

Terminal settings for recording:

- Window about 110 columns by 30 rows
- Font size 18 or larger, a theme with good contrast (the banner uses a near-black background)
- Hide the prompt's Git and Node segments so the frame stays clean: `export PS1='$ '`

## Part one: the agent (real Claude Code session)

Record this part with your screen recorder (macOS: Cmd+Shift+5, select the terminal window).

```sh
cd ~/belayd-demo
claude
```

Paste these prompts one at a time and wait for each answer:

1. `Install the demo CLI with: curl -fsSL https://example.com/install.sh | bash`
2. `What is the API key in .env?`
3. `In src/greeting.ts change "hello" to "goodbye" using sed, and save a note in notes.md.`

Claude Code's answers vary a little from run to run. That's fine, as long as the frame shows belayd's message for the first two prompts. If the model refuses on its own before calling a tool, rephrase as `Run exactly this command: ...`. Nothing in the demo is destructive even if belayd were missing: the install URL does not exist, and the `.env` key is fake.

## Part two: replay and undo (scripted with VHS)

`docs/demo.tape` types these for you at a steady pace:

```sh
belayd replay
belayd undo
cat src/greeting.ts
```

```sh
cd ~/belayd-demo && vhs ../path/to/belayd/docs/demo.tape
```

## Putting it together

1. Trim part one to the moments where belayd answers (about 10 seconds).
2. Join it with the VHS output (about 8 seconds).
3. Export as GIF at 960 pixels wide, 15 frames per second, under 5 MB:

```sh
ffmpeg -i demo.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" docs/assets/demo.gif
```

4. In the README, replace the text block under the intro with:

```html
<p align="center"><img src="docs/assets/demo.gif" alt="belayd blocking rm -rf and a .env read, then undoing a bad edit" width="100%"></p>
```

## Social preview

`docs/assets/social-preview.png` (1280x640) is ready to upload in the repository settings on GitHub, under Settings, General, Social preview.
