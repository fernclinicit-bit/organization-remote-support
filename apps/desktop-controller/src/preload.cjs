const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("remoteController", {
  platform: process.platform,
  appVersion: "0.4.9",
  clipboardRead: () => ipcRenderer.invoke("clipboard:read"),
  clipboardWrite: (text) => ipcRenderer.invoke("clipboard:write", text)
});
