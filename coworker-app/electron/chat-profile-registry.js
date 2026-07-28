import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const ID_PATTERN = /^p_[a-f0-9]{16}$/;
const PARTITION_PREFIX = "persist:coworker-chatgpt-";
const PARTITION_PATTERN = /^persist:coworker-chatgpt-[a-f0-9]{16}$/;

function profileId() { return `p_${crypto.randomBytes(8).toString("hex")}`; }
function safeLabel(value, fallback) { return String(value || fallback).trim().slice(0, 80) || fallback; }

export class ChatProfileRegistry {
  #file;
  #profiles = [];
  #activeProfileId = "";
  #queue = Promise.resolve();

  constructor(dataPath) { this.#file = path.join(dataPath, "chat-profiles.json"); }

  async initialize() {
    try {
      const document = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (document.version !== VERSION || !Array.isArray(document.profiles)) throw new Error("Invalid profile registry.");
      this.#profiles = document.profiles.filter(item => ID_PATTERN.test(item.id) && typeof item.partition === "string" && (item.partition === "persist:coworker-chatgpt" || PARTITION_PATTERN.test(item.partition))).map(item => ({ id: item.id, label: safeLabel(item.label, "ChatGPT"), partition: item.partition, status: ["unknown", "available", "login_required", "user_marked_unavailable"].includes(item.status) ? item.status : "unknown", createdAt: item.createdAt || new Date().toISOString(), lastUsedAt: item.lastUsedAt || item.createdAt || new Date().toISOString() }));
      this.#activeProfileId = ID_PATTERN.test(document.activeProfileId) ? document.activeProfileId : "";
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`Profile registry reset: ${error.message}`);
    }
    if (!this.#profiles.length) {
      const id = profileId();
      this.#profiles = [{ id, label: "ChatGPT 1", partition: "persist:coworker-chatgpt", status: "unknown", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }];
      this.#activeProfileId = id;
    }
    if (!this.#profiles.some(item => item.id === this.#activeProfileId)) this.#activeProfileId = this.#profiles[0].id;
    await this.#persist();
    return this.snapshot();
  }

  snapshot() { return { version: VERSION, activeProfileId: this.#activeProfileId, profiles: this.#profiles.map(item => ({ ...item })) }; }
  active() { return this.#profiles.find(item => item.id === this.#activeProfileId) || this.#profiles[0]; }
  #find(id) { const item = this.#profiles.find(profile => profile.id === id); if (!item) throw new Error("ChatGPT profile not found."); return item; }

  async #persist() {
    const document = JSON.stringify(this.snapshot(), null, 2);
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${crypto.randomBytes(3).toString("hex")}.tmp`;
      await fs.writeFile(temporary, document, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.#file);
    });
    return this.#queue;
  }

  async create(label = "") {
    const id = profileId();
    const now = new Date().toISOString();
    this.#profiles.push({ id, label: safeLabel(label, `ChatGPT ${this.#profiles.length + 1}`), partition: `${PARTITION_PREFIX}${id.slice(2)}`, status: "login_required", createdAt: now, lastUsedAt: now });
    await this.#persist();
    return this.#profiles.at(-1);
  }

  async select(id) { const item = this.#find(id); this.#activeProfileId = item.id; item.lastUsedAt = new Date().toISOString(); await this.#persist(); return { ...item }; }
  async rename(id, label) { const item = this.#find(id); item.label = safeLabel(label, item.label); await this.#persist(); return { ...item }; }
  async setStatus(id, status) { const item = this.#find(id); if (!["unknown", "available", "login_required", "user_marked_unavailable"].includes(status)) throw new Error("Invalid profile status."); item.status = status; await this.#persist(); return { ...item }; }
  async remove(id) { if (this.#profiles.length <= 1) throw new Error("At least one ChatGPT profile must remain."); this.#find(id); this.#profiles = this.#profiles.filter(item => item.id !== id); if (this.#activeProfileId === id) this.#activeProfileId = this.#profiles[0].id; await this.#persist(); return this.snapshot(); }
}
