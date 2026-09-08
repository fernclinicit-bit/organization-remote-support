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
The Agent emergency disconnect shortcut is `Ctrl+Alt+Shift+Esc`.

## Production gate

Do not expose this prototype directly to the internet. Complete the controls in
`docs/security.md`, place services behind TLS, use a managed identity provider,
and obtain Windows/macOS code-signing credentials first.
