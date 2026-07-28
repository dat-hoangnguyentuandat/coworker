import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactText } from "./secret-redaction.js";

const VERSION = 1;
const MAX_PENDING_PER_TASK = 50;

export class TaskMailbox {
  #file;
  #state;
  #messages = [];
  #queue = Promise.resolve();

  constructor(dataPath, state) {
    this.#file = path.join(dataPath, "task-mailbox.json");
    this.#state = state;
  }

  async initialize() {
    try {
      const stored = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (stored.version !== VERSION || !Array.isArray(stored.messages)) throw new Error("Unsupported task mailbox schema.");
      this.#messages = stored.messages.slice(-2000);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  async #persist() {
    const document = { version: VERSION, messages: this.#messages.slice(-2000) };
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${crypto.randomBytes(3).toString("hex")}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(document, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.#file);
    });
    await this.#queue;
  }

  async send(fromTaskId, toTaskId, prompt) {
    const from = this.#state.getTask(fromTaskId); const to = this.#state.getTask(toTaskId);
    if (!from || !to || from.task.status !== "active" || to.task.status !== "active") throw new Error("Both source and target tasks must be active.");
    if (from.workspace.id !== to.workspace.id) throw new Error("Task dispatch is limited to tasks in the same workspace.");
    const queued = this.#messages.filter(item => item.toTaskId === toTaskId && item.status === "queued").length;
    if (queued >= MAX_PENDING_PER_TASK) throw new Error("Target task queue is full; inspect or claim existing messages first.");
    const message = { id: `msg_${crypto.randomBytes(8).toString("hex")}`, workspaceId: from.workspace.id, fromTaskId, toTaskId, prompt: redactText(prompt).slice(0, 10000), status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.#messages.push(message);
    await this.#persist();
    return { ...message };
  }

  list(taskId, limit = 30) {
    if (!this.#state.getTask(taskId)) throw new Error("Task not found.");
    return this.#messages.filter(item => item.toTaskId === taskId || item.fromTaskId === taskId).slice(-Math.min(100, Math.max(1, limit))).reverse().map(item => ({ ...item }));
  }

  async claim(taskId, messageId) {
    const item = this.#messages.find(message => message.id === messageId);
    if (!item || item.toTaskId !== taskId) throw new Error("Message not found for this task.");
    if (item.status !== "queued") throw new Error(`Message is ${item.status}, not queued.`);
    item.status = "claimed"; item.claimedAt = new Date().toISOString(); item.updatedAt = item.claimedAt;
    await this.#persist();
    return { ...item };
  }

  async finish(taskId, messageId, status, response = "") {
    if (!["completed", "failed"].includes(status)) throw new Error("Status must be completed or failed.");
    const item = this.#messages.find(message => message.id === messageId);
    if (!item || item.toTaskId !== taskId) throw new Error("Message not found for this task.");
    if (item.status !== "claimed") throw new Error("Claim the message before completing it.");
    item.status = status; item.response = redactText(response).slice(0, 5000); item.updatedAt = new Date().toISOString();
    await this.#persist();
    return { ...item };
  }

  summary() {
    const active = this.#messages.filter(item => item.status === "queued");
    return { queued: active.length, tasks: [...new Set(active.map(item => item.toTaskId))].length };
  }
}
