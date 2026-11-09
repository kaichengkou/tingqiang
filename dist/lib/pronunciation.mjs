import {pinyin} from '../vendor/pinyin.mjs';
const TONES = {'阴平': 1, '阳平': 2, '上声': 3, '去声': 4};
const VOWELS = {a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ'};
export function toneReading(text, tone) {
  if (!text || !tone || /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(text)) return text;
  const lower = text.toLowerCase();
  let index = lower.indexOf('a');
  if (index < 0) index = lower.indexOf('e');
  if (index < 0) index = lower.indexOf('o');
  if (index < 0) for (let i = lower.length - 1; i >= 0; i--) if (VOWELS[lower[i]]) { index = i; break; }
  return index < 0 ? text : text.slice(0, index) + VOWELS[lower[index]][tone - 1] + text.slice(index + 1);
}

export function annotateLine(text, dictionary, overrides = {}) {
  const ordinary = pinyin(text, {type: 'all'}).flatMap(item => [...item.origin].map(origin => ({...item, origin})));
  return ordinary.map((item, index) => {
    const char = item.origin, upper = dictionary?.shang?.[char] || [], sharp = dictionary?.jian?.[char];
    const candidates = [...new Set(upper.filter(q => q.reading?.trim()).map(q => toneReading(q.reading, TONES[q.tone])))];
    const sharpOnly = !upper.length && sharp?.type === '尖';
    if (sharpOnly && sharp.reading) candidates.push(toneReading(sharp.reading, item.num));
    const special = upper.length > 0 || sharpOnly;
    const defaultReading = special ? candidates.join(' / ') || '待校订' : item.pinyin;
    const override = overrides[index];
    return {char, index, ordinary: item.pinyin, reading: override?.reading ?? defaultReading, special: override?.special ?? special, isUpper: upper.length > 0, isZh: item.isZh, ambiguous: candidates.length > 1, candidates, source: upper.length ? '上口字表' : sharpOnly ? '尖字表' : '普通话', details: upper.map(q => `${q.reading || '读法缺失'} · ${q.yun} · ${q.tone}`).join('；') || (sharp ? `${sharp.type}音 · ${sharp.yun}` : '')};
  });
}
