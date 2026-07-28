import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { activeWorkspaceRoot } from "./execution-context.js";
import { resolveWorkspacePath, result } from "./workspace-tools.js";
import { isSensitivePath } from "./path-policy.js";

const execFileAsync = promisify(execFile);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv"]);
const LANGUAGE = new Map([[".ts", "TypeScript"], [".tsx", "TypeScript"], [".js", "JavaScript"], [".jsx", "JavaScript"], [".py", "Python"], [".go", "Go"], [".rs", "Rust"], [".java", "Java"], [".cs", "C#"], [".cpp", "C++"], [".c", "C"], [".h", "C/C++"], [".swift", "Swift"], [".rb", "Ruby"], [".php", "PHP"]]);
const SYMBOL_PATTERNS = [
  ["function", /\b(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/], ["class", /\bclass\s+([\w$]+)/],
  ["type", /\b(?:export\s+)?(?:interface|type|enum)\s+([\w$]+)/], ["python", /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(|^\s*class\s+([A-Za-z_]\w*)/],
  ["rust", /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(|^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/],
  ["go", /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/]
];

function inside(root, target) { const rel = path.relative(root, target); return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); }
async function collectFiles(root, start, maxFiles) {
  const result = [];
  async function visit(dir, depth) {
    if (depth > 20 || result.length >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length >= maxFiles) break;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await visit(path.join(dir, entry.name), depth + 1);
      else if (entry.isFile()) {
        const relative = path.relative(root, path.join(dir, entry.name));
        if (!isSensitivePath(relative)) result.push(relative);
      }
    }
  }
  await visit(start, 0);
  return result;
}

async function fileExists(file) { try { await fs.access(file); return true; } catch { return false; } }

function symbolsInFile(relativePath, text, limit) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (out.length >= limit) break;
    const line = lines[index];
    for (const [kind, pattern] of SYMBOL_PATTERNS) {
      const match = line.match(pattern);
      const name = match?.[1] || match?.[2];
      if (name) { out.push({ name, kind, path: relativePath, line: index + 1 }); break; }
    }
  }
  return out;
}

async function analyze(root, pathArg, maxFiles, maxSymbols) {
  const target = await resolveWorkspacePath(root, pathArg || ".");
  const files = await collectFiles(root, target, maxFiles + 1);
  const languages = {};
  const entrypoints = [];
  const symbols = [];
  for (const relativePath of files.slice(0, maxFiles)) {
    const ext = path.extname(relativePath).toLowerCase();
    const language = LANGUAGE.get(ext);
    if (language) languages[language] = (languages[language] || 0) + 1;
    if (/^(src\/)?(index|main|app|server)\.(ts|tsx|js|jsx|py|go|rs)$/.test(relativePath.replaceAll("\\", "/"))) entrypoints.push(relativePath);
    if (language && symbols.length < maxSymbols) {
      try {
        const full = path.join(root, relativePath);
        const stat = await fs.stat(full);
        if (stat.size <= 512 * 1024) symbols.push(...symbolsInFile(relativePath, await fs.readFile(full, "utf8"), maxSymbols - symbols.length));
      } catch {}
    }
  }
  const markers = [["Node.js", "package.json"], ["Python", "pyproject.toml"], ["Go", "go.mod"], ["Rust", "Cargo.toml"], ["Java/Maven", "pom.xml"], [".NET", "*.sln"]];
  const projectTypes = [];
  for (const [label, marker] of markers) {
    if (marker === "*.sln") { if (files.some(file => file.toLowerCase().endsWith(".sln"))) projectTypes.push(label); continue; }
    if (await fileExists(path.join(target, marker))) projectTypes.push(label);
  }
  return { root: pathArg || ".", filesScanned: Math.min(files.length, maxFiles), truncated: files.length > maxFiles, projectTypes, languages, entrypoints: entrypoints.slice(0, 40), symbols: symbols.slice(0, maxSymbols), symbolCountReturned: Math.min(symbols.length, maxSymbols), coverage: "Bounded lexical inventory; declarations and relationships are heuristic, not compiler facts." };
}

function findLines(files, query, intent, maxResults, caseSensitive) {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const hits = [];
  for (const file of files) {
    if (hits.length >= maxResults) break;
    const name = caseSensitive ? file : file.toLocaleLowerCase();
    if (intent === "path" && name.includes(needle)) { hits.push({ path: file, line: 0, text: "[path match]" }); continue; }
    if (intent === "path") continue;
  }
  return hits;
}

