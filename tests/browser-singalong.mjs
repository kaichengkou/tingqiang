// Sing-along checks in real Chromium. A software loopback stands in for the singer: whatever goes to the
// speakers comes straight back as "the microphone", so the recording should line up with the reference
// exactly, and any error in the timing model shows up as a measurable offset.
import {chromium} from './harness.mjs';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeWav} from '../dist/lib/analysis.mjs';

const url = process.env.TINGQIANG_TEST_URL || 'http://127.0.0.1:8000/';
const output = process.env.TINGQIANG_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'tingqiang-singalong-'));
const rate = 44100, seconds = 30, signal = new Float32Array(rate * seconds);
let phase = 0;
for (let i = 0; i < signal.length; i++) {
  const t = i / rate, hz = 220 * 2 ** ((5 * Math.sin(t * 1.3) + 2 * Math.sin(t * 3.1) + 0.2 * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
  const syllable = (t % 2.3) < 1.6 && (t % 0.77) < 0.6 ? 1 : 0.002;
  phase += 2 * Math.PI * hz / rate;
  signal[i] = syllable * (0.25 * Math.sin(phase) + 0.08 * Math.sin(2 * phase));
}
const recording = join(output, 'loopback-source.wav');
await writeFile(recording, Buffer.from(encodeWav([signal, signal], rate)));

const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']});
const errors = [];
const status = page => page.locator('#analysis-status').textContent();
const takeStatus = (page, text, timeout = 90000) => page.waitForFunction(value => document.getElementById('take-status').textContent.includes(value), text, {timeout});
const analysisDone = (page, timeout = 90000) => page.waitForFunction(() => document.getElementById('analysis-status').textContent === '分析完成', null, {timeout});
const countPixels = (page, test) => page.locator('#pitch-chart').evaluate((canvas, source) => {
  const match = window.__colors[source], pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 100 && match(pixels[i], pixels[i + 1], pixels[i + 2])) n++;
  return n;
}, test);
const RED = 'red', BLUE = 'blue';

// What the app saved, and how far the take sits from where its curve should be.
const measure = page => page.evaluate(async () => {
  const store = await import('/lib/project-store.mjs?v=0.7'), {alignTake} = await import('/lib/sing-along.mjs');
  const project = await store.readProject(localStorage.getItem('tingqiang-last-project')), take = project.takes.at(-1);
  const fit = alignTake(project.analysis, take, take.analysis, {maxShift: 1, step: 0.005});
  return {offsetError: fit.offset, score: fit.score, anchor: take.anchor, rate: take.rate, transpose: take.transpose, backing: take.backing, duration: take.duration, takes: project.takes.length, voiced: take.analysis.points.filter(point => point.hz).length};
});
async function selectLine(page, index = 1) {
  await page.locator('.lyric-text').nth(index).click();
  await page.waitForFunction(() => document.getElementById('b-time').textContent !== '—');
}
async function singAlong(page) {
  const before = await page.locator('#take-select option').count();
  await page.locator('#singalong-button').click();
  await takeStatus(page, '正在录音');
  await page.waitForFunction(count => document.querySelectorAll('#take-select option').length > count && document.getElementById('take-status').textContent.includes('蓝线'), before, {timeout: 120000});
}
function envelope(samples, hop) {
  const out = new Float32Array(Math.floor(samples.length / hop));
  for (let i = 0; i < out.length; i++) { let sum = 0; for (let j = 0; j < hop; j++) sum += samples[i * hop + j] ** 2; out[i] = Math.sqrt(sum / hop); }
  return out;
}
/** Seconds by which `b` lags `a`, from the loudness shapes; survives pitch shift and time stretch artefacts. */
function envelopeLag(a, b) {
  const x = envelope(a.left, Math.round(a.sampleRate * 0.005)), y = envelope(b.left, Math.round(b.sampleRate * 0.005)), mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;
  const mx = mean(x), my = mean(y);
  let best = 0, bestScore = -Infinity;
  for (let lag = -60; lag <= 60; lag++) {
    let score = 0;
    for (let i = 60; i < Math.min(x.length, y.length) - 60; i++) score += (x[i] - mx) * (y[i + lag] - my);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  return best * 0.005;
}
const pcm = async file => {
  const bytes = await readFile(file), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), channels = view.getUint16(22, true), sampleRate = view.getUint32(24, true);
  const frames = (bytes.byteLength - 44) / 2 / channels, left = new Float32Array(frames);
  for (let i = 0; i < frames; i++) left[i] = view.getInt16(44 + i * channels * 2, true) / 32768;
  return {left, sampleRate, frames, channels};
};

try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}, acceptDownloads: true});
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__colors = {red: (r, g) => r > 120 && r > g * 1.5 && g < 130, blue: (r, g, b) => b > 100 && b > r * 1.5 && g > r * 1.3};
    const Real = window.AudioContext, connect = AudioNode.prototype.connect;
    window.__runs = 0;
    window.AudioContext = class extends Real { constructor(...args) { super(...args); window.__context = this; } };
    AudioNode.prototype.connect = function (target, ...rest) {
      if (target === window.__context?.destination && this.context === window.__context) { window.__loop ||= window.__context.createMediaStreamDestination(); connect.call(this, window.__loop); }
      return connect.call(this, target, ...rest);
    };
    navigator.mediaDevices.getUserMedia = async () => new MediaStream(window.__loop.stream.getTracks().map(track => track.clone()));
    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker { constructor(...args) { super(...args); if (String(args[0]).includes('analysis-worker')) window.__runs++; } };
  });
  await page.goto(url);

  // Waiting: importing starts the analysis, the recording stays playable and the curve fills in early.
  const started = Date.now();
  await page.locator('#audio-input').setInputFiles(recording);
  await page.waitForFunction(() => document.getElementById('analyze-button').textContent.includes('取消分析'));
  await page.waitForFunction(() => !document.getElementById('play-button').disabled);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.5, null, {timeout: 20000});
  await page.waitForFunction(({test}) => {
    const canvas = document.getElementById('pitch-chart'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, match = window.__colors[test];
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 100 && match(pixels[i], pixels[i + 1], pixels[i + 2])) n++;
    return n > 50;
  }, {test: RED}, {timeout: 30000});
  const firstCurve = Date.now() - started;
  const midway = await status(page);
  await analysisDone(page);
  const analyzed = Date.now() - started;
  await page.locator('#play-button').click();
  assert.notEqual(midway, '分析完成', 'The curve should appear before the analysis finishes.');
  assert.equal(await page.evaluate(() => window.__runs <= 4), true);
  console.log(`Import to first curve ${firstCurve} ms, to finished analysis ${analyzed} ms, for ${seconds} s of audio; playback ran throughout.`);

  await page.locator('#lyrics-input').setInputFiles({name: 'test.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:00.00]第一句\n[00:06.00]第二句\n[00:12.00]第三句\n[00:18.00]')});
  await page.waitForFunction(() => document.querySelectorAll('.lyric-row').length === 3);
  assert.match(await page.locator('#along-hint').textContent(), /还没有伴奏/);

  // Cancelling during the lead-in leaves no take and restores the selection.
  await selectLine(page);
  await page.locator('#lead-in').selectOption('2');
  await page.locator('#singalong-button').click();
  await page.waitForFunction(() => !document.getElementById('stop-recording').hidden);
  await page.locator('#stop-recording').click();
  await page.waitForFunction(() => !document.getElementById('singalong-button').hidden);
  assert.equal(await page.locator('#take-select option').count(), 0);
  assert.equal(await page.locator('#a-time').textContent(), '00:06.0');
  assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), true);

  // Latency calibration runs on the same clock as the recording. The loopback has a small delay of its own;
  // once that is measured and saved, a take should land right on the reference.
  await page.locator('#latency-button').click();
  await page.locator('#latency-start').click();
  await page.waitForFunction(() => /测得|没有听清|失败/.test(document.getElementById('latency-result').textContent) && !document.getElementById('latency-start').disabled, null, {timeout: 30000});
  const calibration = await page.locator('#latency-result').textContent();
  assert.match(calibration, /测得往返延迟约 \d+ ms/);
  assert.ok(Number(calibration.match(/(\d+) ms/)[1]) < 60, calibration);
  console.log(calibration);
  await page.locator('#latency-dialog .close-dialog').click();
  await selectLine(page);
  await page.locator('#singalong-button').click();
  await page.waitForFunction(() => !document.getElementById('sing-cue').hidden && /\d/.test(document.querySelector('#sing-cue strong').textContent), null, {timeout: 20000});
  assert.match(await page.locator('#sing-cue span').textContent(), /第二句/);
  await page.locator('#mic-level').waitFor({state: 'visible', timeout: 5000});
  await page.waitForFunction(() => document.querySelector('#sing-cue strong').textContent === '唱', null, {timeout: 20000});
  await page.waitForFunction(({test}) => {
    const canvas = document.getElementById('pitch-chart'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, match = window.__colors[test];
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 100 && match(pixels[i], pixels[i + 1], pixels[i + 2])) n++;
    return n > 30;
  }, {test: BLUE}, {timeout: 15000});
  console.log('Live pitch line drew while singing.');
  await page.screenshot({path: join(output, 'singalong-recording.png'), fullPage: true});
  await takeStatus(page, '蓝线', 120000);
  const plain = await measure(page);
  assert.ok(Math.abs(plain.offsetError) <= 0.03, `Plain take is off by ${plain.offsetError} s`);
  assert.equal(plain.backing, 'original'); assert.ok(plain.voiced > 100);
  assert.ok(Math.abs(plain.duration - (6 + 2 + 0.5)) < 0.6, `Unexpected length ${plain.duration}`);
  assert.equal(await page.locator('#a-time').textContent(), '00:06.0', 'The selection should survive the recording.');
  assert.equal(await page.locator('#loop-button').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#take-meta').textContent(), /跟原声/);
  assert.ok(await countPixels(page, BLUE) > 40, 'No overlay was drawn after recording');
  console.log(`Plain take: curve within ${(Math.abs(plain.offsetError) * 1000).toFixed(0)} ms of the reference.`);
  await page.screenshot({path: join(output, 'singalong-done.png'), fullPage: true});

  // Listening back: the voice follows the backing.
  await page.locator('#listen-mix').click();
  assert.equal(await page.locator('#voice-gain-label').isHidden(), false);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => !document.getElementById('take-audio').paused, null, {timeout: 10000});
  await page.waitForTimeout(1200);
  const drift = await page.evaluate(async () => {
    const store = await import('/lib/project-store.mjs?v=0.7'), project = await store.readProject(localStorage.getItem('tingqiang-last-project')), take = project.takes.at(-1), audio = document.getElementById('audio'), voice = document.getElementById('take-audio'), rows = [];
    for (let i = 0; i < 20 && !voice.paused; i++) { rows.push(Math.abs(voice.currentTime - (audio.currentTime - take.anchor - take.offset) / take.rate)); await new Promise(resolve => setTimeout(resolve, 50)); }
    return rows;
  });
  await page.locator('#play-button').click();
  assert.ok(drift.length >= 5 && Math.max(...drift) < 0.06, `Voice drifted from the backing: ${Math.max(...drift)}`);
  console.log(`Mixed playback: voice stayed within ${(Math.max(...drift) * 1000).toFixed(0)} ms of the backing.`);

  // Downloads: with the voice turned down, the rendered backing must still line up with the recorded voice.
  await page.locator('#voice-gain').evaluate(input => { input.value = 0; input.dispatchEvent(new Event('input', {bubbles: true})); });
  const takeDownload = page.waitForEvent('download');
  await page.locator('#download-take').click();
  const voiceFile = join(output, 'voice-plain.wav'); await (await takeDownload).saveAs(voiceFile);
  const mixDownload = page.waitForEvent('download');
  await page.locator('#download-mix').click();
  const mixFile = join(output, 'mix-plain.wav'); await (await mixDownload).saveAs(mixFile);
  const [voiceAudio, mixAudio] = await Promise.all([pcm(voiceFile), pcm(mixFile)]);
  assert.equal(mixAudio.channels, 2); assert.ok(Math.abs(mixAudio.frames / mixAudio.sampleRate - voiceAudio.frames / voiceAudio.sampleRate) < 0.05);
  const plainLag = envelopeLag(voiceAudio, mixAudio);
  assert.ok(Math.abs(plainLag) <= 0.03, `Rendered mix is off by ${plainLag} s`);
  console.log(`Downloaded mix: backing within ${(Math.abs(plainLag) * 1000).toFixed(0)} ms of the voice.`);
  await page.locator('#listen-reference').click();

  // Lower key: the backing runs through the pitch shifter, whose delay has to be accounted for.
  await page.locator('#transpose').selectOption('-3');
  await page.waitForFunction(() => !document.getElementById('transpose').disabled, null, {timeout: 15000});
  await selectLine(page);
  await singAlong(page);
  const lower = await measure(page);
  assert.equal(lower.transpose, -3); assert.ok(lower.voiced > 100);
  assert.ok(Math.abs(lower.offsetError) <= 0.03, `Transposed take is off by ${lower.offsetError} s`);
  console.log(`Transposed take: within ${(Math.abs(lower.offsetError) * 1000).toFixed(0)} ms.`);
  await page.locator('#voice-gain').evaluate(input => { input.value = 0; input.dispatchEvent(new Event('input', {bubbles: true})); });
  const lowerVoice = page.waitForEvent('download');
  await page.locator('#download-take').click();
  const lowerVoiceFile = join(output, 'voice-lower.wav'); await (await lowerVoice).saveAs(lowerVoiceFile);
  const lowerMix = page.waitForEvent('download');
  await page.locator('#download-mix').click();
  const lowerMixFile = join(output, 'mix-lower.wav'); await (await lowerMix).saveAs(lowerMixFile);
  const [lowerVoiceAudio, lowerMixAudio] = await Promise.all([pcm(lowerVoiceFile), pcm(lowerMixFile)]);
  const lowerLag = envelopeLag(lowerVoiceAudio, lowerMixAudio);
  assert.ok(Math.abs(lowerLag) <= 0.03, `Transposed mix is off by ${lowerLag} s`);
  console.log(`Transposed mix: backing within ${(Math.abs(lowerLag) * 1000).toFixed(0)} ms of the voice.`);

  // Slower: at 0.75× the mapping scales, and the voice stays at its natural speed.
  await page.locator('#transpose').selectOption('0');
  await page.waitForFunction(() => !document.getElementById('transpose').disabled, null, {timeout: 15000});
  await page.locator('#rate').selectOption('0.75');
  await selectLine(page);
  await singAlong(page);
  const slower = await measure(page);
  assert.equal(slower.rate, 0.75);
  assert.ok(Math.abs(slower.offsetError) <= 0.04, `Slow take is off by ${slower.offsetError} s`);
  assert.ok(Math.abs(slower.duration - (6 + 2 + 0.5) / 0.75) < 0.8, `Unexpected slow length ${slower.duration}`);
  console.log(`0.75× take: within ${(Math.abs(slower.offsetError) * 1000).toFixed(0)} ms.`);
  await page.locator('#rate').selectOption('1');

  // The very first line has no music before it: a silent count-in stands in for the lead-in.
  await selectLine(page, 0);
  await page.locator('#singalong-button').click();
  await page.waitForFunction(() => !document.getElementById('sing-cue').hidden && document.querySelector('#sing-cue strong').textContent === '3', null, {timeout: 20000});
  assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), true, 'The backing should wait for the count-in.');
  await page.waitForFunction(() => document.querySelector('#sing-cue strong').textContent === '唱', null, {timeout: 10000});
  await takeStatus(page, '正在录音');
  await page.waitForFunction(() => document.querySelectorAll('#take-select option').length === 4 && document.getElementById('take-status').textContent.includes('蓝线'), null, {timeout: 120000});
  const opening = await measure(page);
  assert.ok(opening.anchor >= 0, `Anchor ${opening.anchor}`);
  assert.ok(Math.abs(opening.offsetError) <= 0.04, `Opening take is off by ${opening.offsetError} s`);
  assert.ok(Math.abs(opening.duration - 6.5) < 0.7, `Count-in leaked into the take: ${opening.duration} s`);
  console.log(`Opening line with count-in: within ${(Math.abs(opening.offsetError) * 1000).toFixed(0)} ms, ${opening.duration.toFixed(1)} s long.`);

  // Automatic alignment repairs a deliberately wrong offset.
  await page.locator('#take-select').selectOption({index: 0});
  await page.locator('#take-alignment').fill('1.5');
  await page.locator('#auto-align').click();
  const repaired = Number(await page.locator('#take-alignment').inputValue());
  assert.ok(Math.abs(repaired) <= 0.08, `Auto-align left ${repaired}`);
  console.log(`Auto-align moved a 1.5 s error back to ${repaired} s.`);

  // Without a saved measurement the estimate comes from what the browser reports.
  await page.locator('#latency-button').click();
  await page.locator('#latency-reset').click();
  assert.match(await page.locator('#latency-result').textContent(), /恢复自动/);
  assert.equal(await page.evaluate(() => localStorage.getItem('tingqiang-latency')), null);
  await page.locator('#latency-dialog .close-dialog').click();

  // Everything survives a reload without running the models again, and the panel fits a phone.
  await page.locator('#save-project').click();
  await page.waitForFunction(() => document.getElementById('project-save-status').textContent === '已保存本机');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('analysis-status').textContent === '已恢复练习', null, {timeout: 30000});
  assert.equal(await page.locator('#take-select option').count(), 4);
  assert.equal(await page.evaluate(() => window.__runs), 0);
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Phone layout overflowed');
  await page.screenshot({path: join(output, 'singalong-mobile.png'), fullPage: true});
  assert.deepEqual(errors, []);
  console.log(`Sing-along browser checks passed. Screenshots: ${output}`);
} finally { await browser.close(); }
