import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;
const PERMISSION_MODES = new Set(["ask", "auto", "full"]);

function workspaceId(root) {
  return `ws_${crypto.createHash("sha256").update(root).digest("hex").slice(0, 20)}`;
}

function safeTaskId() {
  return `task_${crypto.randomBytes(8).toString("hex")}`;
}

function sessionKey(extra) {
  const clientSession = extra?._meta?.["openai/session"];
  if (typeof clientSession === "string" && clientSession.trim() && clientSession.length <= 512) return `openai:${clientSession.trim()}`;
  if (clientSession && typeof clientSession === "object") {
    const serialized = JSON.stringify(clientSession);
    if (serialized.length <= 512) return `openai:${serialized}`;
  }
  if (typeof extra?.sessionId === "string" && extra.sessionId) return `mcp:${extra.sessionId}`;
  return "";
}

export class WorkbenchState {
  #file;
  #workspaces = new Map();
  #tasks = new Map();
  #sessionTasks = new Map();
  #defaultWorkspaceId = "";
  #defaultTaskId = "";
  #writeQueue = Promise.resolve();

  constructor(dataPath) {
    this.#file = path.join(dataPath, "workbench-state.json");
  }

  async initialize(initialWorkspacePath) {
    try {
      const stored = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (stored.version !== STATE_VERSION || !Array.isArray(stored.workspaces) || !Array.isArray(stored.tasks)) {
        throw new Error("Unsupported workbench state schema.");
      }
      for (const item of stored.workspaces) {
        try {
          const root = await fs.realpath(item.root);
          if (root === item.root && item.id === workspaceId(root)) this.#workspaces.set(item.id, item);
        } catch {}
      }
      for (const task of stored.tasks) if (this.#workspaces.has(task.workspaceId)) this.#tasks.set(task.id, task);
      this.#defaultWorkspaceId = stored.defaultWorkspaceId || "";
      this.#defaultTaskId = stored.defaultTaskId || "";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (initialWorkspacePath) {
      const workspace = await this.addWorkspace(initialWorkspacePath, { persist: false });
      if (!this.#defaultWorkspaceId) this.#defaultWorkspaceId = workspace.id;
    }
    if (!this.#workspaces.has(this.#defaultWorkspaceId)) this.#defaultWorkspaceId = this.#workspaces.keys().next().value || "";
    if (!this.#tasks.has(this.#defaultTaskId)) {
      const task = [...this.#tasks.values()].find(item => item.workspaceId === this.#defaultWorkspaceId);
      this.#defaultTaskId = task?.id || "";
    }
    if (!this.#defaultTaskId && this.#defaultWorkspaceId) {
      const task = this.#newTask(this.#defaultWorkspaceId, "Default task");
      this.#defaultTaskId = task.id;
    }
    await this.#persist();
    return this.snapshot();
  }

  #newTask(workspaceIdValue, title) {
    const now = new Date().toISOString();
    const task = { id: safeTaskId(), workspaceId: workspaceIdValue, title: title.trim().slice(0, 120) || "New task", permissionMode: "ask", status: "active", createdAt: now, updatedAt: now };
    this.#tasks.set(task.id, task);
    return task;
  }

  async #persist() {
    const state = {
      version: STATE_VERSION,
      defaultWorkspaceId: this.#defaultWorkspaceId,
      defaultTaskId: this.#defaultTaskId,
      workspaces: [...this.#workspaces.values()],
      tasks: [...this.#tasks.values()]
    };
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${crypto.randomBytes(3).toString("hex")}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.#file);
    });
    return this.#writeQueue;
  }

  async addWorkspace(inputPath, { persist = true } = {}) {
    const root = await fs.realpath(inputPath);
    const id = workspaceId(root);
    let item = this.#workspaces.get(id);
    if (!item) {
      item = { id, name: path.basename(root), root, createdAt: new Date().toISOString() };
      this.#workspaces.set(id, item);
    }
    if (![...this.#tasks.values()].some(task => task.workspaceId === id)) {
      const task = this.#newTask(id, "Default task");
      if (!this.#defaultTaskId) this.#defaultTaskId = task.id;
    }
    if (!this.#defaultWorkspaceId) this.#defaultWorkspaceId = id;
    if (persist) await this.#persist();
    return { ...item };
  }

  async selectWorkspace(id) {
    if (!this.#workspaces.has(id)) throw new Error("Workspace not found.");
    this.#defaultWorkspaceId = id;
    const task = [...this.#tasks.values()].find(item => item.workspaceId === id && item.status === "active");
    this.#defaultTaskId = task?.id || this.#newTask(id, "Default task").id;
    await this.#persist();
    return this.snapshot();
  }

  async renameWorkspace(id, name) {
    const item = this.#workspaces.get(id);
    if (!item) throw new Error("Workspace not found.");
    const label = String(name || "").trim().slice(0, 120);
    if (!label) throw new Error("Workspace name is required.");
    item.name = label;
    await this.#persist();
    return { ...item };
  }

  async removeWorkspace(id) {
    if (!this.#workspaces.has(id)) throw new Error("Workspace not found.");
    this.#workspaces.delete(id);
    for (const [taskId, task] of this.#tasks) {
      if (task.workspaceId !== id) continue;
      this.#tasks.delete(taskId);
      for (const [key, boundId] of this.#sessionTasks) if (boundId === taskId) this.#sessionTasks.delete(key);
    }
    if (this.#defaultWorkspaceId === id) this.#defaultWorkspaceId = this.#workspaces.keys().next().value || "";
    if (!this.#tasks.has(this.#defaultTaskId)) {
      const next = [...this.#tasks.values()].find(item => item.workspaceId === this.#defaultWorkspaceId && item.status === "active");
      this.#defaultTaskId = next?.id || "";
    }
    await this.#persist();
    return this.snapshot();
  }

  async selectTask(id) {
    const task = this.#tasks.get(id);
    if (!task || task.status !== "active") throw new Error("Active task not found.");
    this.#defaultWorkspaceId = task.workspaceId;
    this.#defaultTaskId = task.id;
    await this.#persist();
    return { ...task };
  }

  async createTask(workspaceIdValue, title) {
    const workspace = this.#workspaces.get(workspaceIdValue || this.#defaultWorkspaceId);
    if (!workspace) throw new Error("Select or add a workspace first.");
    const task = this.#newTask(workspace.id, String(title || "New task"));
    this.#defaultWorkspaceId = workspace.id;
    this.#defaultTaskId = task.id;
    await this.#persist();
    return { ...task, workspace: { id: workspace.id, name: workspace.name, root: workspace.root } };
  }

  async renameTask(id, title) {
    const task = this.#tasks.get(id);
    if (!task || task.status !== "active") throw new Error("Active task not found.");
    const label = String(title || "").trim().slice(0, 120);
    if (!label) throw new Error("Task name is required.");
    task.title = label;
    task.updatedAt = new Date().toISOString();
    await this.#persist();
    return { ...task };
  }

  async deleteTask(id) {
    const task = this.#tasks.get(id);
    if (!task || task.status !== "active") throw new Error("Active task not found.");
    task.status = "closed";
    task.updatedAt = new Date().toISOString();
    for (const [key, boundId] of this.#sessionTasks) if (boundId === id) this.#sessionTasks.delete(key);
    if (this.#defaultTaskId === id) {
      const next = [...this.#tasks.values()].find(item => item.status === "active" && item.workspaceId === task.workspaceId);
      this.#defaultTaskId = next?.id || "";
    }
    await this.#persist();
    return { ...task };
  }

  async setPermissionMode(taskId, mode) {
    if (!PERMISSION_MODES.has(mode)) throw new Error("Permission mode must be ask, auto, or full.");
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error("Task not found.");
    task.permissionMode = mode;
    task.updatedAt = new Date().toISOString();
    await this.#persist();
    return { ...task };
  }

  bindSession(taskId, extra) {
    const task = this.#tasks.get(taskId);
    if (!task || task.status !== "active") throw new Error("Active task not found.");
    const key = sessionKey(extra);
    if (!key) throw new Error("This MCP connection has no stable session identifier. Pass task_id on tool calls instead.");
    const existing = this.#sessionTasks.get(key);
    if (existing && existing !== taskId) throw new Error("This MCP session is already bound to another task. Start a new conversation to change tasks.");
    this.#sessionTasks.set(key, taskId);
    return { taskId, sessionKey: key.split(":")[0] };
  }

  resolveTask(explicitTaskId, extra) {
    const key = sessionKey(extra);
    const boundId = key ? this.#sessionTasks.get(key) : "";
    if (boundId && explicitTaskId && boundId !== explicitTaskId) throw new Error("This MCP session is bound to another task. Start a new session or use its bound task.");
    const id = explicitTaskId || boundId || this.#defaultTaskId;
    const task = this.#tasks.get(id);
    if (!task || task.status !== "active") throw new Error("Task not found or closed. Call workbench_list_tasks, then bind a task or pass task_id.");
    if (!boundId && !explicitTaskId && this.#tasks.size > 1) throw new Error("Several tasks are available. Call workbench_bind_task or include task_id with this tool call.");
    if (key && !boundId) this.#sessionTasks.set(key, id);
    const workspace = this.#workspaces.get(task.workspaceId);
    if (!workspace) throw new Error("Task workspace no longer exists.");
    return { task: { ...task }, workspace: { ...workspace }, sessionKey: key };
  }

  getDefaultWorkspace() {
    const item = this.#workspaces.get(this.#defaultWorkspaceId);
    return item ? { ...item } : undefined;
  }

  getTask(id) {
    const task = this.#tasks.get(id);
    if (!task) return undefined;
    const workspace = this.#workspaces.get(task.workspaceId);
    return workspace ? { task: { ...task }, workspace: { ...workspace } } : undefined;
  }

  snapshot() {
    return {
      workspaces: [...this.#workspaces.values()].map(item => ({ ...item })),
      tasks: [...this.#tasks.values()].map(task => ({ ...task, workspaceName: this.#workspaces.get(task.workspaceId)?.name || "" })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      defaultWorkspaceId: this.#defaultWorkspaceId,
      defaultTaskId: this.#defaultTaskId
    };
  }
}
