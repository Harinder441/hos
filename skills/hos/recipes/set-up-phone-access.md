---
id: set-up-phone-access
title: Set up phone access
kind: brain
size: S
hos: ">=0.1"
source:
  - src/policy.ts
  - src/settings.ts
  - src/adapters/tailscale-transport.ts
  - src/adapters/cloudflare-transport.ts
  - src/passkeys.ts
  - schemas/policy.schema.json
docs: make-it-yours#set-up-phone-access
---

# Set up phone access

hos listens on this computer only. To use it from your phone or another computer, put a transport in front of it:

- **Tailscale** publishes hos inside your own tailnet, so only your signed-in devices reach it. Simplest.
- **Cloudflare** runs your own Cloudflare Tunnel behind a Cloudflare Access login, so any browser works. It needs a
  domain on Cloudflare.

Then you save a passkey for the new address. No relay of ours sits in the path.

**What you get:** `transport:` in `hos/policy.yaml`, hos at an `https://` address on your phone, signed in with a
passkey. Needs one restart and a few steps only you can do.

**Ask your agent:** "Use the hos skill to set up phone access with <Tailscale or Cloudflare>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **Transport**: (a) `tailscale` (default) or (b) `cloudflare`.
2. For Cloudflare: the Zero Trust team name, the hostname for hos (`hos.<their domain>`), the preview hostname
   pattern (`hos-{port}.<their domain>`), the Access application's audience tag, and the one email Access allows.
3. **Is the brain shared by several computers?** If yes, the setting goes in `hos/policy.<short host name>.yaml`
   (merged over `hos/policy.yaml` on that computer only) instead of the shared file.

### Steps

Installing software and changing network settings are the user's steps. List each as a `[user]` item with the exact
command and wait; never run them yourself.

1. Tailscale: `[user]` install Tailscale on this computer and the phone, sign in to the same account on both.
   Cloudflare: `[user]` create a tunnel named `hos` whose ingress sends the hos hostname and the preview hostnames to
   the daemon on its IPv4 loopback address, port 4517 (hos binds IPv4 only, so the ingress service is
   `http://127.0.0.1:4517`, not `localhost`), DNS records for both, and one self-hosted Access application covering both that allows only
   the email from answer 2. Run it with `cloudflared tunnel run hos`.
2. Set the transport in the policy file (answer 3 picks which):

   ```yaml
   transport: tailscale          # or cloudflare, with the block below
   cloudflare:
     team: <team>
     aud: <audience tag>
     hostname: hos.example.com
     previews: "hos-{port}.example.com"
     email: you@example.com
   ```

3. `[user]` restart hos: `hos keeper restart`, or stop and start it. `transport` is read only at start.
4. Read the doctor: `curl -s http://localhost:4517/api/doctor`. Its `message` says whether the transport works and
   its `fix` lines give the exact next command. For Tailscale that is a `tailscale serve --bg --https=443 ...` line:
   `[user]` run it once.
5. `[user]` open the address the doctor names, on the phone. The first visit asks for the one-time enrolment code:
   the user reads it on this computer with `cat ~/.hos/enrolment-code` (in hos's data folder) and saves a passkey.
   Then Add to Home Screen.

### Check

The doctor answers `"ok": true` and its `passkeys` list includes the new `https://` origin. Settings, Connection
shows the running transport and the URL. The user signs in on the phone with the passkey.

### If it fails

- Tailscale "isn't installed" or "isn't running": the doctor's fix lines say what to do. The address must not load
  on Funnel; only `tailscale serve` is right.
- After the switch, the local address shows only the doctor: expected. With Tailscale, open the tailnet address on
  this computer too.
- "the enrolment code was used": restart hos for a new code.
- Cloudflare "can't fetch Access's signing keys": the `team` name is wrong or the computer is offline.
- hos won't start with Cloudflare: one of the five `cloudflare` keys is missing, or `previews` lacks `{port}`.

### Undo

Remove `transport:` (and `cloudflare:`), restart hos: it is local-only again. `[user]` `tailscale serve reset` only
if nothing else is served; or stop the tunnel.

### Don't

- Don't use Tailscale Funnel, open the daemon port to the network, or put another proxy in front of it.
- Don't print or paste the enrolment code into a chat or a file; the user reads it themselves.
- Don't change `ports` or the daemon port while doing this.
