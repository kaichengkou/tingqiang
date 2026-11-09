// Checks the Android app on an emulator or a phone over adb, through the screens a person uses: the system file picker,
// the permission and save dialogs, the back button, turning the phone, and the app behind the lock screen.
//   node scripts/build-android.mjs install && node tests/android.mjs
// ANDROID_SERIAL picks the device. TINGQIANG_TEST_RECORDING names a real recording to time (an LRC of the same name
// beside it is imported too). The device's media volume is set to 0 first so nothing is heard.
// The page's own behaviour is covered by the browser tests; the app only adds what is checked here.
import {_android as android} from 'playwright-core';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {encodeWav, synthesizeDemo} from '../dist/lib/analysis.mjs';

const PACKAGE = 'com.tingqiang.app', DOWNLOAD = '/sdcard/Download';
// The app ends its notification 5 s after the last sound, so a pause between repetitions does not end it.
const IDLE_MS = 6500;
let [device] = await android.devices();
assert.ok(device, 'No device: start the emulator or connect a phone with USB debugging.');
const sh = async command => (await device.shell(command)).toString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now();
const step = message => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${message}`);
const attr = (node, name) => node.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';

/** What is on screen, from uiautomator: text, description, package and bounds of every node. */
async function screen() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const xml = await sh('uiautomator dump /sdcard/tingqiang-window.xml >/dev/null 2>&1; cat /sdcard/tingqiang-window.xml');
    if (xml.includes('<hierarchy')) return [...xml.matchAll(/<node [^>]*>/g)].map(([node]) => ({
      text: attr(node, 'text'), desc: attr(node, 'content-desc'), id: attr(node, 'resource-id'), pkg: attr(node, 'package'),
      bounds: attr(node, 'bounds').match(/\d+/g)?.map(Number) || [0, 0, 0, 0],
    }));
    await sleep(500);
  }
  throw new Error('uiautomator could not read the screen');
}
const showing = (...labels) => node => labels.some(label => node.text === label || node.desc === label);
async function waitFor(match, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const node = (await screen()).find(match);
    if (node) return node;
    await sleep(400);
  }
  throw new Error(`Never appeared on screen: ${match}`);
}
async function tap(match, timeout) {
  const [x1, y1, x2, y2] = (await waitFor(match, timeout)).bounds;
  await sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
}
const focused = async () => (await sh('dumpsys window | grep -m1 mCurrentFocus')).trim();

async function attach() {
  const webview = await device.webView({pkg: PACKAGE}, {timeout: 30000});
  const page = await webview.page();
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.documentElement.classList.contains('android'), null, {timeout: 20000});
  return page;
}
async function openApp({clear = false} = {}) {
  await sh(`am force-stop ${PACKAGE}`);
  if (clear) await sh(`pm clear ${PACKAGE}`);
  await sh(`am start -W -n ${PACKAGE}/.MainActivity`);
  return attach();
}
const analysed = page => page.waitForFunction(() => document.getElementById('analysis-status').textContent.includes('分析完成'), null, {timeout: 300000});
const mediaTime = page => page.evaluate(() => document.getElementById('audio').currentTime);
const notification = async () => (await sh(`dumpsys notification --noredact | grep -A60 "NotificationRecord.*pkg=${PACKAGE}" | grep -m1 "android.text="`)).trim();
/** What the app's foreground service is kept for ('' when it is not running): 0x2 media playback, 0x2000 media processing, 0x1 data sync. */
async function busyService() {
  const types = (await sh(`dumpsys activity services ${PACKAGE}/.BusyService`)).match(/isForeground=true[^\n]*types=0x([0-9a-f]+)/)?.[1];
  return types === undefined ? '' : ({2: 'playing', 8192: 'processing', 1: 'processing'})[parseInt(types, 16)] || `0x${types}`;
}

for (const stream of [1, 2, 3, 4, 5]) await sh(`cmd media_session volume --stream ${stream} --set 0`).catch(() => {});
await sh('settings put system accelerometer_rotation 0; settings put system user_rotation 0; svc power stayon true; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard');

// A minute of the synthetic demo, long enough to hear behind the lock screen; a Chinese name, as phones have.
const demo = synthesizeDemo(), minute = new Float32Array(demo.sampleRate * 60);
for (let i = 0; i < minute.length; i++) minute[i] = demo.original[i % demo.original.length];
await device.push(Buffer.from(encodeWav([minute], demo.sampleRate)), `${DOWNLOAD}/听腔测试.wav`);
await sh(`content call --uri content://media/external/file --method scan_volume --arg external_primary >/dev/null 2>&1`).catch(() => {});

