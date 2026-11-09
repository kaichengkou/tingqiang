// Renders the app icon from the same mark as the favicon. Small sizes get a heavier line so the curve survives at 16 px.
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';

const out = new URL('../desktop/build/', import.meta.url);
const mark = stroke => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="14" fill="#a34132"/><path d="M13 37c8 0 8-18 16-18s6 27 15 27c4 0 7-11 7-11" stroke="#fffaf0" stroke-width="${stroke}" fill="none" stroke-linecap="round"/><circle cx="13" cy="37" r="${stroke * 0.95}" fill="#fffaf0"/></svg>`;
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium'});
const page = await browser.newPage({viewport: {width: 512, height: 512}});
async function render(size) {
  await page.setContent(`<!doctype html><style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${mark(size <= 32 ? 6 : size <= 64 ? 5 : 4)}`);
  return page.locator('svg').screenshot({omitBackground: true});
}
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256], images = [];
for (const size of sizes) images.push(await render(size));
writeFileSync(new URL('icon.png', out), await render(512));
await browser.close();
// An ICO is a directory of images; PNG entries are valid from Windows Vista on.
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i;
  header.writeUInt8(size % 256, entry); header.writeUInt8(size % 256, entry + 1);
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
writeFileSync(new URL('icon.ico', out), Buffer.concat([header, ...images]));
console.log(`Wrote ${sizes.length} sizes.`);
