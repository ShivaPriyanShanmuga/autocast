# autocast Phase 6b — Voice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voiceover that lands on the action, and a named failure when narration is driving the pacing more than the action is.

**Architecture:** 6a built the input this needs — `planComposition` already takes narration *durations*. Voice replaces the word-count estimate with a measured one through that same input, so the planner does not change. Everything new lives behind a `VoiceBackend` interface: Kokoro is the default, a fake backend serves every timing test, and paid providers slot in later without touching the pipeline.

**Tech Stack:** `kokoro-js` as an OPTIONAL dependency, not installed by default. Voice is opt-in; a base install must not pull ~300MB of onnxruntime.

**Spec:** `docs/superpowers/specs/2026-09-04-autocast-design.md` — especially §7.1, §7.1.2 and §7.1.3.

## Spike findings this plan is built on (2026-09-06, Node 24, win32 x64)

- kokoro-js runs in Node. Model loads in 1.9s warm. Output is 24kHz mono float32 WAV.
- **Deterministic**: the same text twice produced identical sha256. The committed script stays the artifact.
- **Slow**: 8.8s to synthesise a 2.7s clip, roughly 3–5× realtime on CPU. Caching is not an optimisation here, it is a requirement.
- **`MAX_PATH` breaks the default cache on Windows.** transformers.js caches under `node_modules/@huggingface/transformers/.cache`; that path measured 265 characters in a normal project and onnxruntime reported "File doesn't exist" about a valid 92MB file. We MUST set a short `env.cacheDir`.
- 150 wpm predicted real speech at ratios 1.11 / 1.07 / 0.97 / 0.89 — mean 1.01. The 6a estimate is sound as a fallback.

## Global Constraints

- **Node 20+**, ESM. All three platforms.
- **Voice is opt-in and the base install stays light.** `kokoro-js` is optional; absence is not an error unless a script asks for voice.
- **The planner does not change.** If `composition.ts` needs edits to accept measured durations, 6a's interface was wrong and that is the bug to fix.
- **Synthesis runs AFTER capture, never concurrently.** Inference pegging the CPU during capture would perturb the timings we measure for pacing.
- **Determinism.** Same script, same engine, same voice ⇒ same audio. Content-addressed cache keyed on engine + voice + rate + text.
- **No frames or audio in agent context.** Voice is verified through durations, `ffprobe` stream metadata and the report, never by listening.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.

---

### Task 1: The backend interface and a fake

**Files:**
- Create: `src/voice/backend.ts`, `src/voice/fake.ts`, `src/voice/fake.test.ts`

**Interfaces:**
- `interface SynthesisRequest { text: string; voice: string; rate: number }`
- `interface SynthesisResult { wavPath: string; durationSec: number }`
- `interface VoiceBackend { readonly name: string; synthesize(req: SynthesisRequest, outPath: string): Promise<SynthesisResult> }`
- `class FakeVoice implements VoiceBackend` — writes a real, valid WAV of silence whose length is `speechDurationSec(text, wpm)`.

The fake must emit a genuine WAV, not a stub: every timing test downstream
depends on ffprobe reading it, so a fake that cannot be muxed would test
nothing.

- [ ] **Step 1: Failing tests** — the fake writes a file ffprobe reports as
  audio; its duration matches `speechDurationSec` within a frame; two calls
  with the same text produce byte-identical files; zero-length text is
  rejected rather than producing a zero-byte WAV.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/voice/fake.test.ts`

---

### Task 2: Content-addressed cache

**Files:**
- Create: `src/voice/cache.ts`, `src/voice/cache.test.ts`

**Interfaces:**
- `function cacheKey(backend: string, req: SynthesisRequest): string` — sha256, hex
- `function cachedPath(dir: string, key: string): string`
- `async function synthesizeCached(backend, req, dir): Promise<SynthesisResult>`

At 3–5× realtime, re-synthesising on every render would make the CI
re-render the spec promises cost minutes. The key must include the
backend name and voice: the same words in a different voice are different
audio.

- [ ] **Step 1: Failing tests** — the key changes with text, voice, rate and
  backend, and is stable across calls; a second synthesis of the same
  request does not call the backend (count invocations); a corrupt or
  zero-byte cache entry is re-synthesised rather than trusted.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/voice/cache.test.ts`

---

### Task 3: The Kokoro backend

**Files:**
- Create: `src/voice/kokoro.ts`, `src/voice/kokoro.test.ts`

**Interfaces:**
- `const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'`
- `function modelCacheDir(): string` — short, user-level
- `class KokoroVoice implements VoiceBackend`

`kokoro-js` is imported dynamically so that not having it installed is a
clear, actionable error rather than a module-resolution crash at startup.

**The cache directory is a correctness fix, not a preference.** See the
spike finding: the default lands past Windows' 260-character `MAX_PATH`
and onnxruntime then reports that a valid 92MB file does not exist.

