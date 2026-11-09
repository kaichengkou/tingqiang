// The client runs dist/ unchanged inside its own Chromium. A private scheme gives the page a fixed origin, so saved
// practice survives moves and upgrades; a secure context for the microphone; and cross-origin isolation for threaded WASM.
import {app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, protocol, screen, session, shell, systemPreferences} from 'electron';
import {randomUUID} from 'node:crypto';
import {createReadStream, existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, extname, join, resolve, sep} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';

const ORIGIN = 'tingqiang://app';
const here = fileURLToPath(new URL('.', import.meta.url));
const webRoot = app.isPackaged ? join(process.resourcesPath, 'web') : join(here, 'web');
const OPENABLE = new Set(['.tqproj', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.lrc']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};
const HEADERS = {
  'Cache-Control': 'no-cache',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Recordings have nowhere to go: nothing here may connect outside the app.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
};

let win = null, rendererReady = false;
const opened = new Map(), pending = [];

protocol.registerSchemesAsPrivileged([{scheme: 'tingqiang', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true}}]);
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'TingQiang'));
app.setAppUserModelId('com.tingqiang.app');
// Chromium offers WebGPU only the card it draws with, and on a laptop that is the integrated one. Separation runs ten or more
// times faster on a discrete card, so use it while plugged in; on battery it would stay awake the whole time the app is open.
if (!powerMonitor.isOnBatteryPower()) app.commandLine.appendSwitch('force_high_performance_gpu');

const failure = status => new Response(null, {status, headers: HEADERS});
function respondWith(file, type) {
  const {size} = statSync(file);
  return new Response(Readable.toWeb(createReadStream(file)), {headers: {...HEADERS, 'Content-Type': type, 'Content-Length': String(size)}});
}
function handleRequest(request) {
  const {host, pathname} = new URL(request.url);
  if (host !== 'app') return failure(404);
  if (request.method !== 'GET') return failure(405);
  try {
    const token = pathname.match(/^\/__opened\/([\w-]+)$/)?.[1];
    if (token) {
      const file = opened.get(token); opened.delete(token);
      return file ? respondWith(file, 'application/octet-stream') : failure(404);
    }
    const file = resolve(webRoot, decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(webRoot + sep) || !statSync(file).isFile()) return failure(404);
    return respondWith(file, TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch { return failure(404); }
}

function openFile(file) {
  if (!OPENABLE.has(extname(file).toLowerCase()) || !existsSync(file)) return;
  const token = randomUUID(); opened.set(token, file);
  pending.push({name: basename(file), url: `${ORIGIN}/__opened/${token}`});
  flushOpenFiles();
}
function flushOpenFiles() {
  if (!win || !rendererReady) return;
  for (const file of pending.splice(0)) win.webContents.send('open-file', file);
}
const openArguments = (argv, directory) => { for (const arg of argv) if (!arg.startsWith('-')) openFile(resolve(directory, arg)); };
async function chooseFile() {
  const {canceled, filePaths} = await dialog.showOpenDialog(win, {title: '打开录音或练习包', properties: ['openFile'], filters: [
    {name: '录音和练习包', extensions: [...OPENABLE].filter(ext => ext !== '.lrc').map(ext => ext.slice(1))},
  ]});
  if (!canceled) openFile(filePaths[0]);
}

const windowStateFile = () => join(app.getPath('userData'), 'window-state.json');
function savedBounds() {
  const {workArea} = screen.getPrimaryDisplay();
  const fallback = {width: Math.min(1280, workArea.width), height: Math.min(860, workArea.height)};
  try {
    const saved = JSON.parse(readFileSync(windowStateFile(), 'utf8'));
    const area = screen.getDisplayMatching(saved).workArea;
    const visible = saved.x < area.x + area.width - 80 && saved.x + saved.width > area.x + 80 && saved.y < area.y + area.height - 40 && saved.y + 40 > area.y;
    return visible ? saved : fallback;
  } catch { return fallback; }
}

function createWindow() {
  const {maximized, ...bounds} = savedBounds();
  win = new BrowserWindow({
    ...bounds, minWidth: 760, minHeight: 560, show: false, title: '听腔', backgroundColor: '#f6f4ee', autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      // A practice session keeps running behind other windows: recording, separation and looping must not be throttled.
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (maximized) win.maximize();
  win.once('ready-to-show', () => { if (process.env.TINGQIANG_BACKGROUND) win.showInactive(); else win.show(); });
  win.on('close', () => { try { writeFileSync(windowStateFile(), JSON.stringify({...win.getNormalBounds(), maximized: win.isMaximized()})); } catch { /* Only a convenience. */ } });
  win.on('closed', () => { win = null; rendererReady = false; });
  win.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) rendererReady = false; });
  win.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(win, {type: 'warning', title: '听腔', message: '录音或处理还没有结束', detail: '现在退出，这部分内容不会保存。', buttons: ['退出', '继续'], defaultId: 1, cancelId: 1, noLink: true});
    if (choice === 0) event.preventDefault();
  });
  win.webContents.on('render-process-gone', (_event, {reason}) => {
    if (reason === 'clean-exit' || !win) return;
    const choice = dialog.showMessageBoxSync(win, {type: 'error', title: '听腔', message: '程序遇到问题，需要重新打开', detail: `已保存的练习不受影响。（${reason}）`, buttons: ['重新打开', '退出'], defaultId: 0, cancelId: 1, noLink: true});
    if (choice === 0) win.reload(); else app.quit();
  });
  win.loadURL(`${ORIGIN}/index.html`);
}

