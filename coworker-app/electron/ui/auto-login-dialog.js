// Renderer for the native auto-login dialog window (auto-login.html).
// No Node access: talks to the main process exclusively over the preload bridge.
const state = { accounts: [], profiles: [], activeProfileId: "", run: { running: false, queue: [], current: null, results: [] } };
const accountList = document.querySelector("#account-list");
const queueList = document.querySelector("#queue-list");
const resultList = document.querySelector("#result-list");
const accountCount = document.querySelector("#account-count");
const stopButton = document.querySelector("#stop");
const bulkInput = document.querySelector("#bulk-input");
const saveBulk = document.querySelector("#save-bulk");
const runPanel = document.querySelector("#run-panel");
const runGoogleBtn = document.querySelector("#run-google");
let language = "vi";
const uiText = {
  "Coworker · Đăng nhập tự động": "Coworker · Automatic sign-in",
  "Đăng nhập tự động": "Automatic sign-in", "Đóng": "Close", "Hàng đợi": "Queue", "Dừng": "Stop",
  "Chưa có gì đang chạy.": "Nothing is running.", "Tài khoản": "Accounts",
  "Thêm nhanh — mỗi dòng: email | mật khẩu | mã 2FA (tùy chọn)": "Quick add — one per line: email | password | 2FA code (optional)",
  "Thêm vào danh sách": "Add to list", "Đăng nhập bằng Google": "Sign in with Google",
  "Đăng nhập tất cả": "Sign in to all", "Chưa có tài khoản nào.": "No accounts yet.",
  "Profile sẽ nhận phiên đăng nhập": "Profile to receive this sign-in session", "— Không —": "— None —",
  "Đăng nhập": "Sign in", "Xóa": "Remove", "có mật khẩu": "password saved",
  "thiếu mật khẩu": "password missing", "Không 2FA": "No 2FA", "đang chờ": "waiting",
  "đang mở trang đăng nhập": "opening sign-in page", "đang tải trang đăng nhập": "loading sign-in page",
  "đang điền email": "entering email", "đang điền mật khẩu": "entering password",
  "đang điền mã 2FA": "entering 2FA code", "đã gửi mã 2FA": "2FA code submitted",
  "đang bấm Đăng nhập bằng Google": "selecting Sign in with Google",
  "chờ bạn đăng nhập Google trong cửa sổ đã mở": "waiting for you to sign in with Google in the open window",
  "hoàn tất": "complete", "thành công": "successful", "lỗi": "error", "quá hạn": "timed out",
  "đã hủy": "cancelled", "đã lưu vào danh sách": "saved to list",
  "google-manual (email không đọc được)": "Google sign-in (email could not be read)",
  "switching": "switching accounts", "stalled": "sign-in stalled", "google-manual": "manual Google sign-in",
  "overall-timeout": "overall time limit reached", "manual-timeout": "manual sign-in timed out",
  "window-closed": "sign-in window closed", "reload-login-failed": "could not reopen sign-in page"
};
function localized(value) {
  if (language !== "en") return value;
  const text = String(value || "");
  if (uiText[text]) return uiText[text];
  if (text.startsWith("Tài khoản ") && text.includes(" chưa gắn profile.")) return text.replace("Tài khoản ", "Account ").replace(" chưa gắn profile. Chọn profile (dropdown) trước khi đăng nhập.", " has no assigned profile. Select a profile before signing in.");
  if (text.startsWith("session-vẫn-là-")) return `session still belongs to ${text.slice(15).replace("không-rõ", "an unknown account")}`;
  if (text.startsWith("stuck-at-")) return `stuck at ${localized(stepText[text.slice(9)] || text.slice(9))}`;
  const [step, ...detail] = text.split(": ");
  if (detail.length && (stepText[step] || uiText[step])) return `${localized(stepText[step] || step)}: ${localized(detail.join(": "))}`;
  return text;
}
function localizeStatic() {
  document.documentElement.lang = language;
  document.title = localized(document.title);
  for (const node of document.querySelectorAll("body *")) {
    for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE) {
      const original = child.nodeValue.trim();
      if (uiText[original]) child.nodeValue = child.nodeValue.replace(original, localized(original));
    }
    for (const attr of ["title", "aria-label"]) {
      const value = node.getAttribute(attr);
      if (value && uiText[value]) node.setAttribute(attr, localized(value));
    }
  }
}

const stepText = { starting: "đang mở trang đăng nhập", page: "đang tải trang đăng nhập", email: "đang điền email", password: "đang điền mật khẩu", otp: "đang điền mã 2FA", "otp-submitted": "đã gửi mã 2FA", "google-start": "đang bấm Đăng nhập bằng Google", "google-manual": "chờ bạn đăng nhập Google trong cửa sổ đã mở", done: "hoàn tất" };
const statusText = { success: "thành công", error: "lỗi", timeout: "quá hạn", cancelled: "đã hủy", saved: "đã lưu vào danh sách" };

function profileLabel(id) { const profile = state.profiles.find(item => item.id === id); return profile ? profile.label : id; }

