import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { isSignalMessage, type PeerRole } from "@remote/protocol";

const port = Number(process.env.PORT ?? process.env.SIGNALING_PORT ?? 8080);
type Session = { peers: Map<PeerRole, WebSocket>; joinToken: string; createdAt: number };
const sessions = new Map<string, Session>();
const failures = new Map<string, { count: number; resetAt: number }>();
const authWindowMs = 10 * 60_000;
const maxAuthFailures = 5;

function authAllowed(address: string): boolean {
  const now = Date.now();
  const current = failures.get(address);
  if (!current || current.resetAt <= now) { failures.delete(address); return true; }
  return current.count < maxAuthFailures;
}

function recordAuthFailure(address: string): void {
  const now = Date.now();
  const current = failures.get(address);
  failures.set(address, !current || current.resetAt <= now ? { count: 1, resetAt: now + authWindowMs } : { ...current, count: current.count + 1 });
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validIdentity(sessionId: string, token: string): boolean {
  return /^\d{9}$/.test(sessionId) && /^\d{6}$/.test(token);
}

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", instance: randomUUID(), revision: process.env.RENDER_GIT_COMMIT ?? "local" }));
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/signal", maxPayload: 64 * 1024 });

wss.on("connection", (socket, request) => {
  let identity: { sessionId: string; role: PeerRole } | undefined;
  const address = request.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || request.socket.remoteAddress || "unknown";

  if (!authAllowed(address)) { socket.close(4429, "too many authentication attempts"); return; }

  const authenticationTimeout = setTimeout(() => socket.close(4401, "authentication required"), 5_000);

  socket.on("message", (raw) => {
    let message: unknown;
    try { message = JSON.parse(raw.toString()); } catch { socket.close(4400, "invalid JSON"); return; }
    if (!isSignalMessage(message)) { socket.close(4400, "invalid message"); return; }

    if (!identity) {
      if (message.type !== "hello" || !validIdentity(message.sessionId, message.joinToken)) {
        recordAuthFailure(address);
        socket.close(4401, "invalid credentials");
        return;
      }
      let session = sessions.get(message.sessionId);
      if (!session) {
        session = { peers: new Map<PeerRole, WebSocket>(), joinToken: message.joinToken, createdAt: Date.now() };
        sessions.set(message.sessionId, session);
      } else if (!equalSecret(message.joinToken, session.joinToken)) {
        recordAuthFailure(address);
        socket.close(4401, "invalid session ID or password");
        return;
      }
      if (!session) { socket.close(4500, "session unavailable"); return; }
      clearTimeout(authenticationTimeout);
      identity = { sessionId: message.sessionId, role: message.role };
      const peers = session.peers;
      peers.get(message.role)?.close(4409, "role already connected");
      peers.set(message.role, socket);
      if (peers.has("agent") && peers.has("controller")) {
        const ready = JSON.stringify({ type: "peer-ready" });
        peers.get("agent")?.send(ready);
        peers.get("controller")?.send(ready);
      }
      return;
    }

    if (message.type === "hello") { socket.close(4400, "already authenticated"); return; }
    const otherRole: PeerRole = identity.role === "agent" ? "controller" : "agent";
    const peer = sessions.get(identity.sessionId)?.peers.get(otherRole);
    if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message));
  });

  socket.on("close", () => {
    clearTimeout(authenticationTimeout);
    if (!identity) return;
    const session = sessions.get(identity.sessionId);
    session?.peers.delete(identity.role);
    if (identity.role === "agent" || !session?.peers.size) sessions.delete(identity.sessionId);
  });
});

httpServer.listen(port, "0.0.0.0", () => console.log(`signaling server listening on :${port}`));

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) if (now - session.createdAt > 12 * 60 * 60_000) {
    for (const peer of session.peers.values()) peer.close(4408, "session expired");
    sessions.delete(id);
  }
  for (const [address, failure] of failures) if (failure.resetAt <= now) failures.delete(address);
}, 60_000).unref();