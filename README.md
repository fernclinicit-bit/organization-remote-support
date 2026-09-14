# Organization Remote Support

Secure remote-support software for Windows and macOS. This repository starts
with the internet-facing control plane: authenticated session creation,
short-lived join codes, WebRTC signaling, and a TURN relay configuration.

## Architecture

```text
IT Controller ---- outbound TLS ---- Signaling API ---- outbound TLS ---- Device Agent
      |                                  |
      +---------- WebRTC media ----------+
                     |
                TURN relay (fallback)
```

Neither endpoint needs an inbound firewall rule. WebRTC attempts a direct
encrypted connection and falls back to TURN when NAT or policy blocks it.

## Repository layout

- `apps/signaling-server`: WebSocket signaling service and health endpoint
- `apps/desktop-agent`: consent-first Windows/macOS screen-sharing agent
- `apps/desktop-controller`: view-only IT support console for Windows/macOS
- `packages/protocol`: shared, versioned message schema
- `infra/compose.yaml`: local signaling and coturn stack
- `docs/security.md`: security requirements before production use

## Run locally

1. Copy `.env.example` to `.env` and replace every development secret.
2. Run `docker compose -f infra/compose.yaml --env-file .env up --build`.
3. Check `http://localhost:8080/health`.

The current milestone is the secure connection backbone. Screen capture,
consent prompts, agent signaling, permission-gated remote input, text clipboard,
and prompted file transfer are implemented. Complete macOS permission onboarding,
device enrollment, SSO/MFA, short-lived TURN credentials, audit storage, and
signed installers are the next implementation stages.

Run the development agent with `npm run dev:agent`. Start the signaling server
first and use the same development secret from `SESSION_SIGNING_SECRET` as the
temporary join token. This shared-secret flow is local-development only.

Run the IT console with `npm run dev:controller`. Use the same server URL,
session ID, and temporary join token on both applications. Either side may join
first; the signaling server announces when both peers are ready.

Remote control, clipboard, and file transfer are separate session grants on the
Agent. File transfer is capped at 25 MB and always opens a local Save As dialog.
Clipboard text is synchronized automatically in both directions only after the
Agent grants clipboard access for that session. Pre-session clipboard contents are
used only as a baseline and are not transmitted until either side copies new text.
The Agent emergency disconnect shortcut is `Ctrl+Alt+Shift+Esc`.

## Public Internet / TURN

The Render service handles WSS signaling only. Reliable connections between
different networks require a public TURN relay. Configure these secret environment
variables on the existing Render service (Dashboard values are required for an
existing Blueprint):

- `CLOUDFLARE_TURN_KEY_ID`
- `CLOUDFLARE_TURN_API_TOKEN`
- `TURN_CREDENTIAL_TTL` (defaults to `86400` seconds)

The signaling service requests short-lived ICE credentials for each authenticated
pairing and sends them in `peer-ready`. The long-lived Cloudflare API token never
leaves the server. If TURN is missing, the apps show an explicit warning and try
STUN/P2P only. Manual TURN fields remain available as an emergency override.

## Windows Admin Mode

Admin Mode is distributed as a separate ZIP under the Agent release directory.

The Windows Agent UI always runs with standard privileges so Electron screen
capture remains reliable. A separate authenticated Input Broker runs elevated,
allowing the remote operator to control ordinary elevated application windows.
Windows Secure Desktop UAC prompts remain local-only and UAC is not disabled or
bypassed.
Run `Install-AdminMode.ps1` from an elevated PowerShell window on the endpoint.
It registers a watchdog Windows Service, a standard-privilege interactive Agent
task, and a separate broker task with `RunLevel Highest`. The broker accepts only
local named-pipe clients whose process ancestry matches the protected Agent path.
The signed-in user must belong to Local Administrators.

When the Agent receives an `.exe` or `.msi`, remote input is suspended and the
person physically at the endpoint must confirm before it is started. If Windows
shows a Secure Desktop UAC prompt, that person must confirm it locally; after
that, the broker can control the elevated installer window. The Agent does not
provide silent installation or arbitrary remote command execution. Admin events
are recorded under `audit/admin-mode.jsonl` in the Agent user-data directory.

## Production gate

Do not expose this prototype directly to the internet. Complete the controls in
`docs/security.md`, place services behind TLS, use a managed identity provider,
and obtain Windows/macOS code-signing credentials first.
