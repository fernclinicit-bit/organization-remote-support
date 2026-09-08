# Security and production checklist

Remote-control software is privileged infrastructure. The first public release
must satisfy all items below.

## Identity and authorization

- Use the organization's OIDC/SAML identity provider and require MFA.
- Enroll every device with a unique, revocable certificate stored in the OS keychain.
- Issue one-use session tokens with a maximum lifetime of five minutes.
- Apply role-based access and explicit device groups; deny by default.
- Never use the development shared secret in production.

## User safety

- Show the operator's verified identity and purpose on the target device.
- Require visible user consent by default; unattended access needs separate policy.
- Keep a persistent on-screen indicator and an immediate disconnect control.
- Block password fields and secure desktops where the OS requires it.

## Transport and infrastructure

- Terminate only TLS 1.2+ and use WSS for signaling.
- Prefer WebRTC DTLS-SRTP; TURN credentials must be short-lived.
- Rate-limit authentication, session creation, and join attempts.
- Separate signaling, identity, audit, and relay services by network policy.
- Do not record video/audio unless policy explicitly enables it.

## Audit and release

- Record who connected, which device, approvals, timestamps, and outcome.
- Send immutable audit events to the organization's SIEM; never log session secrets.
- Sign and notarize macOS builds; sign Windows installers and binaries.
- Complete penetration testing, privacy review, incident response, and key rotation.
- Test macOS Screen Recording/Accessibility permission revocation and Windows UAC behavior.

