const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("remoteAgent", {
  platform: process.platform,
  listDisplays: () => ipcRenderer.invoke("desktop:list"),
  selectDisplay: (id) => ipcRenderer.invoke("desktop:select", id),
  permissionStatus: () => ipcRenderer.invoke("permissions:status"),
  requestAccessibility: () => ipcRenderer.invoke("permissions:accessibility"),
  setGrants: (grants) => ipcRenderer.invoke("remote:set-grants", grants),
  diagnostics: () => ipcRenderer.invoke("remote:diagnostics"),
  releaseInput: () => ipcRenderer.invoke("remote:release-input"),
  sessionActive: (active) => ipcRenderer.invoke("remote:session-active", active),
  input: (event) => ipcRenderer.invoke("remote:input", event),
  inputRealtime: (event) => ipcRenderer.send("remote:input-realtime", event),
  clipboardRead: () => ipcRenderer.invoke("remote:clipboard-read"),
  clipboardWrite: (text) => ipcRenderer.invoke("remote:clipboard-write", text),
  saveFile: (file) => ipcRenderer.invoke("remote:save-file", file)
});
