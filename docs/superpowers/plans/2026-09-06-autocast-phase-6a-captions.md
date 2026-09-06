# autocast Phase 6a — Captions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `narrate:` mean something. Burned-in captions, a `.vtt` sidecar, and the §7.1.1 narration floor — so a scene whose narration outlasts its action holds for the narration instead of cutting early.

**Architecture:** `planComposition` gains one input: seconds of narration per scene. In this phase those seconds are estimated from word count; in 6b they are measured from synthesised audio, through the same input. The planner never learns which it received, which is what makes 6b additive instead of a second timing path. Everything else is a compositor pass on the output frame, drawn after the camera.

**Tech Stack:** No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-autocast-design.md` — especially §7.1, §7.1.1 and §7.1.2.

## Global Constraints

- **Node 20+**, ESM. All three platforms. **No new runtime dependencies.**
- **The planner takes a duration, not a text.** No word counting inside `composition.ts`. If 6b has to change the planner to add audio, this phase failed.
- **`captions: false` must reproduce the current video exactly.** Not approximately.
- **Captions draw after the camera and before the crossfade blend.** Inside the camera they scale with a zoom; after the blend they pop at a cut instead of dissolving.
- **The floor applies only when narration is presented.** Reserving time for text nobody can see is a frozen frame for nothing.
- **No frames in agent context (§3, constraint 2).** Caption correctness is verified through the `.vtt` sidecar and pixel-band deltas, never by looking at a frame.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Every existing test must keep passing.

---

### Task 1: Speech duration

**Files:**
- Create: `src/render/speech.ts`, `src/render/speech.test.ts`

**Interfaces:**
- `const DEFAULT_WPM = 150`
- `function speechDurationSec(text: string, wpm?: number): number`

The only place a word rate lives. 150 wpm is a deliberate compromise
between caption reading comfort and TTS speaking rate: two different
numbers would mean the silent cut stops being a preview of the narrated
one (§7.1.2).

- [ ] **Step 1: Failing tests** — empty and whitespace-only text is 0s;
  a known sentence lands within a few percent of `words / wpm * 60`;
  the rate is honoured; punctuation and newlines do not count as words;
  the result is finite and non-negative for pathological input.
- [ ] **Step 2: Implement** — reuse the word-splitting rule already in
  `src/validate/lint.ts:161` so the linter's warning and the planner's
  floor cannot disagree about what a word is.
- [ ] **Step 3: Verify** — `npx vitest run src/render/speech.test.ts`

---

### Task 2: Caption wrapping

**Files:**
- Create: `src/render/caption.ts`, `src/render/caption.test.ts`

**Interfaces:**
- `const MAX_LINES = 2`
- `function wrapCaption(text: string, maxChars: number, maxLines?: number): string[]`

- [ ] **Step 1: Failing tests** — short text is one line; long text wraps
  on word boundaries; never exceeds `maxLines`; overflow is truncated with
  an ellipsis rather than silently dropped; a single word longer than
  `maxChars` does not loop forever; empty text yields `[]`.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/render/caption.test.ts`

---

### Task 3: Caption drawing

**Files:**
- Modify: `src/render/caption.ts`, `src/render/caption.test.ts`

**Interfaces:**
- `interface CaptionStyle { fontPx: number; padding: number; radius: number; opacity: number }`
- `function drawCaption(ctx: SKRSContext2D, lines: string[], box: { width: number; height: number }, style?: Partial<CaptionStyle>): void`

A rounded, semi-transparent scrim in the lower third, inset from the
edges, with the text centred on it. It must stay legible over both a
near-black terminal and a white page, which is the entire reason for the
scrim rather than outlined text.

Uses the bundled JetBrains Mono already loaded for the terminal renderer —
a generic family name resolves to a different face per platform and would
break determinism (the same trap §4 records for the terminal).

