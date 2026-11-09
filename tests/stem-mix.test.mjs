import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMix, deriveBrowserStems} from '../dist/lib/stem-mix.mjs';

test('both stems share one amplitude domain and reconstruct the input at low levels', () => {
  const voice = Float32Array.from({length: 1000}, (_, i) => 0.03 * Math.sin(i * 0.3));
  const music = Float32Array.from(voice, (_, i) => 0.02 * Math.sin(i * 0.17));
  const mix = [Float32Array.from(voice, (v, i) => v + music[i])];
  const normalized = normalizeMix(mix);
  const prediction = [Float32Array.from(music, x => x / normalized.peak / 1.065)];
  const result = deriveBrowserStems(mix, prediction, normalized.peak);
  assert.equal(result.gain, 1);
  for (let i = 0; i < voice.length; i++) {
    assert.ok(Math.abs(result.vocals[0][i] - voice[i]) < 1e-7);
    assert.ok(Math.abs(result.vocals[0][i] + result.accompaniment[0][i] - mix[0][i]) < 1e-7);
  }
});
test('clipping prevention scales both stems together and keeps their timing', () => {
  const mix = [new Float32Array([0.7, -0.4, 0.3])];
  const prediction = [new Float32Array([-0.8, 1.2, 0.1])];
  const result = deriveBrowserStems(mix, prediction, 1);
  assert.ok(result.gain < 1); assert.equal(result.vocals[0].length, mix[0].length);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(result.vocals[0][i]) <= 0.981);
    assert.ok(Math.abs(result.accompaniment[0][i]) <= 0.981);
    assert.ok(Math.abs(result.vocals[0][i] + result.accompaniment[0][i] - mix[0][i] * result.gain) < 1e-6);
  }
});
