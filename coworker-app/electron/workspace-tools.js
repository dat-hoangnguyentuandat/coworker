import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { activeWorkspaceRoot, currentExecutionContext } from "./execution-context.js";
import { isSensitivePath } from "./path-policy.js";
import { redactText } from "./secret-redaction.js";

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".venv"]);
const jobs = new Map();
const SENSITIVE_ENV_VALUES = Object.entries(process.env)
  .filter(([name, value]) => /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY)/i.test(name) && value && value.length >= 8)
  .map(([, value]) => value)
  .sort((a, b) => b.length - a.length);

function redactJobText(value) {
  let output = redactText(value);
  for (const secret of SENSITIVE_ENV_VALUES) output = output.replaceAll(secret, "[environment secret redacted]");
  return output;
}

function result(text, isError = false) {
  return { content: [{ type: "text", text: redactText(text) }], ...(isError ? { isError: true } : {}) };
}

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export async function resolveWorkspacePath(root, input = ".", { allowMissing = false } = {}) {
  root = activeWorkspaceRoot(root);
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, input || ".");
  if (!within(realRoot, target)) throw new Error("Path is outside the selected workspace.");
  let realTarget;
  try {
    realTarget = await fs.realpath(target);
  } catch (error) {
    if (!allowMissing || error.code !== "ENOENT") throw error;
    const parent = await fs.realpath(path.dirname(target));
    if (!within(realRoot, parent)) throw new Error("Parent directory is outside the selected workspace.");
    realTarget = path.join(parent, path.basename(target));
  }
  if (!within(realRoot, realTarget)) throw new Error("Resolved path is outside the selected workspace.");
  const relativeRealTarget = path.relative(realRoot, realTarget);
  const context = currentExecutionContext();
  if (isSensitivePath(relativeRealTarget) && context?.task?.permissionMode !== "full" && context?.approvedOperation !== true) {
    throw new Error("This path resolves to a sensitive file or folder. Coworker requires explicit approval; use its direct path so the approval request identifies the target.");
  }
  return realTarget;
}

async function run(program, args, cwd, timeout = 30000) {
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      cwd, windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8"
    });
    return { output: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), exitCode: 0 };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${program} is not installed or is not on PATH.`);
    return { output: `${error.stdout ?? ""}${error.stderr ? `\n${error.stderr}` : ""}`.trim() || error.message, exitCode: error.code ?? 1 };
  }
}

async function listFiles(root, rel = ".", max = 2000) {
  root = activeWorkspaceRoot(root);
  const found = [];
  async function visit(dir, depth) {
    if (found.length >= max || depth > 20) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= max) break;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (isSensitivePath(relative)) continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) found.push(relative);
    }
  }
  await visit(await resolveWorkspacePath(root, rel), 0);
  return found;
}

async function saveSnapshot(root, dataPath, relativePath, maxEntries = 100) {
  root = activeWorkspaceRoot(root);
  const target = await resolveWorkspacePath(root, relativePath, { allowMissing: true });
  const rel = path.relative(root, target);
  let content = null;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("Checkpoint target must be a file.");
    if (stat.size > 5 * 1024 * 1024) throw new Error("Files larger than 5 MiB are not checkpointed.");
    content = await fs.readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
  const dir = path.join(dataPath, "checkpoints", crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
  await fs.mkdir(dir, { recursive: true });
  const entry = { id, createdAt: new Date().toISOString(), path: rel, existed: content !== null, content: content?.toString("base64") ?? null };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(entry), { mode: 0o600 });
  const all = (await fs.readdir(dir)).filter(name => name.endsWith(".json")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - maxEntries))) await fs.rm(path.join(dir, old), { force: true });
  return { id, path: rel, createdAt: entry.createdAt, existed: entry.existed };
}

function checkpointDir(root, dataPath) {
  root = activeWorkspaceRoot(root);
  return path.join(dataPath, "checkpoints", crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
}

async function readCheckpoints(root, dataPath) {
  const dir = checkpointDir(root, dataPath);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  const values = await Promise.all(entries.filter(x => x.endsWith(".json")).map(async name => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"))));
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function jobDirectory(dataPath, root) {
  root = activeWorkspaceRoot(root);
  return path.join(dataPath, "jobs", crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
}

function persistJob(job, dataPath, root) {
  job.persistQueue = (job.persistQueue || Promise.resolve()).then(async () => {
    const dir = jobDirectory(dataPath, root);
    await fs.mkdir(dir, { recursive: true });
    const record = publicJob(job);
    const temporary = path.join(dir, `${job.id}.${crypto.randomBytes(3).toString("hex")}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temporary, path.join(dir, `${job.id}.json`));
  }).catch(() => {});
  return job.persistQueue;
}

