import {clamp, estimateBeats} from './analysis.mjs?v=0.6';

// CREPE's 360 logarithmic bins cover ~32–2006 Hz in 20-cent steps.
export const CREPE_BINS = 360;
// Frames quieter than this never become a pitch, so they can skip the model entirely.
export const MIN_RMS = 0.002;
const CENTS_OFFSET = 1997.3794084376191;
export const binHz = bin => 10 * 2 ** ((CENTS_OFFSET + bin * 20) / 1200);
const frequencyBin = hz => (1200 * Math.log2(hz / 10) - CENTS_OFFSET) / 20;

/** Normalize exactly the 1024-sample, centred, 16 kHz windows used upstream. */
export function crepeBatch(samples, firstFrame, count, hop = 320, sampleOffset = 0) {
  const frames = new Float32Array(count * 1024), energy = [];
  for (let frame = 0; frame < count; frame++) {
    const centre = (firstFrame + frame) * hop, start = centre - 512 - sampleOffset, dest = frame * 1024;
    let mean = 0;
    for (let j = 0; j < 1024; j++) { const v = samples[start + j] || 0; frames[dest + j] = v; mean += v; }
    mean /= 1024;
    let sum = 0;
    for (let j = 0; j < 1024; j++) { const value = frames[dest + j] - mean; frames[dest + j] = value; sum += value * value; }
    const std = Math.max(1e-10, Math.sqrt(sum / 1023));
    for (let j = 0; j < 1024; j++) frames[dest + j] /= std;
    energy.push({t: centre / 16000, value: Math.sqrt(sum / 1024)});
  }
  return {frames, energy};
}

/** Small-jump Viterbi tracking, followed by local weighted frequency refinement.
 * The transition is the triangular CREPE/torchcrepe transition; no random dither.
 * Probabilities may be stored as bytes to keep long-recording memory bounded.
 */
export function decodeCrepe(activations, frameCount, energy, options = {}, progress = () => {}) {
  const scale = activations instanceof Uint8Array ? 255 : 1;
  const minBin = clamp(Math.floor(frequencyBin(options.fmin || 75)), 0, 358);
  const maxBin = clamp(Math.ceil(frequencyBin(options.fmax || 1400)), minBin + 1, 359);
  const count = maxBin - minBin + 1;
  const links = new Uint16Array(frameCount * count);
  const normalizers = Float64Array.from({length: count}, (_, i) => {
    const bin = i + minBin;
    let sum = 0; for (let j = Math.max(0, bin - 11); j <= Math.min(CREPE_BINS - 1, bin + 11); j++) sum += 12 - Math.abs(bin - j);
    return Math.log(sum);
  });
  const weights = Float64Array.from({length: 12}, (_, distance) => Math.log(12 - distance));
  let costs = new Float64Array(count), next = new Float64Array(count);
  for (let frame = 0; frame < frameCount; frame++) {
    let minCost = Infinity;
    for (let i = 0; i < count; i++) {
      let best = Infinity, previous = i;
      for (let j = Math.max(0, i - 11); j <= Math.min(count - 1, i + 11); j++) {
        const cost = costs[j] + normalizers[j] - weights[Math.abs(i - j)];
        if (cost < best) { best = cost; previous = j; }
      }
      const score = activations[frame * CREPE_BINS + minBin + i] / scale;
      next[i] = (frame ? best : 0) - score;
      links[frame * count + i] = previous;
      minCost = Math.min(minCost, next[i]);
    }
    for (let i = 0; i < count; i++) next[i] -= minCost;
    [costs, next] = [next, costs];
    if (frame % 200 === 0) progress(frame / Math.max(1, frameCount));
  }
  let index = 0;
  for (let i = 1; i < count; i++) if (costs[i] < costs[index]) index = i;
  const bins = new Uint16Array(frameCount), confidence = new Float32Array(frameCount);
  for (let frame = frameCount - 1; frame >= 0; frame--) {
    const bin = index + minBin;
    bins[frame] = bin; confidence[frame] = activations[frame * CREPE_BINS + bin] / scale;
    index = links[frame * count + index];
  }
  const medianConfidence = confidence.map((p, i) => {
    const a = confidence[Math.max(0, i - 1)], c = confidence[Math.min(frameCount - 1, i + 1)];
    return a + p + c - Math.max(a, p, c) - Math.min(a, p, c);
  });
  const threshold = options.confidence ?? 0.12;
  const points = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const bin = bins[frame], rms = energy[frame].value, p = medianConfidence[frame];
    let hz = null;
    if (p >= threshold && rms >= MIN_RMS) {
      let weighted = 0, total = 0;
      for (let i = Math.max(minBin, bin - 4); i <= Math.min(maxBin, bin + 4); i++) {
        const weight = activations[frame * CREPE_BINS + i] / scale;
        weighted += weight * i; total += weight;
      }
      if (total) hz = binHz(weighted / total);
    }
    points.push({t: energy[frame].t, hz, confidence: p, rms});
  }
  // Fricatives and boundary noise sometimes produce isolated short pitch islands.
  for (let start = 0; start < points.length;) {
    if (!points[start].hz) { start++; continue; }
    let end = start + 1;
    while (end < points.length && points[end].hz) end++;
    if (end - start < 3) for (let i = start; i < end; i++) points[i].hz = null;
    start = end;
  }
  progress(1);
  return {points, energy, beats: options.beats === false ? null : estimateBeats(energy), sampleRate: 16000, hopSeconds: 0.02, method: 'crepe-tiny'};
}

/** One frame's pitch for the live view while singing; saved curves still come from full tracking. */
export function framePitch(activation, {fmin = 75, fmax = 1400, threshold = 0.2} = {}) {
  const minBin = clamp(Math.floor(frequencyBin(fmin)), 0, 358), maxBin = clamp(Math.ceil(frequencyBin(fmax)), minBin + 1, 359);
  let best = minBin;
  for (let i = minBin + 1; i <= maxBin; i++) if (activation[i] > activation[best]) best = i;
  if (activation[best] < threshold) return null;
  let weighted = 0, total = 0;
  for (let i = Math.max(minBin, best - 4); i <= Math.min(maxBin, best + 4); i++) { weighted += activation[i] * i; total += activation[i]; }
  return binHz(weighted / total);
}
