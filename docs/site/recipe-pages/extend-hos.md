---
title: Extend hos
description: Changes to hos's code, each a recipe in the hos skill that your agent runs against a checkout of the matching hos version.
---

These recipes change hos itself. Your agent runs them against a checkout of the hos version you have installed, adds
a test, and opens a pull request to your fork. Ask: "Use the hos skill to …".

Each recipe declares the hos versions it fits (`hos:`) and the source files it relies on (`source:`); hos's own tests
fail when one of those files moves. This page is built from the recipe files, and each section's fold shows the
agent's part.

<!-- recipes -->

## Plug-ins from your brain

Things that are yours alone, such as a data source for your own task app or an agent that needs special handling,
can live as plug-in files in your brain's `hos/plugins/` folder, listed under `plugins:` in `hos/policy.yaml`. hos
loads them at start. Each plug-in registers what it provides through one small, versioned interface per kind, so a
plug-in written today keeps working. Because the server runs this code with its own rights, your policy can make hos
ask you every time an agent changes a plug-in file or the `plugins:` list (`approvals.plugin_edits: ask_every_time`;
the starter brain sets it).
