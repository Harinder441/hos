---
title: Updating and uninstalling
description: Move to a new release in the right order, and remove everything the install created.
---

## Updating

hos moves by release tags. Update hos first, then your brain.

```sh
cd ~/code/hos
git fetch --tags && git checkout <new tag>
npm ci && npm run build
node dist/daemon/main.js keeper restart      # or stop and start it by hand

hos brain update                             # merge the starter's new commits, sync the skills hos owns, validate
```

Or ask your agent: "Update hos to the latest release, following the Updating page." It reads the release notes
first and stops if a step needs you. `hos skills sync` on its own refreshes just the skills hos owns.

- **Brain conflicts** happen only in files both you and the starter changed. Your agent shows them file by file and
  never takes the starter's version wholesale.
- **Edited skills.** If you changed a skill hos owns, `hos skills sync` keeps your copy and lists it as "edited,
  not updated".
- **hos-code.** Download the new release binary and check it against the release's checksums, or pull and rebuild
  if you built it yourself.

## Uninstalling

Undo in reverse order, only what the install created. Ask your agent to do it and it asks before each step.

1. Remove the login item: `node ~/code/hos/dist/daemon/main.js keeper uninstall`. If you set up Tailscale for hos,
   `tailscale serve reset` (only if you serve nothing else).
2. Stop any hos you started by hand.
3. Delete hos's data: `rm -rf ~/.hos`. This removes chats, your passkey and settings, and cannot be undone. Its logs
   are in `~/Library/Logs/hos` on macOS and `~/.local/state/hos` on Linux.
4. Delete the code: `rm ~/.local/bin/hos-code`, then `rm -rf ~/code/hos ~/code/hos-code`.
5. Your brain is yours: the install never deletes it. If you want the private GitHub repo gone, delete it yourself.
