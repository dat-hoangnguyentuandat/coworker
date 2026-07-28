import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { activeWorkspaceRoot } from "./execution-context.js";
import { resolveWorkspacePath, result } from "./workspace-tools.js";

const SKILL_ROOTS = [
  { id: "workspace-agents", source: "workspace", path: root => path.join(root, ".agents", "skills") },
  { id: "workspace-claude", source: "workspace", path: root => path.join(root, ".claude", "skills") },
  { id: "workspace-codex", source: "workspace", path: root => path.join(root, ".codex", "skills") },
  { id: "user-codex", source: "user", path: () => path.join(os.homedir(), ".codex", "skills") },
  { id: "user-claude", source: "user", path: () => path.join(os.homedir(), ".claude", "skills") },
  { id: "user-agents", source: "user", path: () => path.join(os.homedir(), ".agents", "skills") }
];

function inside(root, target) { const rel = path.relative(root, target); return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); }
function globRegex(pattern) {
  let output = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i, i + 3) === "**/") { output += "(?:.*/)?"; i += 2; }
    else if (pattern.slice(i, i + 2) === "**") { output += ".*"; i++; }
    else if (pattern[i] === "*") output += "[^/]*";
    else if (pattern[i] === "?") output += "[^/]";
    else output += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${output}$`);
}
function ruleApplies(content, relativeTarget) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter || !/^paths\s*:/m.test(frontmatter[1])) return true;
  const section = frontmatter[1].split(/^paths\s*:\s*$/m)[1] || "";
  const patterns = [...section.matchAll(/^\s*-\s*["']?([^"'\r\n]+)["']?\s*$/gm)].map(match => match[1].trim()).filter(Boolean);
  return patterns.length === 0 || patterns.some(pattern => globRegex(pattern).test(relativeTarget.replaceAll("\\", "/")));
}
async function skillFiles(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter(item => item.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item.name)).map(item => ({ name: item.name, file: path.join(root, item.name, "SKILL.md") }));
}

async function listSkills(workspaceRoot) {
  const out = [];
  for (const source of SKILL_ROOTS) {
    const root = source.path(workspaceRoot);
    let realRoot;
    try { realRoot = await fs.realpath(root); } catch { continue; }
    for (const skill of await skillFiles(realRoot)) {
      try {
        const realFile = await fs.realpath(skill.file);
        if (!inside(realRoot, realFile)) continue;
        const content = await fs.readFile(realFile, "utf8");
        const description = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.slice(0, 240) || "";
        out.push({ name: skill.name, source: source.id, scope: source.source, description });
      } catch {}
    }
  }
  return out;
}

async function loadSkill(workspaceRoot, sourceId, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) throw new Error("Invalid skill name.");
  const source = SKILL_ROOTS.find(item => item.id === sourceId);
  if (!source) throw new Error("Unknown skill source. Call skill_inventory first.");
  const root = source.path(workspaceRoot);
  const realRoot = await fs.realpath(root);
  const target = await fs.realpath(path.join(realRoot, name, "SKILL.md"));
  if (!inside(realRoot, target)) throw new Error("Skill path escapes the configured skill folder.");
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > 100 * 1024) throw new Error("Skill file must be a regular file no larger than 100 KiB.");
  return (await fs.readFile(target, "utf8")).slice(0, 40000);
}

export function registerInstructionTools(server, defaultRoot) {
  server.registerTool("workspace_instructions", { title: "Load workspace instructions", description: "Read AGENTS.md, CLAUDE.md, CLAUDE.local.md and .claude/rules Markdown files from the workspace and the target file's ancestor folders.", inputSchema: { path: z.string().optional(), max_bytes: z.number().int().min(1000).max(100000).optional() } }, async ({ path: rel = ".", max_bytes = 30000 }) => {
    try {
      const root = activeWorkspaceRoot(defaultRoot); const target = await resolveWorkspacePath(root, rel); const targetDir = (await fs.stat(target)).isDirectory() ? target : path.dirname(target);
      const candidates = new Set(["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"]); const dirs = [];
      let current = targetDir;
      while (inside(root, current)) { dirs.unshift(current); if (current === root) break; current = path.dirname(current); }
      const found = []; let total = 0;
      for (const dir of dirs) {
        for (const name of candidates) {
          const file = path.join(dir, name);
          try { const real = await fs.realpath(file); if (!inside(root, real)) continue; const stat = await fs.stat(real); const remaining = max_bytes - total; if (stat.isFile() && remaining > 0) { const content = (await fs.readFile(real, "utf8")).slice(0, remaining); found.push({ path: path.relative(root, real), content }); total += Buffer.byteLength(content); } } catch {}
        }
        const rulesDir = path.join(dir, ".claude", "rules");
        try {
          const entries = await fs.readdir(rulesDir, { withFileTypes: true });
          for (const entry of entries.filter(item => item.isFile() && item.name.endsWith(".md")).slice(0, 20)) {
            const file = path.join(rulesDir, entry.name); const real = await fs.realpath(file); if (!inside(root, real)) continue; const stat = await fs.stat(real); const remaining = max_bytes - total;
            if (stat.size <= remaining && remaining > 0) { const content = await fs.readFile(real, "utf8"); if (ruleApplies(content, path.relative(root, target))) { found.push({ path: path.relative(root, real), content }); total += stat.size; } }
          }
        } catch {}
      }
      return result(JSON.stringify({ target: path.relative(root, target), files: found, truncated: total >= max_bytes }, null, 2));
    } catch (error) { return result(error.message, true); }
  });

  server.registerTool("skill_inventory", { title: "List available project and user skills", description: "Discover reusable SKILL.md instructions in workspace and user skill folders. Bodies are loaded only on demand.", inputSchema: {} }, async () => {
    try { return result(JSON.stringify(await listSkills(activeWorkspaceRoot(defaultRoot)), null, 2)); }
    catch (error) { return result(error.message, true); }
  });

  server.registerTool("load_skill", { title: "Load a coding skill", description: "Load one named skill from skill_inventory. Skill text is guidance, not a security boundary.", inputSchema: { name: z.string().min(1).max(80), source: z.enum(SKILL_ROOTS.map(item => item.id)) } }, async ({ name, source }) => {
    try { return result(await loadSkill(activeWorkspaceRoot(defaultRoot), source, name)); }
    catch (error) { return result(error.message, true); }
  });
}
