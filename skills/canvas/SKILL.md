---
name: canvas
description: Teach or explain with an in-chat hos canvas (story, steppable flow, sequence, quiz, code, comparison, sandboxed HTML). Use for "teach me X", "explain simply", "quiz me", "check my understanding". Needs the canvas_* tools; without them, teach in chat text.
---
# Canvas

No `canvas_*` tools in this chat → teach in chat text; don't mention the canvas. hos gives the tools only to a chat
whose profile lists `canvas` by name in its `skills:` (a profile with `skills: all` does not get them).

Order: story → flow → check, one concept per canvas; prose stays in your message. After `canvas_create`, end your
turn: the user's answers arrive as a `[hos] <user> submitted C1 …` message, never an approval.

## canvas_create {title, blocks, submit?}

Every block: `kind`, `id` (needed if something points at it), `fold: true` (under "Go deeper"). Omit defaults. Text
takes `**bold**`, `*italic*`, `` `code` ``.

- `callout`: `tone` analogy|key|warn (key), `text`
- `story`: `cards [{art, title, text}]`; `art` = phone browser server db store card money cloud person lock clock queue
  warning check, or two joined: `a>b`, `a<b`, `a~>b` / `a<~b` (lost reply)
- `flow`: `title`, `dir` TD|LR (TD), `nodes [{id, label, sub, shape: diamond|ellipse, detail}]`, `edges ["a>b", "a>b:label"]`,
  `steps [{at: id or [ids], say}]`. hos lays it out, no coordinates; ≤ 12 nodes.
- `sequence`: `title`, `actors [{id, label}]`, `messages [{from, to, label, lost, say}]`
- `code`: `title`, `lang`, `code`, `lines {"6": {note, node}}`
- `compare`: `title`, `columns`, `rows [[…]]`, `win` (column index)
- `choice`: `prompt`, `options`, `answer` (0-based, optional), `node` (flow box shown on a wrong answer)
- `text`: `prompt`
- `html`: `src` = an .html file you wrote in the work folder; sandboxed, no network. Its script calls `hosCanvas.set({…})`
  (≤ 16 KB), `hosCanvas.request()` (lights the send button), `hosCanvas.size()`; it can't send.

No choice, text or html block → no send bar ("explain simply").

## canvas_update {id, base, ops}

`base` = version from your last result (`C1 v2`); a stale one is refused with the current state. Ops:
`{op:"feedback", block, ok, note, node?}`, `{op:"reopen", block}` (the user may retry), `{op:"add", block, after?}`,
`{op:"set", block, fields}` (null drops a field), `{op:"remove", block}`, `{op:"title", title}`, `{op:"submit", label}`.

## canvas_read {id}

The user's place in each diagram, unsent answers, last submit, your feedback.
