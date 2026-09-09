# castscript

Agent-driven demo video recorder. A coding agent writes a YAML script,
runs one command, and gets a **real recorded mp4** of a terminal and a
browser — committed alongside the code, re-renderable in CI.

https://github.com/ShivaPriyanShanmuga/autocast/raw/main/docs/shipboard-demo.mp4

*Recorded by castscript from [`demos/shipboard/demo.yaml`](demos/shipboard/demo.yaml) —
a terminal starting a server, a browser deploying through it, and the
terminal's own log of that deploy, as one continuous take. Re-record it
with `castscript render demos/shipboard/demo.yaml`.*

## What makes it different

**Frames never reach the agent's context.** Not a performance note — a
design constraint. Every question you might answer by looking at a frame
is answered exactly by an assertion, because a terminal's character grid
and a browser's DOM are exact where pixels are guesswork. The agent
writes a script, reads a ~300-token text report, and never sees a pixel.

**Web and non-web are equal citizens.** One capture abstraction, two
backends. A terminal scene and a browser scene compose into one
continuous video with no resolution pop at the cut — the demo above
shows a terminal logging the deploy the browser just triggered.

**Re-rendering costs zero model calls.** The committed script is the
artifact. CI can re-record the video from it; nothing needs an LLM.

**A broken demo produces no video.** Deliberately. A failing render
deletes any stale output rather than leaving something plausible-looking
where a passing result would go.

## Install

```bash
npm install --save-dev castscript
npx castscript doctor    # checks ffmpeg, Chromium, node-pty
```

`doctor` reports every dependency with a copy-pasteable fix, and never
claims a check passed when it could not run it.

## Use

```bash
npx castscript init                  # scaffold demo.yaml for this project
npx castscript validate demo.yaml    # static check, no capture — free
npx castscript render demo.yaml      # record, encode, report
```

## A script

```yaml
castscript: 1
output:
  path: docs/demo.mp4
  canvas: [1280, 720]

sessions:
  api:
    backend: terminal
  web:
    backend: browser
    viewport: [1280, 720]

scenes:
  - id: boot
    use: api
    narrate: "First we start the order API."
    steps:
      - type: "npm run dev"
      - key: Enter
      - wait_for: { stdout: /listening on :3000/ }
    assert:
      - process_alive: true

  - id: order
    use: web
    narrate: "A customer places an order."
    steps:
      - goto: http://127.0.0.1:3000/
      - click: "[data-test=new-order]"
      - fill: { selector: "#qty", value: "24" }
      - click: "#submit"
      - wait_for: { selector: ".order-confirmed" }
    assert:
      - visible: ".order-confirmed"
      - no_console_errors: true

  - id: proof
    use: api
    narrate: "There it is, in the server's own log."
    focus: /POST \/api\/orders 201/
    assert:
      - stdout_matches: /POST \/api\/orders 201/
```

Sessions outlive scenes, so the server booted in scene one is still
serving in scene three. The last scene has no steps at all — it proves a
side effect happened and frames the line that proves it.

## Presentation

Optional, and entirely a compositor pass — it cannot perturb capture or
change timing:

```yaml
style:
  background: { gradient: ["#0f1020", "#1b1b33"], padding: 56 }
  window: { radius: 14, shadow: true }
  zoom: { auto: true, on: click, scale: 1.7, ease: spring }
  cursor: { size: 1.4 }
```

Zoom is a camera over the finished frame, for both backends. We frame
better than a screen recorder can: they infer intent from pixels, we know
the element's exact bounding box from the DOM, and on a terminal `focus:`
is a pattern matched against the character grid.

## Narration

Captions are on whenever a scene has `narrate:`, and a `.vtt` sidecar is
written next to the video. Voice is opt-in:

```bash
npm i -D kokoro-js      # ~300MB; free, keyless, local, deterministic
```

```yaml
voice:
  enabled: true
```

A scene never cuts away before its narration finishes, and a scene whose
narration is driving the pacing more than its action can be made a hard
error with `voice: { sync: strict }`.

## For agents

`AGENTS.md` is written for coding agents and is the thing to point one
at. A Claude Code skill lives in `skills/castscript/`.

## The demo

[`demos/shipboard`](demos/shipboard) is a small deploy dashboard — a real
app, not a fixture — kept in this repo so the demo above can be
re-recorded from source at any time:

```bash
castscript validate demos/shipboard/demo.yaml   # free, no capture
castscript render   demos/shipboard/demo.yaml
```

Nothing needs starting first. The demo's own first scene boots the
server, which is the point: one script drives the terminal and the
browser together.

## Status

Phases 0–7 complete: terminal and browser capture, composition, pacing,
verification, presentation, captions and voice, agent surface.

Published as [`castscript`](https://www.npmjs.com/package/castscript). The
project's git history and design docs use its working name, `autocast`.

## Design

`docs/superpowers/specs/2026-09-04-castscript-design.md` is the design
document, including the decisions that were overturned by spikes and why.

## Licence

MIT.
