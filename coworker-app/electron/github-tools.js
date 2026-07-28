import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { activeWorkspaceRoot } from "./execution-context.js";
import { resolveWorkspacePath, result } from "./workspace-tools.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 20000;

async function repository(root, pathArg) {
  const workspace = activeWorkspaceRoot(root);
  const cwd = await resolveWorkspacePath(workspace, pathArg || ".");
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true, timeout: 10000 });
    const gitRoot = await fs.realpath(stdout.trim());
    const relative = path.relative(workspace, gitRoot);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Git repository root is outside the selected workspace.");
    return cwd;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Git is not installed or not on PATH.");
    throw error;
  }
}

async function gh(args, cwd, { json = true, allowNonZero = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, { cwd, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
    if (json && output) return JSON.stringify(JSON.parse(output), null, 2).slice(0, MAX_OUTPUT);
    return output.slice(0, MAX_OUTPUT) || "Command completed with no output.";
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("GitHub CLI (gh) is not installed or is not on PATH.");
    const message = `${error.stderr || error.stdout || error.message}`.trim().slice(0, 4000);
    if (allowNonZero && (error.stdout || error.stderr)) return message || "GitHub check command returned a non-zero status.";
    throw new Error(message);
  }
}

export function registerGitHubTools(server, defaultRoot) {
  const tool = (name, title, description, schema, args, json = true, allowNonZero = false) => server.registerTool(name, { title, description, inputSchema: { path: z.string().optional(), ...schema } }, async input => {
    try { const cwd = await repository(defaultRoot, input.path); return result(await gh([...args(input)], cwd, { json, allowNonZero })); }
    catch (error) { return result(error.message, true); }
  });
  const listFields = "number,title,state,headRefName,baseRefName,url,reviewDecision";
  tool("github_auth_status", "Check GitHub CLI authentication", "Show whether the local GitHub CLI is authenticated. Coworker does not read or store GitHub tokens.", {}, () => ["auth", "status"], false);
  tool("github_list_pull_requests", "List GitHub pull requests", "List pull requests in the workspace repository.", { state: z.enum(["open", "closed", "merged", "all"]).optional(), limit: z.number().int().min(1).max(100).optional() }, ({ state = "open", limit = 30 }) => ["pr", "list", "--state", state, "--limit", String(limit), "--json", listFields]);
  tool("github_view_pull_request", "View a GitHub pull request", "Read one pull request's description, branch, review, and labels.", { number: z.number().int().positive() }, ({ number }) => ["pr", "view", String(number), "--json", "number,title,body,state,url,headRefName,baseRefName,reviewDecision,assignees,labels"]);
  tool("github_pull_request_checks", "Read GitHub pull request checks", "Read check results for one pull request or the current branch. A failing check is returned as data.", { number: z.number().int().positive().optional() }, ({ number }) => ["pr", "checks", ...(number ? [String(number)] : [])], false, true);
  tool("github_list_issues", "List GitHub issues", "List repository issues with optional state and text search.", { state: z.enum(["open", "closed", "all"]).optional(), limit: z.number().int().min(1).max(100).optional(), search: z.string().max(200).optional() }, ({ state = "open", limit = 30, search }) => ["issue", "list", "--state", state, "--limit", String(limit), ...(search ? ["--search", search] : []), "--json", "number,title,state,url,labels,assignees"]);
  tool("github_view_issue", "View a GitHub issue", "Read an issue description, labels, assignees, and comments.", { number: z.number().int().positive() }, ({ number }) => ["issue", "view", String(number), "--json", "number,title,body,state,url,labels,assignees,comments"]);
  tool("github_create_draft_pull_request", "Create a draft pull request", "Create a draft PR from the current branch. GitHub CLI may push the branch if needed; this operation always requires local approval.", { title: z.string().min(1).max(256), body: z.string().max(20000), base: z.string().max(200).optional(), head: z.string().max(200).optional() }, ({ title, body, base, head }) => ["pr", "create", "--draft", "--title", title, "--body", body, ...(base ? ["--base", base] : []), ...(head ? ["--head", head] : [])], false);
  tool("github_merge_pull_request", "Merge a pull request", "Merge a pull request using the chosen strategy. This operation always requires local approval.", { number: z.number().int().positive(), method: z.enum(["merge", "squash", "rebase"]).optional(), delete_branch: z.boolean().optional() }, ({ number, method = "squash", delete_branch = false }) => ["pr", "merge", String(number), `--${method}`, ...(delete_branch ? ["--delete-branch"] : [])], false);
}
