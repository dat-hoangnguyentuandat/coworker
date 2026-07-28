import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactText } from "./secret-redaction.js";

const MAX_HISTORY_BYTES = 5 * 1024 * 1024;
const RETAIN_HISTORY_BYTES = 2 * 1024 * 1024;

function redact(value, key = "") {
  if (/token|secret|password|authorization|api[_-]?key|credential/i.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (["content", "body", "prompt", "old_text", "new_text"].includes(key)) return `[${key} omitted: ${value.length} characters]`;
    return redactText(value).slice(0, 3000);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export class OperationJournal {
  #root;
  #queue = Promise.resolve();

  constructor(dataPath, taskId) {
    if (!/^task_[a-f0-9]{16}$/.test(taskId)) throw new Error("Invalid task id.");
    this.#root = path.join(dataPath, "tasks", taskId);
  }

  async append(event) {
    const record = { id: `op_${crypto.randomBytes(8).toString("hex")}`, at: new Date().toISOString(), ...redact(event) };
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.#root, { recursive: true });
      const file = path.join(this.#root, "history.jsonl");
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_HISTORY_BYTES) {
          const bytes = await fs.readFile(file);
          const tail = bytes.subarray(-RETAIN_HISTORY_BYTES).toString("utf8");
          const firstBreak = tail.indexOf("\n");
          await fs.writeFile(file, firstBreak < 0 ? "" : tail.slice(firstBreak + 1), { encoding: "utf8", mode: 0o600 });
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    await this.#queue;
    return record;
  }

  async recent(limit = 50) {
    const file = path.join(this.#root, "history.jsonl");
    let text;
    try {
      const stat = await fs.stat(file);
      const bytes = await fs.readFile(file);
      const slice = stat.size > MAX_HISTORY_BYTES ? bytes.subarray(-MAX_HISTORY_BYTES) : bytes;
      text = slice.toString("utf8");
    }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return text.split(/\r?\n/).filter(Boolean).slice(-Math.min(200, Math.max(1, limit))).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).reverse();
  }
}
