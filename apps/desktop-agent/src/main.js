import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, powerSaveBlocker, screen, session, systemPreferences } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
let sessionGrants = Object.freeze({ control: false, clipboard: false, files: false });
let nativeInputPromise;
let windowsInputHost;
let suspensionBlocker;
let selectedDisplayId;
let selectedDisplayBounds;

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

function inputHostPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "native", "RemoteInputHost.exe") : path.join(directory, "..", "native", "RemoteInputHost.exe");
}

function getWindowsInputHost() {
  if (windowsInputHost && !windowsInputHost.killed) return windowsInputHost;
  const executable = inputHostPath();
  if (!existsSync(executable)) throw new Error("RemoteInputHost.exe missing");
  windowsInputHost = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  windowsInputHost.on("exit", () => { windowsInputHost = undefined; });
  return windowsInputHost;
}

function writeWindowsInput(command) {
  const host = getWindowsInputHost();
  if (!host.stdin.writable) throw new Error("RemoteInputHost is not writable");
  host.stdin.write(`${command}\n`);
}

function getNativeInput() {
  nativeInputPromise ??= import("robotjs").then((module) => module.default ?? module);
  return nativeInputPromise;
}

function permissionState() {
  if (process.platform !== "darwin") return { screen: "granted", accessibility: "not-required" };
  return {
    screen: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied"
  };
}

function rememberSelectedDisplay(source, sources) {
  if (!source) return;
  selectedDisplayId = source.id;
  const displays = screen.getAllDisplays();
  const sourceIndex = sources.indexOf(source);
  const display = displays.find((candidate) => String(candidate.id) === String(source.display_id)) ?? displays[sourceIndex] ?? screen.getPrimaryDisplay();
  selectedDisplayBounds = { ...display.bounds };
}

function virtualDesktopPoint(input) {
  const displays = screen.getAllDisplays();
  const selected = selectedDisplayBounds ?? screen.getPrimaryDisplay().bounds;
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  const localX = Math.max(0, Math.min(1, Number(input.x)));
  const localY = Math.max(0, Math.min(1, Number(input.y)));
  const absoluteX = selected.x + localX * Math.max(1, selected.width - 1);
  const absoluteY = selected.y + localY * Math.max(1, selected.height - 1);
  return {
    x: Math.max(0, Math.min(1, (absoluteX - left) / Math.max(1, right - left - 1))),
    y: Math.max(0, Math.min(1, (absoluteY - top) / Math.max(1, bottom - top - 1)))
  };
}

function isElevated() {
  if (process.platform !== "win32") return false;
  try {
    const groups = execFileSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    return /S-1-16-(12288|16384)/.test(groups);
  } catch { return false; }
}

async function writeAudit(event, details = {}) {
  try {
    const directory = path.join(app.getPath("userData"), "audit");
    await mkdir(directory, { recursive: true });
    const record = JSON.stringify({ timestamp: new Date().toISOString(), event, ...details });
    await appendFile(path.join(directory, "admin-mode.jsonl"), `${record}\n`, "utf8");
  } catch (error) { console.warn("เขียน audit log ไม่ได้", error); }
}

async function confirmAndLaunchInstaller(owner, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (process.platform !== "win32" || ![".exe", ".msi"].includes(extension)) return { offered: false };
  await writeAudit("installer-received", { name: path.basename(filePath), elevated: isElevated() });
  if (!isElevated()) return { offered: false, requiresAdminMode: true };
  const previousGrants = sessionGrants;
  sessionGrants = Object.freeze({ ...previousGrants, control: false });
  try {
    writeWindowsInput("RELEASE");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await dialog.showMessageBox(owner, {
      type: "warning", title: "ยืนยันการติดตั้งบนเครื่องนี้",
      message: `อนุญาตให้เปิด ${path.basename(filePath)} ด้วยสิทธิ์ผู้ดูแลหรือไม่`,
      detail: "Remote input ถูกปิดชั่วคราว กรุณาให้ผู้ใช้ที่อยู่หน้าเครื่องเป็นผู้ยืนยันเท่านั้น UAC จะไม่ถูกปิดหรือแก้ไข",
      buttons: ["ยกเลิก", "เปิดตัวติดตั้ง"], defaultId: 0, cancelId: 0, noLink: true
    });
    if (result.response !== 1) {
      await writeAudit("installer-rejected", { name: path.basename(filePath) });
      return { offered: true, launched: false };
    }
    const child = extension === ".msi"
      ? spawn("msiexec.exe", ["/i", filePath], { detached: true, stdio: "ignore", windowsHide: false })
      : spawn(filePath, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    await writeAudit("installer-launched", { name: path.basename(filePath) });
    return { offered: true, launched: true };
  } finally { sessionGrants = previousGrants; }
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 820,
    minHeight: 600,
    title: "Organization Remote Support",
    icon: path.join(directory, "app-icon.png"),
    backgroundColor: "#07152f",
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    const selected = sources.find((source) => source.id === selectedDisplayId) ?? sources[0];
    rememberSelectedDisplay(selected, sources);
    callback({ video: selected, audio: false });
  });

  await window.loadFile(path.join(directory, "index.html"));
}