- [ ] **Step 1: Failing tests** — a missing `kokoro-js` produces a named
  error naming the install command, not a resolution stack trace;
  `modelCacheDir()` is short enough that the full model path stays under
  200 characters; the real-engine test runs only when `kokoro-js` resolves
  and skips loudly otherwise.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/voice/kokoro.test.ts`

---

### Task 4: Schema

**Files:**
- Modify: `src/schema/demo.ts`, `src/schema/demo.test.ts`

**Interfaces:**
- `voice?: { enabled?: boolean; backend?: 'kokoro' | 'fake'; voice?: string; rate?: number; sync?: 'hold' | 'strict' }`

- [ ] **Step 1: Failing tests** — the block parses and is optional; `rate`
  must be positive; `sync` defaults to `hold`; unknown keys still fail.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/schema/`

---

### Task 5: The audio timeline

**Files:**
- Create: `src/voice/timeline.ts`, `src/voice/timeline.test.ts`

**Interfaces:**
- `interface Clip { startSec: number; wavPath: string; durationSec: number }`
- `function planClips(plan, synthesized): Clip[]` — anchored on the same cues 6a emits
- `async function buildTrack(clips, totalSec, outPath): Promise<void>`

One WAV for the whole video, built with ffmpeg's `adelay`/`amix`, then
handed to the encoder as a second input. §13 forbids buffering the whole
*video*; a couple of megabytes of PCM is not that.

Clips anchor to their cue start, so audio and captions cannot drift apart
— they are the same timeline.

- [ ] **Step 1: Failing tests** — a clip starts at its window's start; a
  plan with no narration yields no clips; the built track's duration
  equals the video's; a clip that would overrun the end is clamped rather
  than extending the file; ffprobe reports one audio stream.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/voice/timeline.test.ts`

---

### Task 6: Muxing

**Files:**
- Modify: `src/render/encoder.ts`, `src/render/encoder.test.ts`

**Interfaces:**
- `EncodeOptions.audioPath?: string`
- `probeVideo` gains `hasAudio: boolean` and `audioCodec: string | null`

Video stays streamed through stdin; audio is a second `-i`. AAC, and
`-shortest` so a stray millisecond of audio cannot extend the video past
its last frame.

- [ ] **Step 1: Failing tests** — with `audioPath`, ffprobe reports an AAC
  stream and the video duration is unchanged within a frame; without it,
  the output is byte-identical to today's; a missing audio file fails with
  a named error rather than silently producing a mute video.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/render/encoder.test.ts`

---

### Task 7: The sync policy

**Files:**
- Create: `src/verify/sync.ts`, `src/verify/sync.test.ts`

**Interfaces:**
- `const STRETCH_LIMIT = 0.1`
- `function stretchFor(narrationSec, actionSec): number` — 1.0 when it fits, up to 1.1
- `function checkSync(windows, mode): Finding[]`

Two deliberate deviations from §7.1, both recorded in §7.1.3:

1. **Lever 3 runs before the floor, not after.** Speeding audio ≤10%
   pitch-preserved is inaudible; holding a scene 10% longer is visible.
   Applied in the spec's order the lever is unreachable, because the floor
   has already extended the scene.
2. **Lever 4 fails on a different condition.** §7.1 fails when narration
   does not fit, but 6a's floor makes it always fit. The failure worth
   having is the one it was reaching for: narration is driving the pacing
   more than the action is.

- [ ] **Step 1: Failing tests** — narration inside the action needs no
  stretch; 5% over yields a 1.05 stretch and no scene extension; 40% over
  clamps at `STRETCH_LIMIT`; `strict` reports a finding for the 40% case
  and `hold` does not; a scene with no action at all (assertions only) is
  exempt, since there is nothing for narration to outrun.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/verify/sync.test.ts`

---

### Task 8: Wire it into the render path

**Files:**
- Modify: `src/driver/render.ts`, `src/driver/render.test.ts`

Order: capture → synthesise (measured durations) → plan with those
durations → render frames → build track → mux. Falls back to the 6a
word-count estimate when voice is off.

- [ ] **Step 1: Failing tests** — with the fake backend the flagship gains
  an audio stream whose duration matches the video; scene bodies use the
  MEASURED duration, not the estimate; voice off produces exactly today's
  output; a script asking for a backend that is not installed fails with a
  named error and no video.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/driver/`

---

### Task 9: Doctor

**Files:**
- Modify: `src/doctor/checks.ts`, `src/doctor/checks.test.ts`

- [ ] **Step 1: Failing tests** — voice reports `skip` (not `fail`) when
  `kokoro-js` is absent, because voice is opt-in; the hint names the exact
  install command; when present, it reports the model cache directory.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify** — `npx vitest run src/doctor/`

---

### Task 10: Full verification

- [ ] `npm run typecheck`
- [ ] `npx vitest run` — everything green
- [ ] `npm run build`, then render the flagship with voice and confirm by
      `ffprobe` that audio and video durations agree, and that cue starts in
      the `.vtt` match where clips were placed.
- [ ] Re-render and confirm the cache means no re-synthesis.

## Exit criteria (hand-testable)

1. The flagship has a voiceover that lands on the action.
2. A deliberately over-wordy narration trips `sync: strict` with a named
   error instead of silently producing a stretched video.
3. `voice:` absent reproduces the 6a output exactly.
4. A second render costs no synthesis.
5. `autocast doctor` explains how to enable voice, and does not fail when
   it is simply not wanted.
