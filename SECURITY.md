# Security policy

## Reporting a vulnerability

Report it privately through GitHub: the repo's **Security** tab → **Report a vulnerability**. Please do not open a
public issue, pull request or discussion for a security problem.

Include what you found, the hos version (`hos --version`), your OS, how you reached hos (loopback, Tailscale or
Cloudflare) and the steps to reproduce. You will get an answer within 7 days. A fix ships in a release, and the
advisory is published with it, crediting you unless you ask otherwise.

## Supported versions

Only the latest release gets security fixes.

## One user account per computer

hos is built for a computer where you are the only user account. Its tokens live in its data folder (`~/.hos`, which
only you can read). Claude chats get theirs through a pipe and the code viewer gets the paths of those files, so no
token is on a command line where another local account could read it with `ps`. `/hos-code/pr` hands out a viewer
link only to a passkey session.

What another local account can still do: see which programs you run and their command lines (paths, chat ids, and for
a chat taken over into a terminal, your brain's and profile's instructions), and reach hos's ports on this computer,
where the passkey, the bus token or the viewer login stops it. One case is outside what hos can promise: an agent that
runs through a plug-in harness gets the bus token through its input, and hos cannot follow what that agent does with
it. If you use one, run hos on a computer where you are the only account.

## What counts

hos is a local daemon that runs coding agents with your user's rights. These are in scope:

- reaching the web app or its API without a passkey session, from another device, a tunnel URL or a website you visit;
- reading or writing files outside what a route or bus tool is meant to touch;
- a chat getting past the approvals policy or the kill switch;
- tokens, setup codes or secrets ending up in logs, links, agent context or the brain's git history;
- data leaving the machine that the docs say does not (hos sends no usage data).

Out of scope: what an agent does inside the rights and approvals you gave it, a compromised account on the same
computer, and problems in Claude Code, Tailscale or Cloudflare themselves (report those to their projects).

The code viewer (hos-code) and the starter brain (hos-brain) are separate repos; report problems in them there.
