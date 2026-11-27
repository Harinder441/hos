---
title: FAQ and contributing
description: Short answers to the questions people actually ask, and how changes and recipes flow back.
---

## Questions

**Does it only work with Claude?**
Claude is built in. Any agent that speaks the Agent Client Protocol plugs in through the generic ACP harness, and
you can add others. See [Add a harness](../add-a-harness/).

**Is this allowed with my Claude plan?**
You sign in through Claude's own login, on your own machine, with your own account. hos runs the unmodified Claude
Code and never handles your credentials. Usage counts against your plan's limits. See
[Security and sign-in](../security/).

**Do I need an API key?**
No. hos does not use API keys.

**Windows?**
Yes, through WSL2. hos runs inside your WSL Linux distro and you open it in your Windows browser at
`http://localhost:4517`; the install prompt is the same. Native Windows is not supported yet. WSL2 support is new and
has not yet been through a full install on a real Windows machine: if something breaks, please
[open an issue](https://github.com/Harinder441/hos/issues). See [Install](../install/#windows-wsl2).

**Does it phone home?**
hos sends no usage data anywhere. What leaves your computer is what your agents send, push notifications through
your browser's push service (encrypted for your device), the remote access transport you set up, chats on computers
you paired, and an optional health-check ping if you set one. hos starts hos-code with its telemetry off.

**Why a brain repo?**
So your rules, skills and your agents' progress are files you can read, diff and revert, not settings hidden inside
an app. The install copies the starter and makes it a private repo you own.

**Why not a fork of hos-brain?**
A fork of a public repo is public on GitHub, and your brain holds your notes. See [Your brain](../your-brain/).

**Can my team share one hos?**
Each person runs their own hos with their own brain and their own agent logins. Never share an account.

**Is it safe to reach from my phone?**
hos listens on `localhost`. Remote access goes only through your own Tailscale tailnet or your own Cloudflare
Access, plus a passkey.

## Contributing

- **Bugs and ideas:** open an issue on [hos](https://github.com/Harinder441/hos/issues). Say which release you run
  (`hos --version`).
- **Pull requests:** fork hos, branch from the latest tag or `main`, and open a PR. Your agent can do the whole flow
  with the hos skill's "change hos" recipe.
- **Tests** live at the daemon's boundary, use temp folders and fakes, and never touch your real repos or logins.
  Run the tests for the files you changed, then the full suite once.
- **Recipes** live in the hos repo in `skills/hos/recipes/`, and each lists the source files it relies on. A change
  to those files should update the recipe in the same PR; the docs pages built from them update with it.
- **Harnesses:** a `harnesses:` entry or a plug-in, a passing contract test, and a live test behind an environment
  variable.
- **The starter brain** (`hos-brain`) takes PRs for its skills, profiles and lessons. It never changes files that
  belong to the user.

## Licences

hos is Apache-2.0. hos-brain is MIT. hos-code is MIT and keeps its original author's notice. Each repo has its
`LICENSE` file.