function render() {
  // Accounts
  accountCount.textContent = String(state.accounts.length);
  accountList.replaceChildren();
  if (!state.accounts.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = localized("Chưa có tài khoản nào."); accountList.append(li); }
  for (const account of state.accounts) {
    const li = document.createElement("li"); li.className = "account-item";
    const email = document.createElement("span"); email.className = "email"; email.textContent = account.email;
    const select = document.createElement("select"); select.title = localized("Profile sẽ nhận phiên đăng nhập");
    const noneOption = document.createElement("option"); noneOption.value = ""; noneOption.textContent = localized("— Không —"); select.append(noneOption);
    for (const profile of state.profiles) { const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.label; select.append(option); }
    select.value = account.profileId || "";
    select.addEventListener("change", () => window.coworkerAutoLoginUi.bindProfile(account.id, select.value).then(nextState => {
      // The bind may have released OTHER accounts bound to the same profile —
      // re-render every row from the fresh snapshot, not just this dropdown.
      if (nextState) { Object.assign(state, nextState); render(); }
    }));
    const runBtn = document.createElement("button"); runBtn.className = "mini-btn go"; runBtn.textContent = localized("Đăng nhập");
    runBtn.addEventListener("click", () => window.coworkerAutoLoginUi.run([{ accountId: account.id, profileId: select.value }]).then(nextState => { if (nextState) { Object.assign(state, nextState); render(); } }));
    const delBtn = document.createElement("button"); delBtn.className = "mini-btn del"; delBtn.textContent = localized("Xóa");
    delBtn.addEventListener("click", async () => { const nextState = await window.coworkerAutoLoginUi.removeAccount(account.id); if (nextState) { Object.assign(state, nextState); render(); } });
    if (account.type === "google") {
      const gTag = document.createElement("span"); gTag.className = "tag go"; gTag.textContent = "Google";
      li.append(email, gTag, select, runBtn, delBtn);
    } else {
      const pwTag = document.createElement("span"); pwTag.className = "tag" + (account.hasPassword ? " ok" : " err"); pwTag.textContent = localized(account.hasPassword ? "có mật khẩu" : "thiếu mật khẩu");
      const faTag = document.createElement("span"); faTag.className = "tag"; faTag.textContent = localized(account.has2fa ? "2FA" : "Không 2FA");
      li.append(email, pwTag, faTag, select, runBtn, delBtn);
    }
    accountList.append(li);
  }

  // Run queue + results
  const run = state.run || { running: false, queue: [], current: null, results: [] };
  stopButton.hidden = !run.running;
  queueList.replaceChildren();
  if (!run.running) { const li = document.createElement("li"); li.className = "empty"; li.textContent = localized("Chưa có gì đang chạy."); queueList.append(li); }
  if (run.current) {
    const li = document.createElement("li"); li.className = "queue-item";
    const spin = document.createElement("span"); spin.className = "spin";
    const email = document.createElement("span"); email.className = "email"; email.textContent = `${run.current.email} → ${profileLabel(run.current.profileId)}`;
    const step = document.createElement("span"); step.className = "step"; step.textContent = localized(stepText[run.current.step] || run.current.step || "");
    li.append(spin, email, step);
    queueList.append(li);
  }
  for (const accountId of run.queue) {
    const account = state.accounts.find(item => item.id === accountId);
    const li = document.createElement("li"); li.className = "queue-item";
    const email = document.createElement("span"); email.className = "email"; email.textContent = account ? account.email : accountId;
    const step = document.createElement("span"); step.className = "step"; step.textContent = localized("đang chờ");
    li.append(email, step);
    queueList.append(li);
  }
  resultList.replaceChildren();
  for (const result of run.results.slice().reverse()) {
    const li = document.createElement("li"); li.className = "result-item";
    const tag = document.createElement("span"); tag.className = "tag " + (result.status === "success" ? "ok" : "err"); tag.textContent = localized(statusText[result.status] || result.status);
    const email = document.createElement("span"); email.className = "email"; email.textContent = `${result.email} → ${profileLabel(result.profileId)}`;
    const detail = document.createElement("span"); detail.className = "detail"; detail.textContent = localized(result.detail || "");
    li.append(tag, email, detail);
    resultList.append(li);
  }
  runPanel.hidden = !run.running && run.results.length === 0;
}

document.querySelector("#close").addEventListener("click", () => window.coworkerAutoLoginUi.close());
document.querySelector(".dialog").addEventListener("click", event => { if (event.target.classList.contains("dialog")) window.coworkerAutoLoginUi.close(); });
window.addEventListener("keydown", event => { if (event.key === "Escape") window.coworkerAutoLoginUi.close(); });
stopButton.addEventListener("click", () => window.coworkerAutoLoginUi.stopRun());
saveBulk.addEventListener("click", async () => {
  const text = bulkInput.value;
  if (!text.trim()) return;
  const nextState = await window.coworkerAutoLoginUi.saveAccounts(text);
  if (nextState) Object.assign(state, nextState);
  bulkInput.value = "";
  render();
});
document.querySelector("#login-all").addEventListener("click", () => {
  const items = state.accounts.filter(account => account.hasPassword && (account.profileId || state.activeProfileId)).map(account => ({ accountId: account.id, profileId: account.profileId || state.activeProfileId }));
  if (!items.length) return;
  window.coworkerAutoLoginUi.run(items).then(nextState => { if (nextState) { Object.assign(state, nextState); render(); } });
});
runGoogleBtn.addEventListener("click", () => {
  const profileId = state.activeProfileId || state.profiles[0]?.id || "";
  window.coworkerAutoLoginUi.runGoogle({ profileId }).then(nextState => { if (nextState) { Object.assign(state, nextState); render(); } });
});

window.coworkerAutoLoginUi.onState(newState => { Object.assign(state, newState); render(); });

(async () => {
  const initial = await window.coworkerAutoLoginUi.getState();
  Object.assign(state, initial);
  try { document.documentElement.dataset.theme = await window.coworkerThemeSeed.getTheme() === "dark" ? "dark" : "light"; } catch {}
  try { language = await window.coworkerThemeSeed.getLanguage() === "en" ? "en" : "vi"; } catch {}
  localizeStatic();
  render();
})();
