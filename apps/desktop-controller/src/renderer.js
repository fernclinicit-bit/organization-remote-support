const elements = {
  server: document.querySelector("#server"), sessionId: document.querySelector("#sessionId"),
  joinToken: document.querySelector("#joinToken"), connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"), video: document.querySelector("#remoteScreen"),
  placeholder: document.querySelector("#placeholder"), status: document.querySelector("#status"),
  dot: document.querySelector("#dot"), log: document.querySelector("#log"),
  tools: document.querySelector(".tools"), sendClipboard: document.querySelector("#sendClipboard"),
  getClipboard: document.querySelector("#getClipboard"), file: document.querySelector("#file"),
  capabilities: document.querySelector("#capabilities"), fullscreen: document.querySelector("#fullscreen"),
  viewer: document.querySelector(".viewer"), modeBadge: document.querySelector("#modeBadge"),
  showDesktop: document.querySelector("#showDesktop"), turnServer: document.querySelector("#turnServer"),
  turnUsername: document.querySelector("#turnUsername"), turnPassword: document.querySelector("#turnPassword"),
  forceRelay: document.querySelector("#forceRelay"), deviceName: document.querySelector("#deviceName"),
  saveDevice: document.querySelector("#saveDevice"), savedDevices: document.querySelector("#savedDevices"),
  autoReconnect: document.querySelector("#autoReconnect")
};

let socket;
let peer;
let offerCreated = false;
let controlChannel;
let inputChannel;
let fileChannel;
let capabilities = { control: false, clipboard: false, files: false, platform: "unknown" };
let keyboardCapture = false;
const pendingIceCandidates = [];
let statsTimer;
let reconnectTimer;
let reconnectAttempts = 0;

function normalizedDeviceId() { return elements.sessionId.value.replace(/\D/g, "").slice(0, 9); }

function loadAddressBook() {
  const devices = JSON.parse(localStorage.getItem("remote-address-book") || "[]");
  elements.savedDevices.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: "— เลือกเครื่อง —" }), ...devices.map((device) => Object.assign(document.createElement("option"), { value: device.id, textContent: `${device.name} · ${device.id.replace(/(\d{3})(?=\d)/g, "$1 ")}` })));
}

function saveCurrentDevice() {
  const id = normalizedDeviceId(); const name = elements.deviceName.value.trim();
  if (!/^\d{9}$/.test(id) || !name) { log("กรอกรหัสเครื่อง 9 หลักและชื่อเครื่องก่อนบันทึก"); return; }
  const devices = JSON.parse(localStorage.getItem("remote-address-book") || "[]").filter((device) => device.id !== id);
  devices.unshift({ id, name }); localStorage.setItem("remote-address-book", JSON.stringify(devices.slice(0, 50))); loadAddressBook(); log(`บันทึก ${name} แล้ว`);
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

async function reportConnectionStats() {
  if (!peer || peer.connectionState !== "connected") return;
  const reports = await peer.getStats();
  let pair;
  reports.forEach((report) => { if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) pair = report; });
  if (!pair) return;
  const remote = reports.get(pair.remoteCandidateId);
  const route = remote?.candidateType === "relay" ? "TURN relay" : remote?.candidateType === "srflx" ? "Internet P2P" : "เครือข่ายตรง";
  setStatus(`เชื่อมต่อแล้ว · ${route}`, true);
}

function log(text) {
  const time = new Date().toLocaleTimeString();
  elements.log.textContent = `[${time}] ${text}\n${elements.log.textContent}`.slice(0, 1800);
}

