---
id: add-repo-locations
title: Tell hos where your code lives
kind: brain
size: S
hos: ">=0.1"
source:
  - src/discovery.ts
  - src/policy.ts
  - src/main.ts
  - schemas/policy.schema.json
  - src/cli/validate.ts
docs: make-it-yours#add-repo-locations
---

# Tell hos where your code lives

hos offers your repos as workspaces, and your chats resolve names like "the api repo" to a folder. It finds them in
two places in your brain:

- `shared/LOCATIONS.md`, a table of short names (keys) and paths. Use it for repos you name often, and for folders
  that aren't git repos. Chats read it whenever you name a key.
- `repo_roots` in `hos/policy.yaml`, the parent folders hos scans for git repos. By default that is a `Repos` folder
  in your home folder.

**What you get:** your repos in the workspace lists and the new-topic form; keys your chats understand. LOCATIONS
needs no restart; a `repo_roots` change takes effect after a restart.

**Ask your agent:** "Use the hos skill to tell hos where my code lives: <folders or repos>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **Repos or folders to name**: for each, a key (short, lowercase, no spaces), its path, and one line about it
   (stack, where PRs go). Default: none.
2. **Parent folders** that hold many repos side by side. Default: keep the current `repo_roots` (or the built-in
   default when the key is missing).

### Steps

1. For each path, check it exists: `ls <path>`, and `git -C <path> rev-parse --show-toplevel` for a repo. Never add
   a path you haven't seen.
2. Add one row per entry to the table in `shared/LOCATIONS.md`:

   ```markdown
   | <key> | `<path>` | <about> |
   ```

   hos reads a row only when the line starts with `|`, the key is letters, digits, `.`, `_` or `-`, and the path is
   in backticks and starts with `~/` or `/` (no `*` or `{}`). Keys must be unique.
3. For answer 2, set the list in `hos/policy.yaml`:

   ```yaml
   repo_roots:
     - ~/code
     - ~/work
   ```

   hos finds git repos directly inside each folder (one level down). A `--repo-root` flag on the daemon wins over
   this list.
4. After a `repo_roots` change, the user restarts hos (`hos keeper restart` when it runs as a login item, else stop
   and start it). Ask first; don't restart while chats are running.

### Check

```sh
hos validate --brain .          # repo_roots must be a non-empty list of folders
```

hos rescans about every 10 seconds. Ask the user to open the new-topic form or the Workspaces section: the repo is
listed under its key. Then ask a chat to "work in <key>"; it should find the path without asking which repo.

### If it fails

- A LOCATIONS row is ignored: the path has no backticks, the key has a space, or the line doesn't start with `|`.
  The example line in the file's header is text on purpose, not a row.
- A repo under a root is missing: it sits two levels down (a group folder) or has no `.git`. Add the group folder
  as its own root, or add the repo to LOCATIONS.
- `repo_roots` changed but nothing moved: hos wasn't restarted, or a `--repo-root` flag overrides it.

### Undo

Delete the rows. Remove `repo_roots` to go back to the default, then restart hos.

### Don't

- Don't guess paths or add folders the user didn't name.
- Don't put tokens, internal URLs with credentials or customer names in the about column; every chat can read it.
- Don't list the brain itself; hos always offers it.
