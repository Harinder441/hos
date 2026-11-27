---
title: Troubleshooting
description: Start with the doctor. Each row it shows has a fix here.
---

Start with the doctor. Open **Settings → Doctor** in the app (it also shows in Ops, under Background service). Each
row checks one thing hos needs and, when it is not fine, says how to fix it. Ask your agent to fix what it can; it
stops for anything only you can do, such as a sign-in.

Before you sign in, the app shows only the remote-access report. You can read the same report from a terminal:

```sh
curl -s http://127.0.0.1:4517/api/doctor
```

## Doctor rows

These rows show on every install:

| Row | What it checks | Fix it shows |
|---|---|---|
| Remote access | The transport in your policy works: local only is always fine; Tailscale is installed and running; Cloudflare's Access keys load | The transport's own steps, for example the `tailscale serve` command |
| Background service | The login item that keeps hos running is installed (launchd on macOS, `systemd --user` on Linux) | `hos keeper install` |
| Watchdog | An outside health check is set up to tell you when hos stops. Optional: it reads down until you set one | Create a check on healthchecks.io, then `hos keeper install --healthchecks-url <ping URL>` |
| Charge limit | macOS only: a battery charge limit is set, for a laptop that stays plugged in | System Settings → Battery → Charging → Charge Limit |
| Claude login | The Claude CLI hos runs is found and signed in, and on which plan | `claude auth login` |
| Commit identity | Only when you set a work email domain: no personal repo commits with it | Remove the override it names. Most installs read "no work domain configured (optional)" |

These rows show only when they apply:

| Row | Shows when | Fix it shows |
|---|---|---|
| hos-code | The code viewer behind Code view is not found | Install `hos-code` on your `PATH`, or point `--hos-code-bin` at it. Optional: hos works without it |
| Profile `<file>` | A profile in your brain is broken; hos skips it | Fix the file, then run `hos validate` |
| Harness settings | The `harnesses:` list in `hos/policy.yaml` has an invalid entry | Fix the list, then restart hos |
| Harness `<name>` | A harness id clashes with one already loaded | Give it another id, then restart hos |
| `<agent>` sign-in | One row per extra harness: signed in, not signed in, or no sign-in check | The agent's own login command |
| Plug-ins | The `plugins:` list in `hos/policy.yaml` is malformed | Fix the list, then restart hos |
| Plug-in `<name>` | One row per plug-in in your brain, listing what it provides, or why it did not load | Fix the file (`hos plugin-check <file>` checks it), then restart hos |
| Computer `<name>` | One row per computer you paired: offline, or running another hos version | Start hos there, check both are on your tailnet, or update the older one |

Ops → Background service also has a **Health** column: tmux, disk, battery, heat, memory, plan windows, sleep,
backups. It reads the machine, not your setup.

## Install problems

- **`npm ci` fails in `better-sqlite3` or `node-pty`.** The C/C++ toolchain is missing. On macOS run
  `xcode-select --install`; on Linux install your distro's build tools. Don't retry with `--force`.
- **The install file's hash does not match.** Stop. Copy the prompt again from the [Install](../install/) page.
- **The brain repo name is taken on GitHub.** Pick another name; never make it public.

## Daily problems

- **A chat shows "queued".** You are at your plan's limit or your slot count. The governor starts it when a slot
  frees or the window resets.
- **A chat stopped answering after a break.** Idle suspend stopped its process. Send a message; it resumes the same
  session.
- **The phone asks for a passkey again.** A sign-in lasts 30 days; then you sign in again with the same passkey. A
  new address (another hostname) needs its own passkey: restart hos for a fresh enrolment code.
- **An approval card never came.** Check the action class in your policy; `auto` and `deny` decide without a card.

## Still stuck

File it as a snag in the app, or open an issue on [hos](https://github.com/Harinder441/hos/issues) with the release
you run (`hos --version`) and the doctor rows that are not fine.