async function packageScripts(root) {
  try { const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")); return pkg.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts) : []; }
  catch { return []; }
}

export function registerCodeIntelligenceTools(server, defaultRoot) {
  server.registerTool("workspace_analyze", { title: "Analyze workspace structure", description: "Build a bounded local inventory of project types, languages, entrypoints, and common source declarations. Results are lexical hints, not compiler guarantees.", inputSchema: { path: z.string().optional(), max_files: z.number().int().min(1).max(10000).optional(), max_symbols: z.number().int().min(1).max(1000).optional() } }, async ({ path: rel = ".", max_files = 3000, max_symbols = 300 }) => {
    try { const root = activeWorkspaceRoot(defaultRoot); return result(JSON.stringify(await analyze(root, rel, max_files, max_symbols), null, 2)); }
    catch (error) { return result(error.message, true); }
  });

  server.registerTool("workspace_code_search", { title: "Search code by text, symbol, or reference", description: "Search bounded UTF-8 source files. Symbol and reference intents use lexical matching and do not replace an LSP/compiler index.", inputSchema: { query: z.string().min(1).max(200), intent: z.enum(["text", "symbol", "references", "path"]).optional(), path: z.string().optional(), case_sensitive: z.boolean().optional(), max_results: z.number().int().min(1).max(300).optional() } }, async ({ query, intent = "text", path: rel = ".", case_sensitive = false, max_results = 80 }) => {
    try {
      const root = activeWorkspaceRoot(defaultRoot); const start = await resolveWorkspacePath(root, rel); const files = await collectFiles(root, start, 10000); const hits = findLines(files, query, intent, max_results, case_sensitive);
      if (intent !== "path") {
        const needle = case_sensitive ? query : query.toLocaleLowerCase();
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const expression = intent === "symbol" ? new RegExp(`\\b(?:function|class|interface|type|enum|def|fn|func|struct|trait)\\s+${escaped}\\b`) : null;
        for (const file of files) {
          if (hits.length >= max_results) break;
          const target = path.join(root, file);
          try {
            const stat = await fs.stat(target); if (stat.size > 512 * 1024) continue;
            const buffer = await fs.readFile(target); if (buffer.includes(0)) continue;
            const lines = buffer.toString("utf8").split(/\r?\n/);
            for (let i = 0; i < lines.length && hits.length < max_results; i++) {
              const value = case_sensitive ? lines[i] : lines[i].toLocaleLowerCase();
              const match = intent === "symbol" ? (expression && expression.test(lines[i])) : intent === "references" ? new RegExp(`\\b${escaped}\\b`, case_sensitive ? "g" : "gi").test(lines[i]) : value.includes(needle);
              if (match) hits.push({ path: file, line: i + 1, text: lines[i].slice(0, 400) });
            }
          } catch {}
        }
      }
      return result(JSON.stringify({ query, intent, count: hits.length, truncated: hits.length >= max_results, matches: hits }, null, 2));
    } catch (error) { return result(error.message, true); }
  });

  server.registerTool("workspace_review_changes", { title: "Review workspace changes", description: "Summarize Git changes, changed paths, likely risk areas, and project scripts that may verify the change. This tool does not run commands.", inputSchema: { path: z.string().optional(), max_paths: z.number().int().min(1).max(100).optional() } }, async ({ path: rel = ".", max_paths = 50 }) => {
    try {
      const root = activeWorkspaceRoot(defaultRoot); const cwd = await resolveWorkspacePath(root, rel);
      const { stdout: top } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true, timeout: 10000 });
      const gitRoot = await fs.realpath(top.trim());
      if (!inside(root, gitRoot)) throw new Error("Git repository root is outside the selected workspace.");
      const [{ stdout: status }, { stdout: stat }, { stdout: names }] = await Promise.all([
        execFileAsync("git", ["status", "--short", "--branch"], { cwd, windowsHide: true, timeout: 10000 }),
        execFileAsync("git", ["diff", "HEAD", "--stat"], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }),
        execFileAsync("git", ["diff", "HEAD", "--name-only"], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
      ]);
      const untracked = status.split(/\r?\n/).slice(1).filter(line => line.length > 3 && line.slice(0, 2).includes("?" )).map(line => line.slice(3).trim());
      const allPaths = [...new Set([...names.split(/\r?\n/).filter(Boolean), ...untracked])];
      const paths = allPaths.slice(0, max_paths);
      const riskSignals = paths.flatMap(file => /package-lock|pnpm-lock|yarn\.lock|Cargo\.lock/.test(file) ? [`Dependency lockfile changed: ${file}`] : /auth|security|permission|secret/i.test(file) ? [`Security-sensitive path changed: ${file}`] : /migration|schema/i.test(file) ? [`Data/schema path changed: ${file}`] : []);
      const scripts = await packageScripts(root);
      const suggestions = ["typecheck", "lint", "test", "build"].filter(name => scripts.includes(name)).map(name => `npm run ${name}`);
      return result(JSON.stringify({ status: status.trim(), diffStat: stat.trim() || "No tracked changes", changedPaths: paths, pathListTruncated: allPaths.length > max_paths, riskSignals, suggestedChecks: suggestions, note: "Suggested checks are derived from package.json and were not executed." }, null, 2));
    } catch (error) { return result(error.message.includes("not found") ? "Git is unavailable or this workspace is not a Git repository." : error.message, true); }
  });
}
