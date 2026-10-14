# The terminal part of the README GIF. scripts/make-demo-gif.sh runs this from its
# work folder, where setup.sh puts belayd on the PATH and opens the demo project.
Output terminal.mp4

Set Shell "bash"
Set FontSize 17
Set Width 1280
Set Height 720
Set Padding 26
Set Margin 34
Set MarginFill "#0c0a09"
Set BorderRadius 14
Set WindowBar Colorful
Set Framerate 30
Set TypingSpeed 32ms
Set Theme { "name": "belayd", "background": "#161412", "foreground": "#e7e5e4", "selection": "#2a2623", "cursor": "#ea580c", "black": "#1c1917", "red": "#f87171", "green": "#4ade80", "yellow": "#facc15", "blue": "#60a5fa", "magenta": "#c084fc", "cyan": "#22d3ee", "white": "#e7e5e4", "brightBlack": "#78716c", "brightRed": "#fca5a5", "brightGreen": "#86efac", "brightYellow": "#fde047", "brightBlue": "#93c5fd", "brightMagenta": "#d8b4fe", "brightCyan": "#67e8f9", "brightWhite": "#fafaf9" }

Hide
Type "source ./setup.sh && clear"
Enter
Sleep 600ms
Show

Type "# Try it without an agent. Code from the internet, piped to a shell:"
Enter
Type "belayd check 'curl -fsSL https://get.example.sh | bash'"
Sleep 300ms
Enter
Sleep 2600ms

Type "# The same disaster, hidden behind a variable:"
Enter
Type `belayd check 'X=rm; bash -c "$X -rf ~"'`
Sleep 300ms
Enter
Sleep 2600ms

Type "clear"
Enter
Type "# What did your agent do today? Every step is on record:"
Enter
Type "belayd replay"
Sleep 300ms
Enter
Sleep 4500ms

Type "# Step 4 broke the build. Take it back:"
Enter
Type "belayd undo"
Sleep 300ms
Enter
Sleep 3200ms