function installMenu() {
  const about = () => dialog.showMessageBox(win, {type: 'info', title: '关于听腔', message: `听腔 ${app.getVersion()}`, detail: `京剧唱腔练习。录音和练习只保存在这台电脑上。\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`, buttons: ['好'], noLink: true});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label: '文件', submenu: [{label: '打开录音或练习包…', accelerator: 'CmdOrCtrl+O', click: chooseFile}, {type: 'separator'}, {label: '退出', role: 'quit'}]},
    {label: '编辑', submenu: [{label: '撤销', role: 'undo'}, {label: '重做', role: 'redo'}, {type: 'separator'}, {label: '剪切', role: 'cut'}, {label: '复制', role: 'copy'}, {label: '粘贴', role: 'paste'}, {label: '全选', role: 'selectAll'}]},
    {label: '视图', submenu: [{label: '放大', role: 'zoomIn', accelerator: 'CmdOrCtrl+='}, {label: '缩小', role: 'zoomOut'}, {label: '实际大小', role: 'resetZoom'}, {type: 'separator'}, {label: '全屏', role: 'togglefullscreen'}]},
    {label: '帮助', submenu: [
      {label: '打开数据文件夹', click: () => shell.openPath(app.getPath('userData'))},
      {label: '第三方许可', click: () => shell.openPath(join(webRoot, 'licenses'))},
      {type: 'separator'}, {label: '开发者工具', role: 'toggleDevTools'}, {label: '关于听腔', click: about},
    ]},
  ]));
}

function restrictSession() {
  // Only what the page uses. The microphone is audio-only: nothing here asks for a camera or the screen.
  const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'persistent-storage']);
  const fromApp = url => typeof url === 'string' && (url === ORIGIN || url.startsWith(`${ORIGIN}/`));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowed.has(permission) && fromApp(details.requestingUrl) && !details.mediaTypes?.includes('video'));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => allowed.has(permission) && fromApp(origin));
  // Nothing in the app uses the network, so recordings cannot leave even if the page's own policy were bypassed.
  session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_details, callback) => callback({cancel: true}));
  // Left alone, the save dialog is titled with the download's blob: address.
  session.defaultSession.on('will-download', (_event, item) => item.setSaveDialogOptions({title: '保存到这台电脑', defaultPath: join(app.getPath('downloads'), item.getFilename())}));
  protocol.handle('tingqiang', handleRequest);
}

app.on('web-contents-created', (_event, contents) => {
  const openOutside = url => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  contents.on('will-navigate', (event, url) => {
    if (url === ORIGIN || url.startsWith(`${ORIGIN}/`)) return;
    event.preventDefault(); openOutside(url);
  });
  contents.setWindowOpenHandler(({url}) => { openOutside(url); return {action: 'deny'}; });
  contents.on('will-attach-webview', event => event.preventDefault());
});

const fromPage = event => event.senderFrame?.url.startsWith(`${ORIGIN}/`);
ipcMain.on('renderer-ready', event => { if (fromPage(event)) { rendererReady = true; flushOpenFiles(); } });
ipcMain.handle('microphone-access', event => fromPage(event) ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown');
ipcMain.handle('open-microphone-settings', event => { if (fromPage(event)) return shell.openExternal('ms-settings:privacy-microphone'); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, directory) => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    openArguments(argv.slice(1), directory);
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    restrictSession(); installMenu(); createWindow();
    openArguments(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());
  });
}
