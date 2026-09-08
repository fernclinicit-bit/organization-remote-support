const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("remoteController", {
  platform: process.platform,
  appVersion: "0.4.2"
});

