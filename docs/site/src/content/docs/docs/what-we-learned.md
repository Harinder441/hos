---
title: What we learned
description: Lessons from a few months of running many agent chats every day. Each one cost us something first.
---

We built hos for ourselves and used it every day before anyone else saw it. These are the lessons that changed how
it works. Most of them are cheap to copy, with or without hos.

## Long chats

**1. Hand off to a fresh chat. Don't lean on compaction.**
Compaction is invisible and loses things you can't see. A handoff is a file: you can read it, check it against the
open decisions, and start a clean chat from it. When a chat runs long, we ask it to write the handoff and start a
new one.

**2. But only when you say so.**
We tried automatic nudges at a token count, then handoff cards, then forced rotation. Each one interrupted work at
a bad moment. Now nothing happens until you press the button.

## Many chats, one repo

**3. One process commits the shared repo.**
When every chat committed its own turn, they fought over git's index lock and mixed their commits. Now one queue
commits for everyone, and each commit holds only the files that chat wrote. Changes made through the shell go into a
separate sweep commit.

**4. Don't make an agent do another agent's bookkeeping.**
We once had a "librarian" chat that wrote history for the others. Each request cost a turn for the librarian and
another for the confirmation. Over six days that was 278 extra turns and about 18% of all cache reads. The server
writes history itself now.

**5. Text from a chat is never the user's approval.**
Agents relay things. Sooner or later one writes "the user approved this" to another. In hos, messages between chats
are labelled as such, and an approval only counts when it comes from the person, through the approval card.

## Instructions

**6. Keep what loads every time small.**
We cut our always-loaded instruction files to about a fifth of their size. The rest moved into skills and reference
files that load only when needed. Agents followed the short version better.

**7. Feedback goes into a numbered rules file in the repo.**
Not into the agent's own memory, where you can't review it. One line per rule, numbered, never renumbered. You can
say "that breaks R12" and everyone, human or agent, knows what you mean.

**8. A guard only sees what it hooks.**
Our comment guard watched the edit tools. Edits made with `sed` walked straight past it. If a check matters, make
the agent use the tool the check watches, or check the result, not the tool call.

## Getting work you can trust

**9. Plan first. An answer to a question in the plan is not a go.**
Agents treat any reply as permission. We answer plan questions, the plan changes, and code starts only on an explicit
"go ahead".

**10. Make agents label their claims.**
`reproduced` (I ran it), `code-inferred` (I read it), `data-inferred` (from the numbers), `unverified`. It takes one
word per claim, and it shows you exactly which parts to check.

**11. Fan out, but one owner merges.**
Helpers are cheap. Merging their answers is not. Each helper writes its own file; one chat reads them all and looks
for contradictions before anything reaches you.

**12. Before "done", map every request to the diff.**
Agents finish the interesting part and report done. A list of what was asked, each with the change that answers it,
catches the item that got skipped.

**13. Batch jobs go 1, then 5, then a few dozen, then all.**
Numbers first at each step. The first run finds the wrong assumption; the fifth finds the edge case. Nobody has to
undo a thousand rows.

**14. Test what you touched; run the full suite once.**
Running every test after every edit wastes most of a session. Run the tests for the files you changed while you
work, and the full suite once before merge. A test that passes only on retry is a bug, not a pass.

## The product itself

**15. Measure, then remove.**
We built a switch that let a chat act on its own recommendations. In 965 chats nobody turned it on. Another toggle
was on in all 965 and never changed. Both are gone. Features you don't use still cost attention every time you open
the screen.
