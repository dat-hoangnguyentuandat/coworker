const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coworker", {
  chooseWorkspace: () => ipcRenderer.invoke("workspace:select"),
  startMcp: () => ipcRenderer.invoke("mcp:start"),
  stopMcp: () => ipcRenderer.invoke("mcp:stop"),
  getPreferences: () => ipcRenderer.invoke("preferences:get"),
  setAutoStartMcp: enabled => ipcRenderer.invoke("preferences:set-auto-start-mcp", enabled),
  getUpstreamConfig: () => ipcRenderer.invoke("upstream:get-config"),
  saveUpstreamConfig: servers => ipcRenderer.invoke("upstream:save-config", servers),
  getUpstreamStatus: () => ipcRenderer.invoke("upstream:status"),
  getTunnelConfig: () => ipcRenderer.invoke("tunnel:get-config"),
  saveTunnelConfig: config => ipcRenderer.invoke("tunnel:save-config", config),
  removeTunnel: tunnelId => ipcRenderer.invoke("tunnel:remove", tunnelId),
  getTunnelStatus: () => ipcRenderer.invoke("tunnel:status"),
  chooseTunnelBinary: () => ipcRenderer.invoke("tunnel:select-binary"),
  toggleChat: () => ipcRenderer.invoke("chat:toggle"),
  closeChat: () => ipcRenderer.invoke("chat:close"),
  layoutChat: dimensions => ipcRenderer.invoke("chat:layout", dimensions),
  notifyApproval: (summary, language) => ipcRenderer.invoke("chat:notify-approval", { summary, language }),
  showTourNative: data => ipcRenderer.invoke("tour:show", data),
  hideTourNative: () => ipcRenderer.invoke("tour:hide"),
  tourAction: action => ipcRenderer.invoke("tour:action", action),
  showProfileDialog: data => ipcRenderer.invoke("profile-dialog:show", data),
  profileDialogAction: result => ipcRenderer.invoke("profile-dialog:action", result),
  openExternal: url => ipcRenderer.invoke("open-external", url),
  getProfiles: () => ipcRenderer.invoke("profiles:get"),
  createProfile: label => ipcRenderer.invoke("profiles:create", label),
  renameProfile: (id, label) => ipcRenderer.invoke("profiles:rename", { id, label }),
  setProfileStatus: (id, status) => ipcRenderer.invoke("profiles:status", { id, status }),
  switchProfile: id => ipcRenderer.invoke("profiles:switch", id),
  forgetProfile: id => ipcRenderer.invoke("profiles:forget", id),
  openAutoLogin: (theme, language) => ipcRenderer.invoke("autologin:open", { theme, language }),
  setUiLanguage: language => ipcRenderer.invoke("ui:set-language", language),
  onProfilesState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("profiles:state", listener);
    return () => ipcRenderer.removeListener("profiles:state", listener);
  },
  onTourAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("tour:action", listener);
    return () => ipcRenderer.removeListener("tour:action", listener);
  },
  onNativeTourState: callback => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on("tour:native-state", listener);
    return () => ipcRenderer.removeListener("tour:native-state", listener);
  },
  onChatState: callback => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on("chat:state", listener);
    return () => ipcRenderer.removeListener("chat:state", listener);
  },
  getState: () => ipcRenderer.invoke("app:state"),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("app:state", listener);
    return () => ipcRenderer.removeListener("app:state", listener);
  },
  getWorkbenchState: () => ipcRenderer.invoke("workbench:get-state"),
  getTaskHistory: taskId => ipcRenderer.invoke("workbench:get-history", taskId),
  callWorkbenchTool: (taskId, toolName, args = {}) => ipcRenderer.invoke("workbench:call-tool", { taskId, toolName, args }),
  createTask: (workspaceId, title) => ipcRenderer.invoke("workbench:create-task", { workspaceId, title }),
  renameTask: (taskId, title) => ipcRenderer.invoke("workbench:rename-task", { taskId, title }),
  deleteTask: taskId => ipcRenderer.invoke("workbench:delete-task", taskId),
  createHandoff: (taskId, profileId) => ipcRenderer.invoke("handoff:create", { taskId, profileId }),
  latestHandoff: taskId => ipcRenderer.invoke("handoff:latest", taskId),
  selectWorkspace: workspaceId => ipcRenderer.invoke("workbench:select-workspace", workspaceId),
  renameWorkspace: (workspaceId, name) => ipcRenderer.invoke("workbench:rename-workspace", { workspaceId, name }),
  removeWorkspace: workspaceId => ipcRenderer.invoke("workbench:remove-workspace", workspaceId),
  selectTask: taskId => ipcRenderer.invoke("workbench:select-task", taskId),
  setTaskPermission: (taskId, mode) => ipcRenderer.invoke("workbench:set-permission", { taskId, mode }),
  decideApproval: (approvalId, approved) => ipcRenderer.invoke("approval:decide", { approvalId, approved }),
  onWorkbenchState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("workbench:state", listener);
    return () => ipcRenderer.removeListener("workbench:state", listener);
  },
  onApprovalRequired: callback => {
    const listener = (_event, approval) => callback(approval);
    ipcRenderer.on("approval:required", listener);
    return () => ipcRenderer.removeListener("approval:required", listener);
  },
  onTunnelState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("tunnel:state", listener);
    return () => ipcRenderer.removeListener("tunnel:state", listener);
  }
});