function setStatus(text, live = false) {
  elements.status.textContent = text;
  elements.dot.classList.toggle("live", live);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendControl(message) {
  if (controlChannel?.readyState === "open") controlChannel.send(JSON.stringify(message));
}

async function sendControlQueued(message) {
  while (controlChannel?.readyState === "open" && controlChannel.bufferedAmount > 512_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  sendControl(message);
}

function sendRealtimeInput(event) {
  if (inputChannel?.readyState === "open" && inputChannel.bufferedAmount < 64_000) inputChannel.send(JSON.stringify({ kind: "input", event }));
}

function updateCapabilities(value) {
  capabilities = value;
  elements.capabilities.textContent = `สิทธิ์: ควบคุม ${value.control ? "✓" : "–"} · คลิปบอร์ด ${value.clipboard ? "✓" : "–"} · ไฟล์ ${value.files ? "✓" : "–"}`;
  elements.video.classList.toggle("control", value.control);
  elements.modeBadge.textContent = value.control ? "CONTROL ENABLED" : "VIEW ONLY";
  elements.modeBadge.classList.toggle("control", value.control);
  elements.sendClipboard.disabled = !value.clipboard;
  elements.getClipboard.disabled = !value.clipboard;
  elements.file.disabled = !value.files;
}

function attachControlChannel(channel) {
  controlChannel = channel;
  channel.onopen = () => { elements.tools.hidden = false; log("ช่องควบคุมพร้อมใช้งาน"); };
  channel.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.kind === "capabilities") updateCapabilities(message);
    if (message.kind === "clipboard-value") { await navigator.clipboard.writeText(message.text); log("คัดลอกข้อความจาก Agent แล้ว"); }
    if (message.kind === "input-error") { setStatus(`Agent ปฏิเสธ input: ${message.message}`); log(`INPUT ERROR: ${message.message}`); }
  };
}

function attachInputChannel(channel) {
  inputChannel = channel;
  channel.onopen = () => log("ช่องเมาส์ความหน่วงต่ำพร้อมใช้งาน");
  channel.onclose = () => { inputChannel = undefined; };
}

function attachFileChannel(channel) {
  fileChannel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 256_000;
  channel.onopen = () => log("ช่องส่งไฟล์พร้อมใช้งาน");
  channel.onmessage = ({ data }) => {
    if (typeof data !== "string") return;
    const message = JSON.parse(data);
    if (message.kind === "file-error") log(`FILE ERROR: ${message.message}`);
  };
  channel.onclose = () => { fileChannel = undefined; };
}

async function createOffer() {
  if (offerCreated || !peer) return;
  offerCreated = true;
  const offer = await peer.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
  await peer.setLocalDescription(offer);
  send({ type: "offer", sdp: offer.sdp });
  log("ส่ง WebRTC offer แล้ว");
}

