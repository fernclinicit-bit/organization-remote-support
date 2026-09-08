const elements = {
  server: document.querySelector("#server"), sessionId: document.querySelector("#sessionId"),
  joinToken: document.querySelector("#joinToken"), consent: document.querySelector("#consent"),
  start: document.querySelector("#start"), stop: document.querySelector("#stop"),
  preview: document.querySelector("#preview"), status: document.querySelector("#statusText"),
  dot: document.querySelector("#dot"), permission: document.querySelector("#permissionBox"),
  allowControl: document.querySelector("#allowControl"), allowClipboard: document.querySelector("#allowClipboard"),
  allowFiles: document.querySelector("#allowFiles"), turnServer: document.querySelector("#turnServer"),
  turnUsername: document.querySelector("#turnUsername"), turnPassword: document.querySelector("#turnPassword"),
  forceRelay: document.querySelector("#forceRelay"), displaySource: document.querySelector("#displaySource"),
  deviceIdText: document.querySelector("#deviceIdText"), passwordText: document.querySelector("#passwordText"),
  regenerateCode: document.querySelector("#regenerateCode")
};

let socket;
let peer;
let stream;
let controlChannel;
const incomingFiles = new Map();
let fileChannel;
let binaryFile;
const pendingIceCandidates = [];

function randomDigits(length) {
  const values = new Uint32Array(1); crypto.getRandomValues(values);
  const minimum = 10 ** (length - 1); return String(minimum + (values[0] % (9 * minimum)));
}

function initializeIdentity() {
  let deviceId = localStorage.getItem("remote-device-id");
  if (!/^\d{9}$/.test(deviceId || "")) { deviceId = randomDigits(9); localStorage.setItem("remote-device-id", deviceId); }
  elements.sessionId.value = deviceId;
  elements.deviceIdText.textContent = deviceId.replace(/(\d{3})(?=\d)/g, "$1 ");
  regenerateAccessCode();
}

function regenerateAccessCode() {
  const value = randomDigits(6); elements.joinToken.value = value; elements.passwordText.textContent = value;
  formValid();
}

async function loadDisplays() {
  const displays = await window.remoteAgent.listDisplays();
  elements.displaySource.replaceChildren(...displays.map(({ id, name }) => Object.assign(document.createElement("option"), { value: id, textContent: name })));
}

function rtcConfiguration() {
  const turnUrl = elements.turnServer.value.trim();
  const iceServers = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (turnUrl) iceServers.push({ urls: [turnUrl, `${turnUrl}?transport=tcp`], username: elements.turnUsername.value, credential: elements.turnPassword.value });
  return { iceServers, iceTransportPolicy: elements.forceRelay.checked ? "relay" : "all", iceCandidatePoolSize: 10 };
}

async function addRemoteCandidate(candidate) {
  if (peer?.remoteDescription) await peer.addIceCandidate(candidate);
  else pendingIceCandidates.push(candidate);
}

async function flushRemoteCandidates() {
  while (pendingIceCandidates.length) await peer.addIceCandidate(pendingIceCandidates.shift());
}

function setStatus(text, live = false) {
  elements.status.textContent = text;
  elements.dot.classList.toggle("live", live);
}

function formValid() {
  elements.start.disabled = !(elements.consent.checked && elements.server.value && elements.sessionId.value && elements.joinToken.value);
}

for (const element of [elements.server, elements.sessionId, elements.joinToken, elements.consent]) element.addEventListener("input", formValid);

