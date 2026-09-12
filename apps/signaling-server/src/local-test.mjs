import { spawn } from "node:child_process";
import WebSocket from "ws";

const port = 20_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/signal`;
const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), CLOUDFLARE_TURN_KEY_ID: "", CLOUDFLARE_TURN_API_TOKEN: "" },
  stdio: ["ignore", "pipe", "pipe"]
});

function waitFor(socket, event, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function open(role, sessionId, joinToken) {
  const socket = new WebSocket(wsUrl);
  await waitFor(socket, "open");
  socket.send(JSON.stringify({ type: "hello", sessionId, joinToken, role }));
  return socket;
}

async function waitForMessage(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expectedType}`)), 5_000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== expectedType) return;
      clearTimeout(timer); socket.off("message", listener); resolve(message);
    };
    socket.on("message", listener);
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local signaling server did not start");
}

const sockets = [];
try {
  await waitForHealth();
  const sessionId = String(Date.now()).slice(-9);
  let agent = await open("agent", sessionId, "047984"); sockets.push(agent);
  const agentReady = waitForMessage(agent, "peer-ready");
  let controller = await open("controller", sessionId, "047984"); sockets.push(controller);
  const controllerReady = waitForMessage(controller, "peer-ready");
  for (const ready of await Promise.all([agentReady, controllerReady])) {
    if (ready.relayAvailable !== false || !Array.isArray(ready.iceServers)) throw new Error("missing STUN fallback state");
  }

  const relayedOffer = waitForMessage(agent, "offer");
  controller.send(JSON.stringify({ type: "offer", sdp: "test-sdp" }));
  if ((await relayedOffer).sdp !== "test-sdp") throw new Error("offer was not relayed");

  const bad = await open("controller", sessionId, "999999"); sockets.push(bad);
  const error = await waitForMessage(bad, "error");
  if (error.code !== "4401" || error.retryable !== false) throw new Error("invalid password response is incorrect");
  const [badCloseCode] = await waitFor(bad, "close");
  if (badCloseCode !== 4401) throw new Error(`invalid password closed with ${badCloseCode}`);

  const missing = await open("controller", "987654321", "047984"); sockets.push(missing);
  const missingError = await waitForMessage(missing, "error");
  if (missingError.code !== "4404" || missingError.retryable !== true) throw new Error("offline agent response is incorrect");

  const previousController = controller;
  const previousClosed = waitFor(previousController, "close");
  controller = await open("controller", sessionId, "047984"); sockets.push(controller);
  await waitForMessage(controller, "peer-ready");
  const [replacementCloseCode] = await previousClosed;
  if (replacementCloseCode !== 4409) throw new Error(`replaced controller closed with ${replacementCloseCode}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const replacementOffer = waitForMessage(agent, "offer");
  controller.send(JSON.stringify({ type: "offer", sdp: "replacement-sdp" }));
  if ((await replacementOffer).sdp !== "replacement-sdp") throw new Error("replacement controller was removed by the old socket close handler");

  const previousAgent = agent;
  const previousAgentClosed = waitFor(previousAgent, "close");
  agent = await open("agent", sessionId, "047984"); sockets.push(agent);
  await waitForMessage(agent, "peer-ready");
  const [replacementAgentCloseCode] = await previousAgentClosed;
  if (replacementAgentCloseCode !== 4409) throw new Error(`replaced agent closed with ${replacementAgentCloseCode}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const offerToReplacementAgent = waitForMessage(agent, "offer");
  controller.send(JSON.stringify({ type: "offer", sdp: "replacement-agent-sdp" }));
  if ((await offerToReplacementAgent).sdp !== "replacement-agent-sdp") throw new Error("replacement agent session was removed by the old socket close handler");

  controller.send(JSON.stringify({ type: "peer-ready" }));
  const serverOnlyError = await waitForMessage(controller, "error");
  if (serverOnlyError.code !== "4400") throw new Error("server-only message was accepted from a client");
  console.log("PASS: pairing, relay metadata, signaling relay, invalid password, offline-agent handling, safe peer replacement, and server-only message rejection");
} finally {
  for (const socket of sockets) if (socket.readyState < WebSocket.CLOSING) socket.close();
  child.kill();
}
