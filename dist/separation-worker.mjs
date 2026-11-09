import {separateAudioBlocks, separationThreads} from './lib/separation-blocks.mjs?v=0.7';

// The apps try the graphics card first: the fastest card measured was 12 times the speed of 12 CPU threads. A weak
// integrated one loses to the CPU, so one pass decides; the page says how long a pass may take (docs/validation-v07.md).
const GPU_SILENCE_LIMIT_MS = 30000;
class SlowGpu extends Error {}
const progress = (value, message) => self.postMessage({type: 'progress', value, message});
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');

/** The apps ship the model beside the page, checked against the manifest when they were built. */
async function bundledModel(manifest) {
  const response = await fetch(new URL(`./models/${manifest.url.split('/').pop()}`, import.meta.url));
  if (!response.ok) throw new Error('找不到分离模型，请重新安装听腔。');
  return response.arrayBuffer();
}

async function modelBytes(manifest) {
  let cache;
  try {
    cache = await caches.open('tingqiang-separation-models-v1');
    const stored = await cache.match(manifest.url);
    if (stored) {
      const bytes = await stored.arrayBuffer();
      if (bytes.byteLength === manifest.bytes && await digest(bytes) === manifest.sha256) return bytes;
      await cache.delete(manifest.url);
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  progress(0, '首次下载人声分离模型，约 53 MB；录音仍留在本机…');
  const response = await fetch(manifest.url, {credentials: 'omit'});
  if (!response.ok) throw new Error(`模型下载失败（${response.status}）。可稍后重试，或使用增强服务。`);
  let bytes;
  if (response.body) {
    const reader = response.body.getReader(), chunks = []; let received = 0;
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      received += value.byteLength;
      if (received > manifest.bytes) { await reader.cancel(); throw new Error('模型文件大小异常，请重试。'); }
      chunks.push(value);
      progress(0.15 * received / manifest.bytes, `下载分离模型… ${(received / 1000000).toFixed(1)} / ${(manifest.bytes / 1000000).toFixed(1)} MB`);
    }
    const merged = new Uint8Array(received); let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    bytes = merged.buffer;
  } else bytes = await response.arrayBuffer();
  if (bytes.byteLength !== manifest.bytes || await digest(bytes) !== manifest.sha256) throw new Error('分离模型校验失败，未处理录音。请重试。');
  if (cache) try { await cache.put(manifest.url, new Response(bytes, {headers: {'Content-Type': 'application/octet-stream'}})); } catch {}
  return bytes;
}

async function gpuName() {
  const adapter = await navigator.gpu?.requestAdapter({powerPreference: 'high-performance'}).catch(() => null);
  return adapter ? `${adapter.info.vendor} ${adapter.info.architecture}`.trim() : null;
}

/** Rejects when the card is lost or stops answering; either way the model's promise would never settle by itself.
 * Losing it after it passed the trial may be a passing driver problem. Failing the trial means it is not worth trying again. */
async function gpuFailure(ort, status) {
  const device = await ort.env.webgpu.device;
  return new Promise((_, reject) => {
    device.lost.then(info => reject(status.proven ? new Error(`Graphics card lost: ${info.message}`) : new SlowGpu()));
    let tick = performance.now();
    setInterval(() => {
      // A phone freezes the page behind the lock screen; time spent frozen is not the card falling silent.
      const now = performance.now();
      if (now - tick > 5000) status.active += now - tick;
      tick = now;
      if (now - status.active > GPU_SILENCE_LIMIT_MS) reject(new SlowGpu());
    }, 1000);
  });
}

async function separate(channels, manifest, bytes, {gpu, native, blockFrames, gpuPassLimitMs}) {
  const [ort, {MDXSeparator}] = await Promise.all(native ? [import('./lib/native-ort.mjs'), import('./vendor/separator-native.mjs')]
    : gpu ? [import('./vendor/ort/ort.webgpu.min.mjs'), import('./vendor/separator-webgpu.mjs?v=0.7')]
    : [import('./vendor/ort/ort.wasm.min.mjs'), import('./vendor/separator.mjs?v=0.7')]);
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = gpu ? 1 : separationThreads(navigator.hardwareConcurrency, self.crossOriginIsolated);
  let bounds = {start: 0, end: 1}, abandoned = false;
  const status = {active: performance.now(), proven: false};
  const speedup = gpu ? '显卡加速，' : native ? '多核加速，' : '';
  const reportFraction = fraction => { if (!abandoned) progress(0.2 + 0.75 * fraction, `正在减弱伴奏… ${Math.round(fraction * 100)}%（${speedup}可继续播放原声）`); };
  const separator = new MDXSeparator({modelPath: new Uint8Array(bytes), modelName: manifest.name, modelData: manifest.parameters, logLevel: 'error', onProgress: p => {
    status.active = performance.now();
    if (p.stage === 'demixing') reportFraction(bounds.start + (bounds.end - bounds.start) * p.fraction);
  }}, {segmentSize: 256, overlap: 0.25, batchSize: 1, hopLength: 1024, executionProviders: [gpu ? 'webgpu' : 'wasm']});
  try {
    await separator.loadModel();
    progress(0.2, gpu ? '正在减弱伴奏…（显卡加速）' : native ? '正在减弱伴奏…（多核加速）' : '正在减弱伴奏…（首次处理较慢，可随时取消）');
    const work = async () => {
      if (gpu && await separator.measureInference() > gpuPassLimitMs) throw new SlowGpu();
      status.active = performance.now(); status.proven = true;
      return separateAudioBlocks(channels, (block, range) => { bounds = range; return separator.demix(block); }, {compensate: manifest.parameters.compensate, progress: reportFraction, ...(blockFrames ? {blockFrames} : {})});
    };
    return await (gpu ? Promise.race([work(), gpuFailure(ort, status)]) : work());
  } finally { abandoned = true; separator.release().catch(() => {}); }
}

self.onmessage = async ({data}) => {
  try {
    const response = await fetch(new URL('./models/separation.json', import.meta.url));
    if (!response.ok) throw new Error('分离配置加载失败，请刷新页面。');
    // Longer blocks mean fewer repeated passes over their overlaps, for memory a desktop can spare.
    const {bundled = false, native = false, gpu: tryGpu = false, gpuPassLimitMs = 3000, blockFrames = 0} = data.options || {};
    const manifest = await response.json(), options = {gpu: false, native: false, blockFrames, gpuPassLimitMs};
    let result = null;
    // On a phone the app runs the model itself, on several cores, and has its own copy of it (lib/native-ort.mjs).
    if (native) {
      globalThis.tingqiangModelPort = data.modelPort;
      progress(0.15, '正在加载人声分离模型…');
      try { result = await separate(data.channels, manifest, new ArrayBuffer(0), {...options, native: true}); }
      catch (error) { console.warn('Falling back to WebAssembly:', error); }
    }
    const bytes = result ? null : await (bundled ? bundledModel : modelBytes)(manifest);
    if (!result) progress(0.15, '正在加载人声分离模型…');
    const adapter = !result && tryGpu ? await gpuName() : null;
    if (adapter && !data.slowGpus?.includes(adapter)) {
      try { result = await separate(data.channels, manifest, bytes, {...options, gpu: true}); }
      catch (error) {
        // Too slow will stay too slow; a failure may be a passing driver problem, so only this run moves to the CPU.
        if (error instanceof SlowGpu) self.postMessage({type: 'slow-gpu', adapter});
        else console.warn('Falling back to the CPU:', error);
      }
    }
    result ||= await separate(data.channels, manifest, bytes, options);
    progress(0.98, '正在整理人声与伴奏…');
    self.postMessage({type: 'done', ...result, sampleRate: 44100}, [...result.vocals.map(c => c.buffer), ...result.accompaniment.map(c => c.buffer)]);
  } catch (error) { self.postMessage({type: 'error', message: error.message || '分离失败，可重试或导入分轨。'}); }
};
