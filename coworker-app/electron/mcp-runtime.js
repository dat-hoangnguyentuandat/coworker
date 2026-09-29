import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { registerWorkspaceTools, result } from "./workspace-tools.js";
import { UpstreamManager } from "./upstream-manager.js";
import { WorkbenchState } from "./workbench-state.js";
import { ApprovalBroker } from "./approval-broker.js";
import { OperationJournal } from "./operation-journal.js";
import { permissionDecision, summarizeOperation, toolAnnotations } from "./permission-policy.js";
import { runInExecutionContext } from "./execution-context.js";
import { registerWorkbenchTools } from "./workbench-tools.js";
import { SecureTunnelPool } from "./secure-tunnel.js";
import { registerCodeIntelligenceTools } from "./code-intelligence.js";
import { registerInstructionTools } from "./instruction-tools.js";
import { registerGitHubTools } from "./github-tools.js";
import { TaskMailbox } from "./task-mailbox.js";
import { registerTaskDispatchTools } from "./task-dispatch-tools.js";
import { HandoffStore } from "./handoff-store.js";

const HOST = "127.0.0.1";
const PORT = 3210;

function withTaskId(shape = {}) {
  return {
    ...shape,
    task_id: z.string().optional().describe("Task ID from workbench_status or workbench_list_tasks. Bind the MCP session once with workbench_bind_task when the client provides a stable session.")
  };
}

