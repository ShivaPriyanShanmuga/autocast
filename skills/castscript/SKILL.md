---
name: castscript
description: Use when the user wants a demo video, screen recording, or GIF of something they just built, or asks to "show" or "demo" a feature - records a real mp4 of a terminal and/or browser from a committed YAML script
---

# Recording a demo video with castscript

Produces a real recorded mp4 of a terminal and/or a browser, from a YAML
script that gets committed alongside the code.

## The loop

```
npx castscript init                  # scaffold demo.yaml + local schema
npx castscript validate demo.yaml    # static check, no capture — free
npx castscript render demo.yaml      # records, encodes, prints a report
```

`validate` executes nothing, so run it after every edit. `render` is the
expensive step; when it fails, its report ends with one concrete next
action. Do that instead of guessing — a guess costs another render.

## NEVER look at the output

Do not open the mp4, the frames, or the contact sheet — no vision model,
no image tool, not "just to check". The architecture exists so you never
need to: the terminal's character grid and the browser's DOM are exact,
so every question worth asking is an assertion. Reading frames back burns
enormous context to get a worse answer than `stdout_matches` gives for
free.

Wanting to look at a frame means you want an assertion.

## Getting the schema

Run `npx castscript schema`. Do not reconstruct it from memory or from an
example — this file deliberately does not restate it, so the two cannot
drift apart.

`init` also writes `.castscript/schema.json` and references it from the
scaffold, so editors autocomplete.

## Shape

- `sessions:` are named and long-lived — a server started in scene one is
  still running in scene four. `backend: terminal` or `backend: browser`.
- `scenes:` are ordered, each using one session, with `steps:`,
  `assert:`, `narrate:`, `focus:`.
- `style:` adds background, window chrome and zoom. `voice:` adds
  narration and is off by default.

A scene with only assertions and no steps is normal — it proves a side
effect happened.

## Reference

`AGENTS.md` in the castscript repo carries the failure table and the
assertion vocabulary.
