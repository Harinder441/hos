# Install hos

Written for a coding agent to follow and for a person to read first. The URL you downloaded this file from names a
release tag (for example `v0.1.0`); call it `TAG` below. Every hos command here comes from that tag.

## For the person reading this

You are about to let your agent install three things:

| What | Where (default) | How |
|---|---|---|
| **hos**, the app | `~/code/hos` | `git clone` at `TAG` (or your fork), `npm ci`, `npm run build` |
| **hos-code**, the code viewer (optional) | `~/.local/bin/hos-code` | release archive checked against its checksum, or built from source |
| **your brain**, a git repo of rules, skills and notes | `~/hos-brain` | a clone of `hos-brain`, pushed to a new **private** repo you own |

It also creates:

- `~/.hos/`: hos's data (chats, passkeys, settings), on first start;
- `~/.local/bin/hos`: a three-line script so `hos` works in any terminal (`hos link`);
- only if you say yes: a login item (a macOS LaunchAgent `~/Library/LaunchAgents/dev.hos.daemon.plist` with logs in
  `~/Library/Logs/hos`, or a systemd user unit `~/.config/systemd/user/hos.service` with logs in `~/.local/state/hos`);
- only if you say yes: one `export PATH=…` line in your shell's startup file, when `~/.local/bin` is not on your `PATH`.

Nothing else on your machine changes, apart from the usual caches of the tools it runs (npm's logs, node-gyp's
headers for native modules, and `~/.claude.json` when Claude Code checks your sign-in). Every command runs in your agent's normal permission mode, so you see and
approve each one. No `sudo`, no `curl | sh`, nothing from the npm registry except the pinned lockfile's packages.
Expect to stop for: a GitHub sign-in and a Claude sign-in (only if you are not signed in), and one passkey.

Remove it all later with **Uninstall** at the end.

On Windows, hos runs inside a WSL 2 Linux distro and you open it in your Windows browser; see **Windows (WSL2)**.

## For the agent: rules for this whole file

1. Follow the steps in order. After each step run its **Check**. If a check fails, stop, show the output and the
   matching **If it fails** line, and ask the user. Do not improvise a different install route.
2. Ask all questions in step 1 at once, as a numbered list with the defaults shown. Do not ask them again later.
3. Never run `sudo`. If a step needs it, print the exact command and ask the user to run it in their own terminal.
4. Never print secrets: no tokens, no `gh auth token`, no contents of `~/.hos/enrolment-code`, `~/.claude*`,
   `~/.config/gh`, `.env` files or Keychain items. Tell the user where a secret is; let them open it.
5. Never force anything: no `git push --force`, no `rm -rf` outside the folders this run created, no
   `git reset --hard` in a folder that already existed, no overwriting a file you did not create in this run.
6. If a target folder already exists, stop and ask (use it, pick another path, or abort). Never delete it.
7. Never sign in on the user's behalf and never type into a browser for them. Sign-ins are theirs.
8. Keep a list of everything you created (folders, files, repos, login items, lines added to files). Print it at the
   end and in any failure; **Uninstall** works from that list.
9. Commit identity: before the first commit in the brain, show `git -C "$BRAIN" config user.email` and ask whether
   that is the address the user wants on their brain's commits. If it is empty or not the one, ask for the name and
   address and set them for that repo only (`git -C "$BRAIN" config user.name …`, `… user.email …`), never globally.
10. Run long commands (`npm ci`, `npm run build`, the first start) so their output stays visible; a command that has
    been quiet for a while is usually still working.
11. If your sandbox blocks a command (no network, or no writes outside the folder you started in; Codex's default
    sandbox blocks both), ask the user to approve that one command when your agent offers it. Never switch yourself
    to full access.
12. Assume every command starts in a fresh shell (Claude Code and Codex do this): nothing you `cd`, `export` or set
    survives to the next command. Run each code block below as one command, write the step 1 answers into it as
    literal paths and values (`$CODE`, `$BRAIN`, `$NAME`, `$TZ`, `$TAG` are placeholders), and call hos by its full
    path `"$HOME/.local/bin/hos"` as the blocks do, even after the user's PATH is set.

## Windows (WSL2)

WSL2 support is new and has not yet been through a full install on a real Windows machine. If a step fails here,
show the user the output and point them at https://github.com/Harinder441/hos/issues.

hos runs on Windows only inside a WSL 2 Linux distro (Ubuntu is the usual one); native Windows is not supported.
Inside WSL every step below is the Linux step, with these differences:

