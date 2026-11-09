// Runs the browser tests in Chrome or, with TINGQIANG_TEST_EXE set, in the packaged client over the DevTools protocol.
// Each new page or context is a fresh client on its own profile, since the client has one window and no incognito mode.
import {chromium as playwright} from 'playwright-core';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const exe = process.env.TINGQIANG_TEST_EXE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); }); });
const artifactFolders = () => new Set(readdirSync(tmpdir()).filter(name => name.startsWith('playwright-artifacts-')));

export async function launchClient({args = [], profile = mkdtempSync(join(tmpdir(), 'tingqiang-client-')), program = exe, env = {}, nativeDownloads = false} = {}) {
  const port = await freePort(), known = artifactFolders();
  // Muted: the client plays through the real speakers, and no one wants to hear a test run.
  const child = spawn(program, ['--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...args], {env: {...process.env, TINGQIANG_BACKGROUND: '1', ...env}, stdio: 'ignore'});
  // Attaching before the window's page exists stalls until Playwright's 30-second timeout.
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    try { ready = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some(target => target.type === 'page' && target.url.startsWith('tingqiang:')); }
    catch { /* Not listening yet. */ }
    if (!ready) await sleep(100);
  }
  if (!ready) { child.kill(); throw new Error('The client did not open its window.'); }
  const browser = await playwright.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  await page.waitForLoadState('load');
  // Saves go to Playwright's folder instead of the native dialog, which nothing here can answer.
  const artifacts = [...artifactFolders()].find(name => !known.has(name));
  const session = await browser.newBrowserCDPSession();
  if (artifacts && !nativeDownloads) await session.send('Browser.setDownloadBehavior', {behavior: 'allowAndName', downloadPath: join(tmpdir(), artifacts), eventsEnabled: true});
  const exited = new Promise(resolve => child.once('exit', resolve));
  /** Ends the app the hard way, as a crash or power cut would, and returns once it is gone. */
  const kill = async () => {
    await browser.close().catch(() => {});
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {stdio: 'ignore'}); } catch { /* Already gone. */ }
    await exited;
  };
  /** Discards the client and its profile. */
  const quit = async () => {
    await kill();
    for (let i = 0; i < 20; i++) { try { rmSync(profile, {recursive: true, force: true}); return; } catch { await sleep(250); } }
  };
  return {browser, context, page, child, profile, port, exited, kill, quit};
}

export const chromium = {
  async launch(options = {}) {
    if (!exe) return playwright.launch(options);
    const running = [], args = (options.args || []).filter(arg => arg !== '--no-sandbox');
    const start = async ({viewport} = {}) => {
      const client = await launchClient({args}); running.push(client);
      if (viewport) await client.page.setViewportSize(viewport);
      return client;
    };
    return {
      newPage: async pageOptions => (await start(pageOptions)).page,
      newContext: async contextOptions => { const client = await start(contextOptions); return Object.assign(client.context, {newPage: async () => client.page}); },
      close: () => Promise.all(running.map(client => client.quit())),
    };
  },
};
