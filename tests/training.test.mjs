import test from 'node:test';
import assert from 'node:assert/strict';
import {sentenceRange, transposeHz, takeToReference, referenceToTake, nextPracticePhase} from '../dist/lib/training.mjs';
import {exportProjectFile, importProjectFile} from '../dist/lib/project-file.mjs';
import {formatTime} from '../dist/lib/analysis.mjs';

test('sentence selection respects offsets, explicit ends, untimed rows and recording boundaries', () => {
  const lines = [{t: 1, text: '一'}, {t: null, text: '未标记'}, {t: 3, text: '二', end: 4}, {t: 6, text: '三'}];
  assert.deepEqual(sentenceRange(lines, 0, 8, .2), {start: 1.2, end: 3.2});
  assert.deepEqual(sentenceRange(lines, 2, 8, .2), {start: 3.2, end: 4.2});
  assert.deepEqual(sentenceRange(lines, 3, 8, .2), {start: 6.2, end: 8});
  assert.equal(sentenceRange(lines, 1, 8), null);
  assert.equal(sentenceRange([{t: 9}], 0, 8), null);
  assert.equal(formatTime(1.2, true), '00:01.2'); assert.equal(formatTime(59.999, true), '00:59.9');
});
test('repeat and echo modes complete the requested rounds and keep a full sing-back interval', () => {
  const p = {mode: 'echo', round: 1, repeats: 2, gap: 1, duration: 3, rate: .5};
  assert.deepEqual(nextPracticePhase(p, 'listen'), {phase: 'sing', round: 1, seconds: 7});
  assert.deepEqual(nextPracticePhase(p, 'sing'), {phase: 'gap', round: 2, seconds: 1});
  assert.deepEqual(nextPracticePhase({...p, round: 2}, 'sing'), {phase: 'done', round: 2});
  assert.equal(nextPracticePhase({...p, mode: 'repeat', round: 2}, 'listen').phase, 'done');
  assert.equal(nextPracticePhase({...p, repeats: 0, round: 100}, 'sing').round, 101);
});
test('recording alignment converts real singing time to reference time without hiding pitch differences', () => {
  const take = {anchor: 12, rate: .5, offset: -.15};
  assert.equal(takeToReference(4, take), 13.85);
  assert.ok(Math.abs(referenceToTake(13.85, take) - 4) < 1e-8);
  assert.equal(transposeHz(440, -12), 220); assert.equal(transposeHz(null, -3), null);
});
const project = () => ({schema: 1, id: 'original-id', title: '测试练习', filename: 'test.wav', duration: 10, position: 2.3, analysis: {points: [{t: 1, hz: 440, confidence: .9, rms: .1}], hopSeconds: .02}, lyrics: [{t: 1, text: '明', words: []}], pronOverrides: {0: {0: {reading: 'mín', special: true}}}, takes: [], ui: {transpose: -3, rate: '.5'}});
test('a practice package round-trips audio and annotations with a fresh project identity', async () => {
  const audio = new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'audio/wav'});
  const file = await exportProjectFile(project(), [{kind: 'original', blob: audio}]);
  const restored = await importProjectFile(file);
  assert.notEqual(restored.project.id, 'original-id'); assert.equal(restored.project.position, 2.3);
  assert.equal(restored.project.ui.transpose, -3); assert.equal(restored.project.pronOverrides[0][0].reading, 'mín');
  assert.deepEqual(new Uint8Array(await restored.assets[0].blob.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});
test('damaged, oversized, incomplete and non-finite practice data are rejected before loading', async () => {
  await assert.rejects(importProjectFile(new Blob(['not a project'])));
  const audio = new Blob(['x']);
  const valid = await exportProjectFile(project(), [{kind: 'original', blob: audio}]);
  await assert.rejects(importProjectFile(valid.slice(0, valid.size - 1)));
  await assert.rejects(importProjectFile(await exportProjectFile(project(), [])));
  const bad = project(); bad.analysis.points[0].t = 99;
  await assert.rejects(importProjectFile(await exportProjectFile(bad, [{kind: 'original', blob: audio}])));
  const duplicate = await exportProjectFile(project(), [{kind: 'original', blob: audio}, {kind: 'original', blob: audio}]);
  await assert.rejects(importProjectFile(duplicate));
});
