import test from 'node:test';
import assert from 'node:assert/strict';
import {binHz, crepeBatch, decodeCrepe} from '../dist/lib/crepe.mjs';

function sequence(n, binAt, strength = 0.7) {
  const data = new Float32Array(n * 360).fill(0.00001);
  for (let frame = 0; frame < n; frame++) {
    const bin = binAt(frame);
    for (let j = -4; j <= 4; j++) if (bin + j >= 0 && bin + j < 360) data[frame * 360 + bin + j] = strength * Math.exp(-j * j / 3);
  }
  return {data, energy: Array.from({length: n}, (_, i) => ({t: i * 0.02, value: 0.2}))};
}
test('CREPE range mask does not attract the track to the frequency limits', () => {
  const {data, energy} = sequence(100, () => 200, 0.4);
  const r = decodeCrepe(data, 100, energy, {fmin: 75, fmax: 1400});
  assert.ok(r.points.every(p => p.hz && Math.abs(p.hz - binHz(200)) < 0.01));
});
test('a temporary strong overtone does not replace a continuous fundamental', () => {
  const {data, energy} = sequence(100, () => 200, 0.6);
  for (let i = 45; i < 48; i++) { data[i * 360 + 260] = 0.99; data[i * 360 + 200] = 0.3; }
  const r = decodeCrepe(data, 100, energy);
  assert.ok(r.points.slice(40, 55).every(p => p.hz && Math.abs(12 * Math.log2(p.hz / binHz(200))) < 0.5));
});
test('persistent real register changes remain in the result', () => {
  const {data, energy} = sequence(200, i => i < 100 ? 200 : 260, 0.9);
  const r = decodeCrepe(data, 200, energy);
  assert.ok(r.points[30].hz && Math.abs(r.points[30].hz - binHz(200)) < 1);
  assert.ok(r.points[170].hz && Math.abs(r.points[170].hz - binHz(260)) < 1);
});
test('silence and uncertain frames remain gaps even with a model prediction', () => {
  const {data, energy} = sequence(100, () => 200);
  for (let i = 20; i < 40; i++) energy[i].value = 0;
  for (let i = 60; i < 80; i++) data.fill(0.01, i * 360, (i + 1) * 360);
  const r = decodeCrepe(data, 100, energy);
  assert.ok(r.points.slice(20, 40).every(p => p.hz === null));
  assert.ok(r.points.slice(62, 78).every(p => p.hz === null));
});
test('frame standardisation preserves centred timestamps and unit sample deviation', () => {
  const x = Float32Array.from({length: 2000}, (_, i) => 0.1 + 0.3 * Math.sin(2 * Math.PI * 320 * i / 16000));
  const {frames, energy} = crepeBatch(x, 2, 1);
  const mean = frames.reduce((a, b) => a + b, 0) / 1024;
  const variance = frames.reduce((a, b) => a + (b - mean) ** 2, 0) / 1023;
  assert.ok(Math.abs(mean) < 1e-6); assert.ok(Math.abs(variance - 1) < 1e-6);
  assert.equal(energy[0].t, 0.04);
});
