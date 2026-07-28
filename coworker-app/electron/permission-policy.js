import { isSensitivePath } from "./path-policy.js";

const READ_ONLY_TOOLS = new Set([
  "workspace_list_files", "workspace_read_file", "workspace_search", "workspace_git_status",
  "workspace_analyze", "workspace_code_search", "workspace_review_changes", "workspace_instructions", "skill_inventory", "load_skill",
  "github_auth_status", "github_list_pull_requests", "github_view_pull_request", "github_pull_request_checks", "github_list_issues", "github_view_issue",
  "git_status", "git_diff", "git_log", "git_branches", "project_memory_read", "project_context",
  "process_status", "process_output", "mcp_upstream_status", "mcp_upstream_list_tools",
  "mcp_upstream_list_resources", "mcp_upstream_read_resource", "mcp_upstream_list_prompts",
  "mcp_upstream_get_prompt"
]);

const LOCAL_MUTATIONS = new Set([
  "workspace_write_file", "workspace_edit_file", "project_memory_remember", "project_memory_replace", "git_stage",
  "git_commit", "git_branch", "git_stash", "start_process", "stop_process", "clear_finished_processes"
]);

const HIGH_RISK = new Set(["run_command", "workspace_delete_file", "git_restore", "git_fetch", "git_pull", "git_push", "mcp_upstream_call_tool", "github_create_draft_pull_request", "github_merge_pull_request"]);

export function toolAnnotations(toolName, config = {}) {
  const readOnly = READ_ONLY_TOOLS.has(toolName) || ["workbench_status", "workbench_list_workspaces", "workbench_list_tasks", "workbench_history", "local_agent_status", "local_agent_output"].includes(toolName);
  const destructive = ["workspace_write_file", "workspace_delete_file", "project_memory_replace", "run_command", "git_restore", "git_push", "git_pull", "mcp_upstream_call_tool", "github_create_draft_pull_request", "github_merge_pull_request", "task_dispatch", "rewind", "clear_finished_processes"].includes(toolName);
  const openWorld = toolName === "run_command" || toolName === "start_process" || toolName.startsWith("github_") || toolName.startsWith("mcp_upstream_") || toolName === "task_dispatch";
  return {
    ...(config.annotations || {}),
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && destructive,
    idempotentHint: readOnly,
    openWorldHint: openWorld
  };
}

export function toolRisk(toolName, args = {}) {
  if (toolName === "task_dispatch") return args.action === "list" ? "read" : args.action === "send" ? "external" : "workspace_write";
  if (READ_ONLY_TOOLS.has(toolName)) return "read";
  if (toolName === "rewind") return ["restore", "clear"].includes(args.action) ? "destructive" : "read";
  if (HIGH_RISK.has(toolName)) return toolName === "git_push" || toolName === "git_pull" || toolName === "mcp_upstream_call_tool" ? "external" : "command";
  if (LOCAL_MUTATIONS.has(toolName)) return "workspace_write";
  return "unknown";
}

export function permissionDecision(task, toolName, args) {
  const risk = toolRisk(toolName, args);
  const sensitiveTarget = [args.path, args.file, ...(Array.isArray(args.files) ? args.files : [])].some(value => typeof value === "string" && isSensitivePath(value));
  if (task.permissionMode === "full") return { allowed: true, requiresApproval: false, risk };
  if (sensitiveTarget) return { allowed: false, requiresApproval: true, risk: "sensitive_path" };
  if (risk === "read") return { allowed: true, requiresApproval: false, risk };
  if (task.permissionMode === "auto" && risk === "workspace_write" && !["start_process", "git_commit", "git_branch", "git_stash", "stop_process", "clear_finished_processes"].includes(toolName)) {
    return { allowed: true, requiresApproval: false, risk };
  }
  return { allowed: false, requiresApproval: true, risk };
}

function safePreview(value, key = "") {
  if (/token|secret|password|authorization|api[_-]?key|credential/i.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]").replace(/\b(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 120);
  }
  if (Array.isArray(value)) return value.slice(0, 10).map(item => safePreview(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 12).map(([name, item]) => [name, safePreview(item, name)]));
  return value;
}

export function summarizeOperation(toolName, args = {}) {
  const path = typeof args.path === "string" ? args.path : "";
  const command = typeof args.command === "string" ? args.command
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(--?(?:token|password|secret|api[-_]?key))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1 [redacted]")
    .slice(0, 240) : "";
  const target = path ? ` on ${path}` : command ? `: ${command}` : "";
  const detail = value => String(value ?? "").replace(/\b(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 160);
  const labels = {
    workspace_write_file: "Write a workspace file",
    workspace_edit_file: `Edit a workspace file${path ? ` on ${path}` : ""}`,
    workspace_delete_file: `Delete a workspace file${path ? ` on ${path}` : ""}`,
    run_command: "Run a shell command",
    start_process: "Start a background process",
    git_stage: "Stage Git changes",
    git_commit: "Create a Git commit",
    git_branch: "Change Git branch",
    git_restore: "Restore Git files",
    git_fetch: "Fetch from a Git remote",
    git_pull: "Pull from a Git remote",
    git_push: "Push to a Git remote",
    git_stash: "Change the Git stash",
    git_stage: `Stage Git paths: ${Array.isArray(args.files) ? args.files.slice(0, 8).map(detail).join(", ") : ""}`,
    git_commit: `Create Git commit: ${detail(args.message)}`,
    git_branch: `${detail(args.action)} Git branch ${detail(args.name)}`,
    git_restore: `Restore Git paths: ${Array.isArray(args.files) ? args.files.slice(0, 8).map(detail).join(", ") : ""}`,
    git_fetch: `Fetch remote ${detail(args.remote || "origin")}`,
    git_pull: `Pull remote ${detail(args.remote || "origin")} ${detail(args.branch)}`,
    git_push: `Push remote ${detail(args.remote || "origin")} ${detail(args.branch)}`,
    mcp_upstream_call_tool: `Call upstream ${detail(args.server_id)} tool ${detail(args.tool_name)} with ${JSON.stringify(safePreview(args.arguments || {})).slice(0, 300)}`,
    github_create_draft_pull_request: `Create draft PR: ${detail(args.title)}${args.base ? ` → ${detail(args.base)}` : ""}`,
    github_merge_pull_request: `Merge PR #${detail(args.number)} with ${detail(args.method || "squash")}`,
    task_dispatch: args.action === "send" ? `Send task request to ${detail(args.to_task_id)}: ${JSON.stringify(safePreview(args.prompt)).slice(0, 300)}` : `${detail(args.action)} task message ${detail(args.message_id)}`,
    rewind: `Rewind action ${detail(args.action)} checkpoint ${detail(args.checkpoint_id)}`
  };
  return `${labels[toolName] || `${toolName}${target}`}`;
}
