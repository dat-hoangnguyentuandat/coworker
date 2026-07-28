import crypto from "node:crypto";
import { safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const ID_PATTERN = /^a_[a-f0-9]{16}$/;

function accountId() { return `a_${crypto.randomBytes(8).toString("hex")}`; }

function protect(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable; auto-login secrets were not saved.");
  return `enc:${safeStorage.encryptString(String(value)).toString("base64")}`;
}

function reveal(value) {
  if (typeof value !== "string" || !value.startsWith("enc:")) return value || "";
  if (!safeStorage.isEncryptionAvailable()) return "";
  try { return safeStorage.decryptString(Buffer.from(value.slice(4), "base64")); }
  catch { return ""; }
}

// Parses "email | password | twofa" lines (| or :), mirroring the extension
// format. Google logins are not entered here at all: the dialog's Google
// button runs a manual flow and saves the account automatically.
export function parseAccountLines(text) {
  return String(text || "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => {
    const parts = line.includes("|") ? line.split("|") : line.split(":");
    return { email: (parts[0] || "").trim(), password: (parts[1] || "").trim(), twofa: (parts[2] || "").trim(), type: "openai" };
  }).filter(account => account.email.includes("@"));
}

export class AutoLoginRegistry {
  #file;
  #accounts = [];
  #queue = Promise.resolve();

  constructor(dataPath) { this.#file = path.join(dataPath, "auto-login.json"); }

  async initialize() {
    try {
      const document = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (document.version !== VERSION || !Array.isArray(document.accounts)) throw new Error("Invalid auto-login registry.");
      this.#accounts = document.accounts.filter(item => ID_PATTERN.test(item.id)).map(item => ({
        id: item.id,
        email: String(item.email || "").trim().slice(0, 200),
        password: typeof item.password === "string" ? item.password : "",
        twofa: typeof item.twofa === "string" ? item.twofa : "",
        profileId: String(item.profileId || ""),
        type: item.type === "google" ? "google" : "openai"
      }));
    } catch (error) { if (error.code !== "ENOENT") console.warn(`Auto-login registry reset: ${error.message}`); }
    await this.#persist();
    return this.snapshot();
  }

  #persist() {
    const document = JSON.stringify({ version: VERSION, accounts: this.#accounts }, null, 2);
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${crypto.randomBytes(3).toString("hex")}.tmp`;
      await fs.writeFile(temporary, document, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.#file);
    });
    return this.#queue;
  }

  // Masked view for UI; secrets never leave the main process.
  snapshot() {
    return { version: VERSION, accounts: this.#accounts.map(item => ({
      id: item.id,
      email: item.email,
      hasPassword: Boolean(item.password),
      has2fa: Boolean(item.twofa),
      profileId: item.profileId || "",
      type: item.type
    })) };
  }

  credentials(id) { const item = this.#accounts.find(account => account.id === id); if (!item) throw new Error("Auto-login account not found."); return { email: item.email, password: reveal(item.password), twofa: reveal(item.twofa), type: item.type }; }

  // Adds new accounts (deduped by email) and removes accounts missing from `keptIds`.
  async replaceAll(rawText, keptIds = null) {
    const incoming = parseAccountLines(rawText);
    const keep = new Set(keptIds || this.#accounts.map(item => item.id));
    const merged = this.#accounts.filter(item => keep.has(item.id));
    for (const account of incoming) {
      if (merged.some(item => item.email.toLowerCase() === account.email.toLowerCase())) continue;
      merged.push({ id: accountId(), email: account.email, password: protect(account.password), twofa: protect(account.twofa), profileId: "", type: account.type });
    }
    this.#accounts = merged;
    await this.#persist();
    return this.snapshot();
  }

  // Adds one account without secrets (used for manual Google logins, where
  // the session email is discovered after the user finishes signing in).
  // An existing account that already has a password keeps its type: flipping
  // it would break its OpenAI auto-login.
  async addPasswordless(email, type = "google", profileId = "") {
    const clean = String(email || "").trim().slice(0, 200);
    if (!clean.includes("@")) throw new Error("Invalid email for auto-login account.");
    const existing = this.#accounts.find(item => item.email.toLowerCase() === clean.toLowerCase());
    if (existing) {
      if (!existing.password) existing.type = type === "google" ? "google" : "openai";
      existing.profileId = String(profileId || existing.profileId || "");
      await this.#persist();
      return this.snapshot();
    }
    this.#accounts.push({ id: accountId(), email: clean, password: "", twofa: "", profileId: String(profileId || ""), type: type === "google" ? "google" : "openai" });
    // One active account per profile: release any other account bound to it.
    for (const other of this.#accounts) {
      if (other.email.toLowerCase() !== clean.toLowerCase() && profileId && other.profileId === profileId) other.profileId = "";
    }
    await this.#persist();
    return this.snapshot();
  }

  async remove(id) { this.#accounts = this.#accounts.filter(item => item.id !== id); await this.#persist(); return this.snapshot(); }

  async bindProfile(id, profileId) {
    const item = this.#accounts.find(account => account.id === id);
    if (!item) throw new Error("Auto-login account not found.");
    const target = String(profileId || "");
    item.profileId = target;
    // Exclusive at bind time too: picking a profile in one account's dropdown
    // must immediately release every other account bound to it — the UI shows
    // one active account per profile, not just the login flow.
    for (const other of this.#accounts) {
      if (other.id !== id && target && other.profileId === target) other.profileId = "";
    }
    await this.#persist();
    return this.snapshot();
  }

  // One profile hosts one active account: when an account claims a profile,
  // every other account bound to it is released to "none" — logging B in over
  // A's profile must not leave A pointing at a session that is no longer hers.
  async claimProfile(id, profileId) {
    const item = this.#accounts.find(account => account.id === id);
    if (!item) return this.snapshot();
    const target = String(profileId || "");
    item.profileId = target;
    for (const other of this.#accounts) {
      if (other.id !== id && target && other.profileId === target) other.profileId = "";
    }
    await this.#persist();
    return this.snapshot();
  }
}