1. **Run inside WSL.** The agent and every command run in the WSL distro. If `uname -s` prints `MINGW…`, `MSYS…` or
   `CYGWIN…` (Git Bash and similar), or there is no `uname` (PowerShell, cmd), stop and tell the user: "Open your WSL
   distro (for example Ubuntu from the Start menu), start your agent there and paste the install prompt again."
2. **WSL 2, not WSL 1.** It is WSL when `WSL_DISTRO_NAME` is set or `/proc/sys/kernel/osrelease` contains
   `microsoft` in any case; WSL 2 when that file contains `WSL` (it ends in `-microsoft-standard-WSL2`). The
   preflight's **Windows (WSL)** row checks this. On WSL 1, stop: the user runs `wsl -l -v` in PowerShell (the
   VERSION column) and `wsl --set-version <distro> 2`. hos needs WSL 2 for its real Linux kernel (full system call
   compatibility) and for systemd, which step 8 uses and which WSL 1 does not have.
3. **Folders in the Linux home.** Keep `CODE` and `BRAIN` in the Linux home (the defaults `~/code` and `~/hos-brain`),
   never under `/mnt/c` or another Windows drive: Linux tools are faster on the Linux file system, and on `/mnt/c`
   file permissions come from Windows. The preflight warns when the hos folder is under `/mnt/`.
4. **Tools.** Install them inside WSL as on Linux (the user runs `sudo apt install build-essential python3 git tmux`;
   Microsoft's guide installs Node in WSL with nvm, ask before adding it). Windows' own Node or git do not count:
   `command -v node npm git` must print paths outside `/mnt/`. Timezone (step 1): if `timedatectl` fails, use
   `readlink /etc/localtime | sed 's#.*/zoneinfo/##'`.
5. **Sign-ins.** `gh auth login` and `claude auth login` run in the WSL terminal; if no browser opens, the user opens
   the link they print in the Windows browser.
6. **Browser (steps 7 and 10).** The user opens `http://localhost:4517` in the Windows browser: WSL 2 forwards ports
   bound to localhost in WSL to Windows. If that page does not load, try `http://127.0.0.1:4517` (in mirrored
   networking mode Windows reaches WSL on `127.0.0.1`, and `::1` is not supported).
7. **Start at login (step 8).** The login item is the systemd user unit, so systemd must run in the distro: check
   `cat /proc/1/comm` prints `systemd` (Ubuntu installed with `wsl --install` has it on). If not, show the user these
   two lines for `/etc/wsl.conf` (they edit it with `sudo` in their own terminal), then they run `wsl --shutdown` in
   PowerShell (needs WSL 0.67.6 or newer, `wsl --version`) and open the distro again:

   ```ini
   [boot]
   systemd=true
   ```

   If systemd stays off, treat `KEEPER` as no and start hos by hand. Tell the user: systemd does not keep WSL running.
   When no WSL window or process is left, Windows shuts the distro down after an idle timeout and hos stops with it.
   To keep it running, they can set `instanceIdleTimeout=-1` under `[general]` in `%UserProfile%\.wslconfig` (their
   edit, then `wsl --shutdown`).
8. **Phone access (step 9): not covered yet for WSL.** Tailscale says to run it on the Windows host only, not inside
   WSL 2 as well; whether a Windows-side `tailscale serve` reaches hos in WSL has not been tested. Leave `PHONE` as
   later and point the user at the Remote access section of https://gethos.vercel.app/docs/security/.
9. **hos-code (step 4).** Use the `linux` archive.

## Step 0. Quick check (read only)

```sh
uname -s          # Darwin or Linux (Linux inside WSL); MINGW*, MSYS*, CYGWIN* or no uname: see Windows (WSL2); anything else: stop
git --version     # any 2.x
node --version    # v22 or newer
```

If git or Node 22 is missing, tell the user what to install (Node: `nvm install 22` or the OS package; ask before
adding a version manager; git on macOS comes with `xcode-select --install`) and stop until they have.
The full machine check is `install/preflight.mjs` in step 2.

## Step 1. Ask the user (once, all together)

1. **Code folder** for hos (and hos-code, if built). Default `~/code`.
2. **hos:** (a) clone the public repo (default) or (b) fork it to your GitHub account first, if you plan to send
   changes back.
3. **hos-code** (optional code viewer): (a) download the release archive (default), (b) clone and build it (needs
   Go 1.25 and Node), or (c) skip it. hos works without it; only "Open in Code view" and PR review need it.
4. **Brain folder.** Default `~/hos-brain`.
5. **Brain on GitHub:** (a) create a **private** repo `<your account>/hos-brain` now (default) or (b) keep it local
   and add a remote later. Say why it is not a fork: a fork of a public repo is always public, and the brain will
   hold the user's notes and rules.
6. **Your name** (shown in prompts and the UI) and **timezone**. Read the timezone from the system and offer it as the
   default: macOS `readlink /etc/localtime | sed 's#.*/zoneinfo/##'`, Linux `timedatectl show -p Timezone --value`.
7. **Start hos at login?** (a) yes (default) or (b) no, I will start it by hand.
8. **Phone access:** (a) later (default; hos stays on `localhost`) or (b) now, through Tailscale.

Note the answers as `CODE`, `HOS_MODE`, `CODE_MODE`, `BRAIN`, `BRAIN_REMOTE`, `NAME`, `TZ`, `KEEPER`, `PHONE` and
write their values into the commands below (rule 12). Expand `~` to the user's home folder in every path.

## Step 2. hos

```sh
mkdir -p "$CODE"
git clone https://github.com/Harinder441/hos "$CODE/hos"
#   2b fork instead: (cd "$CODE" && gh repo fork Harinder441/hos --clone)   # origin = your fork, upstream = public
cd "$CODE/hos"
git -c advice.detachedHead=false checkout "$TAG"
node install/preflight.mjs
```

`install/preflight.mjs` needs nothing but Node. Read every row to the user:

- `fail` rows block the install. Show the row's `fix:` line; the user runs it (sign-ins and anything with `sudo`
  happen in their own terminal), then run the preflight again.
