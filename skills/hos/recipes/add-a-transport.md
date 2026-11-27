---
id: add-a-transport
title: Add a transport
kind: code
size: M
hos: ">=0.1"
source:
  - src/adapters/transport.ts
  - src/adapters/tailscale-transport.ts
  - src/adapters/cloudflare-transport.ts
  - src/fakes/fake-transport-identity.ts
  - src/policy.ts
  - schemas/policy.schema.json
  - src/cli/validate.ts
  - src/settings.ts
  - src/main.ts
  - test/harness.ts
  - test/transport.test.ts
  - docs/adr/0005-transport-adapter-loopback-only.md
docs: extend-hos#add-a-transport
---

# Add a transport

hos listens only on this computer (loopback). A transport is how your other devices reach it: a service on this
computer publishes hos to your devices and tells hos who is asking. hos ships two, Tailscale and Cloudflare Tunnel
with Access. With none set, hos is reachable from this computer only.

A new transport is a change to hos's code, not a plug-in, because it decides who may use hos at all. Your agent makes
it in a new branch of your hos checkout, with tests, and opens a pull request to your fork (the recipe `change-hos`).

The transport must prove who is asking: a header that only the local service can set, or a token hos can verify.
hos's own passkey stays on top of it, so each new address needs its own passkey.

**What you get:** a pull request with the transport, its tests and its docs. After you merge it: a new value for
`transport:` in `hos/policy.yaml`, and a Doctor line that says whether it works.

**Ask your agent:** "Use the hos skill to add a transport for <service>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **The service**, and how it tells a local process who the visitor is: a header its local proxy sets, a signed
   token, a client certificate. If it can't prove the visitor, stop here: hos refuses transports without an
   identity check (ADR 0005).
2. **Name**: one lowercase word, used as `transport: <name>`.
3. **Settings it needs**, as keys under a `<name>:` block in `hos/policy.yaml` (for example a host name and the
   owner's account). Default: none.
4. **Previews**: should it also publish worktree dev servers? Default: no.

### Steps

Run the recipe `change-hos` steps 1–4 first (pin the version, find the checkout, make a new worktree, read). Then:

1. Read `src/adapters/transport.ts` (the `Transport` interface), both transports beside it, ADR 0005, and
   `test/transport.test.ts`.
2. Write `src/adapters/<name>-transport.ts`, a class that implements `Transport`:
   - `name`: the word from answer 2.
   - `identify(req)`: return `{ user, via }` only when `fromLoopback(req)` is true (the request came through the
     local service) **and** the identity checks out against the configured owner. Return `null` otherwise.
   - `webOrigin(port)`: the https address the user opens, or `null` until it is known.
   - `previewUrl(port)`, and `previewPort(host)` if it publishes previews; `null` when it doesn't.
   - `doctor(port)`: `{ transport, ok, message, fix }`. One plain sentence, then the exact commands that fix it.
   - `codeViewHost()`: return what `loopbackTransport` returns, unless the service also publishes hos's terminal ports.
   - Put each outside call (a CLI, a key download) behind a small interface, the way `TailscaleCli` and
     `AccessCerts` are, so tests can pass a fake.
3. In `src/policy.ts`: add the name to `TRANSPORTS`, and write `load<Name>Config(file)` modelled on
   `loadCloudflareConfig`. It must throw a message that names the file and each missing key. Call it from
   `loaderErrors` in `src/cli/validate.ts`, next to the Cloudflare line, so `hos validate` reports it.
4. In `src/main.ts`: build the transport next to the other two. Add a flag (like `--tailscale-bin`) only for a path
   tests must point at a fake.
5. In `src/settings.ts`: add the `<name>` block to `CONNECTION` and `RESTART`, so Settings shows it under
   Connection and says it needs a restart.
6. In `schemas/policy.schema.json`: add the name to the `transport` list and describe the `<name>` block, so
   `hos validate` accepts it.
7. Tests at the daemon seam (ADR 0003), in `test/transport.test.ts`: add a fake identity to
   `src/fakes/fake-transport-identity.ts` and a `transport` option to `startTestDaemon` in `test/harness.ts`. Cover:
   - the owner's request is served;
   - no identity, another user, or a request not from loopback gets 401;
   - the doctor explains a broken setup without needing an identity;
   - a passkey is still required.
8. Optional live test: `test/<name>.live.test.ts`, skipped unless an environment variable is set, like
   `test/tailscale.live.test.ts`. Run it by hand only when the user asks.
9. Docs, in the same diff: the security page (`docs/site/src/content/docs/docs/security.md`) and the
   `set-up-phone-access` recipe if it lists the transports.

### Check

```sh
npm run check -- transport policy settings
npm run test:full    # once, at the end, holding the hos-full-suite lock
```

Then hand over, as `[user]` steps: install and sign in to the service, set `transport: <name>` and its block, run
`npm run build && hos keeper restart` in the live checkout after the merge, open the new address and add a passkey
with the enrolment code hos prints at start.

### If it fails

- 401 for the owner: `identify` reads the wrong header, or the request reaches hos through another hop, so it isn't
  from loopback. Print what the service actually sends in a test, not in the live daemon.
- hos exits at start with "transport must be one of …": the name isn't in `TRANSPORTS` in the build that runs.
- The passkey prompt fails on the new address: passkeys are per address. Enrol a new one there.

### Undo

Before merge: close the PR and remove the worktree. After merge: the user removes `transport:` (hos goes back to
loopback only) and restarts.

### Don't

- Don't make hos listen on anything but loopback. The service connects to hos locally.
- Don't trust an identity header on a request that didn't come from loopback.
- Don't skip or weaken the passkey. If the user insists, say so in the PR's first line.
- Don't install the service, open a tunnel or change machine settings. Those are `[user]` steps.
- Don't publish hos to the open internet without an identity check in front of it.
