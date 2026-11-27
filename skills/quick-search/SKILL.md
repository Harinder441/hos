---
name: quick-search
description: Answer one web question for the user from live sources, every claim tagged with its source link. Use for "what is X", "X vs Y", "compare A and B", "top 10 / best X", "latest on X", "price of X". Do NOT use for deep research that should become a report file (rnd) or for questions about the user's own repos (work-in).
---

# Quick Search

One question in, one sourced answer out, in this chat. Speed matches the question: a definition comes back in
seconds; a comparison or ranking takes longer and comes back right.

## 1. Pick the branch

Read the query once and pick exactly one:

| Branch | The query looks like | Go to |
|---|---|---|
| **Quick** | what is / who is / when / how do I / one fact, one price, one date | 2 |
| **Compare** | X vs Y, compare A and B, difference between, which is better for … | 3 |
| **Rank** | top N, best X, recommended X, alternatives to X | 4 |

Two branches fit → take the slower one. Done when you have named the branch to yourself.

## 2. Quick

1. One web search (your harness's search tool, at its normal depth).
2. The snippets answer it and two results agree → answer from them. They disagree, are older than a year for a
   fast-moving topic, or are thin → open the best result (step 5) or search once more at a deeper setting (for
   example `mode: "extended"` where the search tool offers it).
3. Answer: 1–5 lines, the answer in the first line, then `Sources:` with 1–3 links.

Done when the first line answers the question and every fact in it has a link.

## 3. Compare

1. Name the 2–4 things being compared and the 3–6 criteria that matter for the question (the user's own words
   first: price, speed, limits, ease …).
2. For each thing: one web search (deeper for prices, availability or anything from the last few months), then
   **read** its primary source (official docs, pricing page, spec sheet) with step 5. A review or blog is a second
   source, never the only one.
3. Answer:
   - a verdict line first ("For <their use>, pick X because …"),
   - a table: rows = criteria, columns = the things, each cell short, each cell's source as a `[n]` marker,
   - `Sources:` numbered `[n] <title> — <url>`, each one opened, not just seen in a snippet.

Done when every cell has a `[n]` that points at a page you read, and the verdict follows from the table.

## 4. Rank

1. Find **at least 3 independent sources** (different sites, not one site's syndicated copies): a mix of expert
   reviews, comparison sites, and community threads (Reddit, HN) when the topic is opinion-driven.
2. Read each with step 5 and write down its list.
3. Tally: an item's rank comes from how many sources list it and how high. Items only one source names go last or
   in "also mentioned".
4. Answer:
   - one line on how you ranked ("3 of 4 sources agree on the top 3"),
   - a numbered list: item — one-line why — `[n][m]` for the sources that back it,
   - `Sources:` numbered, each opened.

Done when the list has N items (or fewer with the reason), each with at least one `[n]`, and the source count is
stated.

## 5. Read a page

- A normal web page → fetch it as clean Markdown (a reader-mode tool such as the `defuddle` CLI, when installed,
  costs fewer tokens); that fails or isn't there → your harness's web fetch tool.
- A URL ending in `.md`, a raw file, or JSON → the web fetch tool.
- A video link → read its transcript if you have a tool for it; otherwise use the page text and say the video
  itself was not watched.
- A paywall, login wall or bot check → skip it and use the next result; say so if it was the primary source.

## Answer rules (every branch)

- Every fact carries its source: a link (Quick) or a `[n]` marker (Compare, Rank). A fact with no source is cut.
- Prices, versions and "latest" carry the date the source states ("$20/mo as of Oct 2026").
- Sources disagree → say so in one line with both links, then say which you trust and why (official > recent > review).
- Plain words, short lines, no preamble. The answer is the reply; write no files and no history entry.
- The question needs a report file, days of digging or many repos → answer what you found and end with one line
  offering a deeper pass: a report in the work folder, fanned out with the `rnd` skill.
