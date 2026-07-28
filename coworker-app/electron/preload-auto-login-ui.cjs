const { contextBridge, ipcRenderer } = require("electron");

// Bridge for the auto-login manager dialog. Read-only data + explicit actions;
// credentials never pass through this surface.
contextBridge.exposeInMainWorld("coworkerAutoLoginUi", {
  getState: () => ipcRenderer.invoke("autologin:get-state"),
  saveAccounts: rawText => ipcRenderer.invoke("autologin:save-accounts", rawText),
  removeAccount: id => ipcRenderer.invoke("autologin:remove-account", id),
  bindProfile: (id, profileId) => ipcRenderer.invoke("autologin:bind-profile", { id, profileId }),
  run: items => ipcRenderer.invoke("autologin:run", items),
  runGoogle: payload => ipcRenderer.invoke("autologin:run-google", payload),
  stopRun: () => ipcRenderer.invoke("autologin:stop"),
  close: () => window.close(),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("autologin:state", listener);
    return () => ipcRenderer.removeListener("autologin:state", listener);
  }
});

contextBridge.exposeInMainWorld("coworkerThemeSeed", {
  getTheme: () => ipcRenderer.invoke("autologin:get-theme"),
  getLanguage: () => ipcRenderer.invoke("autologin:get-language")
});
