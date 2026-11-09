// Regression on the user's supplied recording. The audio is never committed.
// Usage: node tests/famen-recording.mjs /path/to/recording.mp3
import {chromium} from 'playwright-core';
import {readFile, writeFile, mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {practiceCurve} from '../dist/lib/practice-curve.mjs';

const file = process.argv[2];
if (!file) throw new Error('Pass the original supplied Famen Temple MP3 as an argument.');
const manifest = JSON.parse(await readFile(new URL('./famen-validation.json', import.meta.url)));
const hash = createHash('sha256').update(await readFile(file)).digest('hex');
assert.equal(hash, manifest.audio_sha256, 'This regression expects the exact supplied recording.');
const output = process.env.TINGQIANG_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'tingqiang-famen-'));
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(...args) { super(...args); this.addEventListener('message', event => {
        if (event.data.type === 'done') { window.__testAnalysis = event.data.result; window.__analysisRuns = (window.__analysisRuns || 0) + 1; }
        if (event.data.type === 'error') window.__testAnalysisError = event.data.message;
      }); }
    };
  });
  await page.goto(process.env.TINGQIANG_TEST_URL || 'http://127.0.0.1:8000/');
  await page.locator('#audio-input').setInputFiles(file);
  await page.waitForFunction(() => document.getElementById('analysis-status').textContent.includes('录音已就绪'));
  await page.locator('#analyze-button').click();
  await page.waitForFunction(() => window.__testAnalysis || window.__testAnalysisError, null, {timeout: 120000});
  const result = await page.evaluate(() => ({result: window.__testAnalysis, error: window.__testAnalysisError}));
  assert.ok(result.result, result.error); assert.equal(result.result.method, 'crepe-tiny');
  const points = result.result.points;
  for (const anchor of manifest.spectral_anchors) {
    const p = points.reduce((a, b) => Math.abs(a.t - anchor.t) < Math.abs(b.t - anchor.t) ? a : b);
    assert.ok(p.hz, `Missing pitch at ${anchor.t}s`);
    assert.ok(Math.abs(12 * Math.log2(p.hz / anchor.hz)) < anchor.tolerance_semitones, `Anchor ${anchor.t}s: ${p.hz} Hz vs spectral estimate ${anchor.hz} Hz`);
  }
  assert.ok(points.filter(p => p.hz).length > 740, 'Pitch coverage regressed.');
  assert.ok(points.filter(p => p.hz > 500).length < 5, 'Spurious high-octave segments returned.');
  const display = practiceCurve(result.result);
  assert.ok(display.stats.connectedGaps >= 30 && display.stats.displayFragments <= 12, 'Learning curve became fragmented again.');
  assert.equal(await page.locator('#curve-profile').inputValue(), 'practice');
  await page.locator('#audio').evaluate(a => a.currentTime = 5.62);
  await page.waitForFunction(() => document.getElementById('current-pitch').textContent.startsWith('参考'));
  await page.locator('#settings-button').click();
  await page.locator('#connect-gaps').uncheck();
  await page.waitForFunction(() => document.getElementById('current-pitch').textContent === '当前音高 —');
  await page.locator('#curve-profile').selectOption('raw');
  assert.equal(await page.locator('#connect-gaps').isDisabled(), true);
  assert.equal(await page.locator('#curve-connection-note').isHidden(), true);
  await page.locator('#curve-profile').selectOption('practice'); await page.locator('#connect-gaps').check();
  await page.locator('#settings-dialog .close-dialog').click();
  assert.equal(await page.evaluate(() => window.__analysisRuns), 1, 'Display settings reran the model.');

  async function cursorX() {
    return page.locator('#pitch-chart').evaluate(canvas => {
      const ctx = canvas.getContext('2d'), {width, height} = canvas, data = ctx.getImageData(0, 0, width, height).data;
      let best = 0, column = -1;
      for (let x = 30; x < width - 10; x++) {
        let score = 0;
        for (let y = 25; y < height - 30; y++) {
          const p = (y * width + x) * 4, r = data[p], g = data[p + 1], b = data[p + 2];
          if (r > 40 && r < 140 && g > r + 6 && b < r + 5 && data[p + 3] > 100) score++;
        }
        if (score > best) { best = score; column = x; }
      }
      const cssWidth = canvas.getBoundingClientRect().width, ratio = width / cssWidth, left = cssWidth < 480 ? 44 : 55;
      return {column, centre: (left + (cssWidth - left - 20) / 2) * ratio, score: best};
    });
  }
  for (const span of ['4', '8', '16', '32']) {
    await page.locator('#zoom').selectOption(span);
    for (const time of [0, 4, 7.98, 8.02, 22.7]) {
      await page.locator('#audio').evaluate((a, t) => a.currentTime = t, time);
      await page.waitForTimeout(100);
      const cursor = await cursorX();
      assert.ok(cursor.score > 100 && Math.abs(cursor.column - cursor.centre) < 2, `Playhead not centred at ${time}s/${span}s: ${JSON.stringify(cursor)}`);
    }
  }
  await page.locator('#zoom').selectOption('8');
  await page.locator('#audio').evaluate(a => a.currentTime = 4);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.getElementById('audio').currentTime > 4.3);
  const cursorPlaying = await cursorX();
  assert.ok(Math.abs(cursorPlaying.column - cursorPlaying.centre) < 2);
  await page.locator('#play-button').click();
  await page.locator('#audio').evaluate(a => a.currentTime = 4); await page.waitForTimeout(100);
  await page.screenshot({path: join(output, 'famen-desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844}); await page.waitForTimeout(100);
  const mobileCursor = await cursorX();
  assert.ok(Math.abs(mobileCursor.column - mobileCursor.centre) < 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const panelWidths = await page.locator('.chart-panel,.practice-panel,.lyrics-panel').evaluateAll(panels => panels.map(p => p.getBoundingClientRect().width));
  assert.ok(panelWidths.every(w => w > 340 && w <= 368), 'Long filename squeezed mobile controls.');
  await page.screenshot({path: join(output, 'famen-mobile.png'), fullPage: true});
  await writeFile(join(output, 'famen-analysis.json'), JSON.stringify(result.result));
  assert.deepEqual(errors, []);
  console.log('Famen recording regression passed: spectral anchors, vocal coverage, smoothing/short-gap controls without reanalysis, centred playback across boundaries/zoom/mobile.');
} finally { await browser.close(); }
