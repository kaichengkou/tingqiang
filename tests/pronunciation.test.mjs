import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {annotateLine, toneReading} from '../dist/lib/pronunciation.mjs';
const dictionary = JSON.parse(fs.readFileSync(new URL('../dist/data/opera-pronunciation.json', import.meta.url)));

test('the provided reference data supplies upper readings and sharp initials', () => {
  const notes = annotateLine('明西学戏', dictionary);
  assert.deepEqual(notes.map(n => n.reading), ['mín', 'sī', 'xió', 'xì']);
  assert.deepEqual(notes.map(n => n.special), [true, true, true, false]);
  assert.deepEqual(notes.map(n => n.isUpper), [true, false, true, false]);
  assert.equal(notes[0].ordinary, 'míng');
});
test('multiple readings and incomplete source entries are preserved for review', () => {
  const note = annotateLine('行', dictionary)[0];
  assert.equal(note.ambiguous, true); assert.ok(note.candidates.includes('xín') && note.candidates.includes('xìn'));
  const missing = annotateLine('字', {jian: {}, shang: {'字': [{reading: '', tone: '去声'}]}})[0];
  assert.equal(missing.reading, '待校订');
});
test('occurrence overrides can keep Mandarin and do not modify the dictionary', () => {
  const notes = annotateLine('明明', dictionary, {1: {reading: 'míng', special: false}});
  assert.equal(notes[0].reading, 'mín'); assert.equal(notes[1].reading, 'míng'); assert.equal(notes[1].special, false);
  assert.equal(annotateLine('明', dictionary)[0].reading, 'mín');
});
test('text stays intact, including punctuation and non-Chinese characters', () => {
  const text = '明，abc🙂<img>';
  assert.equal(annotateLine(text, dictionary).map(n => n.char).join(''), text);
  assert.equal(toneReading('ngo', 3), 'ngǒ'); assert.equal(toneReading('xio', 2), 'xió');
});
