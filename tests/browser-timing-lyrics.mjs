import {chromium} from './harness.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const output = process.env.TINGQIANG_TEST_OUTPUT || '/tmp/tingqiang-timing-lyrics';
await mkdir(output, {recursive: true});
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.TINGQIANG_TEST_URL || 'http://127.0.0.1:8000/');
  await page.locator('#demo-button').click();
  await page.waitForFunction(() => document.getElementById('analysis-status').textContent.includes('分析完成'), null, {timeout: 90000});
  await page.locator('#lyrics-input').setInputFiles({name: 'untimed-test.txt', mimeType: 'text/plain', buffer: Buffer.from('未标时间的测试文本')});
  assert.equal(await page.locator('#jump-vocal').isEnabled(), true);
  assert.match(await page.locator('#vocal-start-info').textContent(), /人声起唱估计/);
  await page.waitForFunction(() => document.getElementById('dictionary-status').textContent.includes('上口字标红'));
  await page.locator('#lyrics-input').setInputFiles({name: 'test-only.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:01.00]<00:01.00>我<00:02.00>将<00:03.00>西<00:04.00>行<00:05.50>\n[00:06.00]你好\n[00:08.00]')});
  assert.equal(await page.locator('.lyric-row.has-alternate').count(), 0);
  assert.equal(await page.locator('.lyric-row').first().locator('rt').count(), 2);
  assert.equal(await page.locator('.lyric-row').last().locator('rt').count(), 0);
  assert.match(await page.locator('.lyric-row').first().locator('rt').first().textContent(), /ngǒ/);
  assert.match(await page.locator('.lyric-row').first().locator('rt').last().textContent(), /xín \/ xìn/);
  await page.locator('#audio').evaluate(a => a.currentTime = 2.2);
  await page.waitForFunction(() => document.querySelector('#current-subtitle .word-active')?.textContent.startsWith('将'));
  assert.equal(await page.locator('#current-subtitle ruby').count(), 2);
  assert.equal(await page.locator('#current-subtitle .has-alternate').count(), 0);
  const colours = await page.locator('#current-subtitle').evaluate(el => ({
    upper: getComputedStyle(el.querySelector('.special-reading')).color,
    plain: getComputedStyle(el.querySelector('.lyric-word:nth-child(2)')).color,
  }));
  assert.notEqual(colours.upper, colours.plain, 'Only upper-reading characters should be red.');
  assert.equal(await page.locator('#current-subtitle .lyric-word').nth(1).textContent(), '将');
  assert.equal(await page.locator('#current-subtitle .lyric-word').nth(2).textContent(), '西');
  const chart = await page.locator('#pitch-chart').boundingBox(), caption = await page.locator('#current-subtitle').boundingBox();
  assert.ok(caption.y > chart.y + chart.height);
  await page.locator('#toggle-subtitles').click();
  assert.equal(await page.locator('#subtitle-body').isVisible(), false);
  assert.equal(await page.locator('#lyrics-list').isVisible(), false);
  await page.locator('#toggle-subtitles').click();
  assert.equal(await page.locator('#subtitle-body').isVisible(), true);

  await page.locator('.edit-reading').first().click();
  await page.locator('.pron-row').first().getByRole('button', {name: '按普通话'}).click();
  await page.locator('#save-pronunciation').click();
  assert.equal(await page.locator('.lyric-row').first().locator('.lyric-word').first().textContent(), '我');
  assert.equal(await page.locator('.lyric-row').first().locator('rt').count(), 1);
  await page.locator('.edit-reading').first().click();
  await page.locator('#reset-pronunciation').click();
  assert.equal(await page.locator('.lyric-row').first().locator('rt').count(), 2);

  await page.locator('#audio').evaluate(a => a.currentTime = 9);
  await page.locator('#jump-vocal').click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  const jumped = await page.locator('#audio').evaluate(a => a.currentTime);
  assert.ok(jumped >= 1 && jumped < 1.5, `First line jump landed at ${jumped}`);
  await page.locator('#play-button').click();
  assert.equal(await page.locator('#loop-button').getAttribute('aria-pressed'), 'false');

  await page.locator('#rate').selectOption('0.5');
  await page.locator('#audio').evaluate(a => a.currentTime = 2.98);
  await page.locator('#sync-button').click();
  await page.locator('#auto-sync').uncheck();
  await page.locator('#sync-shift').fill('100');
  await page.waitForFunction(() => document.querySelector('#current-subtitle .word-active')?.textContent.startsWith('西'));
  await page.locator('#sync-later').click();
  assert.equal(await page.locator('#sync-shift').inputValue(), '80');
  await page.locator('#sync-reset').click();
  await page.waitForFunction(() => document.querySelector('#current-subtitle .word-active')?.textContent.startsWith('将'));
  await page.locator('#sync-dialog .close-dialog').click();
  await page.locator('#audio').evaluate(a => a.currentTime = 5.7);
  await page.waitForFunction(() => document.getElementById('current-subtitle').textContent.includes('间奏'));
  await page.locator('#audio').evaluate(a => a.currentTime = 6.2);
  await page.waitForFunction(() => document.getElementById('current-subtitle').textContent === '你好');
  assert.equal(await page.locator('#current-subtitle rt').count(), 0);
  assert.equal(await page.locator('#current-subtitle .has-alternate').count(), 0);

  await page.locator('#audio').evaluate(a => a.currentTime = 2.2);
  await page.waitForFunction(() => document.querySelector('#current-subtitle ruby')?.textContent.startsWith('我'));
  await page.screenshot({path: `${output}/timing-lyrics-desktop.png`, fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  const sizes = await page.evaluate(() => ({w: innerWidth, scroll: document.documentElement.scrollWidth}));
  assert.ok(sizes.scroll <= sizes.w + 1, `Mobile overflow: ${JSON.stringify(sizes)}`);
  await page.screenshot({path: `${output}/timing-lyrics-mobile.png`, fullPage: true});
  await page.locator('#toggle-subtitles').click();
  await page.reload();
  assert.equal(await page.locator('#toggle-subtitles').textContent(), '显示字幕');
  assert.equal(await page.locator('#subtitle-body').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Timing/lyric browser checks passed: detected/LRC onset, timestamped captions, only upper-reading characters red with ruby, plain characters without pinyin, corrections/reset, visibility persistence, slow-rate visual trim, end markers, mobile.');
} finally { await browser.close(); }
