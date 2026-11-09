import {clamp} from './analysis.mjs?v=0.6';

export const transposeHz = (hz, semitones = 0) => hz ? hz * 2 ** (semitones / 12) : null;
export const takeToReference = (seconds, take) => take.anchor + (take.offset || 0) + seconds * take.rate;
export const referenceToTake = (seconds, take) => (seconds - take.anchor - (take.offset || 0)) / take.rate;

export function sentenceRange(lines, index, duration, offset = 0) {
  const line = lines[index];
  if (!line || !Number.isFinite(line.t)) return null;
  const start = clamp(line.t + offset, 0, duration);
  const next = lines.filter(q => Number.isFinite(q.t) && q.t > line.t).reduce((end, q) => Math.min(end, q.t + offset), duration);
  const end = clamp(Math.min((line.end ?? Infinity) + offset, next), start, duration);
  return end - start >= 0.15 ? {start, end} : null;
}

export function nextPracticePhase({mode, round, repeats, gap, duration, rate}, completed) {
  if (completed === 'listen' && mode === 'echo') return {phase: 'sing', round, seconds: duration / rate + gap};
  if (repeats > 0 && round >= repeats) return {phase: 'done', round};
  return {phase: 'gap', round: round + 1, seconds: gap};
}
