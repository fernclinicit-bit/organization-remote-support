import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { isSignalMessage, type IceServerConfig, type PeerRole } from "@remote/protocol";

const port = Number(process.env.PORT ?? process.env.SIGNALING_PORT ?? 8080);
const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
const turnApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
const turnCredentialTtl = Math.min(86_400, Math.max(3_600, Number(process.env.TURN_CREDENTIAL_TTL ?? 86_400) || 86_400));
const stunIceServers: IceServerConfig[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const turnConfigured = Boolean(turnKeyId && turnApiToken);
type Session = { peers: Map<PeerRole, WebSocket>; joinToken: string; createdAt: number; announcing?: boolean };
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

function rejectSocket(socket: WebSocket, code: number, reason: string): void {
  const close = () => setImmediate(() => socket.close(code, reason));
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "error", code: String(code), message: reason, retryable: code === 4404 || code === 4429 || code >= 4500 }), close);
  } else close();
  setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 2_000).unref();
}

function validIceServers(value: unknown): value is IceServerConfig[] {
  return Array.isArray(value) && value.length > 0 && value.every((server) => {
    if (!server || typeof server !== "object") return false;
    const urls = (server as IceServerConfig).urls;
    return typeof urls === "string" || (Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === "string"));
  });
}

async function managedIceServers(): Promise<{ iceServers: IceServerConfig[]; relayAvailable: boolean }> {
  if (!turnConfigured) return { iceServers: stunIceServers, relayAvailable: false };
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId!)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${turnApiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: turnCredentialTtl }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Cloudflare TURN returned HTTP ${response.status}`);
  const payload = await response.json() as { iceServers?: unknown };
  if (!validIceServers(payload.iceServers)) throw new Error("Cloudflare TURN returned invalid ICE servers");
  return { iceServers: payload.iceServers, relayAvailable: true };
}

async function announceReady(session: Session): Promise<void> {
  if (session.announcing || !session.peers.has("agent") || !session.peers.has("controller")) return;
  session.announcing = true;
  let configuration = { iceServers: stunIceServers, relayAvailable: false };
  try { configuration = await managedIceServers(); }
  catch (error) { console.error("TURN credential generation failed", error instanceof Error ? error.message : String(error)); }
  const ready = JSON.stringify({ type: "peer-ready", ...configuration });
  for (const peer of session.peers.values()) if (peer.readyState === WebSocket.OPEN) peer.send(ready);
  session.announcing = false;
}

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", instance: randomUUID(), revision: process.env.RENDER_GIT_COMMIT ?? "local", turnRelay: turnConfigured ? "configured" : "missing" }));
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/signal", maxPayload: 64 * 1024 });

wss.on("connection", (socket, request) => {
  let identity: { sessionId: string; role: PeerRole } | undefined;
  (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
  socket.on("pong", () => { (socket as WebSocket & { isAlive?: boolean }).isAlive = true; });
  const address = request.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || request.socket.remoteAddress || "unknown";

  if (!authAllowed(address)) { rejectSocket(socket, 4429, "too many authentication attempts"); return; }

  const authenticationTimeout = setTimeout(() => socket.close(4401, "authentication required"), 5_000);

  socket.on("message", (raw) => {
    let message: unknown;
    try { message = JSON.parse(raw.toString()); } catch { socket.close(4400, "invalid JSON"); return; }
    if (!isSignalMessage(message)) { socket.close(4400, "invalid message"); return; }

    if (!identity) {
      if (message.type !== "hello" || !validIdentity(message.sessionId, message.joinToken) || !["agent", "controller"].includes(message.role)) {
        recordAuthFailure(address);
        rejectSocket(socket, 4401, "invalid credentials");
        return;
      }
      let session = sessions.get(message.sessionId);
      if (!session && message.role !== "agent") {
        rejectSocket(socket, 4404, "agent is not online");
        return;
      }
      if (!session) {
        session = { peers: new Map<PeerRole, WebSocket>(), joinToken: message.joinToken, createdAt: Date.now() };
        sessions.set(message.sessionId, session);
      } else if (!equalSecret(message.joinToken, session.joinToken)) {
        recordAuthFailure(address);
        rejectSocket(socket, 4401, "invalid session ID or password");
        return;
      }
      if (!session) { socket.close(4500, "session unavailable"); return; }
      clearTimeout(authenticationTimeout);
      failures.delete(address);
      identity = { sessionId: message.sessionId, role: message.role };
      const peers = session.peers;
      peers.get(message.role)?.close(4409, "role already connected");
      peers.set(message.role, socket);
      if (peers.has("agent") && peers.has("controller")) void announceReady(session);
      return;
    }

    if (["hello", "peer-ready", "error"].includes(message.type)) { rejectSocket(socket, 4400, "message type is server-only or already authenticated"); return; }
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

setInterval(() => {
  for (const socket of wss.clients) {
    const liveSocket = socket as WebSocket & { isAlive?: boolean };
    if (liveSocket.isAlive === false) { socket.terminate(); continue; }
    liveSocket.isAlive = false;
    socket.ping();
  }
}, 30_000).unref();
