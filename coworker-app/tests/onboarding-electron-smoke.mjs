// Run with: node_modules/electron/dist/electron.exe tests/onboarding-electron-smoke.mjs
// Uses a fresh disposable profile and blocks all network requests; never starts MCP.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'coworker-tour-smoke-'));
app.setPath('appData', output);
app.setPath('userData', output);
app.on('session-created', session => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [];
let win;
const js = source => win.webContents.executeJavaScript(source);
const tour = () => win.contentView.children.find(view => view.webContents && view.webContents !== win.webContents && view.webContents.getURL().startsWith('data:text/html'));
const check = (name, success, detail = {}) => rows.push({ name, success: Boolean(success), ...detail });
async function waitForNativeTour(index) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const view = tour();
    if (view && await js(`localStorage.getItem('coworker.tour.progress') === '${index}'`)) {
      const ready = await view.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('.card');
        return document.querySelector('#step')?.textContent.endsWith('${index + 1}/13')
          && Math.abs(card.getBoundingClientRect().height - innerHeight) < 3;
      })()`).catch(() => false);
      if (ready) return true;
    }
    await delay(100);
  }
  return false;
}
async function show(index) {
  const current = Number(await js(`localStorage.getItem('coworker.tour.progress')`));
  if (tour() && index === current + 1) {
    await tour().webContents.executeJavaScript(`document.querySelector('#next').click()`);
  } else {
    await js(`localStorage.setItem('coworker.tour.progress','${index}');localStorage.removeItem('coworker.tour.v2')`);
    win.webContents.reload();
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await delay(500);
  }
  await waitForNativeTour(index);
  await delay(120);
}
async function measure(name) {
  const target = await js(`(()=>{const e=document.querySelector('.tour-target');return e ? {rect:e.getBoundingClientRect().toJSON(),selector:e.id || e.className,index:localStorage.getItem('coworker.tour.progress'),viewport:{width:innerWidth,height:innerHeight}} : null})()`);
  const view = tour();
  if (!view || !target) { check(name, false, { reason: 'Missing native popup or highlighted target', target }); return; }
  const bounds = view.getBounds();
  const dom = await view.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.card');return {card:e?.getBoundingClientRect().toJSON(),scrollHeight:e?.scrollHeight,height:innerHeight,width:innerWidth,body:document.body.scrollHeight}})()`);
  const rect = target.rect;
  const overlap = Math.max(0, Math.min(rect.right, bounds.x + bounds.width) - Math.max(rect.left, bounds.x)) * Math.max(0, Math.min(rect.bottom, bounds.y + bounds.height) - Math.max(rect.top, bounds.y));
  check(name, rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.left >= -1 && rect.bottom <= target.viewport.height + 1 && rect.right <= target.viewport.width + 1 && overlap < 1 && dom.card && Math.abs(bounds.height - dom.card.height) <= 3 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= target.viewport.width + 1 && bounds.y + bounds.height <= target.viewport.height + 1, { target, bounds, dom, overlap });
}
async function run() {
try {
  await import('../electron/main.js');
  for (let i = 0; i < 100; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) {
      try { if (await js(`Boolean(document.querySelector('#show-tour'))`)) break; } catch {}
    }
    await delay(100);
  }
  await delay(500);
  const sizes = [[760, 560], [1100, 850], [1366, 768]];
  for (const [width, height] of sizes) {
    win.setContentSize(width, height);
    await delay(200);
    for (const lang of ['vi', 'en']) for (const theme of ['dark', 'light']) {
      await js(`localStorage.setItem('coworker.language','${lang}'); localStorage.setItem('coworker.theme','${theme}');`);
      for (let i = 0; i < 13; i++) {
        await show(i);
        const name = `${width}x${height}-${lang}-${theme}-step-${i + 1}`;
        await measure(name);
        if (lang === 'vi' && theme === 'dark' && [0, 4, 5, 6, 8, 12].includes(i) && tour()) {
          await fs.writeFile(path.join(output, `${name}.png`), (await tour().webContents.capturePage()).toPNG());
          await fs.writeFile(path.join(output, `${name}-window.png`), (await win.capturePage()).toPNG());
        }
      }
    }
  }
  for (const language of ['vi', 'en']) {
    await js(`localStorage.setItem('coworker.language','${language}')`);
    for (const [index, expected] of [[4, language === 'en' ? 'Optional:' : 'Tùy chọn:'], [12, language === 'en' ? 'Optional:' : 'Tùy chọn:']]) {
      await show(index);
      const title = await tour().webContents.executeJavaScript(`document.querySelector('#title').textContent`);
      check(`${language}-step-${index + 1}-marked-optional`, title.startsWith(expected), { title });
    }
    await show(5);
    const tunnelTitle = await tour().webContents.executeJavaScript(`document.querySelector('#title').textContent`);
    check(`${language}-tunnel-creation-follows-per-account-preflight`, /Tunnel ID/.test(tunnelTitle), { tunnelTitle });
  }
  await js(`localStorage.setItem('coworker.tour.progress','12');localStorage.removeItem('coworker.tour.order-version')`);
  win.webContents.reload();
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await delay(650);
  check('legacy final step migrates to step 5', await js(`localStorage.getItem('coworker.tour.progress') === '4' && localStorage.getItem('coworker.tour.order-version') === '3'`));
  win.webContents.reload();
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await delay(650);
  check('tour progress migrates only once', await js(`localStorage.getItem('coworker.tour.progress') === '4'`));
  await js(`localStorage.setItem('coworker.tour.progress','4');localStorage.removeItem('coworker.tour.order-version')`);
  win.webContents.reload();
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await delay(650);
  check('legacy Tunnel ID step migrates to step 6', await js(`localStorage.getItem('coworker.tour.progress') === '5'`));
  await show(5);
  await tour().webContents.executeJavaScript(`document.querySelector('#hide').click()`);
  await delay(250);
  check('hide preserves progress', !tour() && await js(`localStorage.getItem('coworker.tour.progress') === '5'`));
  await js(`document.querySelector('#show-tour').click()`);
  check('resume restores step', await waitForNativeTour(5));
  if (!tour()) throw new Error('Native tour did not resume');
  const previous = await tour().webContents.executeJavaScript(`Boolean(document.querySelector('#back, #previous, #prev'))`);
  check('previous button exists', previous);
  if (previous) {
    await tour().webContents.executeJavaScript(`document.querySelector('#back, #previous, #prev').click()`);
    await delay(350);
    check('previous moves backward', await js(`localStorage.getItem('coworker.tour.progress') === '4'`));
    await tour().webContents.executeJavaScript(`document.querySelector('#next').click()`);
    await delay(350);
    check('next moves forward', await js(`localStorage.getItem('coworker.tour.progress') === '5'`));
  }
  await show(6);
  await tour().webContents.executeJavaScript(`document.querySelector('.image').click()`);
  await delay(250);
  check('image zoom fills viewport', tour().getBounds().width === win.getContentBounds().width && tour().getBounds().height === win.getContentBounds().height);
  win.setContentSize(1100, 700);
  await delay(350);
  const zoomed = await tour().webContents.executeJavaScript(`document.body.classList.contains('zoomed')`);
  const zoomBounds = tour().getBounds();
  const zoomContent = win.getContentBounds();
  check('image zoom survives resize', zoomed && zoomBounds.height === zoomContent.height, { zoomed, zoomBounds, zoomContent });
  await tour().webContents.executeJavaScript(`document.querySelector('.zoom-close').click()`);
  await delay(350);
  await measure('image close restores fitted popup');
  await js(`localStorage.setItem('coworker.sidebarCollapsed','true')`);
  await show(0);
  await measure('collapsed sidebar target is visible');
  await show(6);
  await js(`document.querySelector('.page-scroll')?.scrollBy(0,30)`);
  await delay(400);
  await measure('scrolled target popup stays aligned');
  await show(12);
  await tour().webContents.executeJavaScript(`document.querySelector('#next').click()`);
  await delay(300);
  check('finish closes popup and completes onboarding', !tour() && await js(`localStorage.getItem('coworker.tour.v2') === 'done' && localStorage.getItem('coworker.tour.progress') === null`));
  await js(`document.querySelector('#show-tour').click()`);
  check('reopen completed tour starts first step', await waitForNativeTour(0));
  if (!tour()) throw new Error('Native tour did not reopen after completion');
  await tour().webContents.executeJavaScript(`document.querySelector('#skip').click()`);
  await delay(300);
  check('skip closes and completes onboarding', !tour() && await js(`localStorage.getItem('coworker.tour.v2') === 'done'`));
} catch (error) {
  check('harness error', false, { message: error.stack });
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(rows, null, 2));
  const failed = rows.filter(row => !row.success);
  console.log(JSON.stringify({ output, total: rows.length, passed: rows.length - failed.length, failed: failed.map(row => row.name) }));
  app.exit(failed.length ? 1 : 0);
}
}
void run();
