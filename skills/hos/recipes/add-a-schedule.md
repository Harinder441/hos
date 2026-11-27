---
id: add-a-schedule
title: Add a schedule
kind: brain
size: S
hos: ">=0.1"
source:
  - src/schedules.ts
  - src/owner.ts
  - src/profiles.ts
docs: make-it-yours#add-a-schedule
---

# Add a schedule

A schedule starts a chat on its own at set times: a Monday digest of open pull requests, a morning brief, a nightly
check. Nobody watches it, so it runs with tighter rights: by default it researches, writes reports and brain notes,
and leaves anything that merges, deploys or messages people for you to approve later.

Each schedule is one row in `hos/schedules.yaml`: when it runs, on which computer, which profile, what it does and
where it reports.

**What you get:** a row in `hos/schedules.yaml`, the schedule on the Schedules page with its next run, no restart.

**Ask your agent:** "Use the hos skill to add a schedule that <does what> every <when>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **What the run does**, in a few sentences, and what its final message should say. This becomes `prompt`.
2. **When**, in words ("weekdays at 8:30"). You turn it into a 5-field cron (minute hour day month weekday) in the
   user's time zone (`owner.timezone` in `hos/policy.yaml`, else the computer's zone). Read the cron back in words.
3. **Where it reports**: (a) one topic, reused every run (default `topic: "Rituals"`; created on the first run if
   missing), (b) the Desk (`desk: true`), or (c) a new topic every run (neither key).
4. **Profile**: (a) `ritual`, the spawn-only profile for unattended runs (default), or another profile id.
5. **id**: lowercase with `-`. Default: two or three words from answer 1. It must not be used by another row.
6. **Start paused?** (a) no (default) or (b) yes, so the user can press Run now first.

### Steps

1. Get this computer's host name: `hostname`. Each hos fires only the rows whose `host` is its own host name (case
   and a trailing `.local` don't matter); the Schedules page also shows it.
2. Append the row to `hos/schedules.yaml` (the file is a YAML list):

   ```yaml
   - id: <answer 5>
     host: <hostname>
     cron: "<answer 2>"
     topic: "<answer 3a>"        # or desk: true, or neither
     profile: <answer 4>
     paused: true                # only if answer 6 is (b)
     prompt: >-
       <answer 1>
   ```

   `model: <model id>` is optional; leave it out for the profile's or hos's default.
3. Always write `profile:`. A row without it runs as the default profile, not `ritual`.
4. If the job needs a right `ritual` doesn't give (for example "may open draft PRs"), say so and offer to add it to
   `profiles/ritual/RULES.md` as a numbered rule (recipe `turn-a-correction-into-a-rule`). Don't widen it silently.

### Check

```sh
hos validate --brain .          # hos/schedules.yaml is valid YAML; hos checks each row's fields itself
```

hos re-reads the file on every tick. Ask the user to open the Schedules page: the row shows with its next run in
their time zone. If it is paused, or to test it now, press **Run now** on this computer. The run should finish with a
short summary in the place from answer 3.

### If it fails

- The row is missing and an alert says "hos/schedules.yaml has rows hos skipped or runs as generic": the alert names
  the row and the field (`cron` needs 5 fields, `desk` and `topic` together, an id used twice). Fix that line.
- "profile ... is unknown, so it runs as generic": the profile id has a typo or its folder is broken.
- Never fires: `host` doesn't match this computer, or the row is paused. If hos was off at the time, the row runs
  once when hos is back (not once per missed time); a brand-new row only fires from its next time on.

### Undo

Delete the row, or set `paused: true` to keep it for later. The Schedules page can pause, edit and delete it too.

### Don't

- Don't give an unattended run rights to merge, deploy, push to a default branch or message people. The run turns
  those into `[user]` items for the user to approve.
- Don't schedule a row more often than its job needs; every run uses the user's subscription.
- Don't copy a row to a second computer by changing `host` without asking; both would run if both rows stay.
