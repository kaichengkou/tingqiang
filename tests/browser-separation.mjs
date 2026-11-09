// Local integration test. Supply a known real-vocal + synthetic-background WAV.
// TINGQIANG_TEST_MODEL can serve the verified model from disk for deterministic QA.
import {chromium} from './harness.mjs';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const input = process.argv[2];
if (!input) throw new Error('Pass the short test WAV path.');
const manifest = JSON.parse(await readFile(new URL('../dist/models/separation.json', import.meta.url)));
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']});
try {
  const context = await browser.newContext(); let modelRequests = 0, uploads = 0;
  context.on('request', request => { if (request.method() === 'POST') uploads++; });
  if (process.env.TINGQIANG_TEST_MODEL) await context.route(manifest.url, route => { modelRequests++; return route.fulfill({path: process.env.TINGQIANG_TEST_MODEL, contentType: 'application/octet-stream', headers: {'Access-Control-Allow-Origin': '*'}}); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.TINGQIANG_TEST_URL || 'http://127.0.0.1:8000/');
  await page.locator('#audio-input').setInputFiles(input);
  await page.waitForFunction(() => !document.getElementById('enhance-vocals').disabled);
  await page.locator('#audio').evaluate(a => a.currentTime = 1.4);
  await page.locator('#enhance-vocals').click();
  await page.waitForFunction(() => document.getElementById('curve-source').textContent === '人声分析' || document.getElementById('browser-separation-status').textContent.startsWith('分离未完成'), null, {timeout: 180000});
  const status = await page.locator('#browser-separation-status').textContent();
  assert.ok(!status.startsWith('分离未完成'), status);
  assert.equal(await page.locator('#analysis-source').inputValue(), 'vocals');
  assert.equal(await page.locator('[data-mode="vocals"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-mode="accompaniment"]').getAttribute('aria-disabled'), 'false');
  const time = await page.locator('#audio').evaluate(a => a.currentTime);
  assert.ok(Math.abs(time - 1.4) < 0.05, `Separation changed playback time to ${time}`);
  const previousUrl = await page.locator('#audio').getAttribute('src');
  await page.locator('#source-button').click();
  await page.locator('#browser-separate-button').click();
  await page.waitForFunction(() => document.getElementById('separation-note').textContent.includes('正在减弱伴奏'), null, {timeout: 30000});
  await page.locator('#cancel-browser-dialog').click();
  await page.waitForFunction(() => !document.getElementById('enhance-vocals').disabled);
  assert.equal(await page.locator('#audio').getAttribute('src'), previousUrl, 'Cancel replaced existing playable stems.');
  if (process.env.TINGQIANG_TEST_MODEL) assert.equal(modelRequests, 1, 'Second run did not use the model cache.');
  assert.equal(uploads, 0, 'Browser separation uploaded recording data.');
  assert.deepEqual(errors, []);
  console.log('Browser separation passed: real model inference, stem modes, vocal analysis, timing, cached second run, cancellation, no audio uploads.');
} finally { await browser.close(); }