function connect() {
  clearTimeout(reconnectTimer);
  const deviceId = normalizedDeviceId(); const password = elements.joinToken.value.replace(/\D/g, "").slice(0, 6);
  if (!elements.server.value || !/^\d{9}$/.test(deviceId) || !/^\d{6}$/.test(password)) {
    setStatus("กรอกรหัสเครื่อง 9 หลักและรหัสผ่าน 6 หลัก"); return;
  }
  elements.connect.disabled = true;
  setStatus("กำลังเชื่อมต่อ signaling…");
  peer = new RTCPeerConnection(rtcConfiguration());
  const videoTransceiver = peer.addTransceiver("video", { direction: "recvonly" });
  const codecs = RTCRtpReceiver.getCapabilities?.("video")?.codecs?.filter((codec) => /VP8|H264/i.test(codec.mimeType));
  if (codecs?.length) videoTransceiver.setCodecPreferences(codecs);
  attachControlChannel(peer.createDataChannel("control", { ordered: true }));
  attachInputChannel(peer.createDataChannel("input", { ordered: false, maxRetransmits: 0 }));
  attachFileChannel(peer.createDataChannel("file-transfer", { ordered: true }));
  peer.onicecandidate = ({ candidate }) => { if (candidate) send({ type: "ice-candidate", candidate }); };
  peer.ontrack = ({ streams }) => {
    elements.video.srcObject = streams[0];
    elements.video.play().catch(() => log("กดภายในหน้าจอเพื่อเริ่มแสดงภาพ"));
    elements.placeholder.hidden = true;
    setStatus("กำลังรับภาพหน้าจอ", true);
    log("ได้รับ video stream");
  };
  peer.onconnectionstatechange = () => {
    log(`WebRTC ${peer.connectionState}`);
    if (peer.connectionState === "connected") { clearInterval(statsTimer); statsTimer = setInterval(reportConnectionStats, 3000); reportConnectionStats(); }
    if (["failed", "closed", "disconnected"].includes(peer.connectionState)) setStatus(`WebRTC: ${peer.connectionState}`);
  };

  socket = new WebSocket(elements.server.value);
  socket.addEventListener("open", () => {
    send({ type: "hello", sessionId: deviceId, joinToken: password, role: "controller" });
    reconnectAttempts = 0;
    setStatus("รอ Agent ยืนยัน…", true);
    elements.disconnect.hidden = false;
    log("เชื่อมต่อ signaling แล้ว");
  });
  socket.addEventListener("message", async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "peer-ready") await createOffer();
    if (message.type === "answer") { await peer.setRemoteDescription({ type: "answer", sdp: message.sdp }); await flushRemoteCandidates(); log("รับ WebRTC answer แล้ว"); }
    if (message.type === "ice-candidate") await addRemoteCandidate(message.candidate);
    if (message.type === "end") disconnect("Agent สิ้นสุด session");
  });
  socket.addEventListener("error", () => { if (peer) disconnect("เชื่อมต่อ signaling ไม่สำเร็จ", true); });
  socket.addEventListener("close", (event) => { if (peer) disconnect(`การเชื่อมต่อสิ้นสุด (${event.code})`, true); });
}

function disconnect(reason = "ตัดการเชื่อมต่อแล้ว", retry = false) {
  keyboardCapture = false;
  clearInterval(statsTimer); statsTimer = undefined; pendingIceCandidates.length = 0;
  if (socket?.readyState === WebSocket.OPEN) send({ type: "end", reason: "controller-disconnected" });
  socket?.close(); socket = undefined;
  peer?.close(); peer = undefined; offerCreated = false;
  controlChannel?.close(); controlChannel = undefined;
  inputChannel?.close(); inputChannel = undefined;
  fileChannel?.close(); fileChannel = undefined;
  elements.video.srcObject = null; elements.placeholder.hidden = false;
  elements.disconnect.hidden = true; elements.tools.hidden = true; elements.connect.disabled = false;
  updateCapabilities({ control: false, clipboard: false, files: false, platform: "unknown" });
  setStatus(reason); log(reason);
  if (retry && elements.autoReconnect.checked) {
    reconnectAttempts += 1; const delay = Math.min(15_000, 1000 * (2 ** Math.min(reconnectAttempts, 4)));
    setStatus(`สัญญาณหลุด · ลองใหม่ใน ${Math.ceil(delay / 1000)} วินาที`);
    reconnectTimer = setTimeout(connect, delay);
  }
}

