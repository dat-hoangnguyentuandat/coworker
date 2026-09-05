// Run with: node_modules/electron/dist/electron.exe tests/profile-continuity-electron-smoke.mjs
// Uses disposable profile partitions and blocks every remote request.
import { app, BrowserWindow, webContents } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'coworker-profile-smoke-'));
app.setPath('appData', output);
app.setPath('userData', output);
app.on('session-created', current => {
  current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const check = (name, success) => checks.push({ name, success: Boolean(success) });
function contrast(foreground, background) {
  const channel = value => { const scaled = value / 255; return scaled <= .04045 ? scaled / 12.92 : ((scaled + .055) / 1.055) ** 2.4; };
  const luminance = value => {
    const rgb = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    return rgb ? rgb.map(channel).reduce((sum, component, index) => sum + component * [.2126, .7152, .0722][index], 0) : NaN;
  };
  const a = luminance(foreground); const b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
let win;
const js = source => win.webContents.executeJavaScript(source);
const attachedChat = () => win.contentView.children.find(view => view.webContents && view.webContents.session !== win.webContents.session);

async function run() {
try {
  process.on('unhandledRejection', error => console.error('Profile smoke unhandled rejection:', error));
  await import('../electron/main.js');
  for (let count = 0; count < 100; count++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) {
      try { if (await js(`Boolean(window.coworker?.getProfiles)`)) break; } catch {}
    }
    await delay(100);
  }
  check('main window was created', Boolean(win));
  if (!win) throw new Error('Main window did not initialize');
  const colors = await js(`(() => {
    document.documentElement.dataset.theme='dark';
    const browser=document.querySelector('#file-browser');
    const entry=document.createElement('button');entry.className='file-entry';entry.textContent='sample';browser.append(entry);
    const selected=entry.cloneNode(true);selected.setAttribute('aria-selected','true');browser.append(selected);
    const history=document.createElement('div');history.className='history-item';history.innerHTML='<span class="history-tool">Tool</span><span class="history-summary">Summary</span>';document.querySelector('#history').append(history);
    const values=(element)=>{const style=getComputedStyle(element);return {color:style.color,background:style.backgroundColor}};
    return {file:values(entry),selected:values(selected),changes:values(document.querySelector('#git-status')),terminal:values(document.querySelector('#terminal-output')),activity:values(history.querySelector('.history-tool')),
      activityBackground:values(history).background};
  })()`);
  check('dark file row text is readable', contrast(colors.file.color, colors.file.background === 'rgba(0, 0, 0, 0)' ? 'rgb(21, 29, 24)' : colors.file.background) >= 4.5);
  check('dark selected file row stays dark and readable', contrast(colors.selected.color, colors.selected.background) >= 4.5 && !colors.selected.background.includes('255, 255, 255'));
  check('dark changes and terminal output readable', contrast(colors.changes.color, colors.changes.background) >= 4.5 && contrast(colors.terminal.color, colors.terminal.background) >= 4.5);
  check('dark activity text readable', contrast(colors.activity.color, colors.activityBackground) >= 4.5);
  await js(`localStorage.setItem('coworker.tour.v2','done');window.coworker.hideTourNative()`);
  const firstId = (await js(`window.coworker.getProfiles()`)).activeProfileId;
  await js(`window.coworker.toggleChat()`);
  const first = attachedChat();
  check('first profile opens native view', Boolean(first));
  await delay(600);
  await first.webContents.executeJavaScript('window.ticks=0;setInterval(()=>window.ticks++,100)');
  const second = await js(`window.coworker.createProfile('Profile B')`);
  await js(`window.coworker.switchProfile(${JSON.stringify(second.id)})`);
  const secondView = attachedChat();
  const secondContents = secondView?.webContents;
  check('second profile uses distinct view', Boolean(secondView && secondView !== first));
  check('first view stays alive while detached', !first.webContents.isDestroyed());
  await delay(800);
  const ticks = await first.webContents.executeJavaScript('window.ticks');
  check('inactive profile JavaScript keeps progressing', ticks >= 3);
  await js(`window.coworker.switchProfile(${JSON.stringify(firstId)})`);
  check('switching back reuses exact first view', attachedChat() === first);
  check('first profile retains its page state', await first.webContents.executeJavaScript('window.ticks') >= ticks);

  const third = await js(`window.coworker.createProfile('Profile C')`);
  await js(`window.coworker.switchProfile(${JSON.stringify(third.id)})`);
  const thirdView = attachedChat();
  const thirdContents = thirdView?.webContents;
  check('third profile opens without suspending another', thirdView && thirdView !== first && thirdView !== secondView);
  check('all three profile pages remain alive', !first.webContents.isDestroyed() && !secondContents?.isDestroyed() && !thirdContents?.isDestroyed());
  await js(`window.coworker.switchProfile(${JSON.stringify(second.id)})`);
  check('second profile reuses its original view', attachedChat() === secondView);
  await js(`window.coworker.switchProfile(${JSON.stringify(third.id)})`);
  check('third profile reuses its original view', attachedChat() === thirdView);
  await js(`window.coworker.forgetProfile(${JSON.stringify(third.id)})`);
  check('forgotten profile view closes', thirdContents?.isDestroyed() && !webContents.getAllWebContents().includes(thirdContents));
} catch (error) {
  checks.push({ name: 'harness error', success: false, error: error.stack });
} finally {
  const failed = checks.filter(item => !item.success);
  console.log(JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed }));
  app.exit(failed.length ? 1 : 0);
}
}
void run();
