import test from 'node:test';
import assert from 'node:assert/strict';
import {singAlongPlan, takeAnchor, median, measureRoundTrip, alignTake, suggestVoiceGain, LiveResampler} from '../dist/lib/sing-along.mjs';
import {takeToReference} from '../dist/lib/training.mjs';
import {crepeBatch, framePitch, binHz, MIN_RMS} from '../dist/lib/crepe.mjs';
import {encodeWav} from '../dist/lib/analysis.mjs';

test('the backing starts early enough to hear the way in', () => {
  assert.deepEqual(singAlongPlan({loopA: 20, loopB: 26, duration: 100, leadIn: 4}), {start: 16, entry: 20, end: 26, silence: 0});
  assert.deepEqual(singAlongPlan({position: 30, duration: 100, leadIn: 8}), {start: 22, entry: 30, end: 100, silence: 0});
});
test('without enough music before the entry, a silent count-in makes up the time', () => {
  assert.equal(singAlongPlan({loopA: 0, loopB: 5, duration: 100}).silence, 3);
  assert.equal(singAlongPlan({loopA: 1, loopB: 5, duration: 100}).silence, 2);
  assert.equal(singAlongPlan({loopA: 2, loopB: 5, duration: 100}).silence, 0);
});
test('a playhead parked at the very end starts over, and a take is limited to ten minutes', () => {
  assert.equal(singAlongPlan({position: 99.8, duration: 100}).entry, 0);
  assert.equal(singAlongPlan({position: 0, duration: 1800}).end, 600);
});
test('the take timeline accounts for output, input and processing delay at any speed', () => {
  // The backing plays from 16 s when the audio clock reads 100 s: media = 16 + (clock - 100) × rate.
  for (const rate of [1, 0.75]) {
    const mediaOffset = 16 - rate * 100;
    const anchor = takeAnchor({mediaOffset, rate, captureStart: 100, roundTrip: 0.08, processing: 0.12});
    assert.ok(Math.abs(anchor - (16 - rate * 0.2)) < 1e-9);
    // A voice that answers the backing at 20 s arrives after the backing got there, by the same 0.2 s of clock time.
    const take = {anchor, rate, offset: 0}, arrival = (20 - 16) / rate + 0.2;
    assert.ok(Math.abs(takeToReference(arrival, take) - 20) < 1e-9);
  }
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 3, 2]), 2.5); assert.equal(median([]), null);
});
function claps(lags, {rate = 48000, seconds = 8, noise = 0.002} = {}) {
  const samples = Float32Array.from({length: rate * seconds}, (_, i) => noise * Math.sin(i * 12.9898));
  const clicks = lags.map((_, i) => 1 + i * 0.8);
  clicks.forEach((click, i) => { if (lags[i] === null) return; const at = Math.round((click + lags[i]) * rate); for (let j = 0; j < 960; j++) samples[at + j] = 0.4 * Math.exp(-j / 150) * (j % 2 ? 1 : -1); });
  return {samples, rate, clicks};
}
test('latency calibration recovers the delay between clicks and claps', () => {
  const {samples, rate, clicks} = claps([.18, .2, .19, .21, .2, .19, .2, .21]);
  const result = measureRoundTrip(samples, rate, clicks);
  assert.ok(Math.abs(result.seconds - 0.2) < 0.012, JSON.stringify(result)); assert.equal(result.answers, 8);
});
test('calibration tolerates missed claps but refuses silence and scattered answers', () => {
  const missed = claps([.2, null, .2, .2, null, .2, .2, .2]);
  assert.ok(Math.abs(measureRoundTrip(missed.samples, missed.rate, missed.clicks).seconds - 0.2) < 0.012);
  const silent = claps(Array(8).fill(null));
  assert.equal(measureRoundTrip(silent.samples, silent.rate, silent.clicks), null);
  const wild = claps([.02, .3, .05, .45, .1, .5, .03, .4]);
  assert.equal(measureRoundTrip(wild.samples, wild.rate, wild.clicks), null);
});
const contour = (seconds, shift = 0, start = 0) => ({hopSeconds: 0.02, points: Array.from({length: seconds * 50}, (_, i) => {
  const t = start + i * 0.02;
  return {t, hz: i % 200 < 170 ? 220 * 2 ** ((5 * Math.sin(t * 1.3) + 2 * Math.sin(t * 3.1) + shift) / 12) : null, rms: 0.1, confidence: 1};
})});
test('automatic alignment finds a known timing error', () => {
  const reference = contour(40), analysis = {points: contour(8).points.map(point => ({...point, hz: reference.points[Math.round((point.t + 11.34) / 0.02)].hz}))};
  const result = alignTake(reference, {anchor: 10, rate: 1, offset: 0, transpose: 0}, analysis);
  assert.ok(Math.abs(result.offset - 1.34) < 0.03, JSON.stringify(result)); assert.ok(result.score < result.current);
});
test('alignment looks past octave and key differences', () => {
  const reference = contour(40);
  const analysis = {points: contour(8).points.map(point => { const hz = reference.points[Math.round((point.t + 5.5) / 0.02)].hz; return {...point, hz: hz && hz * 2 * 2 ** (-3 / 12)}; })};
  const result = alignTake(reference, {anchor: 5, rate: 1, offset: 0, transpose: -3}, analysis);
  assert.ok(Math.abs(result.offset - 0.5) < 0.03, JSON.stringify(result));
});
test('alignment declines when there is nothing to compare', () => {
  assert.equal(alignTake(null, {anchor: 0, rate: 1}, contour(1)), null);
  assert.equal(alignTake(contour(5), {anchor: 0, rate: 1}, {points: []}), null);
});
test('a quiet take is brought up to the reference, within limits', () => {
  const at = rms => ({points: [{hz: 300, rms}, {hz: 300, rms}, {hz: null, rms: 9}]});
  assert.equal(suggestVoiceGain(at(0.2), at(0.1)), 2); assert.equal(suggestVoiceGain(at(0.2), at(0.001)), 4);
  assert.equal(suggestVoiceGain(at(0.01), at(0.5)), 0.5); assert.equal(suggestVoiceGain(at(0.1), null), 1.5);
});
test('the live resampler keeps pitch and hands back the newest samples in order', () => {
  for (const from of [44100, 48000]) {
    const resampler = new LiveResampler(from), tone = Float32Array.from({length: from}, (_, i) => Math.sin(2 * Math.PI * 300 * i / from));
    for (let at = 0; at < tone.length; at += 2048) resampler.push(tone.subarray(at, at + 2048));
    const window = resampler.latest();
    assert.equal(window.length, 1024);
    let crossings = 0;
    for (let i = 1; i < window.length; i++) if (window[i - 1] < 0 && window[i] >= 0) crossings++;
    assert.ok(Math.abs(crossings / (1024 / 16000) - 300) < 20, `${from}: ${crossings}`);
  }
  assert.equal(new LiveResampler(48000).latest(), null);
});
test('a single frame window is read in order, and one frame gives a pitch only when clear', () => {
  const window = Float32Array.from({length: 1024}, (_, i) => 0.3 * Math.sin(i * 0.1));
  const {frames, energy} = crepeBatch(window, 0, 1, 320, -512);
  assert.ok(energy[0].value > MIN_RMS); assert.ok(Math.abs(frames[0]) < 0.02 && frames[100] !== 0);
  const activation = new Float32Array(360); for (let j = -3; j <= 3; j++) activation[150 + j] = 0.8 * Math.exp(-j * j / 2);
  assert.ok(Math.abs(framePitch(activation) - binHz(150)) < 0.5);
  assert.equal(framePitch(new Float32Array(360).fill(0.05)), null);
});
test('WAV samples clip safely and keep their order across channels', () => {
  const wav = encodeWav([Float32Array.of(0.5, -2, 2), Float32Array.of(-0.5, 0, 1)], 8000);
  assert.deepEqual([...new Int16Array(wav, 44)], [16383, -16384, -32768, 0, 32767, 32767]);
});
