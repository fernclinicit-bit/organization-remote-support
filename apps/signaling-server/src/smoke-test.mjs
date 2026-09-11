import WebSocket from "ws";

const url = process.argv[2];
const token = process.argv[3];
const sessionId = String(Date.now()).slice(-9);
if (!url || !token) throw new Error("usage: node smoke-test.mjs <wss-url> <token>");

const agent = new WebSocket(url);
await new Promise((resolve, reject) => {
  agent.on("open", () => { agent.send(JSON.stringify({ type: "hello", sessionId, joinToken: token, role: "agent" })); resolve(); });
  agent.on("error", reject);
});
const controller = new WebSocket(url);
const peers = [agent, controller];

await new Promise((resolve, reject) => {
  let ready = 0;
  const timer = setTimeout(() => reject(new Error("signaling smoke test timed out")), 10_000);
  controller.on("open", () => controller.send(JSON.stringify({ type: "hello", sessionId, joinToken: token, role: "controller" })));
  for (const peer of peers) {
    peer.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "peer-ready" && ++ready === 2) {
        clearTimeout(timer);
        resolve();
      }
    });
    peer.on("error", reject);
  }
});

controller.close();
await new Promise((resolve) => controller.once("close", resolve));

await new Promise((resolve, reject) => {
  const intruder = new WebSocket(url);
  const timer = setTimeout(() => reject(new Error("invalid password was not rejected")), 20_000);
  intruder.on("open", () => intruder.send(JSON.stringify({ type: "hello", sessionId, joinToken: token === "999999" ? "888888" : "999999", role: "controller" })));
  intruder.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "error" && message.code === "4401") { clearTimeout(timer); intruder.close(); resolve(); }
  });
  intruder.on("close", (code) => { if (code === 4401) { clearTimeout(timer); resolve(); } });
  intruder.on("error", reject);
});

for (const peer of peers) peer.close();
console.log(`PASS: pairing succeeds and invalid password is rejected through ${url}`);