async function showPermissions() {
  const status = await window.remoteAgent.permissionStatus();
  elements.permission.textContent = window.remoteAgent.platform === "darwin"
    ? `macOS Screen Recording: ${status.screen} · Accessibility: ${status.accessibility}`
    : "Windows: พร้อมขอสิทธิ์แชร์หน้าจอเมื่อเริ่ม session";
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function acceptOffer(sdp) {
  await peer.setRemoteDescription({ type: "offer", sdp });
  await flushRemoteCandidates();
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({ type: "answer", sdp: answer.sdp });
}

async function handleControl(message) {
  if (!message || typeof message !== "object") return;
  if (message.kind === "input" && elements.allowControl.checked) await window.remoteAgent.input(message.event);
  if (message.kind === "clipboard-set" && elements.allowClipboard.checked) await window.remoteAgent.clipboardWrite(message.text);
  if (message.kind === "clipboard-get" && elements.allowClipboard.checked) {
    const text = await window.remoteAgent.clipboardRead();
    controlChannel?.send(JSON.stringify({ kind: "clipboard-value", text }));
  }
  if (message.kind === "file-start" && elements.allowFiles.checked) {
    if (message.size > 25 * 1024 * 1024) return;
    incomingFiles.set(message.id, { name: message.name, size: message.size, chunks: [] });
  }
  if (message.kind === "file-chunk" && elements.allowFiles.checked) incomingFiles.get(message.id)?.chunks.push(message.data);
  if (message.kind === "file-end" && elements.allowFiles.checked) {
    const file = incomingFiles.get(message.id); incomingFiles.delete(message.id);
    if (!file) return;
    const base64 = file.chunks.join("");
    await window.remoteAgent.saveFile({ name: file.name, base64 });
  }
}

function attachControlChannel(channel) {
  controlChannel = channel;
  channel.onopen = () => channel.send(JSON.stringify({ kind: "capabilities", platform: window.remoteAgent.platform, control: elements.allowControl.checked, clipboard: elements.allowClipboard.checked, files: elements.allowFiles.checked }));
  channel.onmessage = async ({ data }) => {
    try { await handleControl(JSON.parse(data)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`ควบคุมไม่ได้: ${message}`);
      if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "input-error", message }));
    }
  };
  channel.onclose = () => { controlChannel = undefined; };
}

function attachFileChannel(channel) {
  fileChannel = channel;
  channel.binaryType = "arraybuffer";
  channel.onmessage = async ({ data }) => {
    try {
      if (typeof data === "string") {
        const message = JSON.parse(data);
        if (message.kind === "file-start" && elements.allowFiles.checked && message.size <= 25 * 1024 * 1024) binaryFile = { name: message.name, size: message.size, received: 0, chunks: [] };
        if (message.kind === "file-end" && binaryFile && elements.allowFiles.checked) {
          if (binaryFile.received !== binaryFile.size) throw new Error("ไฟล์ได้รับไม่ครบ");
          const bytes = new Uint8Array(binaryFile.received); let offset = 0;
          for (const chunk of binaryFile.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          const current = binaryFile; binaryFile = undefined;
          await window.remoteAgent.saveFile({ name: current.name, bytes });
        }
      } else if (binaryFile && elements.allowFiles.checked) {
        const chunk = new Uint8Array(data); binaryFile.received += chunk.length;
        if (binaryFile.received > binaryFile.size) throw new Error("ขนาดไฟล์ไม่ตรง");
        binaryFile.chunks.push(chunk);
      }
    } catch (error) {
      binaryFile = undefined;
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`รับไฟล์ไม่สำเร็จ: ${message}`);
      if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "file-error", message }));
    }
  };
  channel.onclose = () => { fileChannel = undefined; binaryFile = undefined; };
}

