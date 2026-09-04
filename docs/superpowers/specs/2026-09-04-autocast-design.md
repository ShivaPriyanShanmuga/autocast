# autocast — agent-driven demo video recorder

**Status:** Design approved, pending implementation plan
**Date:** 2026-09-04

## 1. Problem

When a coding agent finishes building something, it should be able to produce a
real demo video — recorded, not stitched screenshots — and commit it to the repo.

The agent is better positioned than the human to script that demo: it already
knows the routes, the CLI flags, the fixtures, the auth setup, and the
interesting edge cases. The ask is "demo everything you just built and give me
an mp4."

## 2. Prior art and why we are building anyway

| Tool | What it is | Terminal? | Sync policy | Agent surface |
|---|---|---|---|---|
| [argo](https://github.com/shreyaskarnik/argo) | Playwright screencast + Kokoro TTS + overlays + ffmpeg | No | marks; overlapping clips pushed forward 100ms | Claude Code skill |
| [playwright-recast](https://github.com/ThePatriczek/playwright-recast) | fluent pipeline over Playwright trace/webm | No | SRT cues; holds frame until audio ends; idle speed-up | MCP server |
| [shot-scraper video](https://simonwillison.net/2026/Jun/30/shot-scraper-video/) | YAML storyboard to Playwright video | No | none (silent) | help-text-as-context |
| [Playwright agent-cli `--save-video`](https://playwright.dev/agent-cli/commands/video-recording) | raw capture + chapter markers | No | none | CLI/MCP primitive |
| [VHS](https://github.com/charmbracelet/vhs) | `.tape` DSL to ttyd + ffmpeg | Terminal only | none | none |
| [asciinema](https://github.com/asciinema/asciinema) + agg | `.cast` to gif/mp4 | Terminal only | none | none |

**Findings:**

- "demo.dev" could not be located. Products in that space (Demosmith, Velo,
  Supademo) are SaaS marketing-demo generators — cloud browser, hosted MP4, no
  repo-committed artifact. Different category, not competition.
- **Every browser tool is browser-only. Every terminal tool is terminal-only.
  Nothing unifies them.** The [HN thread asking for exactly this](https://news.ycombinator.com/item?id=34244317)
  is answered with "hand-edit in a video editor."
- **Token efficiency is table stakes, not a differentiator.** argo,
  playwright-recast and shot-scraper all already keep frames out of the LLM
  context. The brief framed this as the whole point; it is the baseline.

The genuine, unbuilt gap is **one script format and one capture abstraction
spanning web and non-web, producing a single continuous artifact.**

## 3. Locked constraints

1. **Success = shippable OSS tool.** We own the capture abstraction end to end.
   No wrapping argo or playwright-recast. Cross-platform and a stable,
   versioned script format are requirements.
2. **Observation policy: text evidence + human-gated frames.** The default
   authoring loop is 100% textual. Frames never auto-enter agent context. On
   failure the CLI writes a contact sheet to disk and prints the path; the
   agent may open it only if the human explicitly says so.
3. **Windows, macOS and Linux are all first-class.**
4. **The demo script is declarative data (YAML), not code.**
5. **v1 = browser + terminal + CDP attach for Electron/Tauri.** Native desktop
   window capture is deferred (see section 11).
6. **Silent first.** Cinematic polish is phase 5; TTS is additive, phase 6.

### 3.1 Two premises in the brief that were corrected

**"Deterministic re-render" cannot mean byte-identical.** We record real
software against wall-clock time — animations, spinners, timestamps, network
jitter. Determinism here is *semantic*: the script either renders with every
assertion green, or it fails loudly with a named reason. CI asserts pass/fail,
never pixel diffs of the output video.

**Token efficiency and verification are the same constraint in tension.** If
the agent may never observe output, it cannot distinguish "demo is correct"
from "demo recorded a stack trace beautifully." Resolved by constraint 2 plus
the heuristic layer in section 8.

## 4. Architecture

**Runtime: TypeScript on Node 20+.** Chosen because the three components we
cannot reasonably rewrite live there: Playwright, `node-pty` (the only mature
cross-platform PTY binding), and `@xterm/headless` (VS Code's VT parser). It is
also the `npx` distribution channel agent users expect.

### 4.1 The backend abstraction

Pluggability reduces to one distinction — how a backend surrenders its pixels:

```ts
type CaptureKind =
  | { kind: 'log' }    // replayable: bytes + timestamps
  | { kind: 'frame' }  // opaque: timestamped image files

interface CaptureBackend {
  id: string;
  captureKind: CaptureKind;
  start(ctx: RenderContext): Promise<void>;
  execute(step: Step): Promise<StepResult>;   // timing + evidence
  assert(a: Assertion): Promise<AssertResult>;
  stop(): Promise<CaptureArtifact>;
}
```

Terminal is `log`. Browser is `frame`. A future desktop or mobile-emulator
backend is `frame` and costs nothing new.

**Web-only tooling is the degenerate case:** a demo with one browser session.
Not a mode, not a code path — just a smaller script.

### 4.2 Chosen approach: uniform frame bus, with offline replay for the terminal

Three approaches were considered:

- **A. Uniform frame bus.** Every backend emits frames onto one shared canvas;
  one compositor, one encode. Mixed sources are free. Cost: we write a
  compositor.
- **B. Per-scene clips stitched with ffmpeg concat.** Cheapest, uses native
  paths. Rejected: "one continuous artifact" degrades to clips butted together,
  with resolution/fps reconciliation at stitch time and no insets or
  transitions. This fails a hard constraint.
- **C. Event log + offline replay for everything.** Best determinism, tiny
  intermediates. Rejected for the browser: a browser replay engine is
  rrweb-scale with real fidelity risk.

**Decision: A, with C applied to the terminal only.**

The asymmetry is the core insight. *A terminal has a natural semantic event
log; a browser does not.* The PTY byte stream plus timestamps **is** an
asciicast. So the terminal is captured as a log and rendered to frames offline,
buying exact retiming, resolution independence, theme changes and perfect
determinism without re-running the command. The browser has no cheap
equivalent and is captured as frames. Both normalize onto the same frame bus.

Consequence to document honestly: **idle speed-up on a terminal is exact
(retime the log, re-render); on a browser it is frame decimation.**

### 4.3 Pipeline

```
demo.yaml --> [schema] --> validate (zero execution)
                  |
        +----- PASS 1: DRIVE -----+
        | terminal > PTY bytes+ts |--> session.log   (~KB, text)
        | browser  > CDP frames   |--> frames/*.jpg + ts manifest
        | both     > marks, asserts, timings        |
        +-------------------------+
                  |   durations now KNOWN
        +----- PASS 2: COMPOSE ---+
        | retime . pace . narrate |
        | log > frames (render)   |
        | jpg > resample to fps   |
        | compositor > canvas     |
        +-------------------------+
                  |
        single ffmpeg encode --> demo.mp4
                  +------------> report.json (text only)
```

**Two passes are not an optimization — they are load-bearing.** Narration is
authored before any duration is known; action durations exist only after
pass 1. One-pass designs (argo, playwright-recast) can only patch the mismatch
in one direction. Two passes make it a solved problem: measure, then compose
against real numbers. Idle compression and pacing depend on the same property.

### 4.4 Canvas contract

One canvas, one encode. Default 1280x720 at 30fps, RGBA internally,
`yuv420p` + `libx264` + `+faststart` out. Every source is normalized **at the
source**, so there is no concat step and no resolution pop. This is what makes
terminal to browser to terminal genuinely one artifact.

### 4.5 Browser capture is raw CDP, not Playwright `recordVideo`

`recordVideo` returns a finished webm with timing baked in — useless for
retiming. `Page.startScreencast` returns JPEG frames each carrying a real
timestamp: variable-rate data we can resample, idle-compress, and align to
narration. Choosing `recordVideo` would forfeit all of section 7.

**Capture happens at `deviceScaleFactor: 2` and is composited down.** The
browser is captured at 2560x1440 and downscaled onto the 720p canvas. This is
not a quality nicety — it is what makes zoom (section 7.2) lossless up to 2x.
Zooming into a 1x raster produces upscaled mush; zooming into a 2x capture
consumes real pixels. **This decision cannot be deferred:** building phase 2 at
1x and adding polish later would require re-recording every demo authored in
between. Cost is 4x frame data on disk during pass 1 plus downscale CPU, both
bounded because frames stream to disk rather than memory.

The terminal is exempt — it is rendered offline at whatever resolution the
compositor asks for, so terminal zoom is always pixel-exact. Another dividend
of the log-replay half of section 4.2.

### 4.6 Sessions are not scenes

The flagship demo — start the server, hit it in the browser, show the logs —
breaks if terminals are scene-scoped, because the server must outlive scene 1.
Long-lived resources are declared once; scenes are views onto them. Teardown is
pipeline-managed in reverse declaration order inside a `finally`, with
pidfile-based orphan detection on the next run.

### 4.7 Module boundaries

| Module | Responsibility |
|---|---|
| `schema` | YAML parse, JSON Schema validation, static lint |
| `backends/terminal` | node-pty session, PTY log capture, step execution, assertions |
| `backends/browser` | Playwright/CDP session, screencast capture, step execution, assertions |
| `driver` | Pass 1: walk the scene graph, collect marks/timings/evidence |
| `timeline` | Pass 2 core: pure solver producing a render plan |
| `render/terminal` | asciicast log + xterm buffer to frames |
| `render/resample` | timestamped JPEGs to fixed-fps frames |
| `render/compositor` | layout, cursor, zoom, transitions to canvas frames |
| `encoder` | ffmpeg pipe, single encode |
| `verify` | assertions, heuristics, report generation |
| `cli` | init / validate / render / doctor / schema |

## 5. Script schema

```yaml
autocast: 1
output:  { path: docs/demo.mp4, canvas: [1280, 720], fps: 30 }
defaults: { typing_speed: 45ms, settle: 400ms }

# optional; phase 5. Omitted entirely = plain, unstyled capture.
style:
  background:  { gradient: ["#1a1a2e", "#16213e"], padding: 64 }
  window:      { radius: 12, shadow: true }
  zoom:        { auto: true, on: click, scale: 1.8, ease: spring }
  cursor:      { size: 1.5 }
  motion_blur: { cursor: true, zoom: true, pan: true }

sessions:
  api: { backend: terminal, cwd: ./server, cols: 100, rows: 28 }
  web: { backend: browser,  viewport: [1280, 720] }
  # desktop-shaped apps (Electron/Tauri):
  # app: { backend: browser, attach: { cdp: "http://localhost:9222" } }

scenes:
  - id: boot
    use: api
    narrate: "First we start the API server."
    steps:
      - type: "npm run dev"
      - key: Enter
      - wait_for: { stdout: /listening on :3000/ }
    assert:
      - process_alive: true

  - id: order
    use: web
    narrate: "A customer places an order."
    focus: "[data-test=order-form]"
    steps:
      - goto: http://localhost:3000
      - click: "[data-test=new-order]"
      - fill: { selector: "#qty", value: "3" }
      - click: "text=Submit"
      - wait_for: { selector: ".order-confirmed" }
    assert:
      - visible: ".order-confirmed"
      - no_console_errors: true

  - id: logs
    use: api
    layout: { primary: web, inset: { session: api, corner: bottom-right, scale: 0.4 } }
    narrate: "And the server logs it."
    assert:
      - stdout_matches: /POST \/orders 201/
```

**Design decisions:**

- **`wait_for`, never `sleep`.** Waits are semantic — a selector appears,
  stdout matches. A slower CI box changes the video's length, not its
  correctness. `sleep` exists but `validate` flags it as a smell. This is the
  single largest contributor to re-render robustness.
- **Assertions are near-mandatory.** `validate` warns on any scene without one.
- **`use` is the acting session; `layout` is what the viewer sees.** A scene's
  steps and assertions always run against `use`. When `layout` is absent, the
  used session is shown fullscreen. When `layout` is present it governs
  composition only — so the `logs` scene above *acts* on `api` (asserting
  against its stdout) while *showing* `web` fullscreen with the `api` terminal
  inset. Every session named in a layout must already be declared, and
  `validate` enforces that.
- **No loops, conditionals or expressions.** Deliberate expressiveness ceiling.
  Logic goes in a `run:` step shelling out to a script the user owns. Keeps
  re-render free of arbitrary evaluation and keeps PR diffs reviewable — the
  reason data was chosen over code.
- **`narrate` exists from day one even while silent.** Phase 1 uses it for
  captions and duration estimation; TTS later uses the same field with no
  schema change.
- **`autocast: 1`** is a schema version supporting migration.

## 6. Terminal capture — decision and rationale

| Option | Verdict |
|---|---|
| ttyd + ffmpeg (VHS's approach) | Rejected — poor Windows story; ships a web server + browser per recording; frames only, so no retiming |
| Screen-record a real terminal | Rejected — non-deterministic by construction (user font, theme, DPI, WM). Unusable in CI |
| tmux `capture-pane` polling | Rejected — POSIX-only; samples on a clock so it drops fast output; loses colour fidelity |
| **`node-pty` + `@xterm/headless` + own renderer** | **Chosen** |

Reasoning:

1. **ConPTY makes Windows a real target**, not an emulation. `node-pty` is what
   VS Code's terminal runs on, across all three platforms, with prebuilds.
2. **The PTY byte stream is the semantic log** — the C-half of section 4.2.
   Capture is kilobytes of text and is asciicast-v2 compatible, so recordings
   interoperate with the existing ecosystem for free.
3. **Offline rendering makes retiming exact.** Idle speed-up is a replay
   against a different clock, not frame-dropping. Re-rendering at 1080p or in a
   different theme requires no re-run of the command.
4. **We bundle the font (JetBrains Mono, OFL).** This is the determinism
   keystone: identical glyph rasterization on all three platforms, so terminal
   frames are reproducible across machines instead of hostage to what is
   installed. It is also what makes golden-frame testing viable.

Glyph rasterization via `@napi-rs/canvas` (prebuilt native, real font shaping).

**Accepted cost:** we own a VT-to-pixels renderer. `@xterm/headless` absorbs VT
parsing — the part that would sink us — leaving layout and rasterization, which
is bounded. Full-screen TUIs (vim, htop), wide CJK glyphs, combining marks and
sixel form a long tail requiring explicit test coverage.

**Total system dependencies: ffmpeg.** Everything else is npm with prebuilds.

## 7. Timing

After pass 1, per scene: `V` = real video duration, `A` = narration duration
(measured from TTS, or estimated from word count while silent).

### 7.1 Narration sync

Four levers in strict precedence:

| # | Lever | Mechanism |
|---|---|---|
| 1 | Compress idle | Detect dead air — terminal: no output; browser: inter-frame delta below threshold. Terminal retimes the log exactly; browser decimates frames. Capped at 8x. Never touches spans where something is visibly happening. |
| 2 | Extend holds | Pad at the scene's natural rest point, after the last action settles. Never a freeze mid-motion. |
| 3 | Time-stretch audio | `librubberband`, pitch-preserved, hard-capped at +/-10%. Beyond that it is audible. |
| 4 | Fail loudly | Residual beyond tolerance produces a named error, not a silently ugly video. |

Bidirectional policy:

- **`A > V`** — extend holds, then compress audio by at most 10%. If still
  over: `sync: hold` (default) extends anyway; `sync: strict` fails and reports
  that the narration is too wordy for the action.
- **`V > A`** — compress idle first. Residual silence at the end of a scene is
  natural and is allowed to stand.

**Sync is per-scene, and every scene boundary re-anchors.** Drift within a
scene is imperceptible; drift accumulating across a video is what reads as
broken. argo and playwright-recast both sync globally and patch in one
direction only.

### 7.2 Not looking robotic

All of this is **compositor-side**, so it never perturbs the app under test and
re-renders without re-running anything.

- **Typing** — per-character Gaussian jitter (+/-30%), longer beats after
  punctuation. Reproducible because the PRNG is seeded from the scene id.
  Humanized *and* deterministic.
- **Cursor** — headless has no cursor, so we draw one. Minimum-jerk eased paths
  between targets with slight overshoot-and-settle; clicks get a ring pulse.
- **Zoom** — `focus: <selector>` for explicit framing, and `style.zoom.auto`
  for automatic zoom on click targets. **We frame better than a screen
  recorder can.** Screen Studio and its peers infer intent from pixels: they
  see a click at (x, y) and guess a zoom factor. We know the semantic action
  and the element's exact bounding box from the DOM, so we frame to fit the
  element plus margin, and we know precisely when the interaction ends and the
  camera should pull back. Their version is a heuristic; ours is exact. Scene
  boundaries also zoom out deliberately, because we know a cut is coming.
- **Motion blur** — camera moves (pan, zoom, cursor travel) are composited at
  4x the target fps and box-averaged down, producing true accumulation blur.
  Only motion segments pay the cost, not the whole video. Configurable
  independently per channel via `style.motion_blur`.
- **Presentation frame** — optional gradient/solid background with padding,
  rounded window corners and a drop shadow (`style.background`,
  `style.window`). Pure compositor layer over the normalized canvas.
- **Pacing** — a settle beat after every action, no instant cut on a click,
  short crossfade at scene boundaries.

All of the above are additive compositor passes, so they can land after
capture and composition are solid (phase 5) without reopening either. The one
exception is capture resolution, which is settled in section 4.5 and must be
right from phase 2.

## 8. Verification and error handling

**Layer 1 — static (`autocast validate`), zero execution.** Schema check;
referential integrity (every `use:` names a declared session, every
`inset.session` exists); lint for scenes without assertions, `sleep` usage,
unused sessions, and narration exceeding an absolute word-count ceiling (true
scene duration is unknowable without running, so this can only catch narration
too long for *any* plausible scene, not narration too long for this one).
Non-zero exit on error. This is the dry-run mode, available from phase 0.

**Layer 2 — runtime assertions during pass 1.**

- terminal: `process_alive`, `exit_code`, `stdout_contains`, `stdout_matches`,
  `stderr_empty`
- browser: `visible`, `hidden`, `text_matches`, `url_matches`,
  `no_console_errors`, `no_failed_requests`

Default `on_assert_fail: abort` — no point encoding a demo already known to be
wrong.

**Layer 3 — heuristics for unpredicted failures.** No LLM, no vision model,
reported as text. **No OCR is required:** for the terminal we own the character
grid, so error-string scanning is an exact buffer grep; for the browser we read
DOM text. Both are free and exact. Genuinely pixel-based heuristics: blank
frame detection, frame-delta flatlining (steps claimed to act, nothing moved),
scene-duration anomalies, and A/V divergence beyond tolerance.

**Report** — the agent's entire view of the world:

```
autocast render - docs/demo.mp4
  OK   boot    4.2s   2 assertions   term        (idle 3.1s -> 0.8s)
  OK   order   7.8s   2 assertions   web         (focus: [data-test=order-form])
  FAIL logs    2.1s   1 assertion    term+inset
      assert stdout_matches /POST \/orders 201/ - no match
      last 3 lines of api stdout:
        GET / 200
        GET /static/app.js 200
      heuristic: frame-delta flatline 1.9s of 2.1s

  FAILED - 1 of 3 scenes.
  Contact sheet: .autocast/failed/logs-contact.png   (not read automatically)
```

**Preflight, before pass 1 begins** — ffmpeg present with `libx264` (warn if
`librubberband` is absent, since narration stretch degrades); `node-pty` native
module loads; Playwright chromium installed; output directory writable. Each
failure prints the exact per-platform install command. A missing dependency must
never be discovered after a two-minute capture.

## 9. Agent surface: CLI + skill, deliberately not MCP

The agent's entire job is: write a YAML file, run a command, read a text
report. That is file-editing plus shell — capabilities every coding agent
already has. An MCP server would wrap `render` in a tool call returning the same
text report, while adding a process, a protocol, a duplicated schema to keep in
sync, and permanent per-session context cost for tool definitions.

MCP earns its place when an agent needs capabilities it lacks — a live session
to interrogate, state persisting across calls. **This architecture deliberately
eliminates that need**, because interrogating would mean looking at frames.
Adopting MCP here would be adopting a protocol to solve a problem we designed
away.

What the agent actually needs is knowledge — schema, assertion vocabulary,
failure playbook. That is documentation.

**Decision:** `npx autocast` is the product. A thin Claude Code skill packages
the knowledge; a plain `AGENTS.md` snippet gives Cursor/Codex/Copilot users the
same thing without a plugin. JSON Schema is published for editor autocomplete.
MCP remains available later without a rewrite, since it would shell out to the
same CLI.

Loop:

```
autocast init        -> scaffold + schema reference
  (agent writes demo.yaml)
autocast validate    -> static errors, no execution, ~free
  (agent fixes)
autocast render      -> text report (~300 tokens)
```

Roughly 2k tokens for the schema once, ~1k to author, ~300 per iteration —
**flat in video length.** This is enforced by a regression test (section 10),
not merely claimed.

## 10. Testing

TDD throughout; every phase ships with tests.

| Layer | Covers |
|---|---|
| Unit | Schema validation; the timing solver (pure fn: `V`, `A`, idle spans to plan); VT buffer to glyph layout; seeded-PRNG reproducibility; sync precedence |
| Golden frame | Render fixtures, compare chosen frames to committed PNGs via SSIM tolerance. Viable cross-platform only because we bundle the font |
| Integration | Full render of fixtures; assert report contents + `ffprobe` output (duration, codec, dimensions, frame count) |
| Determinism | Render twice; the report's **deterministic core** (scene ids and order, assertion results, pass/fail, which timing policies fired) must be byte-identical. Measured wall-clock durations live in a separate annex and are compared within tolerance — see the note below |
| Token budget | Two demos with the **same scene count** but 10-second and 10-minute durations produce reports within the same token band. Report size scales with scene count, never with video length — that is the invariant being protected |
| Failure injection | Dead selector, server that will not boot, failing assertion — assert we fail loudly and correctly |

**Report structure follows from the determinism test.** `report.json` is split
into two parts, because a report containing measured durations can never be
byte-stable:

- **core** — scene ids and order, assertion names and results, pass/fail,
  which timing policies fired and why. Fully deterministic; this is what CI
  compares and what the agent reads.
- **measured** — wall-clock durations, frame counts, applied speed factors.
  Varies run to run; compared only within tolerance.

**Fixtures — checked in, zero network, zero npm dependencies beyond Node:**

- `fixtures/web-app/` — static + JSON API server; a form, a result element, one
  deliberately slow endpoint to exercise `wait_for`
- `fixtures/cli-app/` — Node CLI with subcommands, ANSI colour, a
  carriage-return redrawing progress bar, and an alt-screen TUI mode (the two
  things most likely to break a VT renderer)
- `fixtures/mixed/demo.yaml` — the flagship

CI runs on Linux, Windows and macOS runners.

## 11. Non-goals and deferred work

- **Native desktop window capture (Win32/Cocoa/GTK).** Deferred. It is the one
  backend that fights the determinism constraint: macOS ScreenCaptureKit needs
  a TCC grant and Wayland needs a portal prompt, both interactive, so such
  scenes **cannot render in headless CI** on two of three platforms. Driving
  native apps is a second and larger problem — UIAutomation, AX API and AT-SPI
  are three unrelated stacks, and the fallback is blind coordinate clicking,
  exactly the brittleness deterministic re-render exists to prevent. When it
  lands, docs must be explicit that it is the non-CI-able backend.
- **Electron/Tauri are covered in v1** via CDP attach through the browser
  backend, which absorbs most agent-built "desktop" apps for near-zero cost.
- **Mobile emulators.** Future `frame` backend.
- **Pixel-diff regression of the output video.** See section 3.1.
- **Loops/conditionals in the script format.** See section 5.

## 12. Phases

Each phase stops for approval. Exit criteria are hand-testable.

**Phase 0 — Foundations and validate.** Repo, TS build, CLI shell, `doctor`,
`schema`, `validate`. No capture.
*Exit:* `npx autocast doctor` truthfully reports present/missing deps with
copy-pasteable install commands. `autocast validate fixtures/mixed/demo.yaml`
passes; a deliberately broken copy fails naming the line and reason.

**Phase 1 — Terminal backend, silent.** node-pty + @xterm/headless + glyph
renderer + encoder. Single session.
*Exit:* render the CLI fixture and watch an mp4 of a real command running,
progress bar redrawing correctly, with human-feeling typing.

**Phase 2 — Browser backend, silent.** CDP screencast, resampling, synthetic
cursor, `focus:` zoom.
*Exit:* render the web fixture; cursor moves on eased paths, clicks pulse, zoom
makes a small form readable.

**Phase 3 — Composition and mixing.** Multi-session, scene graph,
layouts/insets, transitions, idle compression.
*Exit:* the flagship — one continuous mp4, terminal to browser to terminal
inset, with no resolution pop at any boundary.

**Phase 4 — Verification hardening.** Full assertion vocabulary, heuristics,
report format, contact sheet, determinism + token-budget tests, CI on three
OSes.
*Exit:* break a selector on purpose and the render fails fast with a named
error and non-zero exit. Render twice and get identical report cores.

**Phase 5 — Cinematic polish.** The `style:` block: auto-zoom on click targets,
spring easing, motion blur, cursor scaling, gradient background with padding,
rounded corners and drop shadow. All additive compositor passes over a working
pipeline; no capture changes, because section 4.5 already settled resolution.
*Exit:* render the flagship twice, with and without `style:`, and the styled
version is one you would actually post publicly. Auto-zoom frames the clicked
element correctly without any `focus:` hint.

**Phase 6 — Narration.** Captions first, then TTS behind the sync policy. The
default must be free, keyless and local; Piper and Kokoro are the candidates,
decided at phase-6 planning on three criteria — cross-platform install
footprint, licence, and whether word-level timing marks are exposed (needed for
lever 3 in section 7.1). Paid providers optional behind the same interface.
*Exit:* the flagship with a voiceover that lands on the action; a deliberately
over-wordy narration trips `sync: strict` instead of silently looking wrong.

**Phase 7 — Agent surface and release.** Claude Code skill, `AGENTS.md`, docs,
`autocast init`, npm publish.
*Exit:* in a different repo, an agent produces an mp4 without the schema being
explained to it by hand.

Phases 0-4 deliver a complete, useful silent tool; phase 5 makes it one people
will actually want to publish. Narration is additive on top of both, by design.

## 13. Known risks

| Risk | Mitigation |
|---|---|
| VT renderer long tail (TUIs, CJK, combining marks) | `@xterm/headless` owns parsing; explicit fixture coverage for alt-screen and carriage-return redraw; sixel explicitly out of scope for v1 |
| Golden-frame tests flaking across platforms | Bundled font; SSIM tolerance rather than exact match; frames chosen at settled rest points |
| CDP screencast frame drops under load | Timestamps are authoritative, not frame counts; resampler interpolates by holding the last frame |
| Compositor performance at 1080p | Frames stream to ffmpeg via stdin; no full-video buffering; encode is single-pass |
| `node-pty` prebuild missing on an exotic platform | Preflight detects module load failure and prints build-from-source instructions |
| 2x browser capture inflates pass-1 disk use 4x | Frames stream to disk as JPEG, never buffered in memory; intermediates live under `.autocast/` and are cleaned on success. Long demos get a documented disk-space note, and `deviceScaleFactor` is overridable for users who never zoom |
| Motion blur at 4x compositing fps costs CPU | Applied only to camera-motion segments, not the whole timeline; disabled by default when `style:` is absent |
