import test from 'node:test';
import assert from 'node:assert/strict';
import {PitchPool, planChunks, pickChunk, poolSize} from '../dist/lib/pitch-pool.mjs';
import {decodeCrepe, binHz} from '../dist/lib/crepe.mjs';

/** Answers like the real worker, but out of order, and records what it was asked. */
function fakeWorkers(log = []) {
  return () => {
    const worker = {terminate() { worker.ended = true; }, postMessage(message) {
      log.push(message);
      const reply = () => {
        if (worker.ended) return;
        if (message.type === 'chunk') {
          const activations = new Uint8Array(message.count * 360), rms = new Float64Array(message.count);
          for (let i = 0; i < message.count; i++) { activations[i * 360 + (message.first + i) % 360] = 200; rms[i] = (message.first + i) / 1000; }
          worker.onmessage({data: {type: 'chunk', id: message.id, first: message.first, count: message.count, activations, rms, points: []}});
        } else if (message.type === 'decode') worker.onmessage({data: {type: 'done', id: message.id, result: {activations: message.activations, rms: message.rms, frames: message.frameCount}}});
        else if (message.type === 'live') worker.onmessage({data: {type: 'live', id: message.id, hz: 220}});
        else worker.onmessage({data: {type: 'done', id: message.id, result: {quick: true}}});
      };
      setTimeout(reply, 1 + (message.first || 0) % 7);
    }};
    return worker;
  };
}
const samples = seconds => new Float32Array(16000 * seconds);

test('pool size leaves a core free and stays small on low-memory devices', () => {
  assert.equal(poolSize(1), 1); assert.equal(poolSize(2), 1); assert.equal(poolSize(4), 3); assert.equal(poolSize(24), 4); assert.equal(poolSize(8, 2), 2);
});
test('chunks cover every frame exactly once', () => {
  const chunks = planChunks(1001, 200);
  assert.equal(chunks.length, 6); assert.deepEqual(chunks.at(-1), {first: 1000, count: 1});
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.count, 0), 1001);
});
test('the chunk under the playhead is started first, then the rest in order', () => {
  const chunks = planChunks(1000, 200);
  assert.equal(pickChunk(chunks, 0), 0); assert.equal(pickChunk(chunks, 450), 2); assert.equal(pickChunk(chunks, 5000), 0);
  assert.equal(pickChunk(chunks.slice(3), 100), 0);
});
test('out-of-order chunk results assemble into the same activations and timeline', async () => {
  const log = [], pool = new PitchPool({size: 4, createWorker: fakeWorkers(log)}), previews = [], progress = [];
  const {promise} = pool.analyze(samples(9), {method: 'crepe'}, {onChunk: first => previews.push(first), onProgress: value => progress.push(value)});
  const result = await promise;
  assert.equal(result.frames, 1 + 9 * 50);
  for (let frame = 0; frame < result.frames; frame++) { assert.equal(result.activations[frame * 360 + frame % 360], 200); assert.equal(result.rms[frame], frame / 1000); }
  assert.deepEqual(previews.toSorted((a, b) => a - b), planChunks(result.frames).map(chunk => chunk.first));
  assert.equal(progress.at(-1).done, result.frames);
  assert.equal(log.filter(message => message.type === 'decode').length, 1);
  const first = log.find(message => message.type === 'chunk' && message.first === 200);
  assert.equal(first.sampleOffset, 200 * 320 - 512, 'A chunk needs half a window of samples before its first frame.');
  pool.dispose();
});
test('work waits while paused, and a higher-priority job goes first', async () => {
  const log = [], pool = new PitchPool({size: 1, createWorker: fakeWorkers(log)});
  let paused = true;
  const main = pool.analyze(samples(9), {method: 'crepe'}, {paused: () => paused});
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(log.length, 0, 'A paused job must not start.');
  const take = pool.analyze(samples(1), {method: 'crepe'}, {priority: 1});
  await take.promise;
  assert.ok(log.length > 0 && log.every(message => message.samples ? message.samples.length < 16000 * 2 : true));
  paused = false; pool.pump();
  assert.equal((await main.promise).frames, 451);
  pool.dispose();
});
test('cancelling rejects at once and frees the pool for the next job', async () => {
  const pool = new PitchPool({size: 2, createWorker: fakeWorkers()});
  const job = pool.analyze(samples(60), {method: 'crepe'});
  job.cancel();
  await assert.rejects(job.promise, {name: 'AbortError'});
  assert.equal((await pool.analyze(samples(1), {method: 'crepe'}).promise).frames, 51);
  pool.dispose();
});
test('a crashed worker fails its job with a message instead of hanging', async () => {
  const workers = [];
  const pool = new PitchPool({size: 1, createWorker: () => { const worker = {terminate() {}, postMessage() {}}; workers.push(worker); return worker; }});
  const job = pool.analyze(samples(1), {method: 'crepe'});
  workers[0].onerror({message: '模型加载失败'});
  await assert.rejects(job.promise, /模型加载失败/);
  pool.dispose();
});
test('the quick method runs once on a single worker', async () => {
  const log = [], pool = new PitchPool({size: 4, createWorker: fakeWorkers(log)});
  assert.deepEqual(await pool.analyze(new Float32Array(1200), {method: 'yin', sampleRate: 12000}).promise, {quick: true});
  assert.equal(log.length, 1); assert.equal(log[0].sampleRate, 12000);
  pool.dispose();
});
test('live pitch skips rather than queues when every worker is busy', async () => {
  const log = [], pool = new PitchPool({size: 1, createWorker: fakeWorkers(log)});
  const first = pool.live(new Float32Array(1024), {}), second = pool.live(new Float32Array(1024), {});
  assert.equal(await second, null); assert.equal(await first, 220); assert.equal(log.length, 1);
  pool.dispose();
});
test('tracking gives the same curve whichever worker computed each frame', () => {
  const frames = 300, activations = new Uint8Array(frames * 360), energy = Array.from({length: frames}, (_, i) => ({t: i * 320 / 16000, value: 0.1}));
  for (let frame = 0; frame < frames; frame++) { const bin = 200 + Math.round(10 * Math.sin(frame / 20)); for (let j = -4; j <= 4; j++) activations[frame * 360 + bin + j] = 180 * Math.exp(-j * j / 3); }
  const whole = decodeCrepe(activations, frames, energy, {fmin: 75, fmax: 1400});
  const assembled = new Uint8Array(frames * 360);
  for (const {first, count} of planChunks(frames, 64).reverse()) assembled.set(activations.subarray(first * 360, (first + count) * 360), first * 360);
  assert.deepEqual(decodeCrepe(assembled, frames, energy, {fmin: 75, fmax: 1400}).points, whole.points);
  assert.ok(Math.abs(whole.points[0].hz - binHz(200)) < 8);
});
