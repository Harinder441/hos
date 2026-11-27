---
name: diagram
description: >-
  Draw or fix a diagram on a hos Excalidraw board so it explains something
  clearly: architecture, request flows, sequences, state machines, decision
  trees, handover explainers. Use when the user says "draw a diagram", "diagram this",
  "make a flowchart", "architecture diagram", "sequence diagram", "visualize
  this flow", "explain this on the board", "clean up / tidy this diagram", or
  "the text overlaps / the diagram is messy". Drives the hos bus tools
  (diagram_layout, diagram_apply, diagram_read, diagram_screenshot). Do NOT use
  it for charts of data, for HTML lesson or explainer pages (explain-visually),
  or for electronic circuits.
---

> Paths here such as `work/`, `history/` and `shared/` are relative to the brain (the folder hos runs chats in; `$WORK_DIR` sits inside it), not to the repo you are in. Write outputs to `$WORK_DIR` (outside hos: the work folder the brain's `work/README.md` rule picks).

# diagram

Ideas adapted from coleam00/excalidraw-diagram-skill (design method) and BV-Venky/excalidraw-architect-mcp (layout from
structure). Neither is installed; hos does the work.

## 1. Decide before drawing

1. **What is the one thing the reader should get?** Write it as the title (≤ 8 words).
2. **Depth.** Default simple: ≤ 12 boxes. A handover or teaching diagram (only when asked) may add a small code or JSON
   snippet as a text element beside the box it explains.
3. **Pattern per idea**, not a uniform grid of cards:

| The idea | Draw it as |
|---|---|
| one thing feeds many | fan-out from one box |
| many things combine | convergence into one box |
| steps in order | left-to-right flow, or a sequence |
| who calls whom, in what order | `diagram_layout` kind `sequence` |
| a choice | diamond with labelled yes / no arrows |
| parts of a system | boxes grouped in frames (one frame per tier or service) |
| hierarchy | tree, top-down (`direction: TD`) |
| before vs after, A vs B | two columns side by side |

## 2. Pick the tool

1. **Boxes and arrows** (architecture, flow, state, tree) → `diagram_layout` kind `graph`. Send only nodes, edges, and
   groups. Never compute coordinates. Shapes: ellipse = start/end, diamond = decision, rectangle = step, note = aside.
   `focal: true` on the one or two boxes the diagram is about.
2. **Calls over time** → `diagram_layout` kind `sequence` (actors + ordered messages; `reply: true` = dashed).
3. **Free-form** (annotations, a legend, a side note, fixing one box) → `diagram_apply`. Place with
   `near: {id, side}`, not x/y.
4. **Change a drawn layout** → `diagram_layout` again with its `layout` id and the full new spec (the old spec is on
   the element `diagram_read` shows with `"spec"`). Box ids stay the same and the user's colour changes are kept.

## 3. Words

1. A box label is a name, ≤ 6 words. Detail goes in a `text` element beside the box (`size: body`), not in the box.
2. Arrow labels ≤ 3 words; the verb ("reads", "calls", "saves").
3. Title `size: title`, section headings `size: heading`, detail `size: body`.

## 4. Colour = meaning

Use the same meaning on every board; leave everything else black on white.

| Meaning | `fill` | `color` |
|---|---|---|
| start / end, success | green | green |
| decision, warning, aside | amber | amber |
| agent / AI model | violet | violet |
| data store, external service | blue | blue |
| error, gap, risk | red | red |
| disabled, out of scope | grey | grey (and `stroke: dashed`) |

## 5. Check and finish

1. Every `diagram_apply` / `diagram_layout` result ends with a **Check** line covering only what that call changed:
   label overflow, overlaps, arrows through shapes, and arrow labels longer than their arrow. Fix everything it lists
   before you reply (move with `update` or `near`, widen a gap, shorten a label, or `{op: "fit"}`).
2. `diagram_read` checks the whole board. Run it once at the end.
3. If the user has the board open, take one `diagram_screenshot` and look at it. Ask: does it make the one point
   from 1.1? If not, fix the structure (pattern, grouping), not the pixels.
4. Messy old board → `diagram_read`, then `{op: "fit"}` (it only grows boxes whose labels spill out). Then fix the
   overlaps the Check line reports, one undoable apply per board.