- `warn` rows do not block. Before `npm ci` the Claude row checks the `claude` on `PATH` and says so; the binary hos
  actually starts comes with `npm ci` and is checked again below.
- **Existing hos** `warn` (a `~/.hos` folder exists) or a **Port** `fail`: hos is probably installed already. Stop
  and ask whether to upgrade (see **Updating**) or abort.
- `node "$CODE/hos/install/preflight.mjs" --json` prints the same rows as JSON.

Then build:

```sh
cd "$CODE/hos"
npm ci
npm run build
node dist/daemon/main.js --version
node dist/daemon/main.js doctor --preflight
```

**Check:** `--version` prints `hos <version> (<commit>)` and `<version>` is `TAG` without the `v`; the second
preflight shows `ok` for **Claude sign-in** ("the claude hos starts … signed in").

**If it fails:**
- `npm ci` errors in `better-sqlite3` or `node-pty`: the C/C++ toolchain is missing (the preflight's toolchain row).
  Do not retry with `--force` or `--legacy-peer-deps`.
- Claude sign-in `fail`: ask the user to run the command in the row's `fix:` line in their own terminal (it opens
  Claude's own login), then run `node "$CODE/hos/dist/daemon/main.js" doctor --preflight` again. hos never asks for an API key
  and never reads Claude's credentials.

## Step 3. `hos` on your PATH

```sh
node "$CODE/hos/dist/daemon/main.js" link
```

It writes `~/.local/bin/hos`, which runs this checkout with this Node. It refuses to overwrite a `hos` it did not
write. If it prints `not on PATH`, show the user the `export PATH=…` line it printed and ask whether to add it to their
shell's startup file (`~/.zshrc` for zsh, `~/.bashrc` for bash). Add it only on a yes, and add it to the list (rule 8).
That line is for the user's own terminals; the steps below call `"$HOME/.local/bin/hos"` by its full path (rule 12).

**Check:** `"$HOME/.local/bin/hos" --version` prints the same line as in step 2.

## Step 4. hos-code (optional; skip if `CODE_MODE` is c)

4a, release archive (default). Pick the archive for this machine: `<os>` is `darwin` or `linux` (`uname -s`,
lowercase), `<arch>` is `arm64` or `amd64` (`uname -m`: `arm64`/`aarch64` → `arm64`, `x86_64` → `amd64`).

```sh
D="$(mktemp -d)"; cd "$D"
gh release download --repo Harinder441/hos-code --pattern "hos-code-*-<os>-<arch>.tar.gz" --pattern checksums.txt
#   without gh: download the same two files from https://github.com/Harinder441/hos-code/releases/latest
shasum -a 256 --ignore-missing -c checksums.txt      # Linux: sha256sum --ignore-missing -c checksums.txt
tar -xzf hos-code-*-<os>-<arch>.tar.gz
mkdir -p ~/.local/bin
install -m 0755 hos-code-*-<os>-<arch>/hos-code ~/.local/bin/hos-code
```

4b, build from source:

```sh
git clone https://github.com/Harinder441/hos-code "$CODE/hos-code"
cd "$CODE/hos-code" && make build && install -m 0755 ./hos-code ~/.local/bin/hos-code
```

**Check:** `~/.local/bin/hos-code --version` prints `hos-code <version>`. hos finds it in `~/.local/bin` or on `PATH`.

**If it fails:** the checksum does not match → stop and delete the download folder `$D`; never install an archive that
failed its check. Anything else: tell the user hos works without hos-code, add "hos-code not installed" to the list,
and go on.

## Step 5. Your brain

```sh
"$HOME/.local/bin/hos" init --adopt "$BRAIN" --name "$NAME" --timezone "$TZ"
```

`hos init --adopt` clones `https://github.com/Harinder441/hos-brain` into `$BRAIN` with the remote named `starter`
and its push URL set to `DISABLED` (you pull starter updates; you never push to it), writes `NAME` and `TZ` into
`hos/policy.yaml` and `shared/USER.md`, copies hos's own skills into `.claude/skills/` and runs `hos validate`.

Show `git -C "$BRAIN" config user.email` and ask the user to confirm it (rule 9). Then commit:

```sh
git -C "$BRAIN" add -A && git -C "$BRAIN" commit -m "Make this brain mine"
```

If `BRAIN_REMOTE` is a:

```sh
gh repo create hos-brain --private --source "$BRAIN" --remote origin --push
```

**Check:** `"$HOME/.local/bin/hos" validate --brain "$BRAIN"` prints no `FAIL` line; `git -C "$BRAIN" remote -v` shows `starter` (push
`DISABLED`) and, for a, `origin` (the user's repo, fetch and push); `gh repo view hos-brain --json visibility -q
.visibility` prints `PRIVATE`.

**If it fails:** `gh` not signed in → ask the user to run `gh auth login` in their own terminal. Name taken → ask for
another name and use it in both commands. Never make the repo public. `hos validate` FAIL lines name the file and the
fix; show them to the user.

## Step 6. First start (foreground)

```sh
HOS_BRAIN="$BRAIN" "$HOME/.local/bin/hos"
```

Run it in the background of your shell (or a tmux window) and keep its output. It listens on
`http://localhost:4517` and only on this computer.

**Check:** the output has `hos daemon listening on`; `curl -s http://127.0.0.1:4517/api/doctor` answers. Doctor rows
need the passkey from step 7, so the full list is read in the browser (Settings → Doctor).

The output also has a `setup code for a new passkey` line. Never use that code yourself and do not repeat it; the
user reads it from the file in step 7 (rule 4).

**If it fails:** `EADDRINUSE` → something else uses port 4517; ask the user. Any other error: show the last 20 lines.

## Step 7. Passkey (the user does this)

Tell the user:

> Open http://localhost:4517 in your browser. It asks for a one-time setup code. The code is in
> `~/.hos/enrolment-code`. Open that file yourself (for example `cat ~/.hos/enrolment-code` in your terminal),
> paste the code, and save the passkey when the browser asks. Tell me when you see the Home page.

Do not read or print the code yourself (rule 4). **Check:** the user confirms the Home page. In Settings → Doctor,
the rows for optional extras may be red and are fine for now: Background service (until step 8), Watchdog (needs a
healthchecks.io URL), on a Mac Charge limit, and hos-code if hos-code was skipped. Any other red row: read its fix
line with the user.

## Step 8. Start at login (only if `KEEPER` is yes)

Stop the foreground hos first (Ctrl-C, or kill the process you started), then:

```sh
cd "$CODE/hos" && "$HOME/.local/bin/hos" keeper install --brain "$BRAIN"
```

**Check:** macOS `launchctl print gui/$(id -u)/dev.hos.daemon | grep state` shows `running`; Linux
`"$HOME/.local/bin/hos" keeper status` says `hos.service is active`. Then `curl -s http://127.0.0.1:4517/api/doctor` answers again.
- Linux: if the output mentions linger and the user wants hos running while logged out, ask them to run the
  `sudo loginctl enable-linger …` line it printed in their own terminal.

If `KEEPER` is no, leave the foreground hos running and tell the user how to start it next time:
`HOS_BRAIN="$BRAIN" hos` (with the PATH line from step 3; otherwise `HOS_BRAIN="$BRAIN" ~/.local/bin/hos`).

## Step 9. Phone access (only if `PHONE` is now)

1. The user installs Tailscale and signs in on the computer and the phone (theirs to do).
2. Add `transport: tailscale` to `$BRAIN/hos/policy.yaml` (show the diff, ask first), commit it in the brain, and
   restart hos (`"$HOME/.local/bin/hos" keeper restart`, or stop and start the foreground process).
3. Publish hos inside the tailnet only, never Funnel. Ask first, then run
   `tailscale serve --bg --https=443 http://127.0.0.1:4517`.
4. The user opens `https://<computer>.<tailnet>.ts.net` on the phone and registers a passkey there. A new address needs
   its own passkey and a fresh setup code, which hos writes to `~/.hos/enrolment-code` on restart.

**Check:** Settings → Doctor shows the Remote access row green. The `set-up-phone-access` recipe of the hos skill
covers Cloudflare and the details.

## Step 10. First chat and hand-off

Ask the user to start a new chat in hos with the **generic** profile (the default) and send "What can you do in this
brain?". Say why generic: it can use every hos feature and tool, canvases included, so they can try everything first;
narrower profiles come later through the hos skill ("use the hos skill to create a profile"). When a reply arrives,
print:

- what was created (rule 8) and where;
- the URL to open hos (`http://localhost:4517`, plus the tailnet URL if step 9 ran);
- how to update (below) and how to remove (**Uninstall**);
- how hos treats the brain: it commits the brain files a chat changes, one commit naming the topic and chat. When the brain has an
  `origin` remote and is on branch `main`, hos syncs about a minute after a commit and every five minutes when idle:
  it fetches `origin`, merges `origin/main` and pushes `main`. It never rebases and never forces. If the merge
  conflicts, hos aborts it, keeps the local commits, stops pushing and raises a "Brain sync conflict" alert; pushing
  resumes once the user has merged by hand. A brain with no `origin` is only committed, never pushed.

## Updating

```sh
cd "$CODE/hos" && git fetch --tags origin      # a fork (step 2b): git fetch --tags upstream
git -c advice.detachedHead=false checkout <new tag>
npm ci && npm run build
"$HOME/.local/bin/hos" keeper restart                       # or stop and start the foreground hos
"$HOME/.local/bin/hos" brain update --brain "$BRAIN"        # merges starter/main into your brain; stops on conflicts
"$HOME/.local/bin/hos" skills sync --brain "$BRAIN"         # refreshes hos's own skills; keeps any you edited
```

Brain conflicts: show them to the user file by file; never resolve one by taking the starter's side wholesale.
`hos link` needs no rerun unless the Node version changed (then run `node "$CODE/hos/dist/daemon/main.js" link`
with the new Node).

## Uninstall

Undo only what the list from rule 8 says this install created, in this order, each after a yes:

1. Login item: `cd "$CODE/hos" && "$HOME/.local/bin/hos" keeper uninstall` (removes the LaunchAgent or the systemd unit). Then remove
   its logs folder: macOS `~/Library/Logs/hos`, Linux `~/.local/state/hos`.
2. Phone access, if step 9 ran: `tailscale serve reset` only if the user has no other serve config (ask); remove the
   `transport:` line from `$BRAIN/hos/policy.yaml` if the brain stays.
3. Stop any foreground hos.
4. `"$HOME/.local/bin/hos" unlink` (removes `~/.local/bin/hos`, only if hos wrote it; run it after step 1). Remove the `export PATH=…` line from the shell
   startup file, only if this install added it.
5. `rm -rf ~/.hos` (chats, passkeys, settings). Ask twice; this cannot be undone.
6. `rm ~/.local/bin/hos-code` if step 4 installed it; `rm -rf "$CODE/hos"`, and `"$CODE/hos-code"` if 4b ran (only
   folders this run created).
7. WSL: the paths above are the Linux ones inside the distro. An `/etc/wsl.conf` or `.wslconfig` change made for hos
   is the user's to undo; they may have other reasons to keep it.
8. The brain: leave it unless the user asks. It is their repo. A private GitHub repo is deleted only by the user
   (`gh repo delete` needs the `delete_repo` scope; do not request it for them).
