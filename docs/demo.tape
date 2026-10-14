# VHS tape for the second half of the README demo: replay and undo.
# Run from ~/belayd-demo after part one:  vhs path/to/docs/demo.tape
Output demo-part2.mp4

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 640
Set Padding 24
Set Theme "Builtin Dark"
Set TypingSpeed 45ms

Type "belayd replay"
Sleep 400ms
Enter
Sleep 3s

Type "belayd undo"
Sleep 400ms
Enter
Sleep 3s

Type "cat src/greeting.ts"
Sleep 400ms
Enter
Sleep 2500ms
