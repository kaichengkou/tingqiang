// Optional integration check: runs the real installed Demucs model via the UI.
import {chromium} from './harness.mjs';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {synthesizeDemo, encodeWav} from '../dist/lib/analysis.mjs';

const output = await mkdtemp(join(tmpdir(), 'tingqiang-separation-'));
const demo = synthesizeDemo();
await writeFile(join(output, 'test.wav'), Buffer.from(encodeWav([demo.original.slice(0, demo.sampleRate * 6)], demo.sampleRate)));
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.TINGQIANG_TEST_URL || 'http://127.0.0.1:8000/');
  await page.locator('#audio-input').setInputFiles(join(output, 'test.wav'));
  await page.waitForFunction(() => document.getElementById('analysis-status').textContent.includes('录音已就绪'));
  await page.locator('#source-button').click();
  await page.locator('#connect-service').click();
  await page.waitForFunction(() => !document.getElementById('separate-button').disabled);
  await page.locator('#separate-button').click();
  await page.waitForFunction(() => document.getElementById('curve-source').textContent === '人声分析' || document.getElementById('service-status').textContent.startsWith('分离失败'), {timeout: 300000});
  const result = await page.locator('#service-status').textContent();
  assert.ok(!result.startsWith('分离失败'), result);
  assert.equal(await page.locator('[data-mode="vocals"]').getAttribute('aria-disabled'), 'false');
  assert.equal(await page.locator('[data-mode="accompaniment"]').getAttribute('aria-disabled'), 'false');
  assert.equal(await page.locator('#analysis-source').inputValue(), 'vocals');
  assert.equal(await page.locator('#curve-source').textContent(), '人声分析');
  await page.locator('[data-mode="vocals"]').click();
  assert.equal(await page.locator('[data-mode="vocals"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  console.log('Real Demucs end-to-end check passed: upload, async job, WAV stems, vocal analysis, playback modes. This validates integration, not Peking-opera separation quality.');
} finally { await browser.close(); }
