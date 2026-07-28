import { BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentScript } from "./auto-login-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_URL = "https://chatgpt.com/auth/login";
const OVERALL_TIMEOUT_MS = 3 * 60 * 1000;
const STEP_TIMEOUT_MS = 45 * 1000;
// Google accounts are finished by hand in the shown window; allow a long wait.
const MANUAL_TIMEOUT_MS = 5 * 60 * 1000;

function isCredentialUrl(url) {
  return url.includes("auth.openai.com") ||
    url.includes("auth0.openai.com") ||
    url.includes("accounts.google.com") ||
    /^https:\/\/chatgpt\.com\/auth\/(login|signin)(?:[/?#]|$)/.test(url);
}

function isMainPage(url) {
  return /^https:\/\/chatgpt\.com\/?(\?|#|$)/.test(url);
}

export class AutoLoginManager {
  #registry;
  #profileRegistry;
  #notify;
  #queue = [];
  #current = null;
  #results = [];
  #onProfileSessionChanged = () => {};
  #handoffStore = null;
  #userAgent = () => undefined;

  constructor({ registry, profileRegistry, notify, onProfileSessionChanged, handoffStore, userAgent }) {
    this.#registry = registry;
    this.#profileRegistry = profileRegistry;
    this.#notify = notify;
    this.#onProfileSessionChanged = typeof onProfileSessionChanged === "function" ? onProfileSessionChanged : () => {};
    this.#handoffStore = handoffStore || null;
    this.#userAgent = typeof userAgent === "function" ? userAgent : () => undefined;
  }

  state() {
    return {
      running: Boolean(this.#current) || this.#queue.length > 0,
      queue: this.#queue.map(item => item.accountId),
      current: this.#current ? { accountId: this.#current.accountId, profileId: this.#current.profileId, email: this.#current.email, step: this.#current.step, url: this.#current.url } : null,
      results: this.#results.slice(-20)
    };
  }

  #emit() { this.#notify(this.state()); }

  // Starts a batch. Each entry binds one account to one chat profile.
  // Ephemeral jobs ({accountId:"", email, type}) skip the registry entirely.
  async run(items = []) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("No accounts selected for auto login.");
    const snapshot = this.#registry.snapshot().accounts;
    for (const item of items) {
      if (item.ephemeral) {
        const isGoogle = item.type === "google";
        if (!isGoogle && !String(item.email || "").includes("@")) throw new Error("Ephemeral auto-login needs a valid email.");
        if (!this.#queue.some(queued => queued.email === item.email)) {
          this.#queue.push({ accountId: "", profileId: item.profileId || this.#profileRegistry.active().id, email: isGoogle ? "Google" : item.email, type: isGoogle ? "google" : "openai" });
        }
        continue;
      }
      const account = snapshot.find(entry => entry.id === item.accountId);
      if (!account) throw new Error(`Auto-login account ${item.accountId} not found.`);
      const profileId = item.profileId || account.profileId || "";
      if (!profileId) throw new Error(`Tài khoản ${account.email} chưa gắn profile. Chọn profile (dropdown) trước khi đăng nhập.`);
      if (this.#queue.some(queued => queued.accountId === item.accountId)) {
        this.#queue = this.#queue.filter(queued => queued.accountId !== item.accountId);
      }
      this.#queue.push({ accountId: item.accountId, profileId, email: account.email, type: account.type });
    }
    this.#results = [];
    this.#emit();
    if (!this.#current) this.#next();
    return this.state();
  }

  stop() {
    for (const item of this.#queue) this.#results.push({ accountId: item.accountId, email: item.email, profileId: item.profileId, status: "cancelled" });
    this.#queue = [];
    if (this.#current) this.#finishCurrent("cancelled");
    else this.#emit();
    return this.state();
  }

  #next() {
    const item = this.#queue.shift();
    if (!item) { this.#emit(); return; }
    this.#current = { ...item, step: "starting", url: "", manual: false };
    this.#emit();
    this.#openWindow(this.#current).catch(error => this.#finishCurrent("error", error.message));
  }

  #finishCurrent(status, detail = "") {
    const current = this.#current;
    if (!current) return;
    // Clear #current before destroy(): the synchronous "closed" event would
    // otherwise re-enter this method and record a duplicate result.
    this.#current = null;
    if (current.win && !current.win.isDestroyed()) {
      // Hide before destroy so Windows doesn't flash the windows behind the app.
      try { if (current.win.isVisible()) current.win.hide(); } catch {}
      setTimeout(() => { if (!current.win.isDestroyed()) current.win.destroy(); }, 0);
    }
    if (current.timeout) clearTimeout(current.timeout);
    if (current.stepTimeout) clearTimeout(current.stepTimeout);
    // A successful login wrote a new session into this profile's partition:
    // notify the host so any live ChatGPT view on that profile reloads.
    if (status === "success") {
      // One active account per profile: this account now owns the profile's
      // session; release any other account still bound to it ("none").
      if (current.accountId) {
        try { this.#registry.claimProfile(current.accountId, current.profileId); } catch (error) { console.warn(`[AutoLogin] claim profile failed: ${error.message}`); }
      }
      try { this.#onProfileSessionChanged(current.profileId); } catch (error) { console.warn(`[AutoLogin] reload hook failed: ${error.message}`); }
    }
    // Manual Google job that reached the ChatGPT home: discover the session
    // email from the profile's API session and remember it as an account.
    if (status === "success" && current.type === "google" && !current.accountId) {
      const email = current.sessionEmail || "";
      if (email.includes("@")) {
        this.#registry.addPasswordless(email, "google", current.profileId)
          .then(snapshot => { this.#results.push({ accountId: "", email, profileId: current.profileId, status: "saved", detail: "google-manual" }); this.#notify(snapshot); })
          .catch(error => console.warn(`[AutoLogin] save google account failed: ${error.message}`));
      } else {
        this.#results.push({ accountId: "", email: current.email, profileId: current.profileId, status: "success", detail: "google-manual (email không đọc được)" });
      }
    }
    if (status) this.#results.push({ accountId: current.accountId, email: current.email, profileId: current.profileId, status, detail: `${current.step}${detail ? `: ${detail}` : ""}` });
    this.#emit();
    this.#next();
  }

  async #openWindow(job) {
    const profile = this.#profileRegistry.snapshot().profiles.find(entry => entry.id === job.profileId);
    if (!profile) throw new Error(`Chat profile ${job.profileId} not found.`);
    await new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 750,
        webPreferences: {
          partition: profile.partition,
          preload: path.join(here, "preload-auto-login.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      job.win = win;
      job.timeout = setTimeout(() => this.#finishCurrent("timeout", "overall-timeout"), OVERALL_TIMEOUT_MS);
      const armStepTimeout = () => {
        if (job.stepTimeout) clearTimeout(job.stepTimeout);
        job.stepTimeout = setTimeout(() => this.#finishCurrent("timeout", `stuck-at-${job.step}`), STEP_TIMEOUT_MS);
      };
      job.armStepTimeout = armStepTimeout;

      win.webContents.on("did-navigate", (_event, url) => this.#onNavigate(job, url));
      win.webContents.on("did-navigate-in-page", (_event, url) => this.#onNavigate(job, url));
      win.webContents.on("console-message", (_event, details) => { if (details.level >= 2) console.error(`[AutoLogin:${job.email}] ${details.message}`); });
      win.on("closed", () => { if (this.#current === job) this.#finishCurrent("error", "window-closed"); });
      win.loadURL(LOGIN_URL).then(resolve, reject);
    });
  }

  // Reads the signed-in email from the profile session. /api/auth/session is
  // cookie-based (the /backend-api endpoints need a Bearer token instead).
  // Retries once: right after landing, the endpoint can briefly return nothing
  // — treating that empty read as "success" is how a stale session once got
  // reported as a completed login.
  async #readSessionEmail(job) {
    const script = `fetch("/api/auth/session", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => (d && d.user && d.user.email) ? d.user.email : "")
      .catch(() => "")`;
    const read = () => (job.win && !job.win.isDestroyed() ? job.win.webContents.executeJavaScript(script, true).catch(() => "") : Promise.resolve(""));
    let email = await read();
    if (!email) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      email = await read();
    }
    job.sessionEmail = typeof email === "string" ? email : "";
  }

  // Signs the previous ChatGPT account out of this partition for real. The
  // server-side /backend-api/logout regularly leaves the session cookie alive,
  // which bounced /auth/login straight back to the OLD account — so after the
  // best-effort server call every chatgpt.com/openai.com cookie is removed
  // from the partition directly. Google cookies are deliberately kept: the
  // "Continue with Google" flow stays one click for Google-type accounts.
  async #signOutPrevious(job) {
    const script = `fetch("/api/auth/session", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d || !d.accessToken) return "no-token";
        return fetch("/backend-api/logout", { method: "POST", credentials: "include", headers: { Authorization: "Bearer " + d.accessToken } })
          .then(() => "logged-out")
          .catch(() => "logout-request-failed");
      })
      .catch(() => "session-read-failed")`;
    try { if (job.win && !job.win.isDestroyed()) await job.win.webContents.executeJavaScript(script, true); } catch {}
    const profile = this.#profileRegistry.snapshot().profiles.find(entry => entry.id === job.profileId);
    if (!profile) return;
    const partitionSession = session.fromPartition(profile.partition);
    const all = await partitionSession.cookies.get({}).catch(() => []);
    const doomed = all.filter(cookie => /(^|\.)chatgpt\.com$/.test(cookie.domain || "") || /(^|\.)openai\.com$/.test(cookie.domain || ""));
    for (const cookie of doomed) {
      await partitionSession.cookies.remove(`https://${String(cookie.domain).replace(/^\./, "")}${cookie.path || "/"}`, cookie.name).catch(() => {});
    }
    console.log(`[AutoLogin:${job.email}] signed out previous account (${doomed.length} chatgpt/openai cookies removed, google cookies kept)`);
  }

  // Captures the outgoing account's latest conversation on this profile's
  // partition and queues it as a pending profile handoff (delivered to the new
  // account's chat after the login lands).
  async #captureOutgoingHandoff(job, outgoingEmail) {
    if (!this.#handoffStore || !job.win || job.win.isDestroyed()) return;
    const profile = this.#profileRegistry.snapshot().profiles.find(entry => entry.id === job.profileId);
    if (!profile) return;
    // Reuse the login window's session (same partition) to fetch the transcript.
    const script = `(async () => {
      const list = await fetch("/backend-api/conversations?offset=0&limit=1&order=updated", { credentials: "include" }).then(r => r.json()).catch(() => null);
      const convo = list && Array.isArray(list.items) && list.items[0];
      if (!convo) return { conversation: null, transcript: [] };
      const detail = await fetch("/backend-api/conversation/" + convo.id, { credentials: "include" }).then(r => r.json()).catch(() => null);
      const out = [];
      if (detail && detail.mapping) {
        const nodes = Object.values(detail.mapping);
        const visited = new Set();
        const ordered = [];
        const visit = node => { if (!node || visited.has(node.id)) return; visited.add(node.id); (node.children || []).forEach(visit); ordered.push(node); };
        visit(nodes.find(n => !n.parent));
        for (const node of ordered) {
          const m = node.message;
          if (!m || !m.author || (m.author.role !== "user" && m.author.role !== "assistant")) continue;
          if (!m.content || !Array.isArray(m.content.parts)) continue;
          const text = m.content.parts.filter(p => typeof p === "string").join("\\n").trim();
          if (!text) continue;
          out.push({ role: m.author.role, text: text.slice(0, 1500), at: m.create_time });
        }
      }
      return { conversation: { id: String(convo.id), title: String(convo.title || ""), updatedAt: convo.update_time ? new Date(convo.update_time * 1000).toISOString() : "" }, transcript: out.slice(-40) };
    })()`;
    const captured = await job.win.webContents.executeJavaScript(script, true);
    if (!captured || !captured.conversation) return;
    await this.#handoffStore.saveProfileHandoff({
      fromProfileId: job.profileId,
      fromProfileLabel: `${profile.label} · ${outgoingEmail}`,
      toProfileId: job.profileId,
      conversation: captured.conversation,
      transcript: captured.transcript
    });
    console.log(`[AutoLogin] handoff captured: ${captured.transcript.length} messages from ${outgoingEmail} on ${profile.label}`);
  }

  #onNavigate(job, url) {
    job.url = url;
    console.log(`[AutoLogin:${job.email}] navigate ${url} (step=${job.step})`);
    if (isMainPage(url)) {
      // Landed on the ChatGPT home: either the session was already valid or the
      // password/OTP submit went through.
      // For jobs targeting a specific account, verify the session really is
      // that account: a still-valid old session on the same partition would
      // otherwise make this login bounce straight to the home page and report
      // success while keeping the OLD account (problem: login B over A).
      const wantEmail = String(job.expectedEmail || job.email || "").trim().toLowerCase();
      if (job.type === "google" && !job.accountId) {
        // Manual Google one-off: any signed-in account is the desired outcome.
        this.#readSessionEmail(job)
          .catch(() => "")
          .then(() => this.#finishCurrent("success"));
        return;
      }
      if (job.sessionPending) {
        // A session verification (and possible account switch) is already in
        // flight for this job. Later main-page navigations — the SPA fires
        // did-navigate AND did-navigate-in-page for one landing — must not
        // race it to finishCurrent("success"); that is exactly how a stale
        // session once got reported as a successful login.
        this.#emit();
        return;
      }
      if (wantEmail.includes("@") && job.win && !job.win.isDestroyed()) {
        job.sessionPending = true;
        this.#readSessionEmail(job)
          .catch(() => "")
          .then(async () => {
            const found = (job.sessionEmail || "").trim().toLowerCase();
            console.log(`[AutoLogin:${job.email}] session check: want=${wantEmail} found=${found} attempt=${job.switchAttempts || 0}`);
            if (found !== wantEmail) {
              // The signed-in account is not the target (empty read counts as
              // mismatch too: an unverified session must never report success).
              // Capture the outgoing conversation for the handoff, then sign it
              // out for real (server call + cookie purge) and restart the login
              // flow. Two attempts max — a loop here would flip-flop accounts.
              job.step = "switching";
              this.#emit();
              job.switchAttempts = (job.switchAttempts || 0) + 1;
              if (job.switchAttempts > 2) {
                job.sessionPending = false;
                this.#finishCurrent("error", `session-vẫn-là-${found || "không-rõ"}`);
                return;
              }
              this.#captureOutgoingHandoff(job, found)
                .catch(error => console.warn(`[AutoLogin] handoff capture skipped: ${error.message}`))
                .then(() => this.#signOutPrevious(job))
                .catch(error => console.warn(`[AutoLogin] sign out failed: ${error.message}`))
                .then(() => {
                  job.sessionPending = false;
                  job.win?.webContents.loadURL(LOGIN_URL).catch(() => this.#finishCurrent("error", "reload-login-failed"));
                });
              return;
            }
            this.#finishCurrent("success");
          });
        return;
      }
      this.#finishCurrent("success");
      return;
    }
    const onGoogle = url.includes("accounts.google.com");
    if (job.type === "google" && onGoogle && !job.manual) {
      // Google blocks scripted logins, so the window is handed to the user at
      // this point: show it, wait long, and let them finish on accounts.google.com.
      job.manual = true;
      job.step = "google-manual";
      if (job.win && !job.win.isDestroyed()) {
        job.win.show();
        job.win.setFocusable(true);
        job.win.focus();
      }
      // The manual wait outlives the normal overall budget: extend it or the
      // 3-minute overall timer would kill the job mid-signin.
      if (job.timeout) clearTimeout(job.timeout);
      job.timeout = setTimeout(() => this.#finishCurrent("timeout", "manual-timeout"), MANUAL_TIMEOUT_MS);
      if (job.stepTimeout) clearTimeout(job.stepTimeout);
      job.stepTimeout = setTimeout(() => this.#finishCurrent("timeout", "manual-timeout"), MANUAL_TIMEOUT_MS);
      this.#emit();
      return;
    }
    if (job.manual) {
      // Manual Google phase: only watching for the redirect back to chatgpt.com.
      this.#emit();
      return;
    }
    if (!isCredentialUrl(url)) return;
    job.step = job.step === "starting" ? "page" : job.step;
    this.#emit();
    // Re-inject the agent after every credential-page navigation; the script
    // no-ops itself when its previous instance is still alive.
    const inject = () => {
      if (job.win && !job.win.isDestroyed() && isCredentialUrl(job.win.webContents.getURL())) {
        void job.win.webContents.executeJavaScript(buildAgentScript(job.accountId ? this.#registry.credentials(job.accountId) : { email: job.email, password: "", twofa: "", type: job.type }), true).catch(error => console.error(`[AutoLogin:${job.email}] inject failed: ${error.message}`));
      }
    };
    const grace = onGoogle ? 2500 : 1200;
    const timer = setTimeout(inject, grace);
    if (job.stepTimeout) clearTimeout(job.stepTimeout);
    job.stepTimeout = setTimeout(() => { clearTimeout(timer); this.#finishCurrent("timeout", `stuck-at-${job.step}`); }, STEP_TIMEOUT_MS + (onGoogle ? 15000 : 0));
  }

  // Called from preload bridge IPC (autologin:agent-report).
  handleAgentReport(payload = {}) {
    const job = this.#current;
    if (!job || !payload || typeof payload !== "object") return;
    if (payload.step && payload.step !== "agent-ready") job.step = payload.step;
    if (job.armStepTimeout && !job.manual) job.armStepTimeout();
    this.#emit();
    if (payload.step === "otp" && payload.submitted) {
      // OTP submitted; success is confirmed when navigation reaches the main page.
      job.step = "otp-submitted";
      this.#emit();
    }
  }
}
