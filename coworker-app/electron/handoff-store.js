import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const MAX_HANDOFFS = 20;
const MAX_TEXT = 12000;

function id() { return `handoff_${crypto.randomBytes(8).toString("hex")}`; }
function clean(value, max = MAX_TEXT) { return String(value || "").replaceAll(/(sk-[A-Za-z0-9_-]{8,}|rk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._-]+|tunnel_[a-f0-9]{32})/gi, "[redacted]").slice(0, max); }
function safeTaskId(taskId) { if (!/^task_[a-f0-9]{16}$/.test(taskId)) throw new Error("Invalid task id."); return taskId; }

export class HandoffStore {
  #root;
  constructor(dataPath) { this.#root = path.join(dataPath, "handoffs"); }

  async create(input = {}) {
    const handoff = {
      schemaVersion: VERSION, handoffId: id(), createdAt: new Date().toISOString(), sourceProfileId: clean(input.profileId, 80), workspace: input.workspace ? { id: clean(input.workspace.id, 80), name: clean(input.workspace.name, 120), root: clean(input.workspace.root, 500) } : null, task: input.task ? { id: clean(input.task.id, 80), title: clean(input.task.title, 200), permissionMode: clean(input.task.permissionMode, 20), status: clean(input.task.status, 20) } : null,
      objective: clean(input.objective, 3000), completed: (input.completed || []).map(item => clean(item, 500)).slice(0, 30), inProgress: (input.inProgress || []).map(item => clean(item, 500)).slice(0, 30), nextSteps: (input.nextSteps || []).map(item => clean(item, 500)).slice(0, 30), decisions: (input.decisions || []).map(item => clean(item, 500)).slice(0, 30), blockers: (input.blockers || []).map(item => clean(item, 500)).slice(0, 30), memory: clean(input.memory, 12000), operations: (input.operations || []).slice(0, 40).map(event => ({ id: clean(event.id, 80), at: clean(event.at, 40), tool: clean(event.tool || event.type, 100), status: clean(event.status, 40), summary: clean(event.summary, 500), error: clean(event.error, 500) })), files: { touched: (input.files?.touched || []).map(item => clean(item, 500)).slice(0, 40), unknownShellChanges: input.files?.unknownShellChanges !== false }, checkpoints: (input.checkpoints || []).slice(0, 30).map(item => ({ id: clean(item.id, 80), path: clean(item.path, 500), createdAt: clean(item.createdAt, 40) })), continuity: { confidence: input.confidence || "medium", missingContext: ["ChatGPT conversation and hidden model state are not stored."] }
    };
    const raw = JSON.stringify(handoff);
    handoff.integrity = { algorithm: "sha256", digest: crypto.createHash("sha256").update(raw).digest("hex") };
    const dir = path.join(this.#root, handoff.task.id);
    await fs.mkdir(dir, { recursive: true });
    await this.#atomicWrite(path.join(dir, `${handoff.createdAt.replaceAll(/[:.]/g, "-")}.json`), JSON.stringify(handoff, null, 2));
    await this.#atomicWrite(path.join(dir, "latest.md"), this.toMarkdown(handoff));
    const entries = (await fs.readdir(dir)).filter(name => name.endsWith(".json")).sort().reverse();
    await Promise.all(entries.slice(MAX_HANDOFFS).map(name => fs.rm(path.join(dir, name), { force: true })));
    return { ...handoff, markdown: this.toMarkdown(handoff) };
  }

  async latest(taskId) {
    safeTaskId(taskId); const dir = path.join(this.#root, taskId); let entries;
    try { entries = (await fs.readdir(dir)).filter(name => name.endsWith(".json")).sort().reverse(); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!entries[0]) return null;
    for (const entry of entries) {
      try { const parsed = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")); const integrity = parsed.integrity; delete parsed.integrity; const digest = crypto.createHash("sha256").update(JSON.stringify(parsed)).digest("hex"); if (integrity?.digest === digest) { parsed.integrity = integrity; return parsed; } } catch {}
    }
    return null;
  }

  async #atomicWrite(file, content) { const temporary = `${file}.${crypto.randomBytes(3).toString("hex")}.tmp`; await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }); await fs.rename(temporary, file); }

  // ---- Automatic profile handoffs -------------------------------------------------
  // When the user switches Chat profiles, the outgoing profile's latest ChatGPT
  // conversation transcript is captured and queued for the target profile
  // (Claude Code/Codex-style transcript persistence, adapted to ChatGPT web:
  // the transcript lives in OpenAI's account, so we pull it via the profile's
  // own session instead of writing one ourselves).

  #profileHandoffFile(toProfileId) { return path.join(this.#root, "_profile-handoffs", `pending-${clean(toProfileId, 80)}.json`); }

  profileResumePrompt(item) {
    const header = `You are continuing work in Coworker that started in another ChatGPT profile ("${item.fromProfileLabel}"). The transcript below is the most recent conversation from that profile — treat it as your own prior context and continue exactly where it left off.\n\nRules:\n- Reply in the same language the transcript uses.\n- If workspace files or tasks are involved, call workbench_status and workbench_list_tasks, then workbench_bind_task with the matching task id before editing anything.\n- Do not restart the work and do not re-ask questions the transcript already answered; ask only when a decision is genuinely missing.\n\n`;
    const convo = `Conversation: "${item.conversation?.title || "untitled"}" (last updated ${item.conversation?.updatedAt || "unknown"})\n\n`;
    const body = (item.transcript || []).map(m => `[${m.role === "assistant" ? "ChatGPT" : "User"}]\n${m.text}`).join("\n\n---\n\n");
    return (header + convo + body).slice(0, 28000);
  }

  async saveProfileHandoff(input = {}) {
    const item = {
      schemaVersion: VERSION, kind: "profile-handoff", handoffId: id(), createdAt: new Date().toISOString(),
      fromProfileId: clean(input.fromProfileId, 80), fromProfileLabel: clean(input.fromProfileLabel, 120), toProfileId: clean(input.toProfileId, 80),
      conversation: input.conversation ? { id: clean(input.conversation.id, 80), title: clean(input.conversation.title, 300), updatedAt: clean(input.conversation.updatedAt, 40) } : null,
      transcript: (input.transcript || []).slice(0, 40).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", text: clean(m.text, 1500) }))
    };
    item.resumePrompt = clean(this.profileResumePrompt(item), 30000);
    const raw = JSON.stringify(item);
    item.integrity = { algorithm: "sha256", digest: crypto.createHash("sha256").update(raw).digest("hex") };
    await fs.mkdir(path.dirname(this.#profileHandoffFile(item.toProfileId)), { recursive: true });
    await this.#atomicWrite(this.#profileHandoffFile(item.toProfileId), JSON.stringify(item, null, 2));
    return item;
  }

  async pendingProfileHandoff(toProfileId) {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#profileHandoffFile(toProfileId), "utf8"));
      const integrity = parsed.integrity;
      delete parsed.integrity;
      const digest = crypto.createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
      if (integrity?.digest === digest) { parsed.integrity = integrity; return parsed; }
    } catch (error) { if (error.code !== "ENOENT") console.warn(`Profile handoff read failed: ${error.message}`); }
    return null;
  }

  async clearProfileHandoff(toProfileId) { await fs.rm(this.#profileHandoffFile(toProfileId), { force: true }); }

  async addNotes(taskId, notes, profileId = "") {
    safeTaskId(taskId);
    const current = await this.latest(taskId);
    if (!current) throw new Error("Create a deterministic handoff before adding model notes.");
    const model = { source: "model", profileId, createdAt: new Date().toISOString(), objective: clean(notes.objective, 3000), completed: (notes.completed || []).map(item => clean(item, 500)).slice(0, 30), inProgress: (notes.inProgress || []).map(item => clean(item, 500)).slice(0, 30), nextSteps: (notes.nextSteps || []).map(item => clean(item, 500)).slice(0, 30), decisions: (notes.decisions || []).map(item => clean(item, 500)).slice(0, 30), blockers: (notes.blockers || []).map(item => clean(item, 500)).slice(0, 30) };
    current.modelNotes = model;
    const raw = JSON.stringify({ ...current, integrity: undefined });
    current.integrity = { algorithm: "sha256", digest: crypto.createHash("sha256").update(raw).digest("hex") };
    const dir = path.join(this.#root, taskId);
    await this.#atomicWrite(path.join(dir, `${current.createdAt.replaceAll(/[:.]/g, "-")}.json`), JSON.stringify(current, null, 2));
    await this.#atomicWrite(path.join(dir, "latest.md"), this.toMarkdown(current));
    return current;
  }

  toMarkdown(item) {
    const list = value => value?.length ? value.map(entry => `- ${entry}`).join("\n") : "- None recorded";
    return `# Coworker handoff\n\nCreated: ${item.createdAt}\nWorkspace: ${item.workspace?.name || "unknown"}\nTask: ${item.task?.title || "unknown"} (${item.task?.id || ""})\n\n## Objective\n${item.objective || "Not recorded"}\n\n## Completed\n${list(item.completed)}\n\n## In progress\n${list(item.inProgress)}\n\n## Next steps\n${list(item.nextSteps)}\n\n## Decisions\n${list(item.decisions)}\n\n## Blockers\n${list(item.blockers)}\n\n## Recent operations\n${list((item.operations || []).map(event => `${event.tool || event.type || "operation"}: ${event.summary || event.status || ""}`))}\n\n## Resume\nCall workbench_bind_task with task_id="${item.task?.id || ""}". Verify workspace and files before editing.\n\nMissing context: ChatGPT conversation and hidden model state are not stored.\n`;
  }

  markdown(item) { return this.toMarkdown(item); }
}
