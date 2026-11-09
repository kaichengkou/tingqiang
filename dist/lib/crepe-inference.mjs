import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import {crepeBatch, framePitch, CREPE_BINS, MIN_RMS} from './crepe.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
const BATCH = 32;
let loading;
const model = () => loading ||= ort.InferenceSession.create(new URL('../models/crepe-tiny.onnx', import.meta.url).href, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});

/** Model activations for a run of frames. `samples` may be a slice that starts at `sampleOffset` of the recording. */
export async function inferChunk(samples, firstFrame, count, sampleOffset = 0) {
  const session = await model();
  const {frames, energy} = crepeBatch(samples, firstFrame, count, 320, sampleOffset);
  const activations = new Uint8Array(count * CREPE_BINS), loud = [];
  for (let frame = 0; frame < count; frame++) if (energy[frame].value >= MIN_RMS) loud.push(frame);
  for (let at = 0; at < loud.length; at += BATCH) {
    const batch = loud.slice(at, at + BATCH), data = new Float32Array(batch.length * 1024);
    batch.forEach((frame, i) => data.set(frames.subarray(frame * 1024, (frame + 1) * 1024), i * 1024));
    const input = new ort.Tensor('float32', data, [batch.length, 1024]);
    const output = (await session.run({frames: input})).activations;
    batch.forEach((frame, i) => { for (let bin = 0; bin < CREPE_BINS; bin++) activations[frame * CREPE_BINS + bin] = Math.round(output.data[i * CREPE_BINS + bin] * 255); });
    input.dispose(); output.dispose();
  }
  return {activations, energy};
}

/** Pitch of the newest 1024 samples at 16 kHz, or null when nothing clear is sounding. */
export async function inferLive(samples, options) {
  const session = await model();
  const {frames, energy} = crepeBatch(samples, 0, 1, 320, -512);
  if (energy[0].value < MIN_RMS) return null;
  const input = new ort.Tensor('float32', frames, [1, 1024]);
  const output = (await session.run({frames: input})).activations;
  const hz = framePitch(output.data, options);
  input.dispose(); output.dispose();
  return hz;
}
