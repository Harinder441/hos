# Loopback-only daemon behind a switchable transport, plus hos's own passkey

The daemon listens only on loopback. Remote access is a transport adapter with two implementations, picked in config:
- Tailscale serve: tailnet only, identity from Tailscale headers.
- Cloudflare Tunnel + Access: identity from a verified Access JWT.

The web app is identical on both. On top of either, hos requires its own passkey login, plus a fresh passkey for approvals, terminals and destructive actions. Network identity alone would let a local, prompt-injected agent approve its own requests. Passkeys and PWA installs are per origin, so each transport needs its own registration. A third transport (own end-to-end relay) must fit the same adapter later.