elements.connect.addEventListener("click", connect);
elements.disconnect.addEventListener("click", () => disconnect());
elements.saveDevice.addEventListener("click", saveCurrentDevice);
elements.savedDevices.addEventListener("change", () => {
  if (!elements.savedDevices.value) return;
  elements.sessionId.value = elements.savedDevices.value.replace(/(\d{3})(?=\d)/g, "$1 ");
});
elements.sessionId.addEventListener("input", () => {
  const id = normalizedDeviceId(); elements.sessionId.value = id.replace(/(\d{3})(?=\d)/g, "$1 ");
});
elements.video.tabIndex = 0;
let pendingMove;
let moveTimer;
let inputSequence = 0;
function sequencedInput(event) { return { ...event, seq: ++inputSequence }; }
function screenPosition(event) {
  const rect = elements.video.getBoundingClientRect();
  const sourceRatio = (elements.video.videoWidth || rect.width) / (elements.video.videoHeight || rect.height);
  const boxRatio = rect.width / rect.height;
  let left = rect.left, top = rect.top, width = rect.width, height = rect.height;
  if (boxRatio > sourceRatio) { width = height * sourceRatio; left += (rect.width - width) / 2; }
  else { height = width / sourceRatio; top += (rect.height - height) / 2; }
  if (event.clientX < left || event.clientX > left + width || event.clientY < top || event.clientY > top + height) return null;
  return { x: (event.clientX - left) / width, y: (event.clientY - top) / height };
}
elements.video.addEventListener("pointermove", (event) => {
  if (!capabilities.control) return;
  const position = screenPosition(event); if (!position) return;
  pendingMove = sequencedInput({ type: "move", ...position });
  if (!moveTimer) moveTimer = setTimeout(() => { sendRealtimeInput(pendingMove); moveTimer = undefined; }, 20);
});
function sendPointerButton(event, down) {
  if (!capabilities.control) return;
  const position = screenPosition(event);
  if (position) sendControl({ kind: "input", event: sequencedInput({ type: "move", ...position }) });
  sendControl({ kind: "input", event: { type: "button", button: event.button, down } });
}
elements.video.addEventListener("pointerdown", (event) => {
  elements.video.focus();
  keyboardCapture = capabilities.control;
  if (keyboardCapture) { elements.modeBadge.textContent = "CONTROL ENABLED • KEYBOARD"; log("จับคีย์บอร์ดแล้ว"); }
  elements.video.setPointerCapture(event.pointerId);
  sendPointerButton(event, true);
});
elements.video.addEventListener("pointerup", (event) => {
  if (elements.video.hasPointerCapture(event.pointerId)) elements.video.releasePointerCapture(event.pointerId);
  sendPointerButton(event, false);
});
elements.video.addEventListener("contextmenu", (event) => event.preventDefault());
elements.video.addEventListener("wheel", (event) => { if (capabilities.control) { event.preventDefault(); sendControl({ kind: "input", event: { type: "wheel", delta: event.deltaY } }); } }, { passive: false });

