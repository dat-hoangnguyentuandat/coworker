import { z } from "zod";
import { OperationJournal } from "./operation-journal.js";
import { result } from "./workspace-tools.js";

export function registerWorkbenchTools(server, { state, dataPath, approvals, mailbox, onChange }) {
  server.registerTool("workbench_status", {
    title: "Coworker Workbench status",
    description: "Show the selected workspace/task, task permission mode, available workspaces, and pending local approvals.",
    inputSchema: {}
  }, async () => { const snapshot = state.snapshot(); return result(JSON.stringify({ ...snapshot, pendingApprovals: approvals.pending(), mailbox: mailbox.summary(), dispatchMessages: snapshot.defaultTaskId ? mailbox.list(snapshot.defaultTaskId, 20) : [], shellBoundary: "Shell commands run with the current OS user's permissions; workspace cwd is not a sandbox." }, null, 2)); });

  server.registerTool("workbench_list_workspaces", {
    title: "List workspaces",
    description: "List projects explicitly registered in this Coworker installation.",
    inputSchema: {}
  }, async () => result(JSON.stringify(state.snapshot().workspaces, null, 2)));

  server.registerTool("workbench_list_tasks", {
    title: "List workspace tasks",
    description: "List persistent tasks for an explicitly registered workspace.",
    inputSchema: { workspace_id: z.string().optional() }
  }, async ({ workspace_id }) => {
    const snapshot = state.snapshot();
    const target = workspace_id || snapshot.defaultWorkspaceId;
    const tasks = snapshot.tasks.filter(task => task.workspaceId === target);
    if (!snapshot.workspaces.some(workspace => workspace.id === target)) return result("Workspace not found. Call workbench_list_workspaces first.", true);
    return result(JSON.stringify(tasks, null, 2));
  });

  server.registerTool("workbench_create_task", {
    title: "Create a coding task",
    description: "Create an isolated task record for an existing workspace. New tasks start in Ask mode and do not retarget an already-bound chat session; use a new conversation and workbench_bind_task to enter it.",
    inputSchema: { workspace_id: z.string().optional(), title: z.string().min(1).max(120) }
  }, async ({ workspace_id, title }) => {
    try { const task = await state.createTask(workspace_id || "", title); await new OperationJournal(dataPath, task.id).append({ type: "task_created", summary: task.title, permissionMode: task.permissionMode }); onChange?.(); return result(JSON.stringify(task, null, 2)); }
    catch (error) { return result(error.message, true); }
  });

  server.registerTool("workbench_bind_task", {
    title: "Bind this MCP session to a task",
    description: "Pin the current MCP/ChatGPT conversation to one task. Existing sessions cannot silently move to a different task. Use task_id on each tool call if the client has no stable session identifier.",
    inputSchema: { task_id: z.string() }
  }, async ({ task_id }, extra) => {
    try { const binding = state.bindSession(task_id, extra); await new OperationJournal(dataPath, task_id).append({ type: "session_bound", sessionKind: binding.sessionKey }); return result(JSON.stringify(binding, null, 2)); }
    catch (error) { return result(error.message, true); }
  });

  server.registerTool("workbench_history", {
    title: "Read task operation history",
    description: "Read recent Coworker tool operations for a task, including permission decisions and outcomes. File contents and credentials are redacted from the history.",
    inputSchema: { task_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }
  }, async ({ task_id, limit = 50 }, extra) => {
    try {
      const context = state.resolveTask(task_id, extra);
      return result(JSON.stringify(await new OperationJournal(dataPath, context.task.id).recent(limit), null, 2));
    } catch (error) { return result(error.message, true); }
  });
}
