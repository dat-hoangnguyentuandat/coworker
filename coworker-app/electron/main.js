import { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, Menu, Notification, safeStorage, session, shell } from "electron";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpRuntime } from "./mcp-runtime.js";
import { validateUpstreamServers } from "./upstream-manager.js";
import { validateTunnelConfig } from "./secure-tunnel.js";
import { ChatProfileRegistry } from "./chat-profile-registry.js";
import { HandoffStore } from "./handoff-store.js";
import { AutoLoginRegistry } from "./auto-login-registry.js";
import { AutoLoginManager } from "./auto-login-manager.js";
import { WorkbenchState } from "./workbench-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateMarkers = ["settings.json", "workbench-state.json", "task-mailbox.json", "jobs", "memory", "checkpoints"];
const currentUserDataPath = app.getPath("userData");
const hasUserData = directory => stateMarkers.some(name => existsSync(path.join(directory, name)));
const legacyUserDataPath = ["Coworker Local", "coworker-local"].map(name => path.join(app.getPath("appData"), name)).find(directory => hasUserData(directory));
if (legacyUserDataPath && !hasUserData(currentUserDataPath)) app.setPath("userData", legacyUserDataPath);
let windowRef;
let chatView;
let chatViewVisible = false;
let chatViewProfileId = "";
const chatViews = new Map();
const handoffsInFlight = new Set();
let profileSwitchQueue = Promise.resolve();
let chatSidebarWidth = 260;
let chatDockHeight = 0;
let tourView;
let tourViewVisible = false;
let tourImageZoomed = false;
let tourCardBounds;
let tourPlacement;
let tourRequest = 0;
let tourLoad;
let tourQueue = Promise.resolve();
let tourNaturalSize;
let profileDialogWindow;
let profileDialogResolver;
let profileDialogHeight = 200;
let autoLoginDialogWindow;
let autoLoginRegistry;
let autoLoginManager;
let autoLoginThemeSeed = "light";
let autoLoginLanguageSeed = "vi";
let workspacePath = "";
let runtime;
let runtimeStarting;
let startupMcpError = "";
let runtimeStopping = Promise.resolve();
let profileRegistry;
let handoffStore;
let workbenchState;
let workbenchCache = { workspaces: [], tasks: [], defaultWorkspaceId: "", defaultTaskId: "", pendingApprovals: [] };
let tunnelCache = [];
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

