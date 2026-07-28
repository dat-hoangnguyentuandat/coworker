import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { redactText } from "./secret-redaction.js";

function validateConfig(input = {}) {
  const tunnelId = String(input.tunnelId || "").trim();
  const runtimeApiKey = String(input.runtimeApiKey || "");
  const binaryPath = String(input.binaryPath || "").trim();
  const enabled = input.enabled === true;
  const label = String(input.label || "").trim().slice(0, 80);
  if (enabled && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) throw new Error("Tunnel ID must look like tunnel_ followed by 32 lowercase hex characters.");
  if (enabled && runtimeApiKey.length < 20) throw new Error("A tunnel Runtime API key is required.");
  if (enabled && !binaryPath) throw new Error("Select the tunnel-client executable or provide its command name.");
  return { enabled, label, tunnelId, runtimeApiKey, binaryPath };
}

function processEnvironment() {
  const names = ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  return Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]]));
}

function redactLog(value, apiKey) {
  const text = String(value);
  return redactText(apiKey ? text.replaceAll(apiKey, "[runtime key redacted]") : text).slice(0, 2000);
}

export class SecureTunnelManager extends EventEmitter {
  #child;
  #key = "";
  #config = { enabled: false, label: "", tunnelId: "", runtimeApiKey: "", binaryPath: "" };
  #status = "disabled";
  #message = "Secure MCP Tunnel is off.";
  #logs = [];

  snapshot() {
    return { key: this.#key, enabled: this.#config.enabled, label: this.#config.label, status: this.#status, message: this.#message, tunnelId: this.#config.tunnelId, binaryPath: this.#config.binaryPath, logs: [...this.#logs] };
  }

  reportError(message, enabled = true) {
    this.#status = "error";
    this.#message = String(message).slice(0, 1000);
    this.#config.enabled = enabled;
    this.#publish();
    return this.snapshot();
  }

  #publish() { this.emit("state", this.snapshot()); }

  #append(stream, chunk) {
    const text = redactLog(chunk.toString(), this.#config.runtimeApiKey).trim();
    if (!text) return;
    this.#logs.push({ at: new Date().toISOString(), stream, text });
    if (this.#logs.length > 100) this.#logs.splice(0, this.#logs.length - 100);
    this.#publish();
  }

  async configure(input, { key = "", mcpUrl, mcpToken } = {}) {
    const next = validateConfig(input);
    await this.stop();
    this.#key = String(key);
    this.#config = next;
    this.#logs = [];
    if (!next.enabled) {
      this.#status = "disabled";
      this.#message = "Secure MCP Tunnel is off.";
      this.#publish();
      return this.snapshot();
    }
    if (!mcpUrl || !mcpToken) throw new Error("Start the Coworker MCP server before starting the tunnel.");
    this.#status = "starting";
    this.#message = "Starting tunnel-client…";
    this.#publish();
    const env = {
      ...processEnvironment(),
      CONTROL_PLANE_TUNNEL_ID: next.tunnelId,
      CONTROL_PLANE_API_KEY: next.runtimeApiKey,
      MCP_SERVER_URL: mcpUrl,
      MCP_EXTRA_HEADERS: `Authorization: Bearer ${mcpToken}`
    };
    const child = spawn(next.binaryPath, ["run", "--health.listen-addr", "127.0.0.1:0", "--log.level=info", "--log.format=struct-text"], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    this.#child = child;
    child.stdout.on("data", chunk => this.#append("stdout", chunk));
    child.stderr.on("data", chunk => this.#append("stderr", chunk));
    child.once("spawn", () => { this.#status = "running"; this.#message = "tunnel-client process is running; control-plane readiness is not yet verified."; this.#publish(); });
    child.once("error", error => { if (this.#child !== child) return; this.#status = "error"; this.#message = error.message; this.#child = undefined; this.#publish(); });
    child.once("close", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#status = this.#config.enabled ? "error" : "disabled";
      this.#message = this.#config.enabled ? `tunnel-client exited (code ${code ?? "none"}, signal ${signal || "none"}).` : "Secure MCP Tunnel is off.";
      this.#publish();
    });
    await new Promise(resolve => {
      if (child.pid) return resolve();
      child.once("spawn", resolve);
      child.once("error", resolve);
      setTimeout(resolve, 5000).unref?.();
    });
    return this.snapshot();
  }

  async stop() {
    const child = this.#child;
    if (!child) {
      if (this.#config.enabled && this.#status !== "disabled") {
        this.#status = "stopped";
        this.#message = "MCP server stopped; tunnel-client is not running.";
        this.#publish();
      }
      return;
    }
    this.#child = undefined;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.unref();
    } else child.kill("SIGTERM");
    await new Promise(resolve => {
      child.once("close", resolve);
      setTimeout(resolve, 2500).unref?.();
    });
    this.#status = this.#config.enabled ? "stopped" : "disabled";
    this.#message = this.#config.enabled ? "MCP server stopped; tunnel-client is not running." : "Secure MCP Tunnel is off.";
    this.#publish();
  }
}

export { validateConfig as validateTunnelConfig };

// Runs one tunnel-client process per configured tunnel: each ChatGPT account
// gets its own tunnel id + Runtime API key while every process forwards to the
// same local MCP endpoint.
export class SecureTunnelPool extends EventEmitter {
  #managers = new Map();

  #publish() { this.emit("state", this.snapshot()); }

  snapshot() { return [...this.#managers.values()].map(manager => manager.snapshot()); }

  async configureAll(configs = [], { mcpUrl, mcpToken } = {}) {
    const wanted = new Map();
    for (const config of configs) {
      const key = String(config.tunnelId || "").trim() || `tunnel-${wanted.size + 1}`;
      if (!wanted.has(key)) wanted.set(key, config);
    }
    for (const [key, manager] of this.#managers) {
      if (!wanted.has(key)) { await manager.stop(); this.#managers.delete(key); }
    }
    for (const [key, config] of wanted) {
      let manager = this.#managers.get(key);
      if (!manager) {
        manager = new SecureTunnelManager();
        manager.on("state", () => this.#publish());
        this.#managers.set(key, manager);
      }
      await manager.configure(config, { key, mcpUrl, mcpToken });
    }
    this.#publish();
    return this.snapshot();
  }

  reportError(message, enabled = true) {
    for (const manager of this.#managers.values()) manager.reportError(message, enabled);
    return this.snapshot();
  }

  async stopAll() { await Promise.allSettled([...this.#managers.values()].map(manager => manager.stop())); }
}
