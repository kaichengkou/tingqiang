import test from 'node:test';
import assert from 'node:assert/strict';
import {practiceCurve, curveRuns} from '../dist/lib/practice-curve.mjs';
import {hzToMidi, midiToHz} from '../dist/lib/analysis.mjs';

function track(n, f) { return {hopSeconds: 0.02, points: Array.from({length: n}, (_, i) => ({t: i * 0.02, hz: midiToHz(f(i * 0.02)), rms: 0.2, confidence: 0.8}))}; }
function amplitude(points, frequency) {
  const values = points.slice(15, -15), n = values.length;
  let sin = 0, cos = 0;
  for (const p of values) { const value = hzToMidi(p.hz) - 60; sin += value * Math.sin(2 * Math.PI * frequency * p.t); cos += value * Math.cos(2 * Math.PI * frequency * p.t); }
  return 2 * Math.hypot(sin, cos) / n;
}
test('learning smoothing suppresses detector chatter while preserving a sustained vibrato', () => {
  const original = track(1000, t => 60 + 0.4 * Math.sin(2 * Math.PI * 7 * t) + 0.15 * Math.sin(2 * Math.PI * 19 * t));
  const result = practiceCurve(original);
  assert.ok(amplitude(result.points, 7) > amplitude(original.points, 7) * 0.85);
  assert.ok(amplitude(result.points, 19) < amplitude(original.points, 19) * 0.15);
});
test('a slide keeps its timing and overall shape', () => {
  const original = track(100, t => 60 + 4 * t);
  const result = practiceCurve(original);
  for (let i = 0; i < original.points.length; i++) {
    assert.equal(result.points[i].t, original.points[i].t);
    assert.ok(Math.abs(hzToMidi(result.points[i].hz) - hzToMidi(original.points[i].hz)) < 1e-6);
  }
});
test('only short bounded gaps connect and remain explicitly labelled', () => {
  const original = track(100, t => 60 + t);
  for (let i = 20; i < 25; i++) original.points[i].hz = null;
  for (let i = 50; i < 68; i++) original.points[i].hz = null;
  const snapshot = JSON.stringify(original);
  const result = practiceCurve(original);
  assert.ok(result.points.slice(20, 25).every(p => p.hz && p.interpolated));
  assert.ok(result.points.slice(50, 68).every(p => p.hz === null));
  assert.equal(result.stats.connectedGaps, 1);
  assert.equal(JSON.stringify(original), snapshot, 'display processing changed the measured pitch');
});
test('silence and large register changes remain open', () => {
  const original = track(80, () => 60);
  for (let i = 10; i < 14; i++) { original.points[i].hz = null; original.points[i].rms = 0; }
  for (let i = 40; i < 44; i++) original.points[i].hz = null;
  for (let i = 44; i < 80; i++) original.points[i].hz = midiToHz(72);
  const result = practiceCurve(original);
  assert.ok(result.points.slice(10, 14).every(p => p.hz === null));
  assert.ok(result.points.slice(40, 44).every(p => p.hz === null));
});
test('raw mode and disabled connection preserve identification gaps', () => {
  const original = track(50, t => 60 + t);
  original.points[20].hz = null;
  const result = practiceCurve(original, {profile: 'raw', connect: false});
  assert.deepEqual(result.points.map(p => p.hz), original.points.map(p => p.hz));
});
test('cubic rendering never overshoots the ends of a contour segment', () => {
  const original = track(40, t => 60 + 0.5 * Math.sin(2 * Math.PI * 5 * t));
  for (const run of curveRuns(original.points)) for (let i = 1; i < run.points.length; i++) {
    const a = run.values[i - 1], b = run.values[i], dt = run.points[i].t - run.points[i - 1].t;
    const c1 = a + run.slopes[i - 1] * dt / 3, c2 = b - run.slopes[i] * dt / 3;
    for (let u = 0; u <= 1; u += 0.1) {
      const value = (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * c1 + 3 * (1 - u) * u * u * c2 + u ** 3 * b;
      assert.ok(value >= Math.min(a, b) - 1e-8 && value <= Math.max(a, b) + 1e-8);
    }
  }
});
