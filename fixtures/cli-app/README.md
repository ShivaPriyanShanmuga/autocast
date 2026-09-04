# cli-app fixture

A dependency-free CLI used by autocast's tests. Never add npm dependencies
to it — tests must run with no install and no network.

| Command | Exercises |
|---|---|
| `greet <name>` | ANSI colour and bold |
| `build` | carriage-return progress-bar redraw |
| `watch` | a process that never exits (the dev-server case) |
| `dash` | alternate screen, full redraw, box-drawing Unicode |
| `fail` | stderr output and a non-zero exit code |
