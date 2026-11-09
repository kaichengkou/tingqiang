import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLyrics, activeLyricIndex, midiToHz, hzToMidi} from '../dist/lib/analysis.mjs';
import {lyricCues, firstLyricTime} from '../dist/lib/lyric-timeline.mjs';
import {firstVocalTime} from '../dist/lib/vocal-start.mjs';
import {outputDelaySeconds, presentedMediaTime} from '../dist/lib/playback-clock.mjs';
import {browserSeparationAllowed} from '../dist/lib/limits.mjs';
import {practiceCurve} from '../dist/lib/practice-curve.mjs';

test('an empty timestamp ends the current subtitle without reviving an older line', () => {
  const lines = parseLyrics('[00:01.00]前一句\n[00:03.00]后一句\n[00:05.00]');
  assert.equal(activeLyricIndex(lines, 4), 1); assert.equal(activeLyricIndex(lines, 5), -1);
  assert.equal(lyricCues(lines, 20).at(-1).end, 5);
  const enhanced = parseLyrics('[00:01.00]<00:01.00>短句<00:04.00>\n[00:06.00]');
  assert.equal(enhanced[0].end, 4, 'A later blank marker must not extend an explicit word end.');
});
test('LRC ID tags never become lyric lines and a positive offset shows lyrics sooner', () => {
  const lines = parseLyrics('[ti:法门寺]\n[au:佚名]\n[id:a1b2]\n[tool:LRC Maker][ve:1.0]\n[#:注释]\n[offset:+500]\n[00:10.00]第一句\n[00:20.00]<00:20.00>第<00:21.00>二句');
  assert.deepEqual(lines.map(line => [line.t, line.text]), [[9.5, '第一句'], [19.5, '第二句']]);
  assert.deepEqual(lines[1].words.map(word => word.t), [19.5, 20.5]);
});
test('enhanced LRC retains text before the first word tag and its trailing end marker', () => {
  const lines = parseLyrics('[00:01.00]我<00:02.00>将<00:03.00>西行<00:05.00>');
  assert.equal(lines[0].text, '我将西行');
  assert.equal(lines[0].words.map(w => w.text).join(''), '我将西行');
  assert.equal(activeLyricIndex(lines, 5.1), -1);
  const cues = lyricCues(lines, 10, 0.25);
  assert.deepEqual(cues.map(c => [c.t, c.end, c.charOffset]), [[1.25, 2.25, 0], [2.25, 3.25, 1], [3.25, 5.25, 2]]);
  assert.equal(firstLyricTime(lines, 10, 0.25), 1.25);
});
test('first vocal onset ignores an isolated blip and includes a short lead-in', () => {
  const points = Array.from({length: 150}, (_, i) => ({t: i * 0.02, hz: null, confidence: 0, rms: 0}));
  for (let i = 10; i < 13; i++) Object.assign(points[i], {hz: 300, confidence: 0.8, rms: 0.2});
  for (let i = 60; i < 100; i++) Object.assign(points[i], {hz: 300, confidence: 0.8, rms: 0.2});
  assert.ok(Math.abs(firstVocalTime({points, hopSeconds: 0.02}) - 1.08) < 1e-8);
  assert.equal(firstVocalTime({points: points.map(p => ({...p, hz: null})), hopSeconds: 0.02}), null);
});
test('output timestamps correct render-ahead time and scale with playback rate', () => {
  const context = {state: 'running', currentTime: 10, getOutputTimestamp: () => ({contextTime: 9.92, performanceTime: 1000})};
  const delay = outputDelaySeconds(context, 1040); assert.ok(Math.abs(delay - 0.04) < 1e-8);
  assert.ok(Math.abs(presentedMediaTime({currentTime: 10, playing: true, deviceDelay: delay}) - 9.96) < 1e-8);
  assert.ok(Math.abs(presentedMediaTime({currentTime: 10, playing: true, rate: 0.5, deviceDelay: delay}) - 9.98) < 1e-8);
  assert.equal(presentedMediaTime({currentTime: 10, playing: false, deviceDelay: 0.2}), 10);
  assert.equal(presentedMediaTime({currentTime: 10, shiftMs: 100, duration: 30}), 10.1);
});
test('fallback latency estimates and limits remain finite', () => {
  assert.ok(Math.abs(outputDelaySeconds({state: 'running', baseLatency: 0.01, outputLatency: 0.08}, 100) - 0.09) < 1e-8);
  assert.equal(outputDelaySeconds({state: 'suspended'}, 100), 0);
  assert.equal(presentedMediaTime({currentTime: 0, playing: true, deviceDelay: 1}), 0);
  assert.equal(browserSeparationAllowed(600), true); assert.equal(browserSeparationAllowed(600.01), false);
});
test('symmetric learning smoothing adds no fixed vibrato phase delay', () => {
  const points = Array.from({length: 1000}, (_, i) => ({t: i * 0.02, hz: midiToHz(60 + Math.sin(2 * Math.PI * 6 * i * 0.02)), rms: 0.2, confidence: 1}));
  const result = practiceCurve({points, hopSeconds: 0.02}).points;
  let bestLag = null, bestScore = -Infinity;
  for (let lag = -5; lag <= 5; lag++) {
    let score = 0; for (let i = 15; i < 980; i++) score += (hzToMidi(points[i].hz) - 60) * (hzToMidi(result[i + lag].hz) - 60);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  assert.equal(bestLag, 0);
});
