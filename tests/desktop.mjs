// Checks that only make sense on the packaged client: what its sandbox allows, opening files from Windows, surviving
// restarts and native dialogs. The browser tests also run inside it, through harness.mjs. Needs TINGQIANG_TEST_EXE.
// Native dialogs are answered through UI Automation, addressed to the client's own process, so no keys reach other windows.
import {launchClient} from './harness.mjs';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {encodeWav} from '../dist/lib/analysis.mjs';

const exe = process.env.TINGQIANG_TEST_EXE;
if (!exe) throw new Error('Set TINGQIANG_TEST_EXE to the packaged tingqiang.exe.');
const output = process.env.TINGQIANG_TEST_OUTPUT || mkdtempSync(join(tmpdir(), 'tingqiang-desktop-'));
const fixtures = mkdtempSync(join(tmpdir(), 'tingqiang-fixtures-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function song(seconds, base = 240) {
  const rate = 44100, n = rate * seconds, left = new Float32Array(n), right = new Float32Array(n); let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, hz = base * 2 ** ((5 * Math.sin(t * 1.1) + 0.2 * Math.sin(2 * Math.PI * 5.3 * t)) / 12);
    phase += 2 * Math.PI * hz / rate;
    const voice = ((t % 2.6) < 1.9 ? 1 : 0.001) * (0.24 * Math.sin(phase) + 0.08 * Math.sin(2 * phase)), backing = 0.09 * Math.sin(2 * Math.PI * 110 * t) + 0.05 * Math.sin(2 * Math.PI * 165 * t);
    left[i] = voice + backing; right[i] = voice + 0.7 * backing;
  }
  return [left, right];
}
const wav = join(fixtures, '唱段-测试.wav');
writeFileSync(wav, Buffer.from(encodeWav(song(12), 44100)));
const lrc = join(fixtures, '唱段-测试.lrc');
writeFileSync(lrc, '[00:01.00]第一句\n[00:04.00]第二句\n[00:07.00]第三句\n');
const formats = ['mp3', 'm4a', 'flac', 'ogg'].map(ext => {
  const file = join(fixtures, `格式.${ext}`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-t', '6', file]);
  return file;
});

const analysisDone = (page, timeout = 120000) => page.waitForFunction(() => document.getElementById('analysis-status').textContent === '分析完成', null, {timeout});
const secondInstance = (profile, file) => new Promise((resolve, reject) => {
  const child = spawn(exe, [`--user-data-dir=${profile}`, file], {stdio: 'ignore'});
  const timer = setTimeout(() => { child.kill(); reject(new Error('The second instance did not exit.')); }, 15000);
  child.once('exit', code => { clearTimeout(timer); resolve(code); });
});
const powershell = script => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`, 'utf16le').toString('base64')], {encoding: 'utf8', timeout: 60000}).trim();
/** Waits for a dialog of the process and presses a button; `file` first fills an open or save dialog's name field and returns what it suggested. */
const answerDialog = (pid, button, file) => powershell(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Native -Name Win -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, string l); [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
$A = [System.Windows.Automation.AutomationElement]; $S = [System.Windows.Automation.TreeScope]
$byProcess = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})
$isDialog = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, '#32770')
$deadline = (Get-Date).AddSeconds(25); $done = $false
while (-not $done -and (Get-Date) -lt $deadline) {
  foreach ($window in $A::RootElement.FindAll($S::Children, $byProcess)) {
    foreach ($dialog in $window.FindAll($S::Children, $isDialog)) {
      ${file
        ? `$found = $dialog.FindFirst($S::Children, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, '1')))`
        : `$found = $dialog.FindFirst($S::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, '${button}')))`}
      if (-not $found) { continue }
      ${file ? `$isEdit = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Edit')
      $edit = $null
      foreach ($id in '1001', '1148') { if (-not $edit) { $edit = $dialog.FindFirst($S::Descendants, (New-Object System.Windows.Automation.AndCondition($isEdit, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id))))) } }
      $edit.Current.Name
      [Native.Win]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, '${file}') | Out-Null
      Start-Sleep -Milliseconds 300` : `$dialog.Current.Name`}
      [Native.Win]::PostMessage([IntPtr]$found.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      $done = $true; break
    }
    if ($done) { break }
  }
  if (-not $done) { Start-Sleep -Milliseconds 200 }
}
if (-not $done) { throw 'No dialog with that button appeared.' }`);
const reconnect = async client => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${client.port}`), context = browser.contexts()[0];
  return {browser, context, page: context.pages()[0] || await context.waitForEvent('page')};
};

async function sandbox() {
  const client = await launchClient({args: ['--use-fake-device-for-media-stream']}), {page, context} = client, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('tingqiang://app/');
  const facts = await page.evaluate(async () => ({
    origin: location.origin, secure: isSecureContext, isolated: crossOriginIsolated, node: typeof process + typeof require,
    desktopClass: document.documentElement.classList.contains('desktop'), serviceHidden: getComputedStyle(document.querySelector('.web-only')).display,
    bridge: Object.keys(window.tingqiangDesktop).sort().join(), access: await window.tingqiangDesktop.microphoneAccess(),
    audio: await navigator.mediaDevices.getUserMedia({audio: true}).then(stream => { stream.getTracks().forEach(track => track.stop()); return 'granted'; }, error => error.name),
    camera: await navigator.mediaDevices.getUserMedia({video: true}).then(() => 'granted', error => error.name),
    outside: await fetch('https://example.com/').then(() => 'reached', error => error.name),
    otherHost: await fetch('tingqiang://other/index.html').then(() => 'reached', error => error.name),
    post: (await fetch('index.html', {method: 'POST'})).status, license: (await fetch('licenses/crepe-MIT.txt')).status, bundled: (await fetch('models/UVR_MDXNET_KARA_2.onnx')).status,
    escapes: await Promise.all(['/../package.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/..%5c..%5capp.asar', '/%2e%2e%5cLICENSE.electron.txt', '/__opened/nothing', '/%00', '/vendor'].map(path => fetch(path).then(response => response.status, () => 'blocked'))),
  }));
  assert.equal(facts.origin, 'tingqiang://app');
  assert.ok(facts.secure && facts.isolated, 'The page needs a secure, isolated context.');
  assert.equal(facts.node, 'undefinedundefined');
  assert.ok(facts.desktopClass); assert.equal(facts.serviceHidden, 'none');
  assert.equal(facts.bridge, 'microphoneAccess,onOpenFile,openMicrophoneSettings');
  assert.equal(facts.audio, 'granted'); assert.equal(facts.camera, 'NotAllowedError');
  assert.equal(facts.outside, 'TypeError', 'Recordings must have nowhere to go.'); assert.equal(facts.otherHost, 'TypeError');
  assert.equal(facts.post, 405); assert.equal(facts.license, 200); assert.equal(facts.bundled, 200);
  for (const status of facts.escapes) assert.ok(status === 404 || status === 'blocked', `Path probe returned ${status}`);
  assert.equal(await page.evaluate(() => window.open('file:///C:/Windows/win.ini')), null);
  await page.evaluate(() => { location.href = 'file:///C:/Windows/win.ini'; }).catch(() => {});
  await sleep(500);
  assert.equal(page.url().split('#')[0], 'tingqiang://app/'); assert.equal(context.pages().length, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({path: join(output, 'client-empty.png')});
  await client.quit();
  console.log('Sandbox: isolated origin, no Node, audio only, nothing reachable outside the app, no path escapes.');
}

async function openingFiles() {
  const client = await launchClient({args: [wav]}), {page, profile} = client;
  await page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await analysisDone(page);
  assert.equal(await secondInstance(profile, lrc), 0);
  await page.waitForFunction(() => document.querySelectorAll('.lyric-text').length === 3, null, {timeout: 15000});
  for (const file of formats) {
    assert.equal(await secondInstance(profile, file), 0);
    await page.waitForFunction(name => document.getElementById('filename').textContent === name, basename(file).replace(/\.[^.]+$/, ''), {timeout: 15000});
    await page.waitForFunction(ext => document.getElementById('filemeta').textContent.includes('00:06'), null, {timeout: 15000});
    await analysisDone(page);
    await page.locator('#play-button').click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.4, null, {timeout: 15000});
    await page.locator('#play-button').click();
    await page.evaluate(() => { document.getElementById('audio').currentTime = 0; });
    console.log(`Opened and played ${basename(file)}.`);
    await page.waitForFunction(() => document.getElementById('audio').currentTime < 1);
  }
  // What the client must not open.
  const before = await page.locator('#filename').textContent();
  assert.equal(await secondInstance(profile, 'C:\\Windows\\win.ini'), 0);
  assert.equal(await secondInstance(profile, join(fixtures, 'missing.mp3')), 0);
  await sleep(500);
  assert.equal(await page.locator('#filename').textContent(), before);
  await client.quit();
}

async function practicePackages() {
  const first = await launchClient({args: [wav]});
  await first.page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await analysisDone(first.page);
  assert.equal(await secondInstance(first.profile, lrc), 0);
  await first.page.waitForFunction(() => document.querySelectorAll('.lyric-text').length === 3, null, {timeout: 15000});
  await first.page.waitForFunction(() => document.getElementById('project-save-status').textContent.includes('已保存'), null, {timeout: 15000}).catch(() => {});
  await first.page.locator('#library-button').click();
  const downloading = first.page.waitForEvent('download');
  await first.page.locator('#export-project').click();
  const download = await downloading, pack = join(fixtures, download.suggestedFilename());
  await download.saveAs(pack);
  assert.equal(basename(pack), '唱段-测试.tqproj');
  await first.quit();

  const client = await launchClient({args: [pack]}), {page} = client;
  await page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试' && document.querySelectorAll('.lyric-text').length === 3, null, {timeout: 30000});
  await page.waitForFunction(() => document.getElementById('analysis-status').textContent !== '正在分析' && !document.getElementById('play-button').disabled, null, {timeout: 30000});
  await client.quit();
  console.log('A practice package saved by one client opened in another from the command line.');
}

async function restarts() {
  const client = await launchClient({args: [wav]}), {profile} = client;
  await client.page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await analysisDone(client.page);
  await sleep(1500);
  assert.equal(await client.page.evaluate(() => navigator.storage.persisted()), true, 'Saved practice should be exempt from eviction.');
  const id = await client.page.evaluate(() => localStorage.getItem('tingqiang-last-project'));
  assert.ok(id);
  // A normal close saves the window position and ends the app.
  await client.browser.close();
  powershell(`(Get-Process -Id ${client.child.pid}).CloseMainWindow() | Out-Null`);
  await Promise.race([client.exited, sleep(15000).then(() => { throw new Error('Closing the window did not end the app.'); })]);
  const state = JSON.parse(readFileSync(join(profile, 'window-state.json'), 'utf8'));
  assert.ok(state.width >= 760 && state.height >= 560, JSON.stringify(state));

  const again = await launchClient({profile});
  await again.page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await again.page.waitForFunction(() => document.getElementById('analysis-status').textContent === '分析完成' || document.getElementById('curve-source').textContent !== '等待分析', null, {timeout: 20000});
  assert.equal(await again.page.evaluate(() => localStorage.getItem('tingqiang-last-project')), id);
  // A hard stop, as in a crash or power cut, keeps what was saved.
  await again.kill();
  const third = await launchClient({profile, args: [formats[0]]});
  await third.page.waitForFunction(name => document.getElementById('filename').textContent === name, basename(formats[0]).replace(/\.[^.]+$/, ''), {timeout: 20000});
  await sleep(2000);
  assert.equal(await third.page.locator('#filename').textContent(), basename(formats[0]).replace(/\.[^.]+$/, ''), 'Restoring the last project replaced the opened file.');
  await third.quit();
  console.log('Practice survived a normal close and a hard stop; a file opened at launch wins over restoring the last practice.');
}

async function separation() {
  for (const [label, args] of [['graphics card if it is fast enough', []], ['CPU threads', ['--disable-gpu']]]) {
    const client = await launchClient({args: [...args, wav]}), {page} = client, started = Date.now();
    await page.waitForFunction(() => !document.getElementById('enhance-vocals').disabled, null, {timeout: 30000});
    await page.locator('#enhance-vocals').click();
    await page.waitForFunction(() => document.getElementById('browser-separation-status').textContent.startsWith('分离'), null, {timeout: 300000, polling: 200});
    assert.match(await page.locator('#browser-separation-status').textContent(), /^分离完成/);
    const seconds = (Date.now() - started) / 1000;
    await page.waitForFunction(() => document.getElementById('curve-source').textContent === '人声分析' && document.getElementById('analysis-status').textContent === '分析完成', null, {timeout: 120000});
    assert.equal(await page.locator('[data-mode="accompaniment"]').getAttribute('aria-disabled'), 'false');
    assert.equal(powershell(`$ids = (Get-Process tingqiang).Id; (Get-NetTCPConnection -OwningProcess $ids -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -notin '127.0.0.1', '::1', '0.0.0.0', '::' } | Measure-Object).Count`), '0', 'The client opened a network connection.');
    console.log(`Separated 12 s with the bundled model (${label}) in ${seconds.toFixed(1)} s, with no network connections.`);
    await client.quit();
  }
}

async function minimized() {
  const client = await launchClient({args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, wav]}), {page, child} = client;
  const showWindow = state => powershell(`Add-Type -Namespace Native -Name Show -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; [Native.Show]::ShowWindow((Get-Process -Id ${child.pid}).MainWindowHandle, ${state}) | Out-Null`);
  await page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await analysisDone(page);
  const moveTo = time => page.evaluate(time => { document.getElementById('audio').currentTime = time; }, time);
  await moveTo(3); await page.locator('#set-a').click();
  await moveTo(5); await page.locator('#set-b').click();
  await moveTo(3); await page.locator('#play-button').click();
  showWindow(6);
  await sleep(1000);
  const times = [];
  for (let i = 0; i < 40; i++) { times.push(await page.evaluate(() => document.getElementById('audio').currentTime)); await sleep(200); }
  assert.ok(Math.max(...times) < 5.25 && Math.min(...times) < 3.5, `The loop ran off while minimized: ${Math.min(...times)}–${Math.max(...times)}`);
  // Singing along must also stop by itself at the end of the selection, with the window out of sight.
  await page.evaluate(() => {
    document.getElementById('play-button').click();
    const leadIn = document.getElementById('lead-in'); leadIn.value = '2'; leadIn.dispatchEvent(new Event('change', {bubbles: true}));
    document.getElementById('singalong-button').click();
  });
  await page.waitForFunction(() => document.getElementById('take-status').textContent.includes('正在录音'), null, {timeout: 20000, polling: 100});
  await page.waitForFunction(() => document.getElementById('take-status').textContent.includes('蓝线'), null, {timeout: 60000, polling: 200});
  const take = await page.evaluate(async () => { const store = await import('/lib/project-store.mjs?v=0.7'); return (await store.readProject(localStorage.getItem('tingqiang-last-project'))).takes.at(-1).duration; });
  assert.ok(Math.abs(take - 4.5) < 0.6, `The take ran ${take} s instead of stopping at the end of the selection.`);
  showWindow(4);
  await client.quit();
  console.log('Minimized: the loop held, and a take stopped by itself at the end of the selection.');
}

async function microphoneMessages() {
  const client = await launchClient({args: [wav]}), {page} = client;
  // The reloads below restore this practice, so it has to be saved first.
  await page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await analysisDone(page);
  await page.waitForFunction(() => localStorage.getItem('tingqiang-last-project'), null, {timeout: 10000});
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('blocked', localStorage.getItem('mic-error'))); });
  for (const [name, text, button] of [['NotAllowedError', 'Windows 禁止了麦克风', true], ['NotFoundError', '没有找到麦克风', false]]) {
    await page.evaluate(name => localStorage.setItem('mic-error', name), name);
    await page.goto('tingqiang://app/');
    await page.waitForFunction(() => !document.getElementById('singalong-button').disabled, null, {timeout: 30000});
    await page.locator('#singalong-button').click();
    await page.waitForFunction(text => document.getElementById('take-status').textContent.includes(text), text, {timeout: 10000});
    assert.equal(await page.locator('#mic-settings').isVisible(), button);
  }
  await client.quit();
  console.log('A blocked or missing microphone says what to do.');
}

async function nativeDialogs() {
  const saved = join(fixtures, '另存.tqproj');
  const client = await launchClient({args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, wav], nativeDownloads: true});
  await client.page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await analysisDone(client.page);
  // Importing through the system's open dialog, which needs a real click on the button.
  await client.page.locator('#import-audio').click({noWaitAfter: true});
  answerDialog(client.child.pid, '打开', formats[0]);
  await client.page.waitForFunction(name => document.getElementById('filename').textContent === name, basename(formats[0]).replace(/\.[^.]+$/, ''), {timeout: 20000});
  await analysisDone(client.page);
  await client.page.locator('#audio-input').setInputFiles(wav);
  await client.page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 20000});
  await analysisDone(client.page);
  // Saving goes through the system dialog, with the practice's name suggested. It only appears with no debugger attached.
  await client.page.locator('#library-button').click();
  await client.page.evaluate(() => { setTimeout(() => document.getElementById('export-project').click(), 300); });
  await client.browser.close();
  const suggested = answerDialog(client.child.pid, '保存', saved);
  assert.match(suggested, /唱段-测试\.tqproj/);
  for (let i = 0; i < 40 && !existsSync(saved); i++) await sleep(250);
  assert.ok(statSync(saved).size > 100000, 'The practice package was not written.');
  const attached = await reconnect(client);
  await attached.page.locator('#library-dialog .close-dialog').click();
  await attached.page.locator('#singalong-button').click();
  await attached.page.waitForFunction(() => document.getElementById('take-status').textContent.includes('正在录音'), null, {timeout: 20000});
  await attached.browser.close();
  // Closing mid-recording asks first, and staying keeps recording.
  const askToClose = () => powershell(`(Get-Process -Id ${client.child.pid}).CloseMainWindow() | Out-Null`);
  askToClose();
  assert.match(answerDialog(client.child.pid, '继续'), /听腔/);
  await sleep(500);
  const during = await reconnect(client);
  assert.equal(await during.page.evaluate(() => document.getElementById('take-status').textContent.includes('正在录音')), true, 'Choosing to stay stopped the recording.');
  // A renderer crash offers to reopen, and the saved practice comes back.
  await during.browser.close();
  powershell(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${client.child.pid}" | Where-Object { $_.CommandLine -match '--type=renderer' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  answerDialog(client.child.pid, '重新打开');
  await sleep(1500);
  const reopened = await reconnect(client);
  await reopened.page.waitForFunction(() => document.getElementById('filename').textContent === '唱段-测试', null, {timeout: 30000});
  await reopened.page.locator('#singalong-button').waitFor({state: 'visible'});
  await reopened.page.waitForFunction(() => !document.getElementById('singalong-button').disabled, null, {timeout: 30000});
  await reopened.page.locator('#singalong-button').click();
  await reopened.page.waitForFunction(() => document.getElementById('take-status').textContent.includes('正在录音'), null, {timeout: 20000});
  await reopened.browser.close();
  askToClose();
  answerDialog(client.child.pid, '退出');
  await Promise.race([client.exited, sleep(15000).then(() => { throw new Error('Choosing to quit did not end the app.'); })]);
  console.log('Native dialogs: save names the file, closing mid-recording asks first, a crash offers to reopen.');
  rmSync(client.profile, {recursive: true, force: true});
}

try {
  const only = process.argv[2];
  for (const check of [sandbox, openingFiles, practicePackages, restarts, minimized, separation, microphoneMessages, nativeDialogs]) if (!only || only === check.name) await check();
  console.log('Desktop client checks passed.');
} finally { rmSync(fixtures, {recursive: true, force: true}); }