const codeMap = { Space: "Space", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", ShiftLeft: "LeftShift", ShiftRight: "RightShift", ControlLeft: "LeftControl", ControlRight: "RightControl", AltLeft: "LeftAlt", AltRight: "RightAlt", MetaLeft: "LeftMeta", MetaRight: "RightMeta", Escape: "Escape", Backspace: "Backspace", Tab: "Tab", Enter: "Enter", Delete: "Delete", Insert: "Insert", PrintScreen: "PrintScreen", Pause: "Pause", ContextMenu: "ContextMenu", NumLock: "NumLock", ScrollLock: "ScrollLock", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", CapsLock: "CapsLock", Comma: "Comma", Period: "Period", Slash: "Slash", Backslash: "Backslash", Semicolon: "Semicolon", Quote: "Quote", BracketLeft: "LeftBracket", BracketRight: "RightBracket", Minus: "Minus", Equal: "Equal", Backquote: "Grave" };
function remoteKey(event) {
  if (event.code.startsWith("Key")) return event.code.slice(3);
  if (event.code.startsWith("Digit")) return `Num${event.code.slice(5)}`;
  if (/^Numpad[0-9]$/.test(event.code)) return event.code;
  if (["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter"].includes(event.code)) return event.code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  return codeMap[event.code];
}
window.addEventListener("keydown", (event) => {
  if (!capabilities.control || !keyboardCapture) return;
  event.preventDefault();
  const key = remoteKey(event); if (!key) return;
  sendControl({ kind: "input", event: { type: "key", key, down: true } });
}, true);
window.addEventListener("keyup", (event) => {
  if (!capabilities.control || !keyboardCapture) return;
  event.preventDefault();
  const key = remoteKey(event); if (!key) return;
  sendControl({ kind: "input", event: { type: "key", key, down: false } });
}, true);
window.addEventListener("blur", () => {
  for (const key of ["LeftShift", "LeftControl", "LeftAlt", "LeftMeta"]) sendControl({ kind: "input", event: { type: "key", key, down: false } });
});
document.querySelector("aside").addEventListener("pointerdown", () => {
  keyboardCapture = false;
  if (capabilities.control) elements.modeBadge.textContent = "CONTROL ENABLED";
});
elements.fullscreen.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen(); else await elements.viewer.requestFullscreen();
});
async function keyCombo(keys) {
  for (const key of keys) sendControl({ kind: "input", event: { type: "key", key, down: true } });
  for (const key of [...keys].reverse()) sendControl({ kind: "input", event: { type: "key", key, down: false } });
}
for (const button of document.querySelectorAll("[data-shortcut]")) {
  button.addEventListener("click", () => {
    if (capabilities.control) keyCombo(button.dataset.shortcut.split(","));
  });
}
elements.showDesktop.addEventListener("click", () => {
  if (!capabilities.control) return;
  if (capabilities.platform === "win32") keyCombo(["LeftMeta", "D"]);
  else keyCombo(["LeftMeta", "F3"]);
});
elements.sendClipboard.addEventListener("click", async () => sendControl({ kind: "clipboard-set", text: await navigator.clipboard.readText() }));
elements.getClipboard.addEventListener("click", () => sendControl({ kind: "clipboard-get" }));
async function sendFile(file) {
  if (!file || file.size > 25 * 1024 * 1024 || !capabilities.files) { log("ไฟล์ไม่ถูกต้อง ไม่มีสิทธิ์ หรือเกิน 25 MB"); return; }
  if (fileChannel?.readyState !== "open") { log("ช่องส่งไฟล์ยังไม่พร้อม"); return; }
  const id = crypto.randomUUID();
  const bytes = await file.arrayBuffer();
  fileChannel.send(JSON.stringify({ kind: "file-start", id, name: file.name, size: file.size }));
  log(`กำลังส่ง ${file.name} (${Math.ceil(file.size / 1024)} KB)`);
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    while (fileChannel.readyState === "open" && fileChannel.bufferedAmount > 512_000) await new Promise((resolve) => setTimeout(resolve, 20));
    if (fileChannel.readyState !== "open") throw new Error("ช่องส่งไฟล์ถูกตัด");
    fileChannel.send(bytes.slice(offset, Math.min(offset + 64 * 1024, bytes.byteLength)));
  }
  fileChannel.send(JSON.stringify({ kind: "file-end", id })); log(`ส่งไฟล์ ${file.name} ครบแล้ว รอ Agent กด Save As`);
}
elements.file.addEventListener("change", async () => { await sendFile(elements.file.files[0]); elements.file.value = ""; });
elements.viewer.addEventListener("dragenter", (event) => { event.preventDefault(); log("ตรวจพบไฟล์ที่ลากเข้ามา"); if (capabilities.files) elements.viewer.classList.add("dragging"); });
elements.viewer.addEventListener("dragover", (event) => { event.preventDefault(); });
elements.viewer.addEventListener("dragleave", (event) => { if (!elements.viewer.contains(event.relatedTarget)) elements.viewer.classList.remove("dragging"); });
elements.viewer.addEventListener("drop", async (event) => {
  event.preventDefault(); elements.viewer.classList.remove("dragging");
  for (const file of event.dataTransfer.files) await sendFile(file);
});
if (window.gsap) {
  window.gsap.from("header", { opacity: 0, y: -18, duration: .45, ease: "power2.out" });
  window.gsap.from("aside > *", { opacity: 0, x: -18, duration: .5, stagger: .035, ease: "power2.out" });
  window.gsap.from(".viewer", { opacity: 0, scale: .985, duration: .7, ease: "power2.out" });
}
loadAddressBook();
