const MAGIC = new TextEncoder().encode('TQPRJ01\n');
const MAX_META = 30 * 1024 * 1024, MAX_FILE = 1024 * 1024 * 1024;
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const bounded = (n, min, max, fallback = 0) => finite(n, min, max) ? n : fallback;

function analysis(value, duration) {
  if (!value) return null;
  if (!Array.isArray(value.points) || value.points.length > 100000) throw new Error('音高数据无效。');
  let previous = -1;
  const points = value.points.map(p => {
    if (!finite(p.t, 0, duration + 1) || p.t < previous || p.hz !== null && !finite(p.hz, 20, 4000)) throw new Error('音高时间或频率无效。');
    previous = p.t;
    return {t: p.t, hz: p.hz, confidence: bounded(p.confidence, 0, 1), rms: bounded(p.rms, 0, 10)};
  });
  return {points, hopSeconds: bounded(value.hopSeconds, 0.001, 1, 0.02), method: String(value.method || '').slice(0, 40), sampleRate: bounded(value.sampleRate, 8000, 192000, 16000), energy: [], beats: {bpm: null, times: []}};
}
function cleanProject(p) {
  if (p?.schema !== 1 || !finite(p.duration, 0.2, 1800) || typeof p.title !== 'string') throw new Error('练习格式不支持。');
  if (!Array.isArray(p.lyrics) || p.lyrics.length > 5000 || !Array.isArray(p.takes) || p.takes.length > 40) throw new Error('练习内容过多或格式错误。');
  const lyrics = p.lyrics.map(line => {
    if (typeof line.text !== 'string' || line.text.length > 4000 || line.t !== null && !finite(line.t, 0, 7200)) throw new Error('唱词数据无效。');
    let words = Array.isArray(line.words) && line.words.length < 4000 ? line.words.filter(w => typeof w.text === 'string' && finite(w.t, 0, 7200)).map(w => ({text: w.text.slice(0, 4000), t: w.t})) : [];
    if (words.map(w => w.text).join('') !== line.text) words = [];
    return {text: line.text, t: line.t, words, ...(finite(line.end, 0, 7200) ? {end: line.end} : {})};
  });
  const takes = p.takes.map(t => {
    if (!/^[a-z0-9-]{1,80}$/i.test(t.id) || !finite(t.duration, 0.3, 600) || !finite(t.rate, 0.5, 1.25)) throw new Error('录音信息无效。');
    return {id: t.id, title: String(t.title || '我的录音').slice(0, 80), anchor: bounded(t.anchor, 0, p.duration), offset: bounded(t.offset, -30, 30), rate: t.rate, duration: t.duration, transpose: bounded(t.transpose, -6, 6), createdAt: bounded(t.createdAt, 0, 1e15), analysis: analysis(t.analysis, t.duration), ...(['accompaniment', 'original', 'vocals'].includes(t.backing) ? {backing: t.backing} : {}), ...(finite(t.voiceGain, 0, 4) ? {voiceGain: t.voiceGain} : {})};
  });
  const overrides = {};
  for (const [lineIndex, chars] of Object.entries(p.pronOverrides || {})) if (/^\d+$/.test(lineIndex) && Number(lineIndex) < lyrics.length && chars && typeof chars === 'object') {
    const row = overrides[lineIndex] = {};
    for (const [charIndex, value] of Object.entries(chars)) if (/^\d+$/.test(charIndex) && Number(charIndex) < [...lyrics[lineIndex].text].length && typeof value?.reading === 'string') row[charIndex] = {reading: value.reading.slice(0, 48), special: !!value.special};
  }
  const loopA = finite(p.loopA, 0, p.duration) ? p.loopA : null;
  const loopB = loopA !== null && finite(p.loopB, loopA + 0.15, p.duration) ? p.loopB : null;
  return {schema: 1, id: crypto.randomUUID(), title: p.title.slice(0, 180), filename: String(p.filename || '').slice(0, 220), duration: p.duration,
    updatedAt: Date.now(), hasVocals: !!p.hasVocals, demo: !!p.demo, position: bounded(p.position, 0, p.duration),
    mode: ['original', 'vocals', 'accompaniment'].includes(p.mode) ? p.mode : 'original', analysis: analysis(p.analysis, p.duration),
    analysisSource: p.analysisSource === 'vocals' ? 'vocals' : 'original', beats: p.beats && finite(p.beats.bpm, 20, 300) ? {bpm: p.beats.bpm, kind: p.beats.kind === 'manual' ? 'manual' : 'estimated', times: (p.beats.times || []).filter(t => finite(t, 0, p.duration)).slice(0, 20000)} : null,
    yRange: Array.isArray(p.yRange) && p.yRange.length === 2 && finite(p.yRange[0], 0, 120) && finite(p.yRange[1], p.yRange[0] + 1, 140) ? p.yRange : [48, 84],
    lyrics, lyricOffset: bounded(p.lyricOffset, -1800, 1800), pronOverrides: overrides, loopA, loopB, looping: loopB !== null && !!p.looping,
    selectedLine: Number.isInteger(p.selectedLine) && p.selectedLine >= 0 && p.selectedLine < lyrics.length ? p.selectedLine : -1,
    takes, activeTakeId: takes.some(t => t.id === p.activeTakeId) ? p.activeTakeId : takes.at(-1)?.id || null, ui: p.ui && typeof p.ui === 'object' ? p.ui : {}};
}
export async function exportProjectFile(project, assets) {
  const list = assets.map(a => ({kind: a.kind, size: a.blob.size, type: a.blob.type}));
  const metadata = new TextEncoder().encode(JSON.stringify({project, assets: list}));
  if (metadata.length > MAX_META) throw new Error('练习信息过大，请减少录音后导出。');
  const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, metadata.length, true);
  return new Blob([MAGIC, size, metadata, ...assets.map(a => a.blob)], {type: 'application/octet-stream'});
}
export async function importProjectFile(file) {
  if (file.size < 12 || file.size > MAX_FILE) throw new Error('练习包大小无效（最多 1 GB）。');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!MAGIC.every((b, i) => b === header[i])) throw new Error('请选择听腔导出的 .tqproj 文件。');
  const length = new DataView(header.buffer).getUint32(8, true);
  if (length > MAX_META || length + 12 > file.size) throw new Error('练习包头部损坏。');
  let manifest; try { manifest = JSON.parse(await file.slice(12, 12 + length).text()); } catch { throw new Error('练习包信息损坏。'); }
  const project = cleanProject(manifest.project);
  if (!Array.isArray(manifest.assets) || manifest.assets.length > 45) throw new Error('音源列表无效。');
  const assets = [], seen = new Set(); let position = 12 + length;
  for (const asset of manifest.assets) {
    if (!/^(original|vocals|accompaniment|take:[a-z0-9-]{1,80})$/i.test(asset.kind) || seen.has(asset.kind) || !finite(asset.size, 1, 160 * 1024 * 1024) || !Number.isInteger(asset.size) || position + asset.size > file.size) throw new Error('音源文件损坏。');
    seen.add(asset.kind); assets.push({kind: asset.kind, blob: file.slice(position, position + asset.size, String(asset.type || 'audio/wav').slice(0, 100))}); position += asset.size;
  }
  if (position !== file.size || !seen.has('original') || project.takes.some(t => !seen.has(`take:${t.id}`))) throw new Error('练习包音源不完整。');
  project.hasVocals = seen.has('vocals');
  return {project, assets};
}