export async function createMcpRuntime({ workspacePath, workspacePaths = [], dataPath, workbenchState, onApprovalRequired, onWorkbenchChange, onTunnelChange }) {
  const initialRoot = workspacePath ? await fs.realpath(workspacePath) : "";
  const storePath = dataPath || path.join(initialRoot, ".coworker-data");
  await fs.mkdir(storePath, { recursive: true });

  const state = workbenchState || new WorkbenchState(storePath);
  if (!workbenchState) await state.initialize(initialRoot);
  for (const root of workspacePaths) {
    if (!root || root === initialRoot) continue;
    try { await state.addWorkspace(root); }
    catch (error) { console.warn(`Skipping unavailable workspace ${root}: ${error.message}`); }
  }
  const approvals = new ApprovalBroker();
  const mailbox = new TaskMailbox(storePath, state);
  const handoffs = new HandoffStore(storePath);
  await mailbox.initialize();
  approvals.on("approval-required", approval => onApprovalRequired?.(approval));
  const tunnel = new SecureTunnelPool();
  tunnel.on("state", state => onTunnelChange?.(state));
  const accessToken = crypto.randomBytes(24).toString("base64url");
  const sessionTransports = new Map();
  const sessionServers = new Map();
  const workspaceTools = new Set();
  const upstreamManagers = new Set();
  let upstreamConfigs = [];

  const createSession = async () => {
    const server = new McpServer({ name: "coworker", version: "1.0.1" }, {
      capabilities: { tools: { listChanged: true } },
      instructions: "Coworker is a local workspace bridge, not a model runtime. Start with workbench_status and workbench_list_tasks. Bind this conversation to one task with workbench_bind_task when the client has a stable MCP/OpenAI session; otherwise pass the returned task_id to every tool call. Task permissions are enforced in the Electron main process. Ask is the default; an approved write/command waits for a local decision. Shell commands run with the current OS user's host permissions; workspace cwd alone is not a sandbox. workspace_analyze and workspace_code_search provide bounded lexical hints, not compiler/LSP guarantees. Rewind covers Coworker MCP file writes only; it does not track shell edits or conversation history. task_dispatch queues work for another conversation in the same workspace; it cannot wake a ChatGPT tab, so the owner must resume that conversation and claim the message."
    });
    const originalRegisterTool = server.registerTool.bind(server);

    server.registerTool = (name, config, handler) => {
      const annotatedConfig = { ...config, annotations: toolAnnotations(name, config) };
      if (name.startsWith("workbench_")) return originalRegisterTool(name, annotatedConfig, handler);
      const inputSchema = withTaskId(config.inputSchema || {});
      return originalRegisterTool(name, { ...annotatedConfig, inputSchema }, async (args, extra) => {
      const { task_id, ...toolArgs } = args || {};
      const context = state.resolveTask(task_id, extra);
      const task = context.task;
      const journal = new OperationJournal(storePath, task.id);
      const policy = permissionDecision(task, name, toolArgs);
      const summary = summarizeOperation(name, toolArgs);
      const startedAt = Date.now();
      await journal.append({ type: "tool_started", tool: name, summary, permissionMode: task.permissionMode, risk: policy.risk });

      if (policy.requiresApproval) {
        await journal.append({ type: "approval_requested", tool: name, summary, risk: policy.risk });
        const approved = await approvals.request({ task, toolName: name, summary, risk: policy.risk, signal: extra?.signal });
        if (!approved) {
          await journal.append({ type: "tool_denied", tool: name, summary, decision: "denied" });
          onWorkbenchChange?.();
          return result(`Coworker blocked this action because approval was denied or expired: ${summary}`, true);
        }
        await journal.append({ type: "approval_granted", tool: name, summary, decision: "approved" });
      }

      return runInExecutionContext({ ...context, dataPath: storePath, approvedOperation: policy.requiresApproval }, async () => {
        try {
          const toolResult = await handler(toolArgs, { ...(extra || {}), task_id });
          await journal.append({ type: "tool_finished", tool: name, summary, status: toolResult?.isError ? "error" : "ok", decision: policy.requiresApproval ? "approved" : "automatic", durationMs: Date.now() - startedAt });
          onWorkbenchChange?.();
          return toolResult;
        } catch (error) {
          await journal.append({ type: "tool_finished", tool: name, summary, status: "error", decision: policy.requiresApproval ? "approved" : "automatic", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
          onWorkbenchChange?.();
          throw error;
        }
      });
      });
    };

    const tools = registerWorkspaceTools(server, { workspacePath: initialRoot || state.getDefaultWorkspace()?.root || "", dataPath: storePath });
    workspaceTools.add(tools);
    registerCodeIntelligenceTools(server, state.getDefaultWorkspace()?.root || "");
    registerInstructionTools(server, state.getDefaultWorkspace()?.root || "");
    registerGitHubTools(server, state.getDefaultWorkspace()?.root || "");
    const upstream = new UpstreamManager(server);
    upstreamManagers.add(upstream);
    await upstream.configure(upstreamConfigs);
    registerWorkbenchTools(server, { state, dataPath: storePath, approvals, mailbox, onChange: onWorkbenchChange });
    registerTaskDispatchTools(server, { mailbox, onChange: onWorkbenchChange });
    server.registerTool("handoff_add_notes", {
      title: "Add model-authored handoff notes",
      description: "Save bounded advisory notes for the current task handoff. Notes are untrusted and never replace local workspace verification.",
      inputSchema: { objective: z.string().max(3000).optional(), completed: z.array(z.string().max(500)).max(30).optional(), inProgress: z.array(z.string().max(500)).max(30).optional(), nextSteps: z.array(z.string().max(500)).max(30).optional(), decisions: z.array(z.string().max(500)).max(30).optional(), blockers: z.array(z.string().max(500)).max(30).optional() }
    }, async (args, extra) => {
      try { const context = state.resolveTask(args.task_id, extra); const saved = await handoffs.addNotes(context.task.id, args, "mcp-session"); return result(JSON.stringify({ handoffId: saved.handoffId, status: "saved", source: "model" })); }
      catch (error) { return result(error.message, true); }
    });
    return { server, upstream };
  };

  const workbenchClients = new Map();
  const web = express();
  web.use(express.json({ limit: "2mb" }));
  web.get("/health", (_request, response) => response.json({ status: "ok", workspace: state.getDefaultWorkspace()?.name || "unselected", tasks: state.snapshot().tasks.length }));
  web.use("/mcp", (request, response, next) => {
    const received = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const expected = Buffer.from(accessToken);
    const actual = Buffer.from(received);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  web.post("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    let transport = sessionId ? sessionTransports.get(sessionId) : undefined;
    try {
      const isInitialize = !sessionId && (Array.isArray(request.body) ? request.body.some(item => item?.method === "initialize") : request.body?.method === "initialize");
      if (!transport && isInitialize) {
        const session = await createSession();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: id => { sessionTransports.set(id, transport); sessionServers.set(id, session.server); }
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) { sessionTransports.delete(id); sessionServers.delete(id); }
          upstreamManagers.delete(session.upstream);
        };
        await session.server.connect(transport);
      }
      if (!transport) { response.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid MCP session" }, id: null }); return; }
      await transport.handleRequest(request, response, request.body);
    } catch (error) { if (!response.headersSent) response.status(500).json({ error: error.message }); }
  });
  for (const method of ["get", "delete"]) web[method]("/mcp", async (request, response) => {
    const transport = sessionTransports.get(request.headers["mcp-session-id"]);
    if (!transport) { response.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid MCP session" }, id: null }); return; }
    try { await transport.handleRequest(request, response); }
    catch (error) { if (!response.headersSent) response.status(500).json({ error: error.message }); }
  });

  let httpServer;
  const workbenchToolAllowlist = new Set([
    "workspace_list_files", "workspace_read_file", "workspace_write_file", "workspace_edit_file", "workspace_delete_file", "workspace_search",
    "workspace_analyze", "workspace_code_search", "workspace_review_changes", "workspace_instructions", "skill_inventory", "load_skill",
    "git_status", "git_diff", "git_log", "git_branches", "git_stage", "git_commit", "git_branch", "git_restore", "git_fetch", "git_pull", "git_push", "git_stash",
    "run_command", "start_process", "process_status", "process_output", "stop_process", "clear_finished_processes",
    "project_memory_read", "project_memory_remember", "project_memory_replace", "rewind",
    "github_auth_status", "github_list_pull_requests", "github_view_pull_request", "github_pull_request_checks", "github_list_issues", "github_view_issue", "github_create_draft_pull_request", "github_merge_pull_request", "task_dispatch"
  ]);
  return {
    endpoint: `http://${HOST}:${PORT}/mcp`,
    accessToken,
    configureUpstreams: async servers => {
      upstreamConfigs = servers || [];
      await Promise.all([...upstreamManagers].map(manager => manager.configure(upstreamConfigs)));
      return [...upstreamManagers][0]?.statuses() || upstreamConfigs.map(item => ({ id: item.id, name: item.name || item.id, transport: item.transport, enabled: item.enabled !== false, connected: false, health: item.enabled === false ? "disabled" : "not_connected" }));
    },
    upstreamStatuses: () => [...upstreamManagers][0]?.statuses() || upstreamConfigs.map(item => ({ id: item.id, name: item.name || item.id, transport: item.transport, enabled: item.enabled !== false, connected: false, health: item.enabled === false ? "disabled" : "not_connected" })),
    configureTunnel: configs => tunnel.configureAll(configs, { mcpUrl: `http://${HOST}:${PORT}/mcp`, mcpToken: accessToken }),
    tunnelSnapshot: () => tunnel.snapshot(),
    reportTunnelError: message => tunnel.reportError(message, true),
    workbenchSnapshot: () => { const snapshot = state.snapshot(); return { ...snapshot, pendingApprovals: approvals.pending(), mailbox: mailbox.summary(), dispatchMessages: snapshot.defaultTaskId ? mailbox.list(snapshot.defaultTaskId, 20) : [] }; },
    taskHistory: async (taskId, limit = 30) => new OperationJournal(storePath, taskId).recent(limit),
    createHandoff: async (taskId, profileId = "") => {
      const context = state.resolveTask(taskId, {});
      const history = await new OperationJournal(storePath, taskId).recent(40);
      const snapshot = state.snapshot();
      const workspace = snapshot.workspaces.find(item => item.id === context.task.workspaceId);
      return handoffs.create({ profileId, workspace, task: context.task, operations: history, files: { touched: history.filter(event => event.tool?.startsWith("workspace_")).map(event => event.summary).slice(0, 40), unknownShellChanges: true }, checkpoints: [], confidence: history.length ? "medium" : "low" });
    },
    latestHandoff: taskId => handoffs.latest(taskId),
    async callWorkbenchTool(taskId, toolName, args = {}) {
      if (!workbenchToolAllowlist.has(toolName)) throw new Error("This tool is not exposed through the local Workbench IPC bridge.");
      state.resolveTask(taskId, {});
      let connection = workbenchClients.get(taskId);
      if (!connection) {
        const client = new Client({ name: "coworker-workbench", version: "1.0.1" });
        const clientTransport = new StreamableHTTPClientTransport(new URL(`http://${HOST}:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
        try { await client.connect(clientTransport); }
        catch (error) { await clientTransport.close().catch(() => {}); throw error; }
        connection = { client, transport: clientTransport };
        workbenchClients.set(taskId, connection);
      }
      return connection.client.callTool({ name: toolName, arguments: { ...args, task_id: taskId } });
    },
    addWorkspace: async root => { const item = await state.addWorkspace(root); onWorkbenchChange?.(); return item; },
    renameWorkspace: async (id, name) => { const item = await state.renameWorkspace(id, name); onWorkbenchChange?.(); return item; },
    removeWorkspace: async id => { const snapshot = await state.removeWorkspace(id); onWorkbenchChange?.(); return snapshot; },
    selectWorkspace: async id => { const snapshot = await state.selectWorkspace(id); onWorkbenchChange?.(); return snapshot; },
    createTask: async (workspaceId, title) => { const task = await state.createTask(workspaceId, title); await new OperationJournal(storePath, task.id).append({ type: "task_created", summary: task.title, permissionMode: task.permissionMode }); onWorkbenchChange?.(); return task; },
    renameTask: async (id, title) => { const task = await state.renameTask(id, title); onWorkbenchChange?.(); return task; },
    deleteTask: async taskId => { const task = await state.deleteTask(taskId); onWorkbenchChange?.(); return task; },
    selectTask: async id => { const task = await state.selectTask(id); await new OperationJournal(storePath, id).append({ type: "task_selected", summary: task.title }); onWorkbenchChange?.(); return task; },
    setTaskPermission: async (id, mode) => { const task = await state.setPermissionMode(id, mode); await new OperationJournal(storePath, id).append({ type: "permission_changed", permissionMode: mode }); onWorkbenchChange?.(); return task; },
    resolveApproval: (id, approved) => approvals.resolve(id, approved),
    async start() {
      if (httpServer) return;
      await new Promise((resolve, reject) => {
        httpServer = web.listen(PORT, HOST, resolve);
        httpServer.once("error", error => { httpServer = undefined; reject(error); });
      });
    },
    async stop() {
      approvals.close();
      await Promise.allSettled([...sessionTransports.values()].map(item => item.close()));
      await Promise.allSettled([...sessionServers.values()].map(item => item.close()));
      sessionTransports.clear();
      sessionServers.clear();
      await Promise.allSettled([...workbenchClients.values()].map(item => item.transport.close()));
      workbenchClients.clear();
      await tunnel.stopAll();
      await Promise.allSettled([...upstreamManagers].map(manager => manager.disconnectAll()));
      await Promise.allSettled([...workspaceTools].map(tools => tools.stop()));
      if (httpServer) {
        // Closing transports first releases long-lived Streamable HTTP/SSE
        // connections. Force any client that ignored the close notification
        // out before waiting for the listener, otherwise restart can race a
        // still-live server and tunnel carrying the previous bearer token.
        httpServer.closeAllConnections?.();
        await new Promise(resolve => httpServer.close(() => resolve()));
        httpServer = undefined;
      }
    }
  };
}