function startJob(command, cwd, timeoutSeconds, dataPath, workspaceRoot) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const child = spawn(shell, args, { cwd, windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const job = { id, command, cwd, workspaceRoot, startedAt: new Date().toISOString(), status: "running", exitCode: null, stdout: "", stderr: "", child };
  let persistTimer;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = undefined; void persistJob(job, dataPath, workspaceRoot); }, 250);
    persistTimer.unref?.();
  };
  const append = (key, chunk) => { job[key] = redactJobText(job[key] + chunk.toString()).slice(-256 * 1024); schedulePersist(); };
  child.stdout.on("data", chunk => append("stdout", chunk));
  child.stderr.on("data", chunk => append("stderr", chunk));
  child.on("error", error => { job.status = "failed"; job.stderr += `\n${error.message}`; schedulePersist(); });
  child.on("close", code => { if (job.status !== "cancelled" && job.status !== "timed_out") job.status = code === 0 ? "completed" : "failed"; job.exitCode = code; if (persistTimer) clearTimeout(persistTimer); if (job.timer) clearTimeout(job.timer); void persistJob(job, dataPath, workspaceRoot); });
  if (timeoutSeconds) {
    job.timer = setTimeout(() => { if (job.status === "running") { job.status = "timed_out"; terminateJob(job); void persistJob(job, dataPath, workspaceRoot); } }, timeoutSeconds * 1000);
    job.timer.unref?.();
  }
  jobs.set(id, job);
  void persistJob(job, dataPath, workspaceRoot);
  return job;
}

function publicJob(job) {
  return { id: job.id, pid: job.child?.pid ?? job.pid ?? null, command: redactJobText(job.command), cwd: job.cwd, startedAt: job.startedAt, status: job.status, exitCode: job.exitCode, stdout: redactJobText(job.stdout), stderr: redactJobText(job.stderr) };
}