ipcMain.handle("permissions:status", permissionState);
ipcMain.handle("desktop:list", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  return sources.map((source, index) => ({ id: source.id, name: source.name || `Display ${index + 1}` }));
});
ipcMain.handle("desktop:select", async (_event, id) => {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  const selected = sources.find((source) => source.id === String(id || "")) ?? sources[0];
  rememberSelectedDisplay(selected, sources);
  return { id: selected?.id, bounds: selectedDisplayBounds };
});
ipcMain.handle("permissions:accessibility", () => {
  if (process.platform !== "darwin") return true;
  return systemPreferences.isTrustedAccessibilityClient(true);
});
ipcMain.handle("remote:set-grants", (_event, grants) => {
  sessionGrants = Object.freeze({ control: grants?.control === true, clipboard: grants?.clipboard === true, files: grants?.files === true });
  return sessionGrants;
});
ipcMain.handle("remote:diagnostics", async () => {
  if (process.platform === "win32") {
    writeWindowsInput("PING");
    return { platform: process.platform, screen: { width: "Win32", height: "ready" }, permissions: permissionState(), adminMode: isElevated() };
  }
  const nativeInput = await getNativeInput();
  return { platform: process.platform, screen: nativeInput.getScreenSize(), permissions: permissionState() };
});
ipcMain.handle("remote:release-input", () => {
  if (process.platform === "win32") writeWindowsInput("RELEASE");
  return true;
});
ipcMain.handle("remote:session-active", (_event, active) => {
  if (active && suspensionBlocker === undefined) suspensionBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!active && suspensionBlocker !== undefined) { powerSaveBlocker.stop(suspensionBlocker); suspensionBlocker = undefined; }
  return true;
});

const keyMap = {
  Escape: "escape", Backspace: "backspace", Tab: "tab", Return: "enter", Enter: "enter", Delete: "delete",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", Space: "space", Left: "left",
  Right: "right", Up: "up", Down: "down", LeftShift: "shift", LeftControl: "control", LeftAlt: "alt",
  LeftMeta: "command", CapsLock: "capslock", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  Semicolon: ";", Quote: "'", LeftBracket: "[", RightBracket: "]", Minus: "-", Equal: "=", Grave: "`"
};
for (let index = 1; index <= 24; index += 1) keyMap[`F${index}`] = `f${index}`;
for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") keyMap[letter] = letter.toLowerCase();
for (let index = 0; index <= 9; index += 1) keyMap[`Num${index}`] = String(index);

ipcMain.handle("remote:input", async (_event, input) => {
  if (!sessionGrants.control) throw new Error("remote control not granted");
  if (process.platform === "win32") {
    if (input?.type === "move") { const point = virtualDesktopPoint(input); writeWindowsInput(`MOVE ${point.x} ${point.y}`); }
    else if (input?.type === "button") writeWindowsInput(`BUTTON ${input.button===2?"right":input.button===1?"middle":"left"} ${input.down?"down":"up"}`);
    else if (input?.type === "wheel") writeWindowsInput(`WHEEL ${Math.round(-Number(input.delta)*2)}`);
    else if (input?.type === "key") writeWindowsInput(`KEY ${String(input.key)} ${input.down?"down":"up"}`);
    else if (input?.type === "text") writeWindowsInput(`TEXT ${Buffer.from(String(input.text??"").slice(0,2048),"utf8").toString("base64")}`);
    return true;
  }
  const nativeInput = await getNativeInput();
  nativeInput.setMouseDelay(0);
  nativeInput.setKeyboardDelay(0);
  if (input?.type === "move") {
    const size = nativeInput.getScreenSize();
    const x = Math.round(Math.max(0, Math.min(1, Number(input.x))) * (size.width - 1));
    const y = Math.round(Math.max(0, Math.min(1, Number(input.y))) * (size.height - 1));
    nativeInput.moveMouse(x, y);
  } else if (input?.type === "button") {
    const button = input.button === 2 ? "right" : input.button === 1 ? "middle" : "left";
    nativeInput.mouseToggle(input.down ? "down" : "up", button);
  } else if (input?.type === "wheel") {
    const amount = Math.min(20, Math.max(1, Math.round(Math.abs(Number(input.delta)) / 50)));
    nativeInput.scrollMouse(0, Number(input.delta) > 0 ? -amount : amount);
  } else if (input?.type === "key") {
    const name = String(input.key);
    if (!keyMap[name]) throw new Error("unsupported key");
    nativeInput.keyToggle(keyMap[name], input.down ? "down" : "up");
  } else if (input?.type === "text") {
    const value = String(input.text ?? "").slice(0, 2048);
    if (value) nativeInput.typeString(value);
  }
  return true;
});

ipcMain.handle("remote:clipboard-read", async () => {
  if (!sessionGrants.clipboard) throw new Error("clipboard access not granted");
  return (await clipboard.readText()).slice(0, 1_000_000);
});
ipcMain.handle("remote:clipboard-write", async (_event, text) => {
  if (!sessionGrants.clipboard) throw new Error("clipboard access not granted");
  await clipboard.writeText(String(text).slice(0, 1_000_000));
  return true;
});
ipcMain.handle("remote:save-file", async (event, file) => {
  if (!sessionGrants.files) throw new Error("file transfer not granted");
  const name = path.basename(String(file?.name ?? "received-file.bin"));
  const bytes = file?.bytes ? Buffer.from(file.bytes) : Buffer.from(String(file?.base64 ?? ""), "base64");
  if (bytes.length > 25 * 1024 * 1024) throw new Error("file exceeds 25 MB limit");
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (owner?.isMinimized()) owner.restore();
  owner?.show();
  const options = { title: "บันทึกไฟล์จากเจ้าหน้าที่ IT", defaultPath: name };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  await writeFile(result.filePath, bytes);
  const installer = await confirmAndLaunchInstaller(owner, result.filePath);
  return { saved: true, path: result.filePath, installer };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
