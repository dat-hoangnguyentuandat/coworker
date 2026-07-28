import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalBroker extends EventEmitter {
  #pending = new Map();

  request({ task, toolName, summary, risk, signal }) {
    if (signal?.aborted) return Promise.resolve(false);
    const id = `approval_${crypto.randomBytes(8).toString("hex")}`;
    return new Promise(resolve => {
      const approval = { id, taskId: task.id, taskTitle: task.title, toolName, summary, risk, createdAt: new Date().toISOString() };
      const timer = setTimeout(() => this.resolve(id, false), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const abort = () => this.resolve(id, false);
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, { approval, resolve, timer, signal, abort });
      this.emit("approval-required", approval);
    });
  }

  resolve(id, approved) {
    const item = this.#pending.get(id);
    if (!item) return false;
    this.#pending.delete(id);
    clearTimeout(item.timer);
    item.signal?.removeEventListener("abort", item.abort);
    item.resolve(Boolean(approved));
    return true;
  }

  pending() {
    return [...this.#pending.values()].map(item => ({ ...item.approval }));
  }

  close() {
    for (const id of this.#pending.keys()) this.resolve(id, false);
  }
}
