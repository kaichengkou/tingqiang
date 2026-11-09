import {clamp, hzToMidi} from './analysis.mjs?v=0.6';

export const TAKE_LIMIT_SECONDS = 600;

/** Where the backing starts, when singing is due, and where to stop. Too little lead-in adds a silent count-in. */
export function singAlongPlan({loopA = null, loopB = null, position = 0, duration, leadIn = 4}) {
  const wanted = clamp(loopA ?? position, 0, duration), entry = duration - wanted < 1 ? 0 : wanted;
  const start = Math.max(0, entry - leadIn), lead = entry - start;
  return {start, entry, end: Math.min(loopB ?? duration, entry + TAKE_LIMIT_SECONDS, duration), silence: lead >= 2 ? 0 : 3 - lead};
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Reference time of the first captured sample. While the backing plays, media time is
 * mediaOffset + rate × context time. A singer answers what they hear, so their voice reaches the
 * graph later than the backing it matches by the output and input delays (the round trip), plus
 * any processing on the backing path such as live pitch shift.
 */
export function takeAnchor({mediaOffset, rate, captureStart, roundTrip = 0, processing = 0}) {
  return mediaOffset + rate * (captureStart - roundTrip - processing);
}

/** Median delay between clicks and the claps answering them, or null when the answers are unclear. */
export function measureRoundTrip(samples, sampleRate, clickTimes, {answerWindow = 0.6} = {}) {
  const hop = Math.max(1, Math.round(sampleRate * 0.002)), envelope = new Float32Array(Math.floor(samples.length / hop));
  for (let i = 0; i < envelope.length; i++) {
    let peak = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) peak = Math.max(peak, Math.abs(samples[j]));
    envelope[i] = peak;
  }
  const floor = median(Array.from(envelope)) ?? 0, lags = [], rate = sampleRate / hop;
  for (const click of clickTimes) {
    const from = Math.max(0, Math.round(click * rate)), to = Math.min(envelope.length, Math.round((click + answerWindow) * rate));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, envelope[i]);
    if (peak < Math.max(floor * 4, 0.02)) continue;
    const threshold = floor + (peak - floor) * 0.3;
    for (let i = from; i < to; i++) if (envelope[i] >= threshold) { lags.push(i / rate - click); break; }
  }
  if (lags.length < Math.ceil(clickTimes.length / 2)) return null;
  const seconds = median(lags), spread = median(lags.map(lag => Math.abs(lag - seconds)));
  return spread > 0.06 ? null : {seconds, spread, answers: lags.length};
}

/** Best constant offset for a take against the reference. Octave differences count as a match. */
export function alignTake(reference, take, analysis, {maxShift = 12, step = 0.02} = {}) {
  if (!reference?.points.length) return null;
  const voiced = analysis?.points.filter(point => point.hz) || [], stride = Math.ceil(voiced.length / 3000) || 1;
  const frames = voiced.filter((_, i) => i % stride === 0).map(point => ({at: take.anchor + point.t * take.rate, midi: hzToMidi(point.hz)}));
  if (frames.length < 10) return null;
  const hop = reference.hopSeconds, origin = reference.points[0].t, pitches = reference.points.map(point => point.hz ? hzToMidi(point.hz) + (take.transpose || 0) : null);
  const miss = offset => {
    let sum = 0;
    for (const frame of frames) {
      const pitch = pitches[Math.round((frame.at + offset - origin) / hop)];
      if (pitch === null || pitch === undefined) { sum += 3; continue; }
      const distance = Math.abs(frame.midi - pitch) % 12;
      sum += Math.min(distance, 12 - distance, 3);
    }
    return sum / frames.length;
  };
  let offset = 0, score = Infinity;
  for (let i = -Math.round(maxShift / step); i <= Math.round(maxShift / step); i++) {
    const current = miss(i * step);
    if (current < score) { score = current; offset = i * step; }
  }
  return {offset, score, current: miss(take.offset || 0)};
}

/** Brings a quiet phone-mic take up to about the level of the singing in the reference. */
export function suggestVoiceGain(reference, analysis) {
  const level = points => median((points || []).filter(point => point.hz).map(point => point.rms));
  const take = level(analysis?.points), target = level(reference?.points) || 0.1;
  return take ? clamp(target / take, 0.5, 4) : 1.5;
}

/** Box-filtered resampling for the live view; saved curves re-decode the take properly. */
export class LiveResampler {
  constructor(fromRate, toRate = 16000, size = 1024) {
    this.ratio = fromRate / toRate; this.ring = new Float32Array(size); this.at = 0; this.filled = 0; this.sum = 0; this.count = 0; this.input = 0; this.edge = this.ratio;
  }
  push(samples) {
    for (const sample of samples) {
      this.sum += sample; this.count++; this.input++;
      if (this.input >= this.edge) {
        this.ring[this.at] = this.sum / this.count; this.at = (this.at + 1) % this.ring.length; this.filled = Math.min(this.filled + 1, this.ring.length);
        this.sum = 0; this.count = 0; this.edge += this.ratio;
      }
    }
  }
  latest() {
    if (this.filled < this.ring.length) return null;
    const window = new Float32Array(this.ring.length);
    window.set(this.ring.subarray(this.at)); window.set(this.ring.subarray(0, this.at), this.ring.length - this.at);
    return window;
  }
}
