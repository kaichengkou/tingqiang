import test from 'node:test';
import assert from 'node:assert/strict';
import {centeredTimeView, pitchAtTime} from '../dist/lib/view.mjs';

test('current time stays exactly in the centre, including recording boundaries', () => {
  for (const span of [4, 8, 16, 32]) for (const now of [0, 0.02, 7.99, 8, 8.01, 22.86]) {
    const view = centeredTimeView(now, span);
    assert.ok(Math.abs((now - view.start) / view.span - 0.5) < 1e-12);
    assert.ok(Math.abs(view.end - view.start - span) < 1e-12);
  }
});
test('timeline moves by the playback increment instead of paging at window edges', () => {
  const a = centeredTimeView(7.99, 8), b = centeredTimeView(8.01, 8);
  assert.ok(Math.abs((b.start - a.start) - 0.02) < 1e-12);
});
test('current pitch marker interpolates in log frequency but never bridges unvoiced gaps', () => {
  const a = {hopSeconds: 0.02, points: [{t: 0, hz: 300}, {t: 0.02, hz: 310}, {t: 0.04, hz: null}, {t: 0.06, hz: 300}]};
  assert.ok(Math.abs(pitchAtTime(a, 0.01) - Math.sqrt(300 * 310)) < 1e-6);
  assert.equal(pitchAtTime(a, 0.03), null); assert.equal(pitchAtTime(a, 0.05), null);
});