- [ ] **Step 1: Failing tests** — drawing changes pixels in the lower
  third and leaves the top half untouched; an empty line array draws
  nothing at all; the scrim darkens a white background and lightens a
  black one, so the text has contrast either way; two lines occupy more
  vertical space than one.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/render/caption.test.ts`

---

### Task 4: The narration floor

**Files:**
- Modify: `src/render/composition.ts`, `src/render/composition.test.ts`

**Interfaces:**
- `PlanOptions.narrationByScene?: Record<string, number>` — seconds, per scene id
- `SceneWindow.narration: { text: string; sec: number } | null`

`bodySec = Math.max(compressedSec, narrationSec, minSceneSec)`, computed
before any holds. Head, zoom envelope and tail stay on top and stay
uncompressible, so narration cannot be cut off by a scene ending early.

- [ ] **Step 1: Failing tests** — a scene whose narration exceeds its
  action gets a body equal to the narration; a scene whose action exceeds
  its narration is unchanged; a scene with no narration is byte-identical
  to today's plan; the floor composes with `minSceneSec` (the largest of
  the three wins); the tail is still never compressed; narration seconds
  of zero behave exactly like absent.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/render/composition.test.ts`

---

### Task 5: The `.vtt` sidecar

**Files:**
- Create: `src/render/vtt.ts`, `src/render/vtt.test.ts`

**Interfaces:**
- `interface Cue { startSec: number; endSec: number; text: string }`
- `function buildVtt(cues: readonly Cue[]): string`
- `function cuesFromPlan(plan: CompositionPlan): Cue[]`

Both the burned-in caption and the sidecar come from `cuesFromPlan`, so
asserting the sidecar verifies the burned-in text and timing without
decoding a pixel (§7.1.2).

- [ ] **Step 1: Failing tests** — output starts with `WEBVTT`; timestamps
  are `HH:MM:SS.mmm` and zero-padded; cues are in order and never overlap;
  a plan with no narration yields no cues (and a valid, empty file);
  cue spans match their window's start and end; text with a blank line
  cannot break the cue framing.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/render/vtt.test.ts`

---

### Task 6: Schema

**Files:**
- Modify: `src/schema/demo.ts`, and whichever schema test covers `style:`

**Interfaces:**
- `style.captions?: boolean` — default true
- `defaults.speech_rate?: number` — words per minute

- [ ] **Step 1: Failing tests** — both fields parse; both are optional;
  a non-positive `speech_rate` is rejected at parse time rather than
  producing an infinite scene; unknown keys still fail (the schema is
  `.strict()`).
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/schema/`

---

### Task 7: Wire it into the render path

**Files:**
- Modify: `src/driver/render.ts`, `src/driver/render.test.ts`

Compute `narrationByScene` from the script, pass it to `planComposition`,
draw the caption on `outCompositor` after `drawFullscreen` and **before**
`fadeInPrevious`, and write `<output>.vtt` next to the mp4.

`needsComposition` gains "any scene narrates while captions are enabled",
for the same reason zoom did: the flat single-session paths have no scene
timeline to hang a cue on.

- [ ] **Step 1: Failing tests** — rendering the flagship writes a `.vtt`
  whose cue count equals the number of narrated scenes; `captions: false`
  writes no `.vtt` and produces a video byte-identical to one rendered
  with narration removed; the caption band differs between a captioned and
  an uncaptioned render while the top half does not.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/driver/`

---

### Task 8: Report and lint

**Files:**
- Modify: `src/verify/report.ts`, `src/validate/lint.ts`, and their tests

- [ ] **Step 1: Failing tests** — narration seconds per scene appear in
  the report's **measured annex**, never in the byte-stable core (§4,
  determinism); the linter warns when narration cannot fit in
  `MAX_LINES` caption lines, naming the scene and the line.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/verify/ src/validate/`

---

### Task 9: Full verification

- [ ] `npm run typecheck`
- [ ] `npx vitest run` — everything green
- [ ] `npm run build && node dist/cli/index.js render fixtures/flagship/demo.yaml`
- [ ] Confirm by measurement, not by eye: `.vtt` cue times match the report's
      scene boundaries; the caption band's pixels change per scene; the top
      half of the frame is untouched by captions.

## Exit criteria (hand-testable)

1. The flagship carries a readable caption per scene, legible over both the
   dark terminal and the white page.
2. `docs/flagship-demo.vtt` exists and its cue times match the scene
   boundaries in the report.
3. A scene whose narration is longer than its action visibly holds for the
   narration instead of cutting early.
4. `style: { captions: false }` produces the current video, unchanged.
5. `autocast validate` warns when narration cannot fit in two caption lines.