async function readSettings() {
  try { return JSON.parse(await fs.readFile(settingsPath(), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

async function writeSettings(settings) {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function protectUpstreams(servers) {
  const protect = value => {
    if (!value) return "";
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable; upstream secrets were not saved.");
    return `enc:${safeStorage.encryptString(String(value)).toString("base64")}`;
  };
  return servers.map(server => ({
    ...server,
    bearerToken: protect(server.bearerToken),
    env: Object.fromEntries(Object.entries(server.env || {}).map(([key, value]) => [key, protect(value)])),
    headers: Object.fromEntries(Object.entries(server.headers || {}).map(([key, value]) => [key, protect(value)]))
  }));
}

function revealUpstreams(servers = []) {
  const reveal = value => {
    if (typeof value !== "string" || !value.startsWith("enc:")) return value || "";
    if (!safeStorage.isEncryptionAvailable()) return "";
    return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
  };
  return servers.map(server => ({
    ...server,
    bearerToken: reveal(server.bearerToken),
    env: Object.fromEntries(Object.entries(server.env || {}).map(([key, value]) => [key, reveal(value)])),
    headers: Object.fromEntries(Object.entries(server.headers || {}).map(([key, value]) => [key, reveal(value)]))
  }));
}

function protectTunnel(input = {}) {
  const config = validateTunnelConfig(input);
  if (!config.runtimeApiKey) return config;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable; the tunnel Runtime API key was not saved.");
  return { ...config, runtimeApiKey: `enc:${safeStorage.encryptString(config.runtimeApiKey).toString("base64")}` };
}

function revealTunnel(config = {}) {
  const value = config.runtimeApiKey;
  if (typeof value !== "string" || !value.startsWith("enc:")) return config;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable; the saved tunnel key cannot be read.");
  return { ...config, runtimeApiKey: safeStorage.decryptString(Buffer.from(value.slice(4), "base64")) };
}

function sendState() {
  if (runtime) {
    workbenchCache = runtime.workbenchSnapshot();
    tunnelCache = runtime.tunnelSnapshot();
  } else if (workbenchState) workbenchCache = { ...workbenchState.snapshot(), pendingApprovals: [] };
  const selectedWorkspace = workbenchCache.workspaces.find(item => item.id === workbenchCache.defaultWorkspaceId);
  workspacePath = selectedWorkspace?.root || "";
  if (!windowRef || windowRef.isDestroyed()) return;
  windowRef.webContents.send("app:state", {
    workspacePath,
    mcpRunning: Boolean(runtime),
    startupMcpError,
    endpoint: runtime?.endpoint ?? "",
    accessToken: runtime?.accessToken ?? "",
    tunnel: tunnelCache
  });
  windowRef.webContents.send("workbench:state", workbenchCache);
  windowRef.webContents.send("tunnel:state", tunnelCache);
}

function layoutChatView() {
  if (!chatView || !chatViewVisible || !windowRef || windowRef.isDestroyed()) return;
  const bounds = windowRef.getContentBounds();
  const top = 58;
  chatView.setBounds({ x: chatSidebarWidth, y: top, width: Math.max(0, bounds.width - chatSidebarWidth), height: Math.max(0, bounds.height - top - chatDockHeight) });
}

function layoutTourView() {
  if (!tourView || !tourViewVisible || !windowRef || windowRef.isDestroyed() || !tourPlacement || !tourNaturalSize) return;
  if (tourImageZoomed) {
    const { width, height } = windowRef.getContentBounds();
    tourView.setBounds({ x: 0, y: 0, width, height });
    return;
  }
  tourCardBounds = nativeTourBounds(tourPlacement, tourNaturalSize.width, tourNaturalSize.height);
  tourView.setBounds(tourCardBounds);
}

function nativeTourBounds(target, width, height) {
  const content = windowRef.getContentBounds();
  const margin = 8, gap = 14;
  width = Math.min(width, Math.max(1, content.width - margin * 2));
  height = Math.min(height, Math.max(1, content.height - margin * 2));
  const left = Number(target.left) || 0, top = Number(target.top) || 0;
  const right = left + (Number(target.width) || 0);
  const bottom = top + (Number(target.height) || 0);
  const clamp = (value, size, limit) => Math.max(margin, Math.min(value, limit - size - margin));
  const x = clamp(right - width, width, content.width);
  const y = clamp(top, height, content.height);
  const candidates = [
    { x, y: bottom + gap, width, height: content.height - bottom - gap - margin },
    { x, y: margin, width, height: top - gap - margin, above: true },
    { x: right + gap, y, width: content.width - right - gap - margin, height },
    { x: margin, y, width: left - gap - margin, height, left: true }
  ];
  let fit = candidates.find(item => item.width >= width && item.height >= height);
  if (!fit) fit = candidates.filter(item => item.width >= Math.min(320, width) && item.height >= 80)
    .sort((a, b) => Math.min(b.width, width) * Math.min(b.height, height) - Math.min(a.width, width) * Math.min(a.height, height))[0];
  if (!fit) fit = candidates.filter(item => item.width > 0 && item.height > 0)
    .sort((a, b) => Math.min(b.width, width) * Math.min(b.height, height) - Math.min(a.width, width) * Math.min(a.height, height))[0];
  if (!fit) return { x: margin, y: margin, width, height };
  width = Math.min(width, fit.width); height = Math.min(height, fit.height);
  return { x: Math.round(fit.left ? left - gap - width : fit.x), y: Math.round(fit.above ? top - gap - height : fit.y), width: Math.floor(width), height: Math.floor(height) };
}

// Native WebContentsView overlays are required whenever ChatGPT WebView is open:
// renderer DOM z-index cannot draw above a sibling WebContentsView. Keep the
// overlay bounds/card sizing here so every WebView-aware popup follows one path.
async function measureNativeTour(width, expression = 'window.coworkerMeasureTour()') {
  for (let attempt = 0; attempt < 40; attempt++) {
    const currentWidth = await tourView.webContents.executeJavaScript('window.innerWidth');
    if (currentWidth === width) return tourView.webContents.executeJavaScript(expression);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Tour view did not resize to ${width}px before measurement.`);
}

async function showNativeTour(data = {}, request = tourRequest) {
  if (!windowRef || windowRef.isDestroyed()) return;
  if (data.layoutOnly) {
    if (!tourViewVisible || !tourView || !data.target) return;
    tourPlacement = data.target;
    if (tourImageZoomed) {
      const { width, height } = windowRef.getContentBounds();
      tourView.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    const { width, height } = windowRef.getContentBounds();
    const desiredWidth = Math.min(470, width - 16);
    if (tourNaturalSize?.width !== desiredWidth) {
      tourView.setVisible(true);
      tourView.setBounds({ x: 0, y: 0, width: desiredWidth, height });
      tourNaturalSize = { width: desiredWidth, height: await measureNativeTour(desiredWidth) };
    }
    if (request !== tourRequest || !windowRef || windowRef.isDestroyed()) return;
    tourCardBounds = nativeTourBounds(tourPlacement, desiredWidth, tourNaturalSize.height);
    if (tourCardBounds.width !== desiredWidth) {
      tourView.setVisible(true);
      tourView.setBounds({ ...tourCardBounds, height });
      const measured = await measureNativeTour(tourCardBounds.width);
      if (request !== tourRequest || !windowRef || windowRef.isDestroyed()) return;
      tourNaturalSize = { width: tourCardBounds.width, height: measured };
      tourCardBounds = nativeTourBounds(tourPlacement, tourCardBounds.width, measured);
    }
    tourView.setBounds(tourCardBounds);
    tourView.setVisible(true);
    return;
  }

  let created = false;
  if (!tourView || tourView.webContents.isDestroyed()) {
    created = true;
    tourView = new WebContentsView({ webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    tourView.setBackgroundColor('#00000000');
    // A hidden/detached native view may not finish its initial data-page load
    // on Windows. A one-pixel attached surface lets the first load complete.
    tourView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    tourView.setVisible(true);
    windowRef.contentView.addChildView(tourView);
    // This attached 1px loading surface is not a presented popup. Do not
    // allow resize/layout handlers to position it before content is measured.
    tourViewVisible = false;
    tourView.webContents.on("did-fail-load", (_event, code, description, url) => console.error(`Coworker tour failed: ${code} ${description} ${url}`));
    tourView.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith("https://")) void shell.openExternal(url); return { action: "deny" }; });

    const shellHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#66756a transparent}*::-webkit-scrollbar{width:4px;height:4px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{border:0;border-radius:99px;background:#66756a}*::-webkit-scrollbar-thumb:hover{background:#8ba091}
    :root{--bg:#fff;--surface:#fff;--text:#24231f;--muted:#77766f;--subtle:#999890;--line:#e3e6e1;--line-soft:#eeede9;--button-bg:#fff;--button-border:#d9d8d2;--primary-bg:#2c4337;--primary-border:#283d32;--primary-text:#fff;--code-bg:#edf5ef;--code-text:#315c48;--link:#1d6846;--zoom-bg:#f8f8f6;--shadow:rgba(18,29,22,.25)}
    body.dark{--bg:#202720;--surface:#202720;--text:#edf5ef;--muted:#c0ccc2;--subtle:#aab6ad;--line:#49604e;--line-soft:#3b493d;--button-bg:#2b3b30;--button-border:#49604e;--primary-bg:#86d0a4;--primary-border:#86d0a4;--primary-text:#102016;--code-bg:#2b4432;--code-text:#c9efd4;--link:#9de0b2;--zoom-bg:#111b14;--shadow:#0009}
    html,body{margin:0!important;padding:0!important;width:100%;height:100%;overflow:hidden;font-family:Segoe UI,sans-serif;background:transparent!important;color:var(--text)}
    body.zoomed{background:var(--zoom-bg)!important}
    .card{position:absolute;top:0;left:0;width:100%;height:auto;min-height:0;max-height:100%;overflow:auto;padding:18px 20px 14px;border:1px solid var(--line);border-radius:13px;color:var(--text);background:var(--surface);box-shadow:0 18px 50px var(--shadow)}
    body.zoomed .card{position:absolute;inset:0;width:100%;height:100%;max-height:none;border:0;border-radius:0;box-shadow:none;background:transparent;padding:48px 40px}
    body.zoomed .card h2,body.zoomed .body,body.zoomed .caption,body.zoomed .footer{display:none}
    .card h2{margin:0;font-size:16px;font-weight:650}
    .body{margin:8px 0 18px;color:var(--muted);font-size:13px;line-height:1.55}
    .body a{color:var(--link);font-weight:650}
    .body code{padding:1px 4px;border-radius:4px;color:var(--code-text);background:var(--code-bg);font:11px Cascadia Code,monospace}
    .image{display:block;width:100%;max-height:210px;object-fit:contain;margin:8px 0 5px;border:1px solid var(--line);border-radius:8px;background:var(--zoom-bg);cursor:zoom-in}
    .image[hidden]{display:none}
    .image.zoom{width:100%;max-height:calc(100vh - 96px);object-fit:contain;cursor:zoom-out}
    .zoom-close{display:none;position:absolute;right:16px;top:12px;z-index:5}
    .zoom-close.visible{display:block}
    .caption{color:var(--subtle);font-size:11px;line-height:1.4}
    .caption[hidden]{display:none}
    .footer{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft);position:sticky;bottom:-14px;background:var(--surface);padding-bottom:4px}
    .step{margin-right:auto;color:var(--subtle);font-size:11px}
    .button{min-height:38px;border:1px solid var(--button-border);border-radius:8px;padding:0 13px;color:var(--text);background:var(--button-bg);font:11px Segoe UI,sans-serif;font-weight:580;cursor:pointer}
    .primary{color:var(--primary-text);background:var(--primary-bg);border-color:var(--primary-border)}
    .button:focus-visible{outline:2px solid var(--link);outline-offset:2px}.button[hidden]{display:none}.body{overflow-wrap:anywhere}
    </style></head><body>
      <button id="zoom-close" class="button zoom-close"></button>
      <div class="card" role="dialog" aria-labelledby="title" aria-describedby="body">
        <h2 id="title"></h2>
        <div id="body" class="body"></div>
        <img id="image" class="image" alt="" hidden>
        <div id="caption" class="caption" hidden></div>
        <div class="footer">
          <span id="step" class="step"></span>
          <button id="back" class="button"></button>
          <button id="hide" class="button"></button>
          <button id="skip" class="button"></button>
          <button id="next" class="button primary"></button>
        </div>
      </div>
      <script>
      const card = document.querySelector('.card');
      const image = document.querySelector('#image');
      const zoomClose = document.querySelector('#zoom-close');
      document.querySelector('#hide').addEventListener('click',()=>window.coworker.tourAction('hide'));
      document.querySelector('#skip').addEventListener('click',()=>window.coworker.tourAction('skip'));
      document.querySelector('#next').addEventListener('click',()=>window.coworker.tourAction('next'));
      document.querySelector('#back').addEventListener('click',()=>window.coworker.tourAction('back'));
      zoomClose.addEventListener('click',()=>window.coworker.tourAction('image'));
      image.addEventListener('click',()=>window.coworker.tourAction('image'));
      document.addEventListener('click',event=>{
        const anchor=event.target.closest('a');
        if(!anchor)return;
        event.preventDefault();
        window.coworker.openExternal(anchor.href);
      });
      document.addEventListener('keydown',event=>{
        if(event.key==='Escape')window.coworker.tourAction(image.classList.contains('zoom')?'image':'hide');
      });
      window.coworkerMeasureTour = () => {
        const maxHeight = card.style.maxHeight;
        card.style.maxHeight = 'none';
        const height = Math.ceil(card.getBoundingClientRect().height);
        card.style.maxHeight = maxHeight;
        return height;
      };
      window.coworkerUpdateTour = async data => {
        document.body.classList.toggle('dark', Boolean(data.dark));
        document.body.classList.remove('zoomed');
        image.classList.remove('zoom');
        zoomClose.classList.remove('visible');
        document.querySelector('#title').textContent = data.title || '';
        document.querySelector('#body').innerHTML = data.body || '';
        if(data.image){
          image.hidden=false;
          image.src=data.image;
          await image.decode().catch(()=>{});
          image.alt=data.imageCaption || data.title;
        }else{
          image.hidden=true;
          image.removeAttribute('src');
        }
        const caption=document.querySelector('#caption');
        caption.textContent=data.imageCaption || '';
        caption.hidden=!data.imageCaption;
        document.querySelector('#step').textContent = data.copy.step + ' ' + (data.index + 1) + '/' + data.total;
        document.querySelector('#hide').textContent = data.copy.hide;
        document.querySelector('#skip').textContent = data.copy.skip;
        document.querySelector('#next').textContent = data.last ? data.copy.done : data.copy.next;
        document.querySelector('#back').textContent = data.copy.back;
        document.querySelector('#back').hidden = data.index === 0;
        zoomClose.textContent = data.copy.close;
        card.scrollTop = 0;
        return window.coworkerMeasureTour();
      };
      </script>
    </body></html>`;
    tourLoad = tourView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shellHtml)}`);
  }
  await tourLoad;
  if (request !== tourRequest || !windowRef || windowRef.isDestroyed()) return;

  const image = data.image ? `data:image/jpeg;base64,${(await fs.readFile(path.join(here, "ui", "images", data.image))).toString("base64")}` : "";
  const target = data.target || { left: 20, top: 20, width: 100, height: 40 };
  const width = Math.min(470, Math.max(1, windowRef.getContentBounds().width - 16));
  const english = data.language === "en";
  const copy = english
    ? { step: "Step", hide: "Hide for now", skip: "Skip", back: "Back", next: "Continue", done: "Done", close: "Close" }
    : { step: "Bước", hide: "Ẩn tạm", skip: "Bỏ qua", back: "Quay lại", next: "Tiếp tục", done: "Xong", close: "Đóng" };

  tourPlacement = target;
  tourImageZoomed = false;

  const payload = {
    title: String(data.title || ""),
    body: String(data.body || "").replaceAll("</script", "<\\/script"),
    image,
    imageCaption: String(data.imageCaption || ""),
    index: Number(data.index || 0),
    total: Number(data.total || 1),
    last: Boolean(data.last),
    dark: data.theme === "dark",
    copy
  };

  if (request !== tourRequest || !windowRef || windowRef.isDestroyed()) return;
  // Measure at the final width, not the previous step's (or a new view's zero) width.
  tourView.setVisible(true);
  tourView.setBounds({ x: 0, y: 0, width, height: windowRef.getContentBounds().height });
  let measuredHeight = await measureNativeTour(width, `window.coworkerUpdateTour(${JSON.stringify(payload)})`);
  if (request !== tourRequest || !windowRef || windowRef.isDestroyed()) return;
  tourNaturalSize = { width, height: Number(measuredHeight) || 170 };
  tourCardBounds = nativeTourBounds(target, width, Number(measuredHeight) || 170);
  if (tourCardBounds.width !== width) {
    tourView.setBounds({ ...tourCardBounds, height: windowRef.getContentBounds().height });
    measuredHeight = await measureNativeTour(tourCardBounds.width, `window.coworkerUpdateTour(${JSON.stringify(payload)})`);
    if (request !== tourRequest || !windowRef || windowRef.isDestroyed()) return;
    tourNaturalSize = { width: tourCardBounds.width, height: Number(measuredHeight) || 170 };
    tourCardBounds = nativeTourBounds(target, tourCardBounds.width, Number(measuredHeight) || 170);
  }

  if (!tourViewVisible) {
    windowRef.contentView.addChildView(tourView);
    tourViewVisible = true;
  }
  tourView.setBounds(tourCardBounds);
  tourView.setVisible(true);
  windowRef.webContents.send("tour:native-state", true);

  if (created) console.error(`Coworker tour attached: childBounds=${JSON.stringify(tourCardBounds)}`);
}

function hideNativeTour() { tourRequest += 1; if (tourView && windowRef && windowRef.contentView.children.includes(tourView)) windowRef.contentView.removeChildView(tourView); tourViewVisible = false; tourImageZoomed = false; }

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function closeNativeProfileDialog(result = { action: "cancel" }) {
  const current = profileDialogWindow;
  profileDialogWindow = undefined;
  profileDialogHeight = 200;
  const resolve = profileDialogResolver;
  profileDialogResolver = undefined;
  if (current && !current.isDestroyed()) current.close();
  resolve?.(result);
}

// WebContentsView is a native layer and always renders above the renderer/WebView.
// Keep this profile dialog to its card bounds (instead of a full-window DOM dialog)
// so ChatGPT remains visible around it and the native layer cannot paint an opaque
// white/gray sheet over the whole app.
function profileDialogBounds(height) {
  const parent = windowRef.getBounds();
  const width = Math.min(430, Math.max(320, parent.width - 32));
  const boundedHeight = Math.min(parent.height - 80, Math.max(150, Number(height) || 200));
  return { x: Math.round(parent.x + (parent.width - width) / 2), y: Math.round(parent.y + (parent.height - boundedHeight) / 2), width, height: boundedHeight };
}

async function showNativeProfileDialog(data = {}) {
  if (!windowRef || windowRef.isDestroyed()) return { action: "cancel" };
  closeNativeProfileDialog();
  const english = data.language === "en";
  const dark = data.theme === "dark";
  const removing = ["forget", "remove-workspace", "delete-task"].includes(data.mode);
  const inputMode = !removing;
  const entity = data.mode?.includes("workspace") ? (english ? "workspace" : "workspace") : data.mode?.includes("task") ? (english ? "task" : "task") : "profile";
  const title = data.mode === "add" ? (english ? "Add ChatGPT profile" : "Thêm profile ChatGPT") : removing ? (english ? `Remove ${entity}?` : `Xóa ${entity}?`) : (english ? `Rename ${entity}` : `Đổi tên ${entity}`);
  const label = english ? `${entity} name` : `Tên ${entity}`;
  const message = data.mode === "remove-workspace"
    ? (english ? `Remove “${data.label}” from Coworker, including its task list? Project files will not be deleted.` : `Gỡ “${data.label}” khỏi Coworker cùng danh sách task? Tệp dự án sẽ không bị xóa.`)
    : data.mode === "delete-task"
      ? (english ? `Close “${data.label}”? Its task record remains available in saved history.` : `Đóng “${data.label}”? Bản ghi task vẫn còn trong lịch sử đã lưu.`)
      : (english ? `Remove “${data.label || "this profile"}” and clear its local sign-in session?` : `Xóa “${data.label || "profile này"}” và dữ liệu đăng nhập cục bộ?`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;font-family:Segoe UI,sans-serif;background:transparent}body{display:grid;place-items:center}.card{width:390px;padding:22px;border:1px solid ${dark ? "#49604e" : "#d9ded9"};border-radius:13px;color:${dark ? "#edf5ef" : "#24231f"};background:${dark ? "#202720" : "#fff"};box-shadow:0 20px 60px rgba(0,0,0,.28)}h2{margin:0 0 14px;font-size:17px}p{margin:0 0 18px;color:${dark ? "#c0ccc2" : "#77766f"};font-size:13px;line-height:1.5}label{display:block;margin-bottom:7px;color:${dark ? "#c0ccc2" : "#77766f"};font-size:11px}input{width:100%;height:38px;padding:8px 10px;border:1px solid ${dark ? "#49604e" : "#d9d8d2"};border-radius:8px;color:${dark ? "#edf5ef" : "#24231f"};background:${dark ? "#171c18" : "#fafaf8"};font:13px Segoe UI,sans-serif}.buttons{display:flex;justify-content:flex-end;gap:9px;margin-top:18px}button{min-height:36px;padding:0 13px;border:1px solid ${dark ? "#49604e" : "#d9d8d2"};border-radius:8px;color:${dark ? "#edf5ef" : "#3b3933"};background:${dark ? "#2b3b30" : "#fff"};font:11px Segoe UI,sans-serif;font-weight:600;cursor:pointer}.primary{color:${dark ? "#102016" : "#fff"};background:${dark ? "#86d0a4" : "#2c4337"};border-color:${dark ? "#86d0a4" : "#283d32"}}.danger{color:${dark ? "#24110f" : "#fff"};background:${dark ? "#ee9b8e" : "#a34035"};border-color:${dark ? "#ee9b8e" : "#a34035"}}</style></head><body><main class="card"><h2>${escapeHtml(title)}</h2>${inputMode ? `<label for="profile-name">${escapeHtml(label)}</label><input id="profile-name" maxlength="120" autocomplete="off" value="${escapeHtml(data.label || "")}">` : `<p>${escapeHtml(message)}</p>`}<div class="buttons"><button onclick="finish('cancel')">${english ? "Cancel" : "Hủy"}</button><button class="${removing ? "danger" : "primary"}" onclick="submitDialog()">${removing ? (english ? "Remove" : "Xóa") : (english ? "Save" : "Lưu")}</button></div></main><script>function finish(action){const result={action,value:document.querySelector('#profile-name')?.value||''};if(window.coworker?.profileDialogAction)window.coworker.profileDialogAction(result);else location.href='coworker-profile://action/'+action+'?value='+encodeURIComponent(result.value)}function submitDialog(){finish('${removing ? data.mode === "forget" ? "forget" : "remove" : "save"}')}document.querySelector('#profile-name')?.focus();document.addEventListener('keydown',event=>{if(event.key==='Escape')finish('cancel');if(event.key==='Enter'&&document.querySelector('#profile-name'))submitDialog()});</script></body></html>`;
  // A parented transparent BrowserWindow is used instead of a renderer modal:
  // ChatGPT's WebContentsView is a native sibling and will cover renderer DOM.
  return new Promise((resolve, reject) => {
    const child = new BrowserWindow({
      parent: windowRef, show: false, frame: false, transparent: true,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      width: 430, height: 220, backgroundColor: "#00000000",
      webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    profileDialogWindow = child;
    profileDialogResolver = resolve;
    let presented = false;
    const present = async () => {
      if (presented) return;
      presented = true;
      try {
        const measured = await child.webContents.executeJavaScript("Math.ceil(document.querySelector('.card').getBoundingClientRect().height)");
        profileDialogHeight = Math.ceil(Number(measured) || 200);
        child.setBounds(profileDialogBounds(profileDialogHeight));
        child.show();
      } catch (error) { closeNativeProfileDialog({ action: "error", message: error.message }); }
    };
    child.webContents.once("did-finish-load", present);
    child.on("closed", () => { if (profileDialogWindow === child) closeNativeProfileDialog(); });
    child.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(error => {
      if (profileDialogWindow === child) closeNativeProfileDialog({ action: "error", message: error.message });
    });
  });
}

function closeChatView() {
  if (!chatView || !chatViewVisible) return;
  windowRef?.contentView.removeChildView(chatView);
  chatViewVisible = false;
  windowRef?.webContents.send("chat:state", false);
}

function destroyChatView(profileId = chatViewProfileId) {
  const view = chatViews.get(profileId);
  if (!view) return;
  const wasVisible = view === chatView && chatViewVisible;
  if (wasVisible && windowRef && !windowRef.isDestroyed()) windowRef.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  chatViews.delete(profileId);
  if (view === chatView) {
    chatView = undefined;
    chatViewProfileId = "";
    chatViewVisible = false;
    if (wasVisible && windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("chat:state", false);
  }
}

function openChatView() {
  if (!windowRef || windowRef.isDestroyed()) return false;
  const profile = profileRegistry?.active();
  if (!profile) throw new Error("ChatGPT profile registry is not ready.");
  if (chatView && chatViewProfileId !== profile.id && chatViewVisible) windowRef.contentView.removeChildView(chatView);
  chatView = chatViews.get(profile.id);
  if (chatView?.webContents.isDestroyed()) { chatViews.delete(profile.id); chatView = undefined; }
  if (!chatView) {
    chatView = new WebContentsView({
      webPreferences: { partition: profile.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    chatViews.set(profile.id, chatView);
    const createdView = chatView;
    createdView.webContents.on("render-process-gone", () => {
      if (chatViews.get(profile.id) !== createdView) return;
      destroyChatView(profile.id);
      console.error(`ChatGPT profile ${profile.id} renderer stopped; its page must be reopened.`);
      windowRef?.webContents.send("profiles:state", profileRegistry.snapshot());
    });
    chatView.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith("https://")) return { action: "deny" };
      return { action: "allow", overrideBrowserWindowOptions: { parent: windowRef, width: 520, height: 720, webPreferences: { partition: profile.partition, contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    });
    chatView.webContents.on("will-navigate", (event, url) => {
      try { const target = new URL(url); const allowed = target.protocol === "https:" && (target.hostname === "chatgpt.com" || target.hostname.endsWith(".chatgpt.com") || target.hostname === "openai.com" || target.hostname.endsWith(".openai.com")); if (!allowed) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
    void chatView.webContents.loadURL("https://chatgpt.com/").catch(error => console.error(`ChatGPT view load failed: ${error.message}`));
  }
  chatViewProfileId = profile.id;
  // Keep the active profile view last in iteration order.
  chatViews.delete(profile.id);
  chatViews.set(profile.id, chatView);
  windowRef.contentView.addChildView(chatView);
  // A profile switch reattaches ChatGPT; keep its sibling guide on top.
  if (tourView && tourViewVisible) {
    windowRef.contentView.removeChildView(tourView);
    windowRef.contentView.addChildView(tourView);
  }
  chatViewVisible = true;
  layoutChatView();
  windowRef.webContents.send("chat:state", true);
  return true;
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1100,
    height: 850,
    minWidth: 760,
    minHeight: 560,
    title: "Coworker",
    icon: path.join(here, "assets", "coworker-logo.png"),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowRef.loadFile(path.join(here, "ui", "index.html"));
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    try { const target = new URL(url); if (target.protocol === "https:" && ["platform.openai.com", "chatgpt.com", "github.com"].includes(target.hostname)) void shell.openExternal(url); }
    catch {}
    return { action: "deny" };
  });
  windowRef.webContents.on("console-message", (_event, details) => console.error(`Coworker renderer ${details.level}: ${details.message}`));
  windowRef.webContents.on("did-fail-load", (_event, code, description, url) => console.error(`Coworker page failed: ${code} ${description} ${url}`));
  windowRef.webContents.on("did-finish-load", async () => {
    try { console.error(`Coworker renderer loaded: ${await windowRef.webContents.executeJavaScript("document.body?.innerText?.slice(0,120) || 'empty'")}`); }
    catch (error) { console.error(`Coworker renderer probe failed: ${error.message}`); }
  });
  windowRef.on("resize", layoutChatView);
  windowRef.on("resize", layoutTourView);
  windowRef.on("resize", () => {
    if (!profileDialogWindow || profileDialogWindow.isDestroyed() || !windowRef || windowRef.isDestroyed()) return;
    profileDialogWindow.setBounds(profileDialogBounds(profileDialogHeight));
  });
  windowRef.on("move", layoutTourView);
  windowRef.on("closed", () => {
    for (const profileId of [...chatViews.keys()]) destroyChatView(profileId);
    chatView = undefined;
    chatViewProfileId = "";
    chatViewVisible = false;
    if (tourView && !tourView.webContents.isDestroyed()) tourView.webContents.close();
    tourView = undefined;
    tourViewVisible = false;
    closeNativeProfileDialog();
    if (autoLoginDialogWindow && !autoLoginDialogWindow.isDestroyed()) autoLoginDialogWindow.destroy();
    autoLoginDialogWindow = undefined;
    windowRef = undefined;
  });
}

ipcMain.handle("chat:toggle", async () => {
  if (chatViewVisible) { closeChatView(); return false; }
  const opened = openChatView();
  if (opened) void deliverProfileHandoff(profileRegistry.active().id);
  return opened;
});
ipcMain.handle("chat:close", () => { closeChatView(); return true; });
ipcMain.handle("profiles:get", () => profileRegistry.snapshot());
ipcMain.handle("profiles:create", async (_event, label) => profileRegistry.create(label));
ipcMain.handle("profiles:rename", async (_event, { id, label }) => profileRegistry.rename(id, label));
ipcMain.handle("profiles:status", async (_event, { id, status }) => profileRegistry.setStatus(id, status));
// Delivers a pending profile handoff into the freshly opened chat view: opens
// a new chat, types the resume prompt into the composer, and sends it. On any
// failure the prompt is copied to the clipboard and the user is notified.
async function deliverProfileHandoff(profileId) {
  if (handoffsInFlight.has(profileId) || profileRegistry.active()?.id !== profileId) return false;
  handoffsInFlight.add(profileId);
  let pending;
  try { pending = await handoffStore.pendingProfileHandoff(profileId); }
  catch (error) { handoffsInFlight.delete(profileId); throw error; }
  if (!pending || !pending.resumePrompt) { handoffsInFlight.delete(profileId); return false; }
  const view = chatViews.get(profileId);
  const isCurrent = () => view && !view.webContents.isDestroyed() && chatView === view
    && chatViewVisible && profileRegistry.active()?.id === profileId;
  if (!isCurrent()) { handoffsInFlight.delete(profileId); return false; }
  const waitFor = async (what, attempts = 40, gapMs = 250) => {
    for (let i = 0; i < attempts; i++) {
      if (!isCurrent()) throw new Error("profile switched during handoff");
      try { if (await view.webContents.executeJavaScript(what, true)) return true; } catch {}
      await new Promise(r => setTimeout(r, gapMs));
    }
    return false;
  };
  try {
    if (!await waitFor(`document.querySelector("#composer-background-button, button[aria-label*="New chat"], nav[aria-label] a[href="/"]") ? true : false`, 20)) throw new Error("new-chat control unavailable");
    // Start a fresh conversation so the resume prompt is its own thread.
    if (!isCurrent()) throw new Error("profile switched during handoff");
    const opened = await view.webContents.executeJavaScript(`(() => { const el = document.querySelector('a[href="/"]'); if (el) { el.click(); return "nav"; } const btn = document.querySelector('#composer-background-button, button[aria-label*="New chat"]'); if (btn) { btn.click(); return "btn"; } return "none"; })()`, true);
    if (opened === "none") throw new Error("new-chat control did not open");
    await new Promise(r => setTimeout(r, 1200));
    if (!await waitFor(`document.querySelector("#prompt-textarea, textarea[placeholder]") ? true : false`, 30)) throw new Error("composer unavailable");
    // React-controlled composer: synthetic input events are ignored, so type
    // via execCommand (triggers the app's own input pipeline).
    if (!isCurrent()) throw new Error("profile switched during handoff");
    const typed = await view.webContents.executeJavaScript(`(() => { const area = document.querySelector("#prompt-textarea, textarea[placeholder]"); if (!area) return false; area.focus(); return document.execCommand("insertText", false, ${JSON.stringify(pending.resumePrompt)}); })()`, true).catch(() => false);
    if (!typed) throw new Error("composer typing failed");
    await new Promise(r => setTimeout(r, 500));
    if (!isCurrent()) throw new Error("profile switched during handoff");
    const sent = await view.webContents.executeJavaScript(`(() => { const btn = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Gửi"]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()`, true).catch(() => false);
    if (!sent) throw new Error("send failed");
    await handoffStore.clearProfileHandoff(profileId);
    console.error(`[Handoff] delivered resume prompt to profile ${profileId}`);
    new Notification({ title: "Coworker", body: autoLoginLanguageSeed === "en" ? `Context from "${pending.fromProfileLabel}" was transferred to a new chat.` : `Đã chuyển ngữ cảnh từ "${pending.fromProfileLabel}" sang chat mới.` }).show();
    return true;
  } catch (error) {
    // Keep the pending handoff for the next activation; never send it to a
    // different profile or claim success for an untrusted keyboard event.
    if (isCurrent()) {
      try {
        clipboard.writeText(pending.resumePrompt);
        new Notification({ title: "Coworker", body: autoLoginLanguageSeed === "en" ? "Could not send automatically. The resume prompt was copied to the clipboard; paste it into the new chat." : "Không gửi tự động được — resume prompt đã vào clipboard, dán vào chat mới nhé." }).show();
      } catch {}
    }
    console.error(`[Handoff] delivery failed: ${error.message}`);
    return false;
  } finally {
    handoffsInFlight.delete(profileId);
  }
}

async function switchProfile(id) {
  const target = profileRegistry.snapshot().profiles.find(profile => profile.id === id);
  if (!target) throw new Error("ChatGPT profile not found.");
  if (target.id === profileRegistry.active()?.id) return target;
  const wasVisible = chatViewVisible;
  if (wasVisible) closeChatView();
  const selected = await profileRegistry.select(id);
  if (wasVisible) { openChatView(); void deliverProfileHandoff(id); }
  windowRef?.webContents.send("profiles:state", profileRegistry.snapshot());
  return selected;
}
ipcMain.handle("profiles:switch", (_event, id) => {
  const next = profileSwitchQueue.catch(() => {}).then(() => switchProfile(id));
  profileSwitchQueue = next;
  return next;
});
ipcMain.handle("profiles:forget", async (_event, id) => {
  const current = profileRegistry.active();
  const target = profileRegistry.snapshot().profiles.find(item => item.id === id);
  if (!target) throw new Error("ChatGPT profile not found.");
  if (current.id === id) {
    if (profileRegistry.snapshot().profiles.length <= 1) throw new Error("At least one ChatGPT profile must remain.");
    const next = profileRegistry.snapshot().profiles.find(item => item.id !== id);
    const wasVisible = chatViewVisible;
    destroyChatView(id);
    await profileRegistry.select(next.id);
    if (wasVisible) openChatView();
  }
  else destroyChatView(id);
  if (target) await session.fromPartition(target.partition).clearStorageData();
  const snapshot = await profileRegistry.remove(id);
  windowRef?.webContents.send("profiles:state", snapshot);
  return snapshot;
});
ipcMain.handle("chat:layout", (_event, { sidebarWidth, dockHeight }) => {
  chatSidebarWidth = Number.isFinite(sidebarWidth) ? Math.max(54, Math.min(320, Math.round(sidebarWidth))) : 260;
  chatDockHeight = Number.isFinite(dockHeight) ? Math.max(0, Math.min(120, Math.round(dockHeight))) : 0;
  layoutChatView();
});
ipcMain.handle("tour:show", (_event, data) => {
  const request = ++tourRequest;
  tourQueue = tourQueue.catch(() => {}).then(() => request === tourRequest ? showNativeTour(data, request) : undefined);
  return tourQueue;
});
ipcMain.handle("tour:hide", () => { hideNativeTour(); windowRef?.webContents.send("tour:native-state", false); return true; });
ipcMain.handle("profile-dialog:show", (_event, data) => showNativeProfileDialog(data));
ipcMain.handle("profile-dialog:action", (_event, result) => { closeNativeProfileDialog(result); return true; });
ipcMain.handle("tour:action", (_event, action) => {
  if (action === "image") {
    if (tourView && tourViewVisible && windowRef) {
      tourImageZoomed = !tourImageZoomed;
      const content = windowRef.getContentBounds();
      tourView.setBounds(tourImageZoomed ? { x: 0, y: 0, width: content.width, height: content.height } : tourCardBounds);
      void tourView.webContents.executeJavaScript(`document.body.classList.toggle('zoomed', ${tourImageZoomed}); document.querySelector('.image')?.classList.toggle('zoom', ${tourImageZoomed}); document.querySelector('.zoom-close')?.classList.toggle('visible', ${tourImageZoomed});`).catch(() => {});
      if (!tourImageZoomed) {
        const request = ++tourRequest;
        tourQueue = tourQueue.catch(() => {}).then(() => request === tourRequest ? showNativeTour({ layoutOnly: true, target: tourPlacement }, request) : undefined);
        void tourQueue.catch(() => {});
      }
    }
    return true;
  }
  if (action === "skip" || action === "hide") {
    hideNativeTour();
    windowRef?.webContents.send("tour:native-state", false);
  }
  windowRef?.webContents.send("tour:action", action);
  return true;
});
ipcMain.handle("open-external", (_event, url) => { try { const target = new URL(url); if (target.protocol === "https:") void shell.openExternal(target.href); } catch {} });
function mainUserAgent() {
  // A Chromium user agent is required: the default Electron UA is blocked by
  // some auth pages (Cloudflare). Seed the dialog theme from the main renderer.
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Coworker/${app.getVersion()}`;
}

ipcMain.handle("autologin:get-theme", () => autoLoginThemeSeed);
ipcMain.handle("autologin:get-language", () => autoLoginLanguageSeed);
ipcMain.handle("ui:set-language", (_event, language) => { autoLoginLanguageSeed = language === "en" ? "en" : "vi"; return true; });

function autoLoginDialogBounds() {
  const parent = windowRef.getBounds();
  const width = 520;
  const height = Math.min(660, Math.max(320, parent.height - 80));
  return { x: Math.round(parent.x + (parent.width - width) / 2), y: Math.round(parent.y + (parent.height - height) / 2), width, height };
}

function showAutoLoginDialog() {
  if (!windowRef || windowRef.isDestroyed()) return;
  if (autoLoginDialogWindow && !autoLoginDialogWindow.isDestroyed()) { autoLoginDialogWindow.focus(); return; }
  // Same native layer trick as the profile name/forget card: a parented,
  // frameless, transparent modal BrowserWindow renders above the ChatGPT
  // WebContentsView, so the popup stays clickable while Chat is open.
  const child = new BrowserWindow({
    parent: windowRef,
    // NOT modal: closing a modal child re-enables the parent and forces a
    // contentView relayout (chatView WebContentsView gets re-attached), which
    // recreates the main window surface for a frame — the 0.1s flash that
    // revealed apps behind Coworker. A parented child stays on top anyway.
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    width: 520,
    height: 620,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(here, "preload-auto-login-ui.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  autoLoginDialogWindow = child;
  child.on("closed", () => { autoLoginDialogWindow = undefined; });
  child.once("ready-to-show", () => {
    child.setBounds(autoLoginDialogBounds());
    child.show();
  });
  child.loadFile(path.join(here, "ui", "auto-login.html"), { userAgent: mainUserAgent() }).catch(error => console.error(`Auto-login dialog failed to load: ${error.message}`));
}

function autoLoginManagerState() {
  return {
    accounts: autoLoginRegistry.snapshot().accounts,
    profiles: profileRegistry.snapshot().profiles,
    activeProfileId: profileRegistry.snapshot().activeProfileId,
    run: autoLoginManager.state()
  };
}

function sendAutoLoginState() {
  if (autoLoginDialogWindow && !autoLoginDialogWindow.isDestroyed()) autoLoginDialogWindow.webContents.send("autologin:state", autoLoginManagerState());
}

ipcMain.handle("autologin:get-state", () => autoLoginManagerState());
ipcMain.handle("autologin:save-accounts", async (_event, rawText) => {
  const snapshot = await autoLoginRegistry.replaceAll(rawText);
  const state = { ...autoLoginManagerState(), accounts: snapshot.accounts };
  sendAutoLoginState();
  return state;
});
ipcMain.handle("autologin:remove-account", async (_event, id) => {
  const snapshot = await autoLoginRegistry.remove(id);
  const state = { ...autoLoginManagerState(), accounts: snapshot.accounts };
  sendAutoLoginState();
  return state;
});
ipcMain.handle("autologin:bind-profile", async (_event, { id, profileId }) => {
  const snapshot = await autoLoginRegistry.bindProfile(id, profileId);
  const state = { ...autoLoginManagerState(), accounts: snapshot.accounts };
  sendAutoLoginState();
  return state;
});
ipcMain.handle("autologin:run", async (_event, items) => {
  const state = await autoLoginManager.run(items);
  return { ...autoLoginManagerState(), run: state };
});
ipcMain.handle("autologin:stop", () => {
  const state = autoLoginManager.stop();
  return { ...autoLoginManagerState(), run: state };
});
ipcMain.handle("autologin:run-google", async (_event, { profileId }) => {
  // One-off manual Google login; the account is remembered automatically
  // after the user finishes signing in (email read from the session).
  const state = await autoLoginManager.run([{ accountId: "", profileId, email: "google-manual", type: "google", ephemeral: true }]);
  return { ...autoLoginManagerState(), run: state };
});
ipcMain.handle("autologin:open", (_event, options) => { autoLoginThemeSeed = options?.theme === "dark" ? "dark" : "light"; autoLoginLanguageSeed = options?.language === "en" ? "en" : "vi"; showAutoLoginDialog(); return true; });
ipcMain.on("autologin:agent-report", (_event, payload) => autoLoginManager.handleAgentReport(payload));

ipcMain.handle("chat:notify-approval", (_event, { summary, language } = {}) => {
  if (Notification.isSupported()) {
    const english = language === "en";
    const notice = new Notification({ title: english ? "Coworker needs your approval" : "Coworker cần bạn duyệt", body: String(summary || (english ? "An action is waiting for approval." : "Một thao tác đang chờ duyệt.")) });
    notice.on("click", () => { windowRef?.show(); windowRef?.focus(); });
    notice.show();
  }
  windowRef?.focus();
});

ipcMain.handle("workspace:select", async () => {
  const result = await dialog.showOpenDialog(windowRef, {
    title: "Choose a workspace",
    properties: ["openDirectory", "createDirectory"]
  });
  if (!result.canceled && result.filePaths[0]) {
    const added = await workbenchState.addWorkspace(result.filePaths[0]);
    await workbenchState.selectWorkspace(added.id);
    workspacePath = added.root;
    const settings = await readSettings();
    settings.workspacePath = workspacePath;
    settings.workspaces = [...new Set([...(Array.isArray(settings.workspaces) ? settings.workspaces : []), workspacePath])];
    await writeSettings(settings);
    sendState();
  }
  return workspacePath;
});

async function doStartMcp() {
  if (!workspacePath) throw new Error("Choose a workspace first.");
  await runtimeStopping;
  if (!runtime) {
    const settings = await readSettings();
    const workspacePaths = [...new Set([workspacePath, ...(Array.isArray(settings.workspaces) ? settings.workspaces : [])])];
    const nextRuntime = await createMcpRuntime({
      workspacePath,
      workspacePaths,
      dataPath: app.getPath("userData"),
      workbenchState,
      onApprovalRequired: approval => {
        if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("approval:required", approval);
        sendState();
      },
      onWorkbenchChange: sendState,
      onTunnelChange: state => {
        tunnelCache = state;
        if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("tunnel:state", state);
      }
    });
    try {
      await nextRuntime.start();
      await nextRuntime.configureUpstreams(revealUpstreams(settings.upstreams));
      try { tunnelCache = await nextRuntime.configureTunnel((await readTunnels()).map(revealTunnel)); }
      catch (error) { tunnelCache = nextRuntime.reportTunnelError(error.message, true); }
      runtime = nextRuntime;
    } catch (error) {
      await nextRuntime.stop().catch(() => {});
      throw error;
    }
  }
  startupMcpError = "";
  sendState();
  return runtime.endpoint;
}
function startMcp() {
  if (!runtimeStarting) runtimeStarting = doStartMcp().finally(() => { runtimeStarting = undefined; });
  return runtimeStarting;
}
ipcMain.handle("mcp:start", startMcp);
ipcMain.handle("preferences:get", async () => ({ autoStartMcp: (await readSettings()).autoStartMcp === true }));
ipcMain.handle("preferences:set-auto-start-mcp", async (_event, enabled) => {
  const settings = await readSettings();
  settings.autoStartMcp = enabled === true;
  await writeSettings(settings);
  return settings.autoStartMcp;
});

ipcMain.handle("mcp:stop", async () => {
  if (runtimeStarting) await runtimeStarting.catch(error => console.error(`MCP start interrupted by stop: ${error.message}`));
  if (runtime) {
    const current = runtime;
    workbenchCache = current.workbenchSnapshot();
    tunnelCache = current.tunnelSnapshot();
    runtime = undefined;
    workbenchCache.pendingApprovals = [];
    tunnelCache = current.tunnelSnapshot().map(state => ({ ...state, status: state.enabled ? "stopped" : "disabled", message: "MCP server is stopped; tunnel-client is not running." }));
    runtimeStopping = current.stop()
      .catch(error => console.error(`MCP stop cleanup failed: ${error.message}`))
      .finally(() => { runtimeStopping = Promise.resolve(); });
  }
  sendState();
});

ipcMain.handle("app:state", () => ({
  workspacePath,
  mcpRunning: Boolean(runtime),
  startupMcpError,
  endpoint: runtime?.endpoint ?? "",
  accessToken: runtime?.accessToken ?? "",
  workbench: runtime?.workbenchSnapshot() ?? workbenchCache,
  tunnel: runtime?.tunnelSnapshot() ?? tunnelCache
}));

ipcMain.handle("workbench:get-state", () => runtime?.workbenchSnapshot() ?? workbenchCache);

ipcMain.handle("workbench:get-history", (_event, taskId) => runtime?.taskHistory(taskId, 40) ?? []);

ipcMain.handle("workbench:call-tool", async (_event, { taskId, toolName, args }) => {
  if (!runtime) throw new Error("Start the MCP server before using workspace tools.");
  return runtime.callWorkbenchTool(taskId, toolName, args || {});
});

ipcMain.handle("workbench:create-task", async (_event, { workspaceId, title }) => {
  const task = runtime ? await runtime.createTask(workspaceId, title) : await workbenchState.createTask(workspaceId, title);
  sendState();
  return task;
});

ipcMain.handle("workbench:rename-task", async (_event, { taskId, title }) => {
  const task = runtime ? await runtime.renameTask(taskId, title) : await workbenchState.renameTask(taskId, title);
  sendState();
  return task;
});

ipcMain.handle("workbench:delete-task", async (_event, taskId) => {
  const task = runtime ? await runtime.deleteTask(taskId) : await workbenchState.deleteTask(taskId);
  sendState();
  return task;
});
ipcMain.handle("handoff:create", async (_event, { taskId, profileId }) => {
  const sourceProfileId = profileId || profileRegistry.active().id;
  if (runtime) return runtime.createHandoff(taskId, sourceProfileId);
  const state = JSON.parse(await fs.readFile(path.join(app.getPath("userData"), "workbench-state.json"), "utf8"));
  const task = state.tasks.find(item => item.id === taskId && item.status === "active");
  const workspace = state.workspaces.find(item => item.id === task?.workspaceId);
  if (!task || !workspace) throw new Error("Task or workspace is unavailable; select an active task first.");
  let operations = [];
  try { const text = await fs.readFile(path.join(app.getPath("userData"), "tasks", taskId, "history.jsonl"), "utf8"); operations = text.split(/\r?\n/).filter(Boolean).slice(-40).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return handoffStore.create({ profileId: sourceProfileId, workspace, task, operations, files: { touched: operations.filter(event => event.tool?.startsWith("workspace_")).map(event => event.summary).slice(0, 40), unknownShellChanges: true }, checkpoints: [], confidence: operations.length ? "medium" : "low" });
});
ipcMain.handle("handoff:latest", async (_event, taskId) => { const item = runtime?.latestHandoff(taskId) ?? await handoffStore.latest(taskId); return item ? { ...item, markdown: handoffStore.markdown(item) } : null; });

ipcMain.handle("workbench:select-workspace", async (_event, workspaceId) => {
  const snapshot = runtime ? await runtime.selectWorkspace(workspaceId) : await workbenchState.selectWorkspace(workspaceId);
  const selected = snapshot.workspaces.find(item => item.id === snapshot.defaultWorkspaceId);
  if (selected) {
    workspacePath = selected.root;
    const settings = await readSettings();
    settings.workspacePath = workspacePath;
    await writeSettings(settings);
  }
  sendState();
  return snapshot;
});

ipcMain.handle("workbench:rename-workspace", async (_event, { workspaceId, name }) => {
  const item = runtime ? await runtime.renameWorkspace(workspaceId, name) : await workbenchState.renameWorkspace(workspaceId, name);
  sendState();
  return item;
});

ipcMain.handle("workbench:remove-workspace", async (_event, workspaceId) => {
  const snapshot = runtime ? await runtime.removeWorkspace(workspaceId) : await workbenchState.removeWorkspace(workspaceId);
  const settings = await readSettings();
  settings.workspaces = snapshot.workspaces.map(item => item.root);
  settings.workspacePath = snapshot.workspaces.find(item => item.id === snapshot.defaultWorkspaceId)?.root || "";
  await writeSettings(settings);
  workspacePath = settings.workspacePath;
  sendState();
  return snapshot;
});

ipcMain.handle("workbench:select-task", async (_event, taskId) => {
  const task = runtime ? await runtime.selectTask(taskId) : await workbenchState.selectTask(taskId);
  sendState();
  return task;
});

ipcMain.handle("workbench:set-permission", async (_event, { taskId, mode }) => {
  const task = runtime ? await runtime.setTaskPermission(taskId, mode) : await workbenchState.setPermissionMode(taskId, mode);
  sendState();
  return task;
});

ipcMain.handle("approval:decide", (_event, { approvalId, approved }) => {
  if (!runtime) return false;
  const resolved = runtime.resolveApproval(approvalId, approved);
  sendState();
  return resolved;
});

ipcMain.handle("upstream:get-config", async () => {
  const settings = await readSettings();
  return revealUpstreams(settings.upstreams);
});

ipcMain.handle("upstream:save-config", async (_event, servers) => {
  const normalized = validateUpstreamServers(servers);
  const settings = await readSettings();
  const secured = protectUpstreams(normalized);
  if (runtime) await runtime.configureUpstreams(normalized);
  settings.upstreams = secured;
  await writeSettings(settings);
  sendState();
  return runtime?.upstreamStatuses() ?? [];
});

ipcMain.handle("upstream:status", () => runtime?.upstreamStatuses() ?? []);

ipcMain.handle("tunnel:get-config", async () => (await readTunnels()).map(revealTunnel));

ipcMain.handle("tunnel:save-config", async (_event, input) => {
  const configs = Array.isArray(input) ? input : [input];
  const validated = configs.map(validateTunnelConfig);
  // One Runtime API key must not be reused across tunnels: each ChatGPT
  // account gets its own credentials.
  const seenKeys = new Set();
  for (const config of validated) {
    if (config.enabled && seenKeys.has(config.runtimeApiKey)) throw new Error("Mỗi Runtime API key chỉ dùng cho một tunnel. Dùng key riêng cho từng tài khoản.");
    if (config.enabled) seenKeys.add(config.runtimeApiKey);
  }
  const settings = await readSettings();
  settings.tunnels = validated.map(protectTunnel);
  await writeSettings(settings);
  if (runtime) tunnelCache = await runtime.configureTunnel((await readTunnels()).map(revealTunnel));
  else tunnelCache = (await readTunnels()).map(config => ({ ...config, runtimeApiKey: undefined, status: config.enabled ? "stopped" : "disabled", message: config.enabled ? "Saved. Start MCP to launch tunnel-client." : "Secure MCP Tunnel is off.", logs: [] }));
  sendState();
  return tunnelCache;
});

ipcMain.handle("tunnel:remove", async (_event, tunnelId) => {
  const settings = await readSettings();
  // readTunnels() migrates the legacy single-tunnel shape first; entries keep
  // their stored (encrypted) keys — no re-protect needed.
  settings.tunnels = (await readTunnels()).filter(config => config.tunnelId !== tunnelId);
  await writeSettings(settings);
  if (runtime) tunnelCache = await runtime.configureTunnel((await readTunnels()).map(revealTunnel));
  else tunnelCache = (await readTunnels()).map(config => ({ ...config, runtimeApiKey: undefined, status: "disabled", message: "Secure MCP Tunnel is off.", logs: [] }));
  sendState();
  return tunnelCache;
});

// Reads settings.tunnels (array); migrates the legacy single-tunnel settings.tunnel.
async function readTunnels() {
  const settings = await readSettings();
  if (Array.isArray(settings.tunnels)) return settings.tunnels;
  const legacy = settings.tunnel;
  if (legacy && legacy.tunnelId) {
    settings.tunnels = [legacy];
    await writeSettings(settings);
    return settings.tunnels;
  }
  return [];
}

ipcMain.handle("tunnel:status", () => runtime?.tunnelSnapshot() ?? tunnelCache);

ipcMain.handle("tunnel:select-binary", async () => {
  const result = await dialog.showOpenDialog(windowRef, {
    title: "Choose the official tunnel-client executable",
    properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "Executable", extensions: ["exe"] }, { name: "All files", extensions: ["*"] }] : []
  });
  return result.canceled ? "" : result.filePaths[0] || "";
});

app.whenReady().then(async () => {
  let startupSettings = {};
  try { startupSettings = await readSettings(); workspacePath = startupSettings.workspacePath || ""; }
  catch (error) { console.error("Could not load Coworker settings:", error); }
  workbenchState = new WorkbenchState(app.getPath("userData"));
  await workbenchState.initialize("");
  for (const root of new Set([workspacePath, ...(startupSettings.workspaces || [])])) {
    if (!root) continue;
    try { await workbenchState.addWorkspace(root); }
    catch (error) { console.warn(`Skipping unavailable workspace ${root}: ${error.message}`); }
  }
  workbenchCache = { ...workbenchState.snapshot(), pendingApprovals: [] };
  workspacePath = workbenchCache.workspaces.find(item => item.id === workbenchCache.defaultWorkspaceId)?.root || "";
  // Coworker owns its toolbar; remove Electron's default File/Edit/View/Window
  // menu so WebContentsView overlays and the app UI have one surface.
  Menu.setApplicationMenu(null);
  profileRegistry = new ChatProfileRegistry(app.getPath("userData"));
  await profileRegistry.initialize();
  handoffStore = new HandoffStore(app.getPath("userData"));
  autoLoginRegistry = new AutoLoginRegistry(app.getPath("userData"));
  await autoLoginRegistry.initialize();
  autoLoginManager = new AutoLoginManager({ registry: autoLoginRegistry, profileRegistry, notify: () => sendAutoLoginState(), handoffStore, userAgent: () => mainUserAgent(), onProfileSessionChanged: profileId => {
    // The login window wrote a fresh session into this profile's partition.
    // Any live ChatGPT view still holds the old page; recreate it (same path
    // as profile switching) so the new account shows up without a manual
    // profile round-trip, then deliver a pending account-switch handoff (the
    // outgoing account's transcript) into a fresh chat.
    const active = profileRegistry.active();
    const wasActiveVisible = active && active.id === profileId && chatViewVisible;
    destroyChatView(profileId);
    if (wasActiveVisible) openChatView();
    void deliverProfileHandoff(profileId);
  } });
  createWindow();
  if (startupSettings.autoStartMcp === true && workspacePath) {
    try { await startMcp(); }
    catch (error) { startupMcpError = error.message; console.error("Could not auto-start MCP:", error); sendState(); }
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", event => {
  if (autoLoginManager) autoLoginManager.stop();
  if (autoLoginDialogWindow && !autoLoginDialogWindow.isDestroyed()) autoLoginDialogWindow.destroy();
  if (!runtime) return;
  event.preventDefault();
  runtime.stop().finally(() => {
    runtime = undefined;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
