---
name: hos-schedule
description: Add, change, pause or place a hos schedule, a row in the brain's `hos/schedules.yaml` that starts an unattended chat on a cron. Use when the user says "schedule this", "every Saturday …", "run it nightly", "watch the deployment for 3–4 hours", "turn off the X ritual", or asks which computer a job runs on. Not for personal reminders or to-do items.
---

# hos schedule

Each hos daemon reads the brain's `hos/schedules.yaml` every tick and fires only the rows whose `host` is its own
hostname (`.local` and case ignored; `hostname` prints it). Cron runs in the time zone hos is configured with
(`owner.timezone` in `hos/policy.yaml`, else the system zone). The file's header gives the row shape.

## 1. Pick the host

With one computer, every row uses its hostname. With more than one (Settings → Computers), place each job where it can
run:

| The job | host | When |
|---|---|---|
| Needs access only one computer has: production logs, databases, cloud accounts, a VPN, a post-deploy watch | the computer with that access, e.g. `<your-laptop-hostname>` | the hours that computer is awake |
| Anything else hos can do alone (brain, hos, research, reports, sweeps), and any night-time work | an always-on computer, e.g. `<your-server-hostname>` | any time |

- A job that needs access the chosen host lacks fails there; name the access in the row's comment.
- A row that came due while its computer slept fires once, late, on wake. Keep laptop rows inside the hours it is awake.

## 2. Write the row

- Edit `hos/schedules.yaml` with Edit, or use the hos Schedules page. The page's host picker lists this computer and
  every attached computer (Settings → Computers) and applies the row on that computer at once ("applied on …").
- A file edit reaches another computer only after the brain is committed and pushed (hos does this; outside hos the
  Stop hook does) and that computer's brain syncs (about 5 min idle). For a row due within 15 min on another
  computer, use the page, or start the work as a chat instead.
- Fields: `id` (kebab, unique) · `host` · `cron` (5 fields, in hos's time zone) · `topic: "Rituals"` for rituals,
  `desk: true`, or neither for a new topic (not both) · `prompt` · `model` (a small, cheap model for a check, a
  mid-size one for a report; omit for the default) · `profile: ritual` (schedule rows run as the ritual profile;
  without it a row runs as generic) · `paused: true` to turn a row off and keep it (record why on a one-line comment
  above it).
- The prompt is the whole brief: hos only prepends the unattended header (nobody is watching; the profile's rules for
  unattended runs, in `profiles/ritual/SOUL.md` for `ritual`, say what it may change). Name every data source by path
  and command so the job does not search; numbers first; a report in its work folder; anything the user must do
  themselves as a `[user]` item at the end of the reply and in PROGRESS.md Open; end with a push notification summary.
  One that should stay quiet when nothing is wrong says so ("check: ok → no notification").

## 3. One-off and time-boxed jobs

hos has no one-off or `until` field. Pin the date in cron and make the last run delete its own row:
`cron: "0 14-17 26 11 *"` fires 14:00–17:00 (hos's time zone) on 26 Nov; the prompt ends "if this is the 17:00 run,
delete row `<id>` from hos/schedules.yaml". Left in place, a pinned row fires again next year.

## 4. Check

After the commit, the Schedules page shows the row with its next run; a bad row raises the inbox alert
"hos/schedules.yaml has rows hos skipped or runs as generic" with the reason. "Run now" on the page fires it once on
its own host.
