import test from 'node:test';
import assert from 'node:assert/strict';
import {separateAudioBlocks, separationThreads} from '../dist/lib/separation-blocks.mjs';

test('separation threads leave room for playback, and need cross-origin isolation', () => {
  assert.equal(separationThreads(24, true), 12);
  assert.equal(separationThreads(8, true), 6);
  assert.equal(separationThreads(2, true), 1);
  assert.equal(separationThreads(undefined, true), 1);
  assert.equal(separationThreads(24, false), 1);
});

test('long separation uses bounded context blocks and preserves timing across seams', async () => {
  const mix = [Float32Array.from({length: 10007}, (_, i) => 0.4 * Math.sin(i * 0.071)), Float32Array.from({length: 10007}, (_, i) => 0.3 * Math.cos(i * 0.043))];
  const sizes = [], progress = [];
  const result = await separateAudioBlocks(mix, async channels => { sizes.push(channels[0].length); return channels.map(c => Float32Array.from(c, v => v * 0.25)); }, {blockFrames: 256, contextFrames: 32, fadeFrames: 16, compensate: 1, progress: p => progress.push(p)});
  assert.ok(sizes.length > 30 && Math.max(...sizes) <= 256 + 64 + 16);
  assert.equal(progress.at(-1), 1); assert.ok(progress.every((p, i) => !i || p >= progress[i - 1]));
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < mix[ch].length; i++) {
    assert.ok(Math.abs(result.accompaniment[ch][i] - mix[ch][i] * 0.25) < 1e-7);
    assert.ok(Math.abs(result.vocals[ch][i] - mix[ch][i] * 0.75) < 1e-7);
  }
});
