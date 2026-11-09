import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
// The Windows client also gets a WebGPU build. ONNX Runtime's WebGPU files are twice the size and slower on the CPU, so the
// plain one stays. The Android app's build runs each model pass in the app instead (dist/lib/native-ort.mjs).
for (const [outfile, runtime] of [['separator.mjs', './ort/ort.wasm.min.mjs'], ['separator-webgpu.mjs', './ort/ort.webgpu.min.mjs'], ['separator-native.mjs', '../lib/native-ort.mjs']]) await build({
  entryPoints: [fileURLToPath(new URL('../third_party/web-audio-separation/src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL(`../dist/vendor/${outfile}`, import.meta.url)),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  banner: {js: '/* web-audio-separation: MIT, (c) 2026 Dan Kurtz. PFFFT notices: ../licenses/. See third_party/ for pinned source and adaptations. */'},
  plugins: [{name: 'local-ort', setup(builder) {
    builder.onResolve({filter: /^onnxruntime-web$/}, () => ({path: runtime, external: true}));
  }}],
});
