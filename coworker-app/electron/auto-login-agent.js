/* Builds the automation script injected into the hidden login window.
   Port of tool-log-gpt content.js + totp.js for OpenAI credentials
   (email -> password -> OTP/2FA). Google-type accounts are only driven as far
   as the "Continue with Google" hand-off; accounts.google.com is finished by
   the user in the window the manager shows (Google blocks scripted logins). */

export function buildAgentScript(credentials) {
  const creds = JSON.stringify({ email: credentials.email || "", password: credentials.password || "", twofa: credentials.twofa || "", type: credentials.type === "google" ? "google" : "openai" });
  return `(async () => {
  if (window.__coworkerAutoLoginAgent) return;
  window.__coworkerAutoLoginAgent = true;
  const creds = ${creds};
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const report = payload => { try { window.coworkerAutoLogin?.report(payload); } catch {} };
  const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

  function waitForVisibleElement(selectors, timeout = 15000) {
    const sel = Array.isArray(selectors) ? selectors.join(",") : selectors;
    return new Promise((resolve, reject) => {
      const check = () => {
        for (const e of document.querySelectorAll(sel)) if (isVisible(e)) return e;
        return null;
      };
      const el = check();
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = check();
        if (found) { obs.disconnect(); clearTimeout(t); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      const t = setTimeout(() => { obs.disconnect(); reject(new Error("Timeout: " + sel)); }, timeout);
    });
  }

  function fillInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    ["input", "change", "blur"].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true })));
  }

  async function clickSubmit(refEl) {
    await delay(200);
    const form = refEl.closest("form");
    let btn = form ? form.querySelector('button[type="submit"], button[data-action-button-primary="true"], button[name="action"]') : null;
    if (!btn) btn = document.querySelector('button[type="submit"], button[data-action-button-primary="true"]');
    for (let i = 0; i < 10; i++) { if (btn && !btn.disabled) break; await delay(250); }
    if (btn && !btn.disabled) btn.click();
    else {
      refEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
      refEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    }
  }

  async function generateTOTP(secret, digits = 6, period = 30) {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = secret.replace(/[^A-Z2-7]/g, "").toUpperCase();
    let bits = "";
    for (const ch of cleaned) { const idx = ALPHABET.indexOf(ch); if (idx !== -1) bits += idx.toString(2).padStart(5, "0"); }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    const timeStep = Math.floor(Date.now() / 1000 / period);
    const counter = new ArrayBuffer(8);
    const view = new DataView(counter);
    view.setUint32(0, Math.floor(timeStep / 0x100000000), false);
    view.setUint32(4, timeStep >>> 0, false);
    const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: { name: "SHA-1" } }, false, ["sign"]);
    const hash = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
    const offset = hash[hash.length - 1] & 0x0f;
    const code = (((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff)) % 10 ** digits;
    return code.toString().padStart(digits, "0");
  }

  async function resolveTwoFa(twofa) {
    if (!twofa || !twofa.trim()) return "";
    const cleaned = twofa.replace(/[\\s\\-=]/g, "").toUpperCase();
    if (/^\\d{6,8}$/.test(cleaned)) return cleaned;
    if (cleaned.length >= 8) { try { return await generateTOTP(cleaned); } catch { return ""; } }
    return twofa.trim();
  }

  async function clickGoogleButton() {
    report({ step: "google-start" });
    const btn = await waitForVisibleElement([
      'button[data-provider="google"]',
      "button.auth-button--google",
      'button[value="google"]',
      "button.js-social-login"
    ], 10000).catch(() => null);
    if (!btn) {
      const fallback = [...document.querySelectorAll("button, a")].find(el => isVisible(el) && /google/i.test(el.textContent || ""));
      if (!fallback) return report({ step: "google-start", error: "no-google-button" });
      fallback.click();
    } else {
      btn.click();
    }
    report({ step: "google-start", submitted: true });
  }

  async function stepEmail() {
    report({ step: "email" });
    const el = await waitForVisibleElement(['input[type="email"]', 'input[name="email"]', 'input[name="username"]', 'input[autocomplete="email"]', 'input[id*="email"]']).catch(() => null);
    if (!el) return report({ step: "email", error: "no-email-input" });
    await delay(500);
    el.focus();
    fillInput(el, creds.email);
    await delay(500);
    await clickSubmit(el);
    await delay(1500);
    detectAndFill(0);
  }

  async function stepPassword() {
    report({ step: "password" });
    const el = await waitForVisibleElement(['input[type="password"]', 'input[name="password"]']).catch(() => null);
    if (!el) return report({ step: "password", error: "no-password-input" });
    await delay(500);
    el.focus();
    fillInput(el, creds.password);
    await delay(500);
    await clickSubmit(el);
    await delay(1500);
    detectAndFill(0);
  }

  async function stepOtp() {
    report({ step: "otp" });
    if (!creds.twofa || !creds.twofa.trim()) return report({ step: "otp", error: "2fa-required-but-missing" });
    const otpCode = await resolveTwoFa(creds.twofa);
    if (!otpCode) return report({ step: "otp", error: "totp-failed" });
    const el = await waitForVisibleElement(['input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[name="code"]', 'input[name="mfa_code"]', 'input[name="totp"]', 'input[type="number"]'], 10000).catch(() => null);
    if (!el) return report({ step: "otp", error: "no-otp-input" });
    const boxes = document.querySelectorAll('input[inputmode="numeric"][maxlength="1"], input[type="text"][maxlength="1"]');
    if (boxes.length >= 6) {
      const digits = otpCode.split("");
      for (let i = 0; i < boxes.length && i < digits.length; i++) {
        if (isVisible(boxes[i])) { boxes[i].focus(); await delay(80); fillInput(boxes[i], digits[i]); }
      }
    } else {
      el.focus();
      await delay(300);
      fillInput(el, otpCode);
    }
    await delay(500);
    await clickSubmit(el);
    report({ step: "otp", submitted: true });
  }

  async function detectAndFill(attempt = 0) {
    if (attempt > 15) return report({ step: "stalled", error: "too-many-attempts" });
    const selEmail = 'input[type="email"], input[name="email"], input[name="username"]';
    const selPassword = 'input[type="password"], input[name="password"]';
    const selOtp = 'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"]';
    const checkVisible = sel => { for (const e of document.querySelectorAll(sel)) if (isVisible(e)) return true; return false; };
    const hasOtp = checkVisible(selOtp);
    const hasPassword = checkVisible(selPassword);
    const hasEmail = checkVisible(selEmail);
    if (hasOtp && !hasPassword) await stepOtp();
    else if (hasPassword) await stepPassword();
    else if (hasEmail) await stepEmail();
    else { await delay(1000); detectAndFill(attempt + 1); }
  }

  report({ step: "agent-ready", url: location.href });
  await delay(500);
  if (creds.type === "google") {
    // Google blocks scripted credential entry. The agent only performs the
    // OpenAI-side hand-off ("Continue with Google"); accounts.google.com is
    // completed by the user in the window the manager shows.
    if (!location.hostname.includes("accounts.google.com")) clickGoogleButton();
    else report({ step: "google-manual" });
  } else {
    detectAndFill(0);
  }
})();`;
}
