import {mkdir, copyFile} from 'node:fs/promises';
const out = new URL('../dist/vendor/ort/', import.meta.url);
await mkdir(out, {recursive: true});
for (const name of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  await copyFile(new URL(`../node_modules/onnxruntime-web/dist/${name}`, import.meta.url), new URL(name, out));
}
const notices = new URL('../dist/licenses/', import.meta.url);
await mkdir(notices, {recursive: true});
for (const name of ['crepe-MIT.txt', 'torchcrepe-MIT.txt', 'onnxruntime-MIT.txt', 'onnxruntime-ThirdPartyNotices.txt', 'web-audio-separation-MIT.txt', 'pffft-LICENSE.txt', 'pinyin-pro-MIT.txt', 'signalsmith-stretch-MIT.txt']) {
  await copyFile(new URL(`../licenses/${name}`, import.meta.url), new URL(name, notices));
}
await copyFile(new URL('../node_modules/signalsmith-stretch/SignalsmithStretch.mjs', import.meta.url), new URL('../dist/vendor/signalsmith-stretch.mjs', import.meta.url));