async function start() {
  elements.start.disabled = true;
  setStatus("กำลังขอสิทธิ์แชร์หน้าจอ…");
  try {
    await window.remoteAgent.selectDisplay(elements.displaySource.value);
    await window.remoteAgent.setGrants({ control: elements.allowControl.checked, clipboard: elements.allowClipboard.checked, files: elements.allowFiles.checked });
    if (elements.allowControl.checked) {
      const diagnostics = await window.remoteAgent.diagnostics();
      if (window.remoteAgent.platform === "darwin" && diagnostics.permissions.accessibility !== "granted") throw new Error("กรุณาอนุญาต Accessibility ใน System Settings");
      setStatus(`Native control พร้อม (${diagnostics.screen.width}×${diagnostics.screen.height})`);
    }
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920, max: 2560 }, height: { ideal: 1080, max: 1440 } }, audio: false });
    elements.preview.srcObject = stream;
    elements.preview.hidden = false;
    peer = new RTCPeerConnection(rtcConfiguration());
    for (const track of stream.getTracks()) {
      if (track.kind === "video") track.contentHint = "motion";
      const sender = peer.addTrack(track, stream);
      const parameters = sender.getParameters();
      parameters.encodings ??= [{}];
      if (!parameters.encodings.length) parameters.encodings.push({});
      parameters.encodings[0].maxBitrate = 8_000_000;
      parameters.encodings[0].maxFramerate = 30;
      parameters.degradationPreference = "maintain-framerate";
      sender.setParameters(parameters).catch(console.error);
    }
    peer.onicecandidate = ({ candidate }) => { if (candidate) send({ type: "ice-candidate", candidate }); };
    peer.ondatachannel = ({ channel }) => {
      if (channel.label === "control") attachControlChannel(channel);
      if (channel.label === "file-transfer") attachFileChannel(channel);
    };
    peer.onconnectionstatechange = () => setStatus(`WebRTC: ${peer.connectionState}`, peer.connectionState === "connected");

    socket = new WebSocket(elements.server.value);
    socket.addEventListener("open", () => {
      send({ type: "hello", sessionId: elements.sessionId.value, joinToken: elements.joinToken.value, role: "agent" });
      setStatus("รอเจ้าหน้าที่เชื่อมต่อ…", true);
      window.remoteAgent.sessionActive(true);
    });
    socket.addEventListener("message", async ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "offer") await acceptOffer(message.sdp);
      if (message.type === "ice-candidate") await addRemoteCandidate(message.candidate);
      if (message.type === "end") stop("เจ้าหน้าที่สิ้นสุด session");
    });
    socket.addEventListener("close", (event) => { if (stream) stop(`การเชื่อมต่อสิ้นสุด (${event.code})`); });
    socket.addEventListener("error", () => stop("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ"));
    stream.getVideoTracks()[0].addEventListener("ended", () => stop("หยุดแชร์หน้าจอแล้ว"));
    elements.stop.hidden = false;
    elements.regenerateCode.disabled = true;
  } catch (error) {
    stop(error instanceof Error ? error.message : "ไม่สามารถแชร์หน้าจอได้");
  }
}

function stop(reason = "ตัดการเชื่อมต่อแล้ว") {
  window.remoteAgent.releaseInput();
  window.remoteAgent.sessionActive(false);
  window.remoteAgent.setGrants({ control: false, clipboard: false, files: false });
  if (socket?.readyState === WebSocket.OPEN) send({ type: "end", reason: "user-disconnected" });
  socket?.close(); socket = undefined;
  peer?.close(); peer = undefined;
  controlChannel?.close(); controlChannel = undefined; incomingFiles.clear();
  fileChannel?.close(); fileChannel = undefined; binaryFile = undefined;
  pendingIceCandidates.length = 0;
  stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
  elements.preview.srcObject = null; elements.preview.hidden = true;
  elements.stop.hidden = true; elements.start.disabled = !elements.consent.checked;
  elements.regenerateCode.disabled = false;
  setStatus(reason);
}

elements.start.addEventListener("click", start);
elements.regenerateCode.addEventListener("click", regenerateAccessCode);
elements.stop.addEventListener("click", () => stop());
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.altKey && event.shiftKey && event.key === "Escape") stop("หยุดฉุกเฉินโดยผู้ใช้");
});
initializeIdentity();
loadDisplays().catch(() => setStatus("ไม่สามารถอ่านรายการหน้าจอได้"));
showPermissions();
if (window.gsap) {
  window.gsap.from(".brand > *", { opacity: 0, x: -24, duration: .65, stagger: .08, ease: "power2.out" });
  window.gsap.from(".panel > *", { opacity: 0, y: 16, duration: .5, stagger: .035, ease: "power2.out" });
}