// ----- First start, the sandbox -----
let page = await openApp({clear: true});
const facts = await page.evaluate(async () => {
  let network;
  try { await fetch('https://example.com/'); network = 'reached'; } catch { network = 'blocked'; }
  return {network, classes: document.documentElement.className, service: getComputedStyle(document.querySelector('.web-only')).display, version: document.querySelector('.version').textContent,
    origin: location.origin, isolated: crossOriginIsolated, model: window.tingqiangAndroid.modelAvailable()};
});
assert.equal(facts.network, 'blocked');
assert.equal(facts.origin, 'https://appassets.androidplatform.net');
assert.match(facts.classes, /\bapp\b.*\bandroid\b/);
assert.equal(facts.service, 'none');
assert.match(facts.version, /安卓 \d+ · WebView \d+/);
assert.equal(facts.model, true, 'ONNX Runtime should load on this device');
assert.equal((await sh(`dumpsys package ${PACKAGE} | grep -c "android.permission.INTERNET"`)).trim(), '0');
step(`sandbox: no network, no INTERNET permission, ${facts.version}, native model available, isolated=${facts.isolated}`);

// ----- Import through the system picker -----
await page.locator('#import-audio').click();
const picked = showing('听腔测试.wav');
try { await waitFor(picked, 6000); }
catch {
  await tap(showing('Show roots', '显示根目录'));
  await tap(showing('Downloads', '下载'));
}
await tap(picked);
await page.waitForFunction(() => document.getElementById('filename').textContent.includes('听腔测试'), null, {timeout: 20000});
await analysed(page);
step('picked 听腔测试.wav in the system file picker; analysed');

