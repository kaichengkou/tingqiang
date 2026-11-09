// CREPE frames are independent, so inference spreads over plain workers. That needs no SharedArrayBuffer, and so
// no special hosting headers; the final tracking pass still runs once over the whole recording.
const BINS = 360, HOP = 320, MARGIN = 512, CHUNK_FRAMES = 200, IDLE_MS = 120000;

/** Leaves a core for playback and the page. Beyond four workers the gain was small when measured (6.6 s vs 5.2 s at eight). */
export function poolSize(cores = globalThis.navigator?.hardwareConcurrency || 2, memoryGb = globalThis.navigator?.deviceMemory) {
  return Math.max(1, Math.min(memoryGb && memoryGb <= 2 ? 2 : 4, cores - 1));
}
export function planChunks(frameCount, size = CHUNK_FRAMES) {
  const chunks = [];
  for (let first = 0; first < frameCount; first += size) chunks.push({first, count: Math.min(size, frameCount - first)});
  return chunks;
}
/** The first unstarted chunk at or after the playhead, so the part being listened to fills in first. */
export function pickChunk(pending, hintFrame = 0) {
  const ahead = pending.findIndex(chunk => chunk.first + chunk.count > hintFrame);
  return ahead < 0 ? 0 : ahead;
}
const defaultWorker = () => new Worker(new URL('../analysis-worker.mjs?v=0.6', import.meta.url), {type: 'module'});

export class PitchPool {
  constructor({size = poolSize(), createWorker = defaultWorker} = {}) {
    this.size = size; this.createWorker = createWorker; this.slots = []; this.jobs = []; this.ids = 0;
  }
  /** Runs CREPE across the pool, or the quick method on one worker. Returns {promise, cancel}. */
  analyze(samples, options, hooks = {}) {
    let job;
    const promise = new Promise((resolve, reject) => {
      job = {samples, options, hooks, resolve, reject, priority: hooks.priority || 0, running: 0, stage: options.method === 'crepe' ? 'chunks' : 'single'};
      if (job.stage === 'chunks') {
        job.frameCount = 1 + Math.floor(samples.length / HOP); job.pending = planChunks(job.frameCount); job.finished = 0;
        job.activations = new Uint8Array(job.frameCount * BINS); job.rms = new Float64Array(job.frameCount);
        hooks.onStart?.(job.frameCount);
      }
      this.jobs.push(job); this.jobs.sort((a, b) => b.priority - a.priority);
      this.pump();
    });
    return {promise, cancel: () => this.settle(job, null, new DOMException('已取消分析', 'AbortError'))};
  }
  /** One frame for the live view. Skips (resolves null) rather than queues when every worker is busy. */
  live(samples, options) {
    const slot = this.freeSlot();
    if (!slot) return Promise.resolve(null);
    return new Promise(resolve => this.send(slot, {resolve, reject: () => resolve(null)}, {type: 'live', samples, options}, [samples.buffer]));
  }
  settle(job, result, error) {
    const index = this.jobs.indexOf(job);
    if (index < 0) return;
    this.jobs.splice(index, 1);
    if (error) job.reject(error); else job.resolve(result);
    job.samples = job.activations = job.rms = null;
    this.pump();
  }
  freeSlot() {
    const idle = this.slots.find(slot => !slot.task);
    if (idle || this.slots.length >= this.size) return idle;
    const slot = {worker: this.createWorker(), task: null};
    slot.worker.onmessage = ({data}) => this.receive(slot, data);
    slot.worker.onerror = event => this.crash(slot, event.message || '分析线程无法启动，请刷新重试。');
    this.slots.push(slot);
    return slot;
  }
  send(slot, task, message, transfer = []) {
    task.id = ++this.ids; slot.task = task;
    slot.worker.postMessage({...message, id: task.id}, transfer);
  }
  /** Hands free workers to waiting work; paused jobs (such as while recording) wait for a later pump. */
  pump() {
    clearTimeout(this.idleTimer);
    for (const job of this.jobs) {
      if (job.hooks.paused?.()) continue;
      for (let slot; this.hasWork(job) && (slot = this.freeSlot());) this.start(slot, job);
    }
    if (!this.jobs.length && this.slots.length && this.slots.every(slot => !slot.task)) this.idleTimer = setTimeout(() => this.dispose(), IDLE_MS);
  }
  hasWork(job) {
    return job.stage === 'chunks' ? job.pending.length > 0 : !job.running;
  }
  start(slot, job) {
    job.running++;
    if (job.stage === 'chunks') {
      const chunk = job.pending.splice(pickChunk(job.pending, job.hooks.hint?.() ?? 0), 1)[0];
      const from = Math.max(0, chunk.first * HOP - MARGIN), to = Math.min(job.samples.length, (chunk.first + chunk.count - 1) * HOP + MARGIN);
      const samples = job.samples.slice(from, to);
      this.send(slot, {job}, {type: 'chunk', samples, first: chunk.first, count: chunk.count, sampleOffset: from, options: job.options}, [samples.buffer]);
    } else if (job.stage === 'decode') {
      const {activations, rms} = job; job.activations = job.rms = null;
      this.send(slot, {job}, {type: 'decode', activations, rms, frameCount: job.frameCount, options: job.options}, [activations.buffer, rms.buffer]);
    } else {
      const {samples} = job; job.samples = null;
      this.send(slot, {job}, {type: 'pitch', samples, sampleRate: job.options.sampleRate, options: job.options}, [samples.buffer]);
    }
  }
  receive(slot, data) {
    const task = slot.task;
    if (!task || data.id !== task.id) return;
    const {job} = task;
    if (data.type === 'progress') { if (this.jobs.includes(job)) job.hooks.onProgress?.({fraction: data.value}); return; }
    slot.task = null;
    if (!job) { if (data.type === 'error') task.reject(data); else task.resolve(data.hz ?? null); this.pump(); return; }
    job.running--;
    if (!this.jobs.includes(job)) { this.pump(); return; }
    if (data.type === 'error') { this.settle(job, null, new Error(data.message)); return; }
    if (data.type === 'done') { this.settle(job, data.result); return; }
    job.activations.set(data.activations, data.first * BINS); job.rms.set(data.rms, data.first); job.finished += data.count;
    job.hooks.onChunk?.(data.first, data.points);
    job.hooks.onProgress?.({done: job.finished, total: job.frameCount});
    if (job.finished === job.frameCount) { job.samples = null; job.stage = 'decode'; }
    this.pump();
  }
  crash(slot, message) {
    const {task} = slot;
    slot.worker.terminate(); this.slots.splice(this.slots.indexOf(slot), 1);
    if (task?.job) this.settle(task.job, null, new Error(message));
    else { task?.reject(new Error(message)); this.pump(); }
  }
  dispose() {
    for (const job of [...this.jobs]) this.settle(job, null, new DOMException('已取消分析', 'AbortError'));
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    clearTimeout(this.idleTimer);
  }
}
