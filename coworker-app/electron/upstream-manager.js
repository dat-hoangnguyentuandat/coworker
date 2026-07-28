import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import { redactMcpResult, redactText } from "./secret-redaction.js";

function textResult(value, isError = false) {
  const text = redactText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export function validateUpstreamServers(input) {
  if (!Array.isArray(input)) throw new Error("Upstream configuration must be an array.");
  const ids = new Set();
  return input.map(server => {
    const id = String(server.id ?? "").trim();
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(id)) throw new Error(`Invalid upstream id: ${id || "(empty)"}`);
    if (ids.has(id)) throw new Error(`Duplicate upstream id: ${id}`);
    ids.add(id);
    if (server.transport !== "stdio" && server.transport !== "http") throw new Error(`${id}: transport must be stdio or http.`);
    if (server.transport === "stdio" && !String(server.command ?? "").trim()) throw new Error(`${id}: command is required.`);
    if (server.transport === "http") {
      const url = new URL(String(server.url ?? ""));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${id}: use a valid HTTP(S) URL without embedded credentials.`);
    }
    const httpTransport = server.httpTransport || "streamable_http";
    if (!["streamable_http", "sse"].includes(httpTransport)) throw new Error(`${id}: HTTP transport must be streamable_http or sse.`);
    return {
      id,
      name: String(server.name || id).trim(),
      enabled: server.enabled !== false,
      transport: server.transport,
      command: server.command ? String(server.command) : "",
      args: Array.isArray(server.args) ? server.args.map(String) : [],
      cwd: server.cwd ? String(server.cwd) : undefined,
      env: server.env && typeof server.env === "object" ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [String(k), String(v)])) : {},
      url: server.url ? String(server.url) : "",
      httpTransport,
      bearerToken: server.bearerToken ? String(server.bearerToken) : "",
      headers: server.headers && typeof server.headers === "object" ? Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [String(k), String(v)])) : {}
    };
  });
}

export class UpstreamManager {
  #clients = new Map();
  #servers = [];

  constructor(mcpServer) {
    this.mcpServer = mcpServer;
    this.#registerTools();
  }

  async configure(input) {
    const configs = validateUpstreamServers(input);
    await this.disconnectAll();
    this.#servers = configs;
    return this.statuses();
  }

  async #connect(config) {
    const existing = this.#clients.get(config.id);
    if (existing) return existing;
    let transport;
    if (config.transport === "stdio") {
      transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...getDefaultEnvironment(), ...config.env }, stderr: "pipe" });
    } else {
      const headers = { ...config.headers };
      if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
      if (config.httpTransport === "sse") {
        const fetchWithHeaders = (url, init = {}) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...headers } });
        transport = new SSEClientTransport(new URL(config.url), { requestInit: { headers }, eventSourceInit: { fetch: fetchWithHeaders }, fetch: fetchWithHeaders });
      } else {
        transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
      }
    }
    const client = new Client({ name: "coworker", version: "1.0.0" });
    try { await client.connect(transport); }
    catch (error) { await transport.close().catch(() => {}); throw error; }
    const record = { config, client, transport, connectedAt: new Date().toISOString() };
    this.#clients.set(config.id, record);
    return record;
  }

  async disconnectAll() {
    const active = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(active.map(record => record.transport.close()));
  }

  statuses() {
    return this.#servers.map(config => {
      const record = this.#clients.get(config.id);
      return { id: config.id, name: config.name, transport: config.transport, enabled: config.enabled, connected: Boolean(record), health: !config.enabled ? "disabled" : record ? "connected" : config.lastError ? "unreachable" : "not_connected", connectedAt: record?.connectedAt, error: config.lastError || undefined };
    });
  }

  async #record(id) {
    const config = this.#servers.find(item => item.id === id);
    if (!config) throw new Error(`Unknown upstream server: ${id}`);
    if (!config.enabled) throw new Error(`Upstream server ${id} is disabled.`);
    try {
      const record = await this.#connect(config);
      config.lastError = "";
      return record;
    } catch (error) {
      config.lastError = error.message;
      throw error;
    }
  }

  #registerTools() {
    this.mcpServer.registerTool("mcp_upstream_status", { title: "List upstream MCP connections", inputSchema: {} }, async () => textResult(this.statuses()));
    this.mcpServer.registerTool("mcp_upstream_list_tools", { title: "List tools on an upstream MCP server", inputSchema: { server_id: z.string() } }, async ({ server_id }) => {
      try { const { client } = await this.#record(server_id); return textResult(await client.listTools()); }
      catch (error) { return textResult(error.message, true); }
    });
    this.mcpServer.registerTool("mcp_upstream_call_tool", { title: "Call a tool on an upstream MCP server", inputSchema: { server_id: z.string(), tool_name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() } }, async ({ server_id, tool_name, arguments: args = {} }) => {
      try { const { client } = await this.#record(server_id); return redactMcpResult(await client.callTool({ name: tool_name, arguments: args })); }
      catch (error) { return textResult(error.message, true); }
    });
    this.mcpServer.registerTool("mcp_upstream_list_resources", { title: "List upstream MCP resources", inputSchema: { server_id: z.string() } }, async ({ server_id }) => {
      try { const { client } = await this.#record(server_id); return textResult(await client.listResources()); }
      catch (error) { return textResult(error.message, true); }
    });
    this.mcpServer.registerTool("mcp_upstream_read_resource", { title: "Read an upstream MCP resource", inputSchema: { server_id: z.string(), uri: z.string() } }, async ({ server_id, uri }) => {
      try { const { client } = await this.#record(server_id); return textResult(await client.readResource({ uri })); }
      catch (error) { return textResult(error.message, true); }
    });
    this.mcpServer.registerTool("mcp_upstream_list_prompts", { title: "List upstream MCP prompts", inputSchema: { server_id: z.string() } }, async ({ server_id }) => {
      try { const { client } = await this.#record(server_id); return textResult(await client.listPrompts()); }
      catch (error) { return textResult(error.message, true); }
    });
    this.mcpServer.registerTool("mcp_upstream_get_prompt", { title: "Get an upstream MCP prompt", inputSchema: { server_id: z.string(), name: z.string(), arguments: z.record(z.string(), z.string()).optional() } }, async ({ server_id, name, arguments: args = {} }) => {
      try { const { client } = await this.#record(server_id); return textResult(await client.getPrompt({ name, arguments: args })); }
      catch (error) { return textResult(error.message, true); }
    });
  }
}