// ----- Playback behind the home screen and the lock screen -----
await page.locator('#play-button').click();
await page.waitForFunction(() => !document.getElementById('audio').paused);
await sleep(1500);
assert.equal(await busyService(), 'playing');
// The app does not ask to show notifications; Android runs the service either way. Granted here only to read its text.
await sh(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
// A shown notification is only redrawn when the page reports a change, at most once a second.
await page.locator('#play-button').click();
await sleep(2000);
await page.locator('#play-button').click();
await sleep(2000);
assert.match(await notification(), /正在播放 · 听腔测试/);
assert.match(await sh('dumpsys window windows | grep -E "mCurrentFocus|KEEP_SCREEN_ON" | head -5'), /KEEP_SCREEN_ON/);
let before = await mediaTime(page);
await sh('input keyevent KEYCODE_HOME');
await sleep(12000);
let after = await mediaTime(page);
assert.ok(after - before > 10, `behind the home screen playback moved ${after - before} s in 12 s`);
await sh('input keyevent KEYCODE_SLEEP');
await sleep(12000);
before = after; after = await mediaTime(page);
assert.ok(after - before > 10, `with the screen off playback moved ${after - before} s in 12 s`);
await sh(`input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; am start -n ${PACKAGE}/.MainActivity`);
await sleep(1000);
await page.locator('#play-button').click();
await page.waitForFunction(() => document.getElementById('audio').paused);
await sleep(IDLE_MS);
assert.equal(await busyService(), '', 'the service should end once playback stops');
assert.equal(await notification(), '');
step(`playback continued behind the home screen and with the screen off; notification shown while playing, gone after`);

// ----- Back button and turning the phone -----
await page.locator('#settings-button').click();
assert.equal(await page.locator('#settings-dialog').evaluate(d => d.open), true);
await sh('input keyevent KEYCODE_BACK');
await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
assert.match(await focused(), new RegExp(PACKAGE));
await page.evaluate(() => { window.__sameDocument = true; });
await sh('settings put system user_rotation 1');
await page.waitForFunction(() => innerWidth > innerHeight, null, {timeout: 10000});
assert.equal(await page.evaluate(() => window.__sameDocument), true, 'turning the phone reloaded the page');
await sh('settings put system user_rotation 0');
await page.waitForFunction(() => innerWidth < innerHeight, null, {timeout: 10000});
await sh('input keyevent KEYCODE_BACK');
await sleep(1500);
assert.doesNotMatch(await focused(), new RegExp(PACKAGE), 'back with nothing open should leave the app');
await sh(`am start -n ${PACKAGE}/.MainActivity`);
await sleep(1500);
assert.equal(await page.evaluate(() => window.__sameDocument && document.getElementById('filename').textContent), '听腔测试');
step('back closed the dialog, then left the app without losing the page; turning the phone kept the page');

// ----- Microphone: allow, record, then refused for good -----
await page.locator('#record-button').click();
await tap(showing('While using the app', '仅在使用该应用时允许'));
// After the count-in: stopping during it cancels the take.
await page.waitForFunction(() => document.getElementById('take-status').textContent.startsWith('正在录音'), null, {timeout: 20000});
await sleep(2500);
await page.locator('#stop-recording').click();
await page.waitForFunction(() => !document.getElementById('take-details').hidden, null, {timeout: 20000});
step('the system asked for the microphone; allowed, a take was recorded');
await sh(`pm revoke ${PACKAGE} android.permission.RECORD_AUDIO; pm set-permission-flags ${PACKAGE} android.permission.RECORD_AUDIO user-fixed`);
page = await openApp();
await page.waitForFunction(() => !document.getElementById('record-button').disabled, null, {timeout: 30000});
await page.locator('#record-button').click();
await page.waitForFunction(() => !document.getElementById('mic-settings').hidden, null, {timeout: 15000});
assert.match(await page.locator('#take-status').textContent(), /麦克风权限已关闭/);
await page.locator('#mic-settings').click();
await sleep(2000);
assert.match(await focused(), /settings/i, 'the button should open the app\'s settings');
await sh('input keyevent KEYCODE_BACK');
await sh(`pm clear-permission-flags ${PACKAGE} android.permission.RECORD_AUDIO user-fixed; pm grant ${PACKAGE} android.permission.RECORD_AUDIO`);
step('refused for good: the page says so and its button opens the app\'s system settings');

// ----- Saving and sending a practice package; opening one handed to the app -----
page = await openApp();
await page.waitForFunction(() => document.getElementById('filename').textContent === '听腔测试', null, {timeout: 30000});
// adb mangles non-ASCII in commands, so names on the device are reached by pattern; output comes back intact.
await sh(`rm -f ${DOWNLOAD}/*.tqproj`);
await page.locator('#library-button').click();
await page.locator('#export-project').click();
await tap(showing('保存到手机…'));
await tap(node => /^(save|保存)$/i.test(node.text) && node.pkg.includes('documentsui'), 20000);
await waitFor(node => node.pkg === PACKAGE, 10000);
await sleep(1500);
const saved = (await sh(`ls -l ${DOWNLOAD}/*.tqproj`)).trim();
assert.match(saved, /听腔测试\.tqproj$/);
step(`saved through the system save screen: ${saved.split(/\s+/).slice(4, 5)} bytes`);
if (!await page.locator('#library-dialog').evaluate(d => d.open)) await page.locator('#library-button').click();
await page.locator('#export-project').click();
await tap(showing('发送给…（微信、QQ 等）'));
await waitFor(node => /intentresolver|android$|chooser/.test(node.pkg) || /发送「听腔测试.tqproj」/.test(node.text), 10000);
await sh('input keyevent KEYCODE_BACK');
const shared = (await sh(`run-as ${PACKAGE} sh -c 'ls cache/exports/*/'`)).trim();
assert.match(shared, /听腔测试\.tqproj/);
step('发送给 opened the system share sheet with the package');
// The share sheet's file, handed back to the app as another app would hand over a download.
const folder = (await sh(`run-as ${PACKAGE} sh -c 'ls cache/exports'`)).trim().split(/\s+/).pop();
// Empty the library first, so only the package can bring the practice back.
await page.evaluate(async () => { const store = await import('/lib/project-store.mjs?v=0.7'); for (const project of await store.listProjects()) await store.deleteProject(project.id); localStorage.clear(); });
// Reloaded rather than restarted: the app clears its shared files when it starts.
await page.reload();
await page.waitForFunction(() => document.documentElement.classList.contains('android'));
await sleep(1500);
assert.notEqual(await page.locator('#filename').textContent(), '听腔测试');
await sh(`am start -a android.intent.action.VIEW -t application/octet-stream -d "content://${PACKAGE}.files/${folder}/${encodeURIComponent('听腔测试.tqproj')}" -n ${PACKAGE}/.MainActivity`);
await page.waitForFunction(() => document.getElementById('filename').textContent === '听腔测试', null, {timeout: 30000});
assert.ok(await page.evaluate(async () => (await (await import('/lib/project-store.mjs?v=0.7')).listProjects()).length === 1));
await page.waitForFunction(() => document.getElementById('duration').textContent === '01:00' && !document.getElementById('play-button').disabled, null, {timeout: 20000});
step('a .tqproj handed to the app (打开方式) was imported into an empty library');

// ----- A recording opened from another app (MediaStore, as file managers hand them over) -----
const media = await sh('content query --uri content://media/external/audio/media --projection _id:_display_name');
const mediaId = media.split('\n').find(row => row.includes('听腔测试.wav'))?.match(/_id=(\d+)/)?.[1];
if (mediaId) {
  await sh(`am start -a android.intent.action.VIEW -t audio/wav --grant-read-uri-permission -d content://media/external/audio/media/${mediaId} -n ${PACKAGE}/.MainActivity`);
  await sleep(4000);
  step(`a recording handed over as content://media/…/${mediaId}: ${await page.locator('#filename').textContent()} · ${await page.locator('#analysis-status').textContent()}`);
}

// ----- The page's process crashing -----
const renderer = (await sh('ps -A -o PID,NAME')).split('\n').filter(line => line.includes('SandboxedProcessService')).map(line => Number(line.trim().split(/\s+/)[0])).sort((a, b) => a - b).pop();
await (await page.context().newCDPSession(page)).send('Page.crash').catch(() => {});
await sleep(3000);
if ((await sh(`ls /proc/${renderer} >/dev/null 2>&1 && echo alive`)).includes('alive')) throw new Error('Page.crash did not end the page process');
// The app made a new WebView; Playwright's connection still points at the old one.
await device.close();
[device] = await android.devices();
page = await attach();
await page.waitForFunction(() => document.getElementById('filename').textContent.includes('听腔测试'), null, {timeout: 30000});
step(`after the page's process crashed the app reopened it and restored ${await page.locator('#filename').textContent()}`);

// ----- 减弱伴奏 with the app's model, and behind the home screen -----
const recording = process.env.TINGQIANG_TEST_RECORDING;
const input = recording && existsSync(recording) ? recording : null;
if (input) {
  const lrc = input.replace(/\.[^.]+$/, '.lrc');
  await page.locator('#audio-input').setInputFiles(input);
  const opened = Date.now();
  await page.waitForFunction(name => document.getElementById('filename').textContent === name, basename(input).replace(/\.[^.]+$/, ''), {timeout: 60000});
  await page.waitForFunction(() => !document.getElementById('play-button').disabled, null, {timeout: 60000});
  const playable = (Date.now() - opened) / 1000;
  await analysed(page);
  step(`real recording ${basename(input)}: playable after ${playable.toFixed(1)} s, analysed after ${((Date.now() - opened) / 1000).toFixed(1)} s`);
  if (existsSync(lrc)) { await page.locator('#lyrics-input').setInputFiles(lrc); await page.waitForFunction(() => document.querySelectorAll('.lyric-row').length > 0); }
}
const separating = Date.now();
await page.locator('#enhance-vocals').click();
await page.waitForFunction(() => /\d+%/.test(document.getElementById('separation-note').textContent), null, {timeout: 60000});
const progress = () => page.evaluate(() => Number(document.getElementById('separation-note').textContent.match(/(\d+)%/)?.[1] || 0));
await sh('input keyevent KEYCODE_HOME');
const away = await progress();
await sleep(15000);
const back = await progress();
assert.equal(await busyService(), 'processing');
assert.match(await notification(), /正在减弱伴奏… \d+%/);
await sh(`am start -n ${PACKAGE}/.MainActivity`);
await page.waitForFunction(() => document.getElementById('separation-note').textContent.includes('已减弱伴奏'), null, {timeout: 1200000});
const seconds = (Date.now() - separating) / 1000;
await analysed(page);
assert.equal(await page.locator('#curve-source').textContent(), '人声分析');
const memory = (await sh(`dumpsys meminfo ${PACKAGE} | grep -m1 "TOTAL PSS"`)).trim();
step(`减弱伴奏 took ${seconds.toFixed(1)} s (${await page.locator('#duration').textContent()} of audio), kept going behind the home screen (${away}% → ${back}% in 15 s); app ${memory}`);

// ----- 跟着伴奏唱 on a lyric line, over the backing just made -----
if (await page.locator('.lyric-row').count()) {
  await page.locator('.lyric-row').nth(1).click();
  await page.locator('#singalong-button').click();
  await page.waitForFunction(() => document.getElementById('take-status').textContent.startsWith('正在录音'), null, {timeout: 40000});
  await sleep(3000);
  await page.locator('#stop-recording').click();
  await page.waitForFunction(() => !document.getElementById('take-details').hidden, null, {timeout: 30000});
  await page.locator('#listen-mix').click();
  await page.locator('#play-button').click();
  await page.waitForFunction(() => !document.getElementById('take-audio').paused || !document.getElementById('audio').paused, null, {timeout: 10000});
  await page.locator('#play-button').click();
  step(`跟着伴奏唱 recorded a take over the ${await page.locator('#backing-source').inputValue()} and played the mix (the emulator's microphone is silent)`);
}

await sh('svc power stayon false');
console.log(`Android checks passed in ${((Date.now() - started) / 1000).toFixed(0)} s on ${device.model()}.`);
await device.close();
