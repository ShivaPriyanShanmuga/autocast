# autocast Phase 7 — Agent surface and release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent in a repo that has never seen autocast writes a demo script and gets an mp4, without a human explaining the schema.

**Architecture:** No new runtime machinery. §9 already settled that the product is `npx autocast` plus knowledge, not an MCP server: the agent's whole job is write-a-file, run-a-command, read-a-report, which every coding agent can already do. This phase adds the missing knowledge layer and the one missing command.

**Tech Stack:** No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-autocast-design.md` — especially §9 and §10.

## Decisions taken into this plan

- **Not publishing to npm in this phase.** `autocast` is taken (v0.0.4 by someone else). Everything ships and is verified locally; publishing stays a deliberate step behind a name the author picks.
- **The skill must NOT embed the schema.** §9 rejected MCP partly for adding "a duplicated schema to keep in sync"; copying the schema into a skill file would be that same mistake in a cheaper wrapper. The skill tells the agent to run `autocast schema`.

## Global Constraints

- **Node 20+**, ESM. All three platforms. **No new runtime dependencies.**
- **`init` never overwrites.** An agent that runs it twice, or in a repo that already has a demo, must not lose work.
- **Knowledge lives in one place.** Schema from `autocast schema`; the skill and `AGENTS.md` point at it rather than restating it.
- **The token budget is enforced, not claimed** (§9). The existing regression test must keep passing.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.

---

### Task 1: `autocast init`

**Files:**
- Create: `src/cli/init-command.ts`, `src/cli/init-command.test.ts`
- Modify: `src/cli/run.ts` (dispatch + usage)

**Interfaces:**
- `function initCommand(argv: string[], io: CliIO): Promise<number>`
- `function detectProject(dir: string): 'web' | 'cli'`

Writes `demo.yaml` scaffolded for what it found, and `.autocast/schema.json`
so editors autocomplete. The scaffold carries a
`# yaml-language-server: $schema=` header pointing at it.

Detection: a `package.json` with a `dev` or `start` script means a web
project; anything else gets the CLI scaffold. Wrong guesses are cheap —
the scaffold is a starting point the agent edits — but a silent wrong
guess with no note is not, so `init` says what it detected and why.

- [x] **Step 1: Failing tests** — writes `demo.yaml` and
  `.autocast/schema.json`; the scaffold passes `autocast validate`
  unedited; refuses to overwrite an existing `demo.yaml` and exits
  non-zero saying so; `--force` overwrites; detects web from a `dev`
  script and cli otherwise; reports which it chose; the schema written
  matches `autocast schema` byte for byte.
- [x] **Step 2: Implement**
- [x] **Step 3: Verify** — `npx vitest run src/cli/init-command.test.ts`

---

### Task 2: The failure playbook

**Files:**
- Create: `src/cli/playbook.ts`, `src/cli/playbook.test.ts`
- Modify: `src/driver/render.ts` or `src/cli/render-command.ts`

**Interfaces:**
- `function nextStepFor(report: RenderReport): string | null`

A failed render already names what broke. What an agent lacks is what to
DO about it — and guessing costs a render each time, which is the
expensive operation in the loop.

Maps the failure to one concrete next action: a selector that matched
nothing suggests `wait_for` before the step; a `wait_for` timeout
suggests checking the pattern against the recorded output; an H005 sync
finding suggests shortening the narration or setting `sync: hold`.

- [x] **Step 1: Failing tests** — each failure class yields a distinct,
  actionable line; a passing report yields null; the line stays under a
  token budget so it cannot bloat the ~300-token report.
- [x] **Step 2: Implement**
- [x] **Step 3: Verify** — `npx vitest run src/cli/playbook.test.ts`

---

### Task 3: `AGENTS.md`

**Files:**
- Create: `AGENTS.md`

The loop, the assertion vocabulary by name only, the failure playbook,
and the one rule that matters most: **never open the video or the contact
sheet.** An agent that starts looking at frames defeats the entire
architecture (§3, constraint 2), and it is the single most likely thing
for a well-meaning agent to do unprompted.

- [x] **Step 1: Write it**, pointing at `autocast schema` rather than
  restating the schema.
- [x] **Step 2: Verify** — a test asserts `AGENTS.md` exists, names all
  four commands, and does not contain an inlined copy of the schema.

---

### Task 4: The Claude Code skill

**Files:**
- Create: `skills/autocast/SKILL.md`

Thin by design: frontmatter, when to use it, the loop, and a pointer to
`autocast schema`. Everything the skill would otherwise duplicate is a
command away.

- [x] **Step 1: Write it** with valid frontmatter (`name`, `description`).
- [x] **Step 2: Verify** — a test parses the frontmatter and asserts the
  description says when to use it, not merely what it is.

---

### Task 5: README and LICENSE

**Files:**
- Create: `README.md`, `LICENSE`

The README leads with what makes this different — a real recorded mp4,
frames never in the agent's context, deterministic re-render in CI — then
install, the loop, and a worked example. Embeds the flagship demo.

MIT, matching the dependency licences already in use.

- [x] **Step 1: Write both.**
- [x] **Step 2: Verify** — `package.json` gains `license`, `repository`,
  `keywords`, `files`; a test asserts the packed tarball contains `dist`
  and `scripts` and excludes `fixtures` and `docs`.

---

### Task 6: The exit criterion, as a test

**Files:**
- Create: `src/cli/agent-surface.test.ts`

The phase's exit criterion, executed rather than asserted by hand: in a
temporary directory that has never seen autocast, run `init`, then
`validate`, then `render`, and get a playable mp4.

- [x] **Step 1: Failing test** — scaffold a throwaway CLI project in a
  temp dir, run the three commands through `runCli`, assert the mp4
  exists and ffprobe reports h264.
- [x] **Step 2: Make it pass**
- [x] **Step 3: Verify** — `npx vitest run src/cli/agent-surface.test.ts`

---

### Task 7: Full verification

- [x] `npm run typecheck`
- [x] `npx vitest run` — everything green
- [x] `npm pack --dry-run` and confirm the file list
- [x] Render the flagship one final time and confirm the report, `.vtt`
      and video are all current

## Exit criteria (hand-testable)

1. In a fresh directory, `npx autocast init && npx autocast render demo.yaml`
   produces a playable mp4 with no hand-holding.
2. `autocast init` refuses to clobber an existing `demo.yaml`.
3. A deliberately broken script produces a report whose suggested next step
   is the one a human would give.
4. `AGENTS.md` and the skill both fit in a couple of thousand tokens and
   neither restates the schema.
5. `npm pack --dry-run` ships `dist` and `scripts`, and nothing else.
