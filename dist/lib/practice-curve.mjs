import {hzToMidi, midiToHz, clamp} from './analysis.mjs?v=0.6';

const PROFILES = {raw: {window: 0, passes: 0}, detail: {window: 5, passes: 1}, practice: {window: 5, passes: 2}, soft: {window: 7, passes: 2}};

function quadraticFit(values, index, radius) {
  const from = Math.max(0, index - radius), to = Math.min(values.length - 1, index + radius);
  if (to - from < 3) return values[index];
  // Local polynomial fit in semitones. Unlike a moving average, this preserves
  // a slide's slope and most of the 3–8 Hz vibrato at the default two 5-point passes.
  const powers = [0, 0, 0, 0, 0], sums = [0, 0, 0];
  for (let i = from; i <= to; i++) {
    const x = i - index, y = values[i];
    let power = 1;
    for (let k = 0; k < 5; k++) { powers[k] += power; if (k < 3) sums[k] += power * y; power *= x; }
  }
  const rows = [[powers[0], powers[1], powers[2], sums[0]], [powers[1], powers[2], powers[3], sums[1]], [powers[2], powers[3], powers[4], sums[2]]];
  for (let col = 0; col < 3; col++) {
    let pivot = col; for (let r = col + 1; r < 3; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col]; if (Math.abs(divisor) < 1e-10) return values[index];
    for (let k = col; k < 4; k++) rows[col][k] /= divisor;
    for (let r = 0; r < 3; r++) if (r !== col) { const factor = rows[r][col]; for (let k = col; k < 4; k++) rows[r][k] -= factor * rows[col][k]; }
  }
  return clamp(rows[0][3], Math.min(...values.slice(from, to + 1)), Math.max(...values.slice(from, to + 1)));
}

export function countFragments(points) {
  let fragments = 0, previous = null;
  for (const p of points) {
    if (p.hz && (!previous?.hz || Math.abs(hzToMidi(p.hz) - hzToMidi(previous.hz)) > 4)) fragments++;
    previous = p;
  }
  return fragments;
}

/** A display-only contour. Never edits the model output or invents long notes. */
export function practiceCurve(analysis, {profile = 'practice', connect = true, maxGapSeconds = 0.2, maxBridgeSemitones = 3.5} = {}) {
  if (!analysis) return null;
  const points = analysis.points.map(p => ({...p, interpolated: false}));
  const hop = analysis.hopSeconds || 0.02;
  let connectedGaps = 0, interpolatedPoints = 0;
  if (connect) for (let start = 0; start < points.length;) {
    if (points[start].hz) { start++; continue; }
    let end = start; while (end < points.length && !points[end].hz) end++;
    const a = points[start - 1], b = points[end];
    if (a?.hz && b?.hz && (end - start) * hop <= maxGapSeconds + 1e-8) {
      const from = hzToMidi(a.hz), to = hzToMidi(b.hz);
      // Keep real silence, abrupt register changes, and unbounded gaps open.
      const silenceFloor = Math.max(0.002, Math.min(a.rms || 0, b.rms || 0) * 0.035);
      let silent = 0;
      for (let i = start; i < end; i++) if ((points[i].rms ?? 0) < silenceFloor) silent++;
      if (Math.abs(to - from) <= maxBridgeSemitones && silent < Math.min(2, end - start)) {
        for (let i = start; i < end; i++) {
          const u = (points[i].t - a.t) / (b.t - a.t);
          points[i].hz = midiToHz(from + (to - from) * u);
          points[i].interpolated = true; interpolatedPoints++;
        }
        connectedGaps++;
      }
    }
    start = end;
  }
  const {window, passes} = PROFILES[profile] ?? PROFILES.practice;
  if (window) for (let start = 0; start < points.length;) {
    if (!points[start].hz) { start++; continue; }
    let end = start + 1;
    while (end < points.length && points[end].hz && Math.abs(hzToMidi(points[end].hz) - hzToMidi(points[end - 1].hz)) <= 4) end++;
    let values = points.slice(start, end).map(p => hzToMidi(p.hz));
    for (let pass = 0; pass < passes; pass++) { const input = values; values = input.map((_, i) => quadraticFit(input, i, (window - 1) / 2)); }
    for (let i = 0; i < values.length; i++) points[start + i].hz = midiToHz(values[i]);
    start = end;
  }
  return {...analysis, points, displayOnly: true, profile, stats: {connectedGaps, interpolatedPoints, rawFragments: countFragments(analysis.points), displayFragments: countFragments(points)}};
}

/** Shape-preserving cubic slopes, with no overshoot at a turn in the contour. */
export function curveRuns(points) {
  const runs = [];
  for (let start = 0; start < points.length;) {
    if (!points[start].hz) { start++; continue; }
    let end = start + 1;
    while (end < points.length && points[end].hz && points[end].t - points[end - 1].t < 0.05 && Math.abs(hzToMidi(points[end].hz) - hzToMidi(points[end - 1].hz)) <= 4) end++;
    const run = points.slice(start, end), values = run.map(p => hzToMidi(p.hz));
    const secants = values.slice(1).map((value, i) => (value - values[i]) / (run[i + 1].t - run[i].t));
    const slopes = values.map((_, i) => {
      if (!i) return secants[0] || 0;
      if (i === values.length - 1) return secants.at(-1) || 0;
      const a = secants[i - 1], b = secants[i];
      return a * b <= 0 ? 0 : 2 * a * b / (a + b);
    });
    for (let i = 0; i < secants.length; i++) {
      if (!secants[i]) { slopes[i] = slopes[i + 1] = 0; continue; }
      const a = slopes[i] / secants[i], b = slopes[i + 1] / secants[i], norm = Math.hypot(a, b);
      if (norm > 3) { const factor = 3 / norm; slopes[i] = factor * a * secants[i]; slopes[i + 1] = factor * b * secants[i]; }
    }
    runs.push({points: run, values, slopes}); start = end;
  }
  return runs;
}