function terminateJob(job) {
  if (process.platform === "win32" && job.child.pid) {
    const killer = spawn("taskkill.exe", ["/pid", String(job.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
  } else job.child.kill("SIGTERM");
}

function registerFileTools(server, root, dataPath) {
  server.registerTool("workspace_list_files", { title: "List workspace files", inputSchema: { path: z.string().optional() } }, async ({ path: rel = "." }) => {
    try {
      const dir = await resolveWorkspacePath(root, rel);
      const items = await fs.readdir(dir, { withFileTypes: true });
      return result(items.filter(entry => !isSensitivePath(entry.name)).slice(0, 500).map(e => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`).join("\n") || "(empty directory)");
    } catch (error) { return result(error.message, true); }
  });
  server.registerTool("workspace_read_file", { title: "Read workspace file", inputSchema: { path: z.string() } }, async ({ path: rel }) => {
    try {
      const target = await resolveWorkspacePath(root, rel);
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error("File must be a regular text file no larger than 1 MiB.");
      return result(await fs.readFile(target, "utf8"));
    } catch (error) { return result(error.message, true); }
  });
  server.registerTool("workspace_write_file", { title: "Write workspace file", inputSchema: { path: z.string(), content: z.string() } }, async ({ path: rel, content }) => {
    try {
      if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error("Content exceeds the 1 MiB write limit.");
      const target = await resolveWorkspacePath(root, rel, { allowMissing: true });
      await saveSnapshot(root, dataPath, rel);
      await fs.writeFile(target, content, { encoding: "utf8", flag: "w" });
      return result(`Wrote ${Buffer.byteLength(content)} bytes to ${rel}.`);
    } catch (error) { return result(error.message, true); }
  });
  server.registerTool("workspace_edit_file", { title: "Replace exact text in a workspace file", description: "Replace one exact text occurrence and checkpoint the original file first. Fails if the source text is missing or appears more than once.", inputSchema: { path: z.string(), old_text: z.string().min(1), new_text: z.string() } }, async ({ path: rel, old_text, new_text }) => {
    try {
      const target = await resolveWorkspacePath(root, rel);
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error("File must be a regular text file no larger than 1 MiB.");
      const content = await fs.readFile(target, "utf8");
      const first = content.indexOf(old_text);
      if (first < 0) throw new Error("Exact source text was not found; read the file and retry with current contents.");
      if (content.indexOf(old_text, first + old_text.length) >= 0) throw new Error("Exact source text appears more than once; provide a larger unique context.");
      const updated = content.slice(0, first) + new_text + content.slice(first + old_text.length);
      if (Buffer.byteLength(updated) > MAX_TEXT_BYTES) throw new Error("Edited file exceeds the 1 MiB limit.");
      await saveSnapshot(root, dataPath, rel);
      await fs.writeFile(target, updated, "utf8");
      return result(`Updated one exact match in ${rel}; original saved as a checkpoint.`);
    } catch (error) { return result(error.message, true); }
  });
  server.registerTool("workspace_delete_file", { title: "Delete a workspace file", description: "Delete one regular workspace file after creating a checkpoint that can restore it.", inputSchema: { path: z.string() } }, async ({ path: rel }) => {
    try {
      const target = await resolveWorkspacePath(root, rel);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("Only regular files can be deleted by this tool.");
      await saveSnapshot(root, dataPath, rel);
      await fs.rm(target);
      return result(`Deleted ${rel}; original saved as a checkpoint.`);
    } catch (error) { return result(error.message, true); }
  });
  server.registerTool("workspace_search", { title: "Search workspace", description: "Search file paths and UTF-8 file contents. Common generated folders are skipped.", inputSchema: { query: z.string().min(1), mode: z.enum(["content", "path", "both"]).optional(), path: z.string().optional(), case_sensitive: z.boolean().optional(), max_results: z.number().int().min(1).max(500).optional() } }, async ({ query, mode = "both", path: rel = ".", case_sensitive = false, max_results = 100 }) => {
    try {
      const workspaceRoot = activeWorkspaceRoot(root);
      const files = await listFiles(root, rel, 10000);
      const needle = case_sensitive ? query : query.toLocaleLowerCase();
      const found = [];
      for (const file of files) {
        const name = case_sensitive ? file : file.toLocaleLowerCase();
        if ((mode === "path" || mode === "both") && name.includes(needle)) found.push(`${file}: [path match]`);
        if (mode === "content" || mode === "both") {
          const target = path.join(workspaceRoot, file);
          const stat = await fs.stat(target);
          if (stat.size > 2 * 1024 * 1024) continue;
          const buffer = await fs.readFile(target);
          if (buffer.includes(0)) continue;
          const lines = buffer.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = case_sensitive ? lines[i] : lines[i].toLocaleLowerCase();
            if (line.includes(needle)) found.push(`${file}:${i + 1}: ${lines[i].slice(0, 500)}`);
            if (found.length >= max_results) break;
          }
        }
        if (found.length >= max_results) break;
      }
      return result(found.join("\n") || "No matches found.");
    } catch (error) { return result(error.message, true); }
  });
}

function registerShellTools(server, root, dataPath) {
  server.registerTool("run_command", { title: "Run shell command", description: "Run a command in the selected workspace. Commands have access to the host system under the current OS user.", inputSchema: { command: z.string().min(1), working_directory: z.string().optional(), timeout_seconds: z.number().int().min(1).max(600).optional() } }, async ({ command, working_directory, timeout_seconds = 60 }) => {
    try {
      const cwd = await resolveWorkspacePath(root, working_directory || ".");
      const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
      const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
      const { stdout, stderr } = await execFileAsync(shell, args, { cwd, windowsHide: true, timeout: timeout_seconds * 1000, maxBuffer: 2 * 1024 * 1024 });
      return result(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "Command completed with no output.");
    } catch (error) { return result(`${error.stdout ?? ""}${error.stderr ? `\n${error.stderr}` : ""}\n${error.message}`.trim(), true); }
  });
  server.registerTool("start_process", { title: "Start background process", inputSchema: { command: z.string().min(1), working_directory: z.string().optional(), timeout_seconds: z.number().int().positive().max(86400).optional() } }, async ({ command, working_directory, timeout_seconds }) => {
    try { const cwd = await resolveWorkspacePath(root, working_directory || "."); const job = startJob(command, cwd, timeout_seconds, dataPath, activeWorkspaceRoot(root)); await job.persistQueue; return result(JSON.stringify(publicJob(job), null, 2)); }
    catch (error) { return result(error.message, true); }
  });
  server.registerTool("process_status", { title: "List background processes", inputSchema: { id: z.string().optional() } }, async ({ id }) => {
    try {
      const workspaceRoot = activeWorkspaceRoot(root);
      const dir = jobDirectory(dataPath, workspaceRoot); await fs.mkdir(dir, { recursive: true });
      const names = await fs.readdir(dir); const records = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"))));
      const liveIds = new Set([...jobs.values()].filter(job => job.workspaceRoot === workspaceRoot).map(job => job.id));
      const current = records.map(job => {
        if (liveIds.has(job.id)) return publicJob(jobs.get(job.id));
        return { ...publicJob(job), status: job.status === "running" ? "interrupted" : job.status };
      });
      return result(JSON.stringify(current.filter(job => !id || job.id === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)), null, 2));
    } catch (error) { return result(error.message, true); }
  });
  server.registerTool("process_output", { title: "Read process output", inputSchema: { id: z.string() } }, async ({ id }) => { try { const workspaceRoot = activeWorkspaceRoot(root); if (!/^[a-z0-9]+-[a-f0-9]{10}$/.test(id)) throw new Error("Unknown process id."); const job = jobs.get(id) ?? JSON.parse(await fs.readFile(path.join(jobDirectory(dataPath, workspaceRoot), `${id}.json`), "utf8")); if (job.workspaceRoot ? job.workspaceRoot !== workspaceRoot : !within(workspaceRoot, job.cwd)) throw new Error("Unknown process id."); return result(JSON.stringify(publicJob(job), null, 2)); } catch (error) { return result(error.code === "ENOENT" ? "Unknown process id." : error.message, true); } });
  server.registerTool("stop_process", { title: "Stop background process", inputSchema: { id: z.string() } }, async ({ id }) => { const workspaceRoot = activeWorkspaceRoot(root); const job = jobs.get(id); if (!job || job.workspaceRoot !== workspaceRoot || job.status !== "running") return result("Process is not running in this workspace session.", true); job.status = "cancelled"; terminateJob(job); await persistJob(job, dataPath, workspaceRoot); return result(`Stop requested for ${id}.`); });
  server.registerTool("clear_finished_processes", { title: "Clear finished process records", inputSchema: {} }, async () => {
    try {
      const dir = jobDirectory(dataPath, root); await fs.mkdir(dir, { recursive: true });
      let removed = 0;
      for (const name of await fs.readdir(dir)) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(dir, name); const record = JSON.parse(await fs.readFile(file, "utf8"));
        if (record.status !== "running") { await fs.rm(file, { force: true }); jobs.delete(record.id); removed++; }
      }
      return result(`Cleared ${removed} finished job record(s).`);
    } catch (error) { return result(error.message, true); }
  });
  return async () => {
    const active = [...jobs.values()].filter(job => job.status === "running");
    for (const job of active) { job.status = "cancelled"; terminateJob(job); await persistJob(job, dataPath, job.workspaceRoot); }
  };
}

function registerGitTools(server, root) {
  async function repo(pathArg) {
    const workspaceRoot = activeWorkspaceRoot(root);
    const cwd = await resolveWorkspacePath(root, pathArg || ".");
    const check = await run("git", ["rev-parse", "--show-toplevel"], cwd, 10000);
    if (check.exitCode !== 0) throw new Error(check.output || "Not inside a Git repository.");
    const gitRoot = await fs.realpath(check.output);
    if (!within(workspaceRoot, gitRoot)) throw new Error("The Git repository root is outside the selected workspace.");
    return cwd;
  }
  const gitTool = (name, title, schema, action) => server.registerTool(name, { title, inputSchema: { path: z.string().optional(), ...schema } }, async args => { try { return result(await action(await repo(args.path), args)); } catch (error) { return result(error.message, true); } });
  gitTool("git_status", "Git status", {}, async cwd => (await run("git", ["status", "--branch", "--short"], cwd)).output || "Working tree clean.");
  gitTool("workspace_git_status", "Git status (compatibility alias)", {}, async cwd => (await run("git", ["status", "--branch", "--short"], cwd)).output || "Working tree clean.");
  gitTool("git_diff", "Git diff", { staged: z.boolean().optional(), file: z.string().optional() }, async (cwd, { staged, file }) => {
    if (file && (path.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /[*?\[\]:]/.test(file))) {
      throw new Error("git_diff file must be one literal workspace-relative path without wildcards, pathspec syntax, or parent traversal.");
    }
    const protectedPaths = [":(exclude).env", ":(exclude).env.*", ":(exclude)**/.env", ":(exclude)**/.env.*", ":(exclude).npmrc", ":(exclude)**/.npmrc", ":(exclude).pypirc", ":(exclude)**/.pypirc", ":(exclude).netrc", ":(exclude)**/.netrc", ":(exclude)credentials", ":(exclude)**/credentials", ":(exclude)credentials.json", ":(exclude)**/credentials.json", ":(exclude)secrets.json", ":(exclude)**/secrets.json", ":(exclude)**/*secret*", ":(exclude)**/*credential*", ":(exclude)**/*private-key*", ":(exclude)**/*.pem", ":(exclude)**/*.key", ":(exclude)**/*.p12", ":(exclude)**/*.pfx", ":(exclude)**/*.kdbx", ":(exclude)**/.ssh/**", ":(exclude)**/id_rsa*", ":(exclude)**/id_ed25519*"];
    const pathArgs = file ? ["--", file] : ["--", ".", ...protectedPaths];
    const diff = await run("git", ["diff", ...(staged ? ["--staged"] : []), ...pathArgs], cwd);
    if (diff.exitCode !== 0) throw new Error(diff.output);
    return diff.output || "No changes outside protected secret paths.";
  });
  gitTool("git_log", "Git history", { count: z.number().int().min(1).max(100).optional() }, async (cwd, { count = 20 }) => (await run("git", ["log", "--oneline", "--decorate", "-n", String(count)], cwd)).output);
  gitTool("git_branches", "List Git branches", {}, async cwd => (await run("git", ["branch", "--all", "--verbose"], cwd)).output);
  gitTool("git_stage", "Stage Git changes", { files: z.array(z.string()).min(1) }, async (cwd, { files }) => { const r = await run("git", ["add", "--", ...files], cwd); if (r.exitCode) throw new Error(r.output); return r.output || `Staged ${files.length} path(s).`; });
  gitTool("git_commit", "Create Git commit", { message: z.string().min(1), stage_all: z.boolean().optional() }, async (cwd, { message, stage_all = false }) => { if (stage_all) { const add = await run("git", ["add", "-A"], cwd); if (add.exitCode) throw new Error(add.output); } const r = await run("git", ["commit", "-m", message], cwd); if (r.exitCode) throw new Error(r.output); return r.output; });
  gitTool("git_branch", "Create or switch Git branch", { action: z.enum(["create", "switch", "create-and-switch"]), name: z.string().min(1) }, async (cwd, { action, name }) => { const args = action === "create" ? ["branch", name] : action === "switch" ? ["switch", name] : ["switch", "-c", name]; const r = await run("git", args, cwd); if (r.exitCode) throw new Error(r.output); return r.output || `Branch ${name} updated.`; });
  gitTool("git_restore", "Restore tracked files", { files: z.array(z.string()).min(1), source: z.string().optional() }, async (cwd, { files, source = "HEAD" }) => { const r = await run("git", ["restore", `--source=${source}`, "--worktree", "--", ...files], cwd); if (r.exitCode) throw new Error(r.output); return r.output || `Restored ${files.length} file(s) from ${source}.`; });
  gitTool("git_fetch", "Fetch from Git remote", { remote: z.string().optional() }, async (cwd, { remote = "origin" }) => { const r = await run("git", ["fetch", remote], cwd, 120000); if (r.exitCode) throw new Error(r.output); return r.output || `Fetched ${remote}.`; });
  gitTool("git_pull", "Pull from Git remote", { remote: z.string().optional(), branch: z.string().optional() }, async (cwd, { remote = "origin", branch }) => { const r = await run("git", ["pull", remote, ...(branch ? [branch] : [])], cwd, 120000); if (r.exitCode) throw new Error(r.output); return r.output; });
  gitTool("git_push", "Push to Git remote", { remote: z.string().optional(), branch: z.string().optional(), set_upstream: z.boolean().optional() }, async (cwd, { remote = "origin", branch, set_upstream = false }) => { const r = await run("git", ["push", ...(set_upstream ? ["-u"] : []), remote, ...(branch ? [branch] : [])], cwd, 120000); if (r.exitCode) throw new Error(r.output); return r.output; });
  gitTool("git_stash", "Manage Git stash", { action: z.enum(["list", "push", "pop", "apply", "drop"]), message: z.string().optional() }, async (cwd, { action, message }) => { const args = action === "list" ? ["stash", "list"] : action === "push" ? ["stash", "push", ...(message ? ["-m", message] : [])] : ["stash", action]; const r = await run("git", args, cwd); if (r.exitCode) throw new Error(r.output); return r.output || `git stash ${action} completed.`; });
}

function registerMemoryTools(server, root, dataPath) {
  const memoryFile = () => path.join(dataPath, "memory", `${crypto.createHash("sha256").update(activeWorkspaceRoot(root)).digest("hex").slice(0, 16)}.md`);
  server.registerTool("project_memory_read", { title: "Read project memory", inputSchema: {} }, async () => { try { return result(await fs.readFile(memoryFile(), "utf8")); } catch (error) { return error.code === "ENOENT" ? result("No project memory saved yet.") : result(error.message, true); } });
  server.registerTool("project_memory_remember", { title: "Remember project fact", inputSchema: { note: z.string().min(1).max(10000) } }, async ({ note }) => { try { const file = memoryFile(); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.appendFile(file, `${note.trim()}\n`, { encoding: "utf8", mode: 0o600 }); return result(`Saved project note to ${file}.`); } catch (error) { return result(error.message, true); } });
  server.registerTool("project_memory_replace", { title: "Replace project memory", inputSchema: { content: z.string().max(100000) } }, async ({ content }) => { try { const file = memoryFile(); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 }); return result("Project memory updated."); } catch (error) { return result(error.message, true); } });
  server.registerTool("project_context", { title: "Load project instructions", inputSchema: { max_depth: z.number().int().min(0).max(5).optional() } }, async ({ max_depth = 3 }) => {
    const names = new Set(["AGENTS.md", "CLAUDE.md", "README.md", ".cursorrules"]); const found = [];
    const workspaceRoot = activeWorkspaceRoot(root);
    async function walk(dir, depth) { if (depth > max_depth) return; let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { if (entry.isFile() && names.has(entry.name)) { const p = path.join(dir, entry.name); const stat = await fs.stat(p); if (stat.size <= 200000) found.push({ path: path.relative(workspaceRoot, p), content: await fs.readFile(p, "utf8") }); } else if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(path.join(dir, entry.name), depth + 1); } }
    await walk(workspaceRoot, 0); return result(JSON.stringify(found, null, 2) || "No context files found.");
  });
}

function registerCheckpointTools(server, root, dataPath) {
  server.registerTool("rewind", { title: "List, preview, or restore a checkpoint", description: "Checkpoints are recorded before Coworker MCP file writes. Shell changes are not tracked.", inputSchema: { action: z.enum(["list", "preview", "restore", "clear"]).optional(), checkpoint_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } }, async ({ action = "list", checkpoint_id, limit = 30 }) => {
    try {
      if (action === "clear") { await fs.rm(checkpointDir(root, dataPath), { recursive: true, force: true }); return result("Workspace checkpoints cleared."); }
      const entries = await readCheckpoints(root, dataPath);
      if (action === "list") return result(JSON.stringify(entries.slice(0, limit).map(({ id, createdAt, path: p, existed }) => ({ id, createdAt, path: p, existed })), null, 2));
      const entry = entries.find(x => x.id === checkpoint_id);
      if (!entry) throw new Error("Checkpoint not found.");
      const target = await resolveWorkspacePath(root, entry.path, { allowMissing: true });
      if (action === "preview") { let current = null; try { current = await fs.readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; } return result(JSON.stringify({ checkpoint: { id: entry.id, path: entry.path, createdAt: entry.createdAt }, currentExists: current !== null, savedExists: entry.existed, currentBytes: current?.length ?? 0, savedBytes: entry.content ? Buffer.from(entry.content, "base64").length : 0 }, null, 2)); }
      if (entry.existed) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.from(entry.content, "base64")); }
      else await fs.rm(target, { force: true });
      return result(`Restored ${entry.path} to checkpoint ${entry.id}.`);
    } catch (error) { return result(error.message, true); }
  });
}

export function registerWorkspaceTools(server, { workspacePath, dataPath }) {
  registerFileTools(server, workspacePath, dataPath);
  const stopJobs = registerShellTools(server, workspacePath, dataPath);
  registerGitTools(server, workspacePath);
  registerMemoryTools(server, workspacePath, dataPath);
  registerCheckpointTools(server, workspacePath, dataPath);
  return { async stop() { await stopJobs(); } };
}

export { result, run, listFiles, startJob, publicJob };
