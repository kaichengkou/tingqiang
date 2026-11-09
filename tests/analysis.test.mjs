import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePitch, hzToMidi, parseLyrics, activeLyricIndex, estimateBeats, synthesizeDemo, encodeWav} from '../dist/lib/analysis.mjs';

const rate = 12000;
function tone(hz, seconds = 2, harmonics = false) {
  return Float32Array.from({length: rate * seconds}, (_, i) => 0.2 * Math.sin(2 * Math.PI * hz * i / rate) + (harmonics ? 0.4 * Math.sin(4 * Math.PI * hz * i / rate) + 0.12 * Math.sin(6 * Math.PI * hz * i / rate) : 0));
}
for (const hz of [82.41, 220, 440, 880, 1250]) test(`detect ${hz} Hz within 20 cents`, () => {
  const result = analyzePitch(tone(hz), rate, {fmin: 65, fmax: 1500});
  const pitches = result.points.filter(p => p.hz).map(p => p.hz).sort((a, b) => a - b);
  assert.ok(pitches.length > result.points.length * 0.9);
  assert.ok(Math.abs(hzToMidi(pitches[pitches.length >> 1]) - hzToMidi(hz)) * 100 < 20);
});
test('strong second harmonic does not cause an octave jump', () => {
  const result = analyzePitch(tone(220, 2, true), rate);
  assert.ok(result.points.filter(p => p.hz && Math.abs(p.hz - 220) < 4).length > result.points.length * 0.9);
});
test('silence has no pitch and no beats', () => {
  const result = analyzePitch(new Float32Array(rate * 3), rate);
  assert.ok(result.points.every(p => p.hz === null)); assert.equal(result.beats.bpm, null);
});
test('continuous glide retains its motion', () => {
  let phase = 0;
  const samples = Float32Array.from({length: rate * 3}, (_, i) => { phase += 2 * Math.PI * (220 + i / (rate * 3) * 220) / rate; return 0.25 * Math.sin(phase); });
  const points = analyzePitch(samples, rate).points.filter(p => p.hz);
  assert.ok(points[0].hz < 235 && points.at(-1).hz > 425);
  assert.ok(points.filter((p, i) => i && p.hz < points[i - 1].hz - 1).length < 5);
});
test('rhythm estimator detects 100 BPM pulses and rejects flat energy', () => {
  const energy = Array.from({length: 1200}, (_, i) => ({t: i * 0.02, value: (i % 30) < 2 ? 0.7 : 0.03}));
  const result = estimateBeats(energy); assert.ok(Math.abs(result.bpm - 100) < 1); assert.ok(result.times.length > 30);
  assert.equal(estimateBeats(energy.map(p => ({...p, value: 0.1}))).bpm, null);
});
test('LRC repeated timestamps, offset, enhanced word timing and metadata', () => {
  const lines = parseLyrics('[ti:测试]\n[offset:-100]\n[00:01.20][00:12.20]同一句\n[00:03.00]<00:03.00>看<00:05.25>腔\n未标记');
  assert.equal(lines.length, 4); assert.ok(Math.abs(lines[0].t - 1.3) < 0.001, 'A negative offset shows lyrics later.');
  assert.equal(lines[1].text, '看腔'); assert.ok(Math.abs(lines[1].words[1].t - 5.35) < 0.001);
  assert.equal(lines[3].t, null); assert.equal(activeLyricIndex(lines, 0), -1);
  assert.equal(activeLyricIndex(lines, 4), 1);
});
test('WAV encoder produces a valid stereo PCM header', () => {
  const wav = encodeWav([tone(220, 1), tone(440, 1)], rate), view = new DataView(wav);
  assert.equal(view.getUint16(22, true), 2); assert.equal(view.getUint32(24, true), rate); assert.equal(wav.byteLength, 44 + rate * 4);
});
test('manual lyric timestamps can be corrected out of order', () => {
  const lines = [{t: 9}, {t: null}, {t: 2}, {t: 5}];
  assert.equal(activeLyricIndex(lines, 6), 3);
  assert.equal(activeLyricIndex(lines, 10), 0);
});
test('demo has independently generated stems and preserves silent vocal gaps', () => {
  const demo = synthesizeDemo();
  assert.equal(demo.original.length, 24 * demo.sampleRate);
  for (let i = 0; i < demo.original.length; i += 173) assert.ok(Math.abs(demo.original[i] - demo.vocals[i] - demo.accompaniment[i]) < 1e-7);
  const result = analyzePitch(demo.vocals, rate);
  assert.ok(result.points.filter(p => p.t > 7.6 && p.t < 8.2).every(p => p.hz === null));
});
