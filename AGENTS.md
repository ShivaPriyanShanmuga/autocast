# autodemo — for agents

Record a real demo video of what you just built. Not stitched
screenshots: a genuine screen recording of a real terminal and a real
browser, encoded to mp4 and committed with the code.

## The loop

```
npx autodemo init                  # scaffold demo.yaml + schema
npx autodemo validate demo.yaml    # static check, no capture — free, run it often
npx autodemo render demo.yaml      # records and encodes; prints a short report
```

`validate` never executes anything, so run it after every edit. `render`
is the expensive step. When it fails, the report ends with one concrete
next action — do that rather than guessing, because each guess costs
another render.

## The one rule that matters

**Never open the video, the frames, or the contact sheet.**

Not with a vision model, not with an image tool, not "just to check". The
whole design exists so that you never need to: every question you might
answer by looking is answered exactly by an assertion, because the
terminal's character grid and the browser's DOM are exact where pixels
are guesswork. The report tells you what happened. A contact sheet path
in the output is there for a human, and reading it back defeats the point
of the architecture and costs enormous context.

If you find yourself wanting to look at a frame, the thing you actually
want is an assertion.

## Writing the script

Get the schema — do not guess at it, and do not trust an example over it:

```
npx autodemo schema
```

`init` also writes `.autodemo/schema.json` and puts a
`# yaml-language-server: $schema=` line at the top of the scaffold, so an
editor will autocomplete and catch mistakes before `validate` does.

Shape of a script:

- `sessions:` — named, each `backend: terminal` or `backend: browser`.
  Sessions outlive scenes; a server started in scene one is still running
  in scene four.
- `scenes:` — ordered. Each `use:`s one session, may carry `steps:`,
  `assert:`, `narrate:` and `focus:`.
- `output:` — path, canvas, fps.
- `style:` — optional presentation: background, window chrome, zoom.
- `voice:` — optional narration. Off by default; needs `npm i -D kokoro-js`.

## Assertions are how you verify

Terminal: `stdout_contains`, `stdout_matches`, `process_alive`.
Browser: `visible`, `text_matches`, `no_console_errors`,
`no_failed_requests`.

A scene with no steps and only assertions is normal and useful — it
proves a side effect happened, and shows the state that proves it.

## Common failures, and what they mean

| Symptom | Cause | Fix |
| --- | --- | --- |
| selector matched nothing | the element had not rendered yet | add `wait_for` before the step |
| `wait_for` timed out | the pattern never appeared | check it against the recorded output in the report |
| `focus:` matched nothing | the target is revealed by later steps, or is hidden | point it at something already on screen |
| scene "held open to finish the sentence" | narration is longer than the action | shorten `narrate:`, or set `voice.sync: hold` |

## Things worth knowing

- **Re-rendering costs zero model calls.** The committed script is the
  artifact; CI can re-render it. Do not treat the video as the source.
- **A failed render produces no video at all**, deliberately, so a broken
  demo can never be mistaken for a passing one.
- **Idle time is compressed automatically**, but a `settle:` you asked
  for is never compressed — deliberate pacing is not dead air.
- Run `npx autodemo doctor` if anything fails for an environmental
  reason; it reports every dependency with a copy-pasteable fix.
