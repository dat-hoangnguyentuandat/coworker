const { contextBridge, ipcRenderer } = require("electron");

// Minimal bridge for the hidden auto-login window. The injected agent script
// calls report() so the main process can track email/password/otp progress.
contextBridge.exposeInMainWorld("coworkerAutoLogin", {
  report: payload => ipcRenderer.send("autologin:agent-report", payload)
});
