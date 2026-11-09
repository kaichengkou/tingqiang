import {clamp, hzToMidi, noteName, formatTime, parseLyrics, activeLyricIndex, manualBeats, synthesizeDemo, encodeWav, estimateBeats} from './lib/analysis.mjs?v=0.6';
import {centeredTimeView, pitchAtTime} from './lib/view.mjs';
import {practiceCurve, curveRuns} from './lib/practice-curve.mjs';
import {outputDelaySeconds, presentedMediaTime} from './lib/playback-clock.mjs';
import {firstVocalTime} from './lib/vocal-start.mjs';
import {lyricCues, firstLyricTime} from './lib/lyric-timeline.mjs';
import {annotateLine} from './lib/pronunciation.mjs?v=0.4.1';
import {browserSeparationAllowed} from './lib/limits.mjs';
import {Studio} from './lib/studio.mjs?v=0.8';
import {PitchOutput} from './lib/pitch-output.mjs';
import {PitchPool, poolSize} from './lib/pitch-pool.mjs';
import {transposeHz, takeToReference, referenceToTake} from './lib/training.mjs';
import {platform, shell} from './lib/shell.mjs';

const $ = id => document.getElementById(id);
// In either app the model ships with it and nothing reaches a server; data-desktop holds the wording for both apps,
// data-android what differs on a phone.
if (shell) {
  document.documentElement.classList.add('app', platform === 'windows' ? 'desktop' : platform);
  for (const element of document.querySelectorAll('[data-desktop], [data-android]')) {
    const text = platform === 'android' ? element.dataset.android ?? element.dataset.desktop : element.dataset.desktop;
    if (text !== undefined) element.textContent = text;
  }
}
const separationFallback = shell ? '可重试或导入已有分轨' : '可使用增强服务或导入已有分轨';
const audio = $('audio');
const takeAudio = $('take-audio');
audio.preservesPitch = true;
const state = {
  tracks: {}, file: null, title: '', duration: 0, mode: 'original', demo: false,
  analysis: null, displayAnalysis: null, curveRuns: [], waveform: [], lyrics: [], lyricOffset: 0, lyricActive: -2,
  loopA: null, loopB: null, looping: false,
  analysisRun: null, preview: null, generation: 0, loading: false, yRange: [48, 84],
  beats: null, tapTimes: [], backend: '', service: false, separation: null,
  dictionary: null, notes: [], pronOverrides: {}, lyricNodes: [], captionWords: [], cues: [], activeWord: -2,
  subtitlesVisible: true, frameTime: 0, syncShiftMs: 0, autoSync: true, outputDelay: 0,
  playbackContext: null, playbackSource: null, detectedStart: null, analysisSource: '',
};
let dirty = true, lastPaint = -1, toastTimer, stemKind, drag = null, hoverT = null, studio;
const modeNames = {original: '原声', vocals: '人声', accompaniment: '伴奏'};
// A phone's WebView renderer was ended for lack of memory with three pitch workers, while two ran fine (docs/validation-v08.md).
const pool = new PitchPool(platform === 'android' ? {size: Math.min(2, poolSize())} : {});

function toast(message, duration = 4300) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, duration);
}
function status(text) { $('analysis-status').textContent = text; }
function cancelAnalysis({quiet = false} = {}) {
  const run = state.analysisRun;
  $('analysis-progress').hidden = true;
  if (!run) return;
  Object.assign(run, {cancelled: true, quiet}); state.analysisRun = null;
  run.job?.cancel();
}
function readyButtons() {
  const ready = !!state.tracks.original && !state.loading && !state.capture && !studio?.pitchBusy;
  $('import-audio').disabled = !!state.loading || !!studio?.busy;
  for (const id of ['analyze-button', 'play-button', 'back-button', 'forward-button', 'loop-button', 'set-a', 'set-b']) $(id).disabled = !ready;
  $('analyze-button').disabled = !ready || !!state.separation;
  $('analyze-button').querySelector('span').textContent = state.analysisRun ? '取消分析' : state.analysis ? '重新分析' : '分析';
  $('separate-button').disabled = !ready || !state.service || !!state.separation;
  $('enhance-vocals').disabled = !ready || !!state.separation;
  $('browser-separate-button').disabled = !ready || !!state.separation;
  $('cancel-browser-separation').hidden = state.separation?.kind !== 'browser';
  $('cancel-browser-dialog').hidden = state.separation?.kind !== 'browser';
  document.querySelectorAll('[data-mode]').forEach(button => {
    const available = !!state.tracks[button.dataset.mode];
    button.classList.toggle('unavailable', !available);
    button.classList.toggle('selected', state.mode === button.dataset.mode);
    button.setAttribute('aria-pressed', String(state.mode === button.dataset.mode));
    button.setAttribute('aria-disabled', String(!available));
  });
  $('analysis-source').querySelector('[value="vocals"]').disabled = !state.tracks.vocals;
  updateVocalStart();
  $('stem-hint').textContent = state.demo ? '合成示范自带独立声部，可直接切换。' : state.tracks.vocals ? '人声已就绪。切换声部保持播放位置。' : '分离或导入分轨后，可切换人声与伴奏。';
  $('stem-status').textContent = `${state.tracks.vocals ? '人声已就绪' : '未导入人声'} · ${state.tracks.accompaniment ? '伴奏已就绪' : '未导入伴奏'}`;
  studio?.update();
}
function updatePlayIcon() {
  const media = state.listening === 'take' ? takeAudio : audio;
  const playing = !media.paused && !media.ended;
  $('play-button').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play-button').classList.toggle('paused', playing);
  $('play-button').setAttribute('aria-label', playing ? '暂停' : '播放');
}
function installTrack(kind, blob) {
  if (state.tracks[kind]) URL.revokeObjectURL(state.tracks[kind].url);
  state.tracks[kind] = {blob, url: URL.createObjectURL(blob)};
  studio?.changed(kind);
}
function revokeTracks() { Object.values(state.tracks).forEach(t => URL.revokeObjectURL(t.url)); state.tracks = {}; }
// Tracks keep only their file. Each step decodes at the rate it needs and lets go afterwards;
// kept at full rate, a 30-minute stereo track alone would hold about 700 MB.
async function decodeAt(blob, sampleRate) {
  if (!window.OfflineAudioContext) throw new Error('当前浏览器不支持音频解码，请使用新版 Chrome、Edge 或 Safari。');
  return new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(await blob.arrayBuffer());
}
/** Duration and overview waveform, from a low-rate decode. */
async function audioOverview(blob) {
  const buffer = await decodeAt(blob, 8000);
  return {duration: buffer.duration, waveform: waveformFor(buffer.getChannelData(0))};
}
function waveformFor(samples) {
  const bins = Math.min(1100, samples.length), step = Math.ceil(samples.length / bins), out = [];
  for (let i = 0; i < bins; i++) {
    let max = 0;
    for (let j = i * step; j < Math.min(samples.length, (i + 1) * step); j += Math.max(1, Math.floor(step / 40))) max = Math.max(max, Math.abs(samples[j]));
    out.push(max);
  }
  const peak = Math.max(...out, 0.001);
  return out.map(v => v / peak);
}
async function cancelSeparation() {
  const pending = state.separation;
  if (!pending) return;
  pending.controller.abort(); pending.worker?.terminate(); pending.reject?.(new DOMException('已取消分离', 'AbortError')); state.separation = null;
  if (pending.id) fetch(`${pending.backend}/api/jobs/${pending.id}`, {method: 'DELETE'}).catch(() => {});
  $('cancel-separation').hidden = true; readyButtons();
  $('separation-progress').hidden = true;
}
function resetRecording() {
  studio?.reset();
  cancelAnalysis(); cancelSeparation(); audio.pause(); audio.removeAttribute('src'); audio.load(); revokeTracks();
  state.analysis = null; state.preview = null; state.displayAnalysis = null; state.curveRuns = []; state.beats = null; state.lyrics = []; state.lyricOffset = 0; state.lyricActive = -2;
  state.detectedStart = null; state.analysisSource = ''; state.pronOverrides = {}; state.frameTime = 0;
  state.mode = 'original'; state.loopA = state.loopB = null; state.looping = false; state.tapTimes = [];
  state.yRange = [48, 84]; hoverT = null; $('chart-tooltip').hidden = true;
  $('curve-source').textContent = '等待分析'; $('chart-empty').hidden = false;
  $('chart-empty').querySelector('strong').textContent = '录音已就绪';
  $('chart-empty').querySelector('p').textContent = '点击分析，生成唱腔曲线';
  $('demo-button').hidden = true;
  $('lyrics-type').textContent = '尚未导入'; $('lyrics-hint').textContent = '导入 LRC 可跟随到句；逐字 LRC 可跟随到字。';
  $('analysis-source').value = 'original'; $('lyric-offset').hidden = true;
  $('browser-separation-status').textContent = shell ? '只在本机处理，不上传。' : '首次下载约 53 MB 模型；只在本机处理。建议先试短唱段。';
  $('separation-note').textContent = '';
  updateLoop(); updateBeats(); renderLyrics(); dirty = true;
}
async function loadRecording(file) {
  if (state.loading) return;
  if (!file || file.size > 150 * 1024 * 1024) return toast('请选择小于 150 MB 的音频文件。');
  const generation = ++state.generation;
  let loaded = false;
  state.loading = true; cancelAnalysis(); readyButtons(); status('正在读取录音…');
  try {
    const {duration, waveform} = await audioOverview(file);
    if (duration > 1800) throw new Error('初版请使用 30 分钟以内的唱段，便于放大练习。');
    if (duration < 0.2) throw new Error('这段音频太短，请选择至少 0.2 秒的录音。');
    if (generation !== state.generation) return;
    await studio.beforeNew();
    resetRecording();
    state.file = file; state.title = file.name.replace(/\.[^.]+$/, ''); state.duration = duration; state.demo = false;
    installTrack('original', file); state.waveform = waveform; audio.src = state.tracks.original.url;
    $('filename').textContent = state.title; $('filename').title = file.name;
    $('filemeta').textContent = `${formatTime(duration)} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    $('current-recording').hidden = false; $('duration').textContent = formatTime(duration);
    status('录音已就绪');
    studio.newProject(); loaded = true;
  } catch (error) { status('读取失败，可换一个文件重试。'); toast(`无法读取录音：${error.message}`); }
  finally { if (generation === state.generation) { state.loading = false; readyButtons(); dirty = true; } }
  // Start straight away: the recording stays playable while the curve fills in.
  if (loaded && generation === state.generation) analyze();
}
async function monoSamples(input, targetRate = 12000) {
  const buffer = input instanceof Blob ? await decodeAt(input, targetRate) : input;
  const context = new OfflineAudioContext(1, Math.ceil(buffer.duration * targetRate), targetRate);
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); source.start();
  return (await context.startRendering()).getChannelData(0);
}
function setChartMessage(title, detail) {
  $('chart-empty').querySelector('strong').textContent = title; $('chart-empty').querySelector('p').textContent = detail;
}
/** Chunk results arrive in any order; each is drawn as soon as it lands. */
function beginPreview(frameCount) {
  state.preview = {points: Array.from({length: frameCount}, (_, i) => ({t: i * 320 / 16000, hz: null, confidence: 0, rms: 0})), hopSeconds: 0.02, pitches: new Uint32Array(128)};
  updateCurve();
  setChartMessage('正在生成唱腔曲线', '可以先播放，曲线会陆续出现'); $('chart-empty').hidden = false;
}
function showChunk(first, points) {
  const preview = state.preview;
  if (!preview) return;
  points.forEach((point, i) => { preview.points[first + i] = point; if (point.hz) preview.pitches[clamp(Math.round(hzToMidi(point.hz)), 0, 127)]++; });
  const display = practiceCurve({points, hopSeconds: preview.hopSeconds}, curveOptions()).points;
  display.forEach((point, i) => { state.displayAnalysis.points[first + i] = point; });
  state.curveRuns.push(...curveRuns(display));
  const total = preview.pitches.reduce((sum, count) => sum + count, 0);
  if (total) {
    $('chart-empty').hidden = true;
    const percentile = share => { let seen = 0; for (let midi = 0; midi < 128; midi++) if ((seen += preview.pitches[midi]) >= total * share) return midi; return 127; };
    const range = pitchRange(percentile(.01), percentile(.99));
    if (Math.abs(range[0] - state.yRange[0]) >= 3 || Math.abs(range[1] - state.yRange[1]) >= 3) state.yRange = range;
  }
  dirty = true;
}
function pitchRange(low, high) {
  const middle = (low + high) / 2, span = Math.max(16, high - low + 6);
  return [Math.floor(middle - span / 2), Math.ceil(middle + span / 2)];
}
function analysisHooks(run, method) {
  const seen = {};
  return {
    paused: () => !!state.capture,
    hint: () => Math.round(state.frameTime / 0.02),
    onStart: frameCount => { beginPreview(frameCount); status('正在加载唱腔模型（首次约 13 MB，录音留在本机）…'); },
    onChunk: (first, points) => { if (!run.cancelled) showChunk(first, points); },
    onProgress: ({done, total, fraction}) => {
      if (run.cancelled) return;
      if (fraction !== undefined) {
        $('analysis-progress').value = method === 'crepe' ? 0.97 + 0.03 * fraction : fraction;
        status(method === 'crepe' ? '正在校正连续音高…' : `正在提取音高… ${Math.round(fraction * 100)}%`);
        return;
      }
      // The first results only say that the workers are up, so the estimate counts from there.
      seen.time ??= performance.now(); seen.done ??= done;
      const elapsed = (performance.now() - seen.time) / 1000, left = done > seen.done ? (total - done) * elapsed / (done - seen.done) : 0;
      $('analysis-progress').value = done / total * 0.97;
      status(`正在生成唱腔曲线… ${Math.round(done / total * 100)}%${left >= 2 ? ` · 约还需 ${left >= 60 ? `${Math.ceil(left / 60)} 分钟` : `${Math.ceil(left)} 秒`}` : ''} · 可以先播放`);
    },
  };
}
async function analyze() {
  if (state.analysisRun) { cancelAnalysis(); return; }
  const source = $('analysis-source').value, track = state.tracks[source];
  if (!track || state.loading) return;
  const fmin = Number($('fmin').value), fmax = Number($('fmax').value);
  if (!(fmin >= 50 && fmin <= 500 && fmax >= fmin + 100 && fmax <= 2000)) return toast('最低音设为 50–500 Hz，最高音至少高出 100 Hz，且不超过 2000 Hz。');
  const generation = state.generation, run = {cancelled: false, quiet: false, job: null};
  state.analysisRun = run; readyButtons();
  $('analysis-progress').hidden = false; $('analysis-progress').value = 0; status('正在准备音频…');
  try {
    const method = $('analysis-method').value, sampleRate = method === 'crepe' ? 16000 : 12000;
    const samples = await monoSamples(track.blob, sampleRate);
    if (run.cancelled) throw new DOMException('已取消分析', 'AbortError');
    run.job = pool.analyze(samples, {fmin, fmax, method, sampleRate}, analysisHooks(run, method));
    const result = await run.job.promise;
    if (generation !== state.generation || run.cancelled) return;
    state.preview = null; state.analysis = result;
    state.analysisSource = source; state.detectedStart = firstVocalTime(result);
    updateCurve();
    // Rhythm is estimated from the original mix even when pitch uses the vocal stem.
    if (source === 'vocals') {
      const original = await monoSamples(state.tracks.original.blob);
      if (generation !== state.generation) return;
      const energy = [], hop = 240;
      for (let i = 0; i + hop < original.length; i += hop) {
        let sum = 0; for (let j = 0; j < hop; j++) sum += original[i + j] ** 2;
        energy.push({t: (i + hop / 2) / 12000, value: Math.sqrt(sum / hop)});
      }
      result.beats = estimateBeats(energy);
    }
    state.beats = result.beats;
    const pitches = result.points.filter(p => p.hz).map(p => hzToMidi(p.hz)).sort((a, b) => a - b);
    if (pitches.length) state.yRange = pitchRange(pitches[Math.floor(pitches.length * 0.01)], pitches[Math.floor(pitches.length * 0.99)]);
    $('curve-source').textContent = source === 'vocals' ? '人声分析' : '原录音分析';
    $('chart-empty').hidden = pitches.length > 0;
    if (!pitches.length) setChartMessage('没有找到可靠的音高', '可尝试缩小音域，或先导入分离人声');
    status(pitches.length ? '分析完成' : '未找到可靠音高，可先减弱伴奏或调整音域。');
    updateBeats(); studio.changed(); dirty = true;
  } catch (error) {
    if (generation === state.generation) {
      state.preview = null; updateCurve();
      if (!state.analysis) { setChartMessage('录音已就绪', '点击分析，生成唱腔曲线'); $('chart-empty').hidden = false; }
      if (!run.quiet) status(error.name === 'AbortError' ? '已取消分析。' : '分析失败，可重试。');
      if (error.name !== 'AbortError') toast(error.message);
    }
  } finally {
    if (state.analysisRun === run) state.analysisRun = null;
    if (generation === state.generation) { if (!state.analysisRun) $('analysis-progress').hidden = true; readyButtons(); dirty = true; }
  }
}
async function loadStem(file, kind) {
  if (!state.file) return toast('先导入对应的原录音。');
  if (!file || file.size > 150 * 1024 * 1024) return toast('请选择小于 150 MB 的分轨文件。');
  const generation = state.generation;
  try {
    $('stem-status').textContent = '正在读取分轨…';
    const {duration} = await audioOverview(file);
    if (generation !== state.generation) return;
    if (Math.abs(duration - state.duration) > Math.max(0.5, state.duration * 0.002)) throw new Error('分轨长度与原录音不一致。请使用同起点、同长度的文件。');
    if (state.mode === kind) await switchMode('original');
    installTrack(kind, file); readyButtons();
    if (kind === 'vocals') { $('analysis-source').value = 'vocals'; status('人声已导入，点击重新分析更新曲线。'); }
    toast(`${modeNames[kind]}已导入`);
  } catch (error) { $('stem-status').textContent = error.message; toast(error.message); }
}
async function switchMode(mode) {
  if (studio?.busy) return;
  if (state.listening === 'take') await studio.listen('reference');
  if (!state.tracks[mode]) { toast('先点「减弱伴奏」，或导入分轨。'); $('settings-dialog').showModal(); return; }
  if (state.mode === mode) return;
  const time = audio.currentTime || 0, playing = !audio.paused;
  studio?.stopPractice();
  audio.pause(); state.mode = mode;
  audio.src = state.tracks[mode].url; audio.playbackRate = Number($('rate').value); audio.preservesPitch = true;
  try { audio.currentTime = Math.min(time, state.duration - 0.01); if (playing) await startPlayback(); }
  catch (error) { toast(`声部切换后请再次点击播放：${error.message}`); }
  readyButtons(); studio?.changed(); dirty = true;
}
function seek(time) {
  if (!state.tracks.original) return;
  audio.currentTime = clamp(time, 0, state.duration);
  studio?.seekMedia(time);
  state.frameTime = clockTime();
  if (state.looping && state.loopA !== null && state.loopB !== null && (time < state.loopA || time > state.loopB)) { state.looping = false; updateLoop(); }
  dirty = true;
}
async function togglePlay() {
  if (!state.tracks.original || state.loading || state.capture || studio.pitchBusy) return;
  if (state.practice) { studio.stopPractice('已暂停练习'); return; }
  const media = state.listening === 'take' ? takeAudio : audio;
  if (!media.paused) media.pause();
  else {
    if (state.listening !== 'take' && state.looping && state.loopA !== null && state.loopB !== null && (audio.currentTime < state.loopA || audio.currentTime >= state.loopB)) audio.currentTime = state.loopA;
    if (state.listening === 'take' && takeAudio.ended) takeAudio.currentTime = 0;
    try { await startPlayback(); } catch (error) { toast(`播放失败：${error.message}`); }
  }
}

function ensureAudioGraph() {
  if (!state.playbackContext) try {
    const context = new (window.AudioContext || window.webkitAudioContext)({latencyHint: 'interactive'});
    const source = context.createMediaElementSource(audio);
    state.playbackContext = context; state.playbackSource = source; state.pitchOutput = new PitchOutput(context, source);
    state.takeSource = context.createMediaElementSource(takeAudio); state.takeGain = context.createGain();
    state.takeSource.connect(state.takeGain); state.takeGain.connect(context.destination);
  } catch { /* Native playback remains available on older browsers. */ }
}
async function startPlayback() {
  ensureAudioGraph();
  const resume = state.playbackContext?.resume();
  if (state.listening !== 'take' && state.pitchOutput && state.pitchOutput.semitones !== state.transpose) {
    await resume; await state.pitchOutput.setSemitones(state.transpose || 0);
  }
  const media = state.listening === 'take' ? takeAudio : audio;
  const play = media.play();
  await Promise.all([resume, play]);
}

function visualTime() { return state.frameTime; }
function clockTime() {
  const media = studio?.mediaTime() || {currentTime: audio.currentTime || 0, rate: audio.playbackRate || 1, playing: !audio.paused};
  const measured = state.autoSync && media.playing ? outputDelaySeconds(state.playbackContext, performance.now()) : 0;
  state.outputDelay = state.outputDelay * 0.85 + measured * 0.15;
  const processingDelay = state.listening !== 'take' ? state.pitchOutput?.latency || 0 : 0;
  return presentedMediaTime({...media, deviceDelay: (state.autoSync ? state.outputDelay : 0) + processingDelay, shiftMs: state.syncShiftMs, duration: state.duration});
}

function vocalStart() {
  const t = firstLyricTime(state.lyrics, state.duration, state.lyricOffset);
  if (t !== null) return {t, label: '唱词首句'};
  return state.detectedStart === null ? null : {t: state.detectedStart, label: state.analysisSource === 'vocals' ? '人声起唱估计' : '原声起唱估计'};
}
function updateVocalStart() {
  const start = vocalStart();
  $('jump-vocal').disabled = !state.tracks.original || start === null || state.loading;
  $('vocal-start-info').textContent = start ? `${start.label} ${formatTime(start.t, true)}` : '分析人声或导入带时间戳的唱词后可用';
}
async function playFromFirstLine() {
  const start = vocalStart(); if (!start) return;
  studio.stopPractice(); studio.stopTakePlayback();
  state.looping = false; updateLoop(); seek(start.t);
  try { await startPlayback(); } catch (error) { toast(error.message); }
}
function updateLoop() {
  $('a-time').textContent = state.loopA === null ? '—' : formatTime(state.loopA, true);
  $('b-time').textContent = state.loopB === null ? '—' : formatTime(state.loopB, true);
  $('clear-loop').hidden = state.loopA === null && state.loopB === null;
  $('loop-button').classList.toggle('active', state.looping);
  $('loop-button').setAttribute('aria-pressed', String(state.looping));
  document.querySelector('.loop-dot').classList.toggle('active', state.looping);
  $('loop-label').textContent = state.looping ? '正在循环' : '选段循环'; dirty = true;
  studio?.update(); studio?.changed();
}
function setPoint(kind) {
  if (!state.tracks.original) return;
  studio.stopPractice(); state.selectedLine = -1;
  const now = visualTime();
  if (kind === 'a') { state.loopA = now; if (state.loopB !== null && state.loopB <= now + 0.15) { state.loopB = null; state.looping = false; } }
  else {
    if (state.loopA === null) state.loopA = 0;
    if (now <= state.loopA + 0.15) return toast('B 点需要在 A 点后至少 0.15 秒。');
    state.loopB = now; state.looping = true;
  }
  updateLoop();
}
function toggleLoop() {
  studio.stopPractice();
  if (state.loopA === null || state.loopB === null) return toast('先拖动曲线选择一段，或分别设置 A、B 点。');
  state.looping = !state.looping; if (state.looping) audio.currentTime = state.loopA; updateLoop();
}
function view() {
  return drag?.view || centeredTimeView(visualTime(), Number($('zoom').value));
}
function canvasSize(canvas) {
  const rect = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2.5);
  if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) { canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  return {ctx, width: rect.width, height: rect.height};
}
function chartMetrics() {
  const rect = $('pitch-chart').getBoundingClientRect();
  return {left: rect.width < 480 ? 44 : 55, right: 20, top: 14, bottom: 27, width: rect.width, height: rect.height};
}
function curveOptions() {
  const raw = $('curve-profile').value === 'raw';
  return {profile: $('curve-profile').value, connect: !raw && $('connect-gaps').checked};
}
function updateCurve() {
  const options = curveOptions(), raw = options.profile === 'raw';
  $('connect-gaps').disabled = raw;
  state.displayAnalysis = practiceCurve(state.preview || state.analysis, options);
  state.curveRuns = state.displayAnalysis ? curveRuns(state.displayAnalysis.points) : [];
  $('curve-connection-note').hidden = raw || !$('connect-gaps').checked;
  dirty = true;
}
function drawChart() {
  const {ctx, width, height} = canvasSize($('pitch-chart'));
  if (!width || !height) return;
  const m = chartMetrics(), v = view(), shift = state.transpose || 0, overlay = studio?.overlay;
  let [low, high] = state.yRange.map(value => value + shift);
  if (overlay?.range) { low = Math.min(low, Math.floor(overlay.range[0])); high = Math.max(high, Math.ceil(overlay.range[1])); }
  const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
  const x = t => m.left + (t - v.start) / v.span * plotW;
  const y = midi => m.top + (high - midi) / (high - low) * plotH;
  ctx.font = '9px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
  const yStep = high - low > 30 ? 4 : 2;
  for (let midi = Math.ceil(low / yStep) * yStep; midi <= high; midi += yStep) {
    const yy = y(midi); ctx.strokeStyle = '#edeee5'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(m.left, yy); ctx.lineTo(width - m.right, yy); ctx.stroke();
    ctx.fillStyle = '#a5ad96'; ctx.textAlign = 'right'; ctx.fillText(noteName(midi), m.left - 12, yy);
  }
  const desired = v.span / Math.max(3, Math.floor(plotW / 85));
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(t => t >= desired) || 600;
  for (let t = Math.ceil(Math.max(0, v.start) / step) * step; t <= Math.min(v.end, state.duration || v.end) + 0.001; t += step) {
    const xx = x(t); ctx.strokeStyle = '#eff0e8'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xx, m.top); ctx.lineTo(xx, height - m.bottom); ctx.stroke();
    ctx.fillStyle = '#aab19d'; ctx.textAlign = 'center'; ctx.fillText(formatTime(t), xx, height - 10);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(m.left, m.top, plotW, plotH); ctx.clip();
  if ($('show-beats').checked && state.beats?.times) {
    ctx.strokeStyle = '#bcc5ab88'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]); ctx.beginPath();
    for (const t of state.beats.times) if (t >= v.start && t <= v.end) { ctx.moveTo(x(t), m.top); ctx.lineTo(x(t), height - m.bottom); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (state.loopA !== null && state.loopB !== null) { ctx.fillStyle = '#a341320b'; ctx.fillRect(x(state.loopA), m.top, x(state.loopB) - x(state.loopA), plotH); }
  if (state.displayAnalysis) {
    ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const run of state.curveRuns) {
      if (run.points.at(-1).t < v.start - 0.1 || run.points[0].t > v.end + 0.1) continue;
      let started = false, previousStyle = '';
      ctx.beginPath();
      for (let i = 1; i < run.points.length; i++) {
        const a = run.points[i - 1], b = run.points[i];
        if (b.t < v.start - 0.1) continue;
        if (a.t > v.end + 0.1) break;
        const style = a.interpolated || b.interpolated ? '#a3413270' : '#a34132';
        if (!started || style !== previousStyle) {
          if (started) ctx.stroke();
          ctx.beginPath(); ctx.strokeStyle = style; ctx.moveTo(x(a.t), y(run.values[i - 1] + shift));
          started = true; previousStyle = style;
        }
        const dt = b.t - a.t;
        ctx.bezierCurveTo(x(a.t + dt / 3), y(run.values[i - 1] + shift + run.slopes[i - 1] * dt / 3), x(b.t - dt / 3), y(run.values[i] + shift - run.slopes[i] * dt / 3), x(b.t), y(run.values[i] + shift));
      }
      if (started) ctx.stroke();
    }
  }
  if (overlay) {
    const tx = t => x(takeToReference(t, overlay.take));
    ctx.lineWidth = 1.8; ctx.strokeStyle = '#397e96';
    for (const run of overlay.runs) {
      if (takeToReference(run.points.at(-1).t, overlay.take) < v.start || takeToReference(run.points[0].t, overlay.take) > v.end) continue;
      ctx.beginPath(); ctx.moveTo(tx(run.points[0].t), y(run.values[0]));
      for (let i = 1; i < run.points.length; i++) {
        const a = run.points[i - 1], b = run.points[i], dt = b.t - a.t;
        ctx.bezierCurveTo(tx(a.t + dt / 3), y(run.values[i - 1] + run.slopes[i - 1] * dt / 3), tx(b.t - dt / 3), y(run.values[i] - run.slopes[i] * dt / 3), tx(b.t), y(run.values[i]));
      }
      ctx.stroke();
    }
  }
  const live = studio?.liveCurve;
  if (live) {
    // Only the newest points can still be on screen: the playhead sits in the middle of the view.
    ctx.lineWidth = 2; ctx.strokeStyle = '#397e96'; ctx.beginPath();
    let previous = null;
    for (let i = Math.max(0, live.points.length - Math.ceil(v.span * 30)); i < live.points.length; i++) {
      const point = live.points[i], t = live.anchor + point.t * live.rate;
      if (!point.hz) { previous = null; continue; }
      const midi = hzToMidi(point.hz);
      if (previous && t - previous.t < 0.25 && Math.abs(midi - previous.midi) < 4) ctx.lineTo(x(t), y(midi)); else ctx.moveTo(x(t), y(midi));
      previous = {t, midi};
    }
    ctx.stroke();
  }
  for (const [value, label] of [[state.loopA, 'A'], [state.loopB, 'B']]) if (value !== null && value >= v.start && value <= v.end) {
    ctx.strokeStyle = '#c99f88'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x(value), m.top); ctx.lineTo(x(value), height - m.bottom); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ac7660'; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(label, x(value) + 5, m.top + 10);
  }
  const time = visualTime();
  if (state.tracks.original && time >= v.start && time <= v.end) {
    ctx.strokeStyle = '#485a46'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x(time), m.top); ctx.lineTo(x(time), height - m.bottom); ctx.stroke();
    ctx.fillStyle = '#485a46'; ctx.beginPath(); ctx.moveTo(x(time) - 3, m.top); ctx.lineTo(x(time) + 3, m.top); ctx.lineTo(x(time), m.top + 5); ctx.fill();
    const hz = state.listening === 'take' && studio.take ? pitchAtTime(studio.take.analysis, referenceToTake(time, studio.take)) : transposeHz(pitchAtTime(state.displayAnalysis, time), shift);
    const currentIndex = state.displayAnalysis ? Math.floor((time - state.displayAnalysis.points[0].t) / state.displayAnalysis.hopSeconds) : -1;
    const reference = state.displayAnalysis?.points[currentIndex]?.interpolated || state.displayAnalysis?.points[currentIndex + 1]?.interpolated;
    if (hz) {
      const yy = y(hzToMidi(hz));
      ctx.fillStyle = '#fffefa'; ctx.beginPath(); ctx.arc(x(time), yy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = state.listening === 'take' ? '#397e96' : reference ? '#c19482' : '#a34132'; ctx.beginPath(); ctx.arc(x(time), yy, 3.3, 0, Math.PI * 2); ctx.fill();
    }
    $('current-pitch').textContent = hz ? `${reference ? '参考 ' : ''}${noteName(hzToMidi(hz))} · ${hz.toFixed(0)} Hz` : '当前音高 —';
  }
  if (hoverT !== null) { ctx.setLineDash([2, 3]); ctx.strokeStyle = '#929c7f80'; ctx.beginPath(); ctx.moveTo(x(hoverT), m.top); ctx.lineTo(x(hoverT), height - m.bottom); ctx.stroke(); ctx.setLineDash([]); }
  ctx.restore();
}
function drawOverview() {
  const {ctx, width, height} = canvasSize($('overview'));
  const center = height / 2;
  if (!state.waveform.length) { ctx.strokeStyle = '#ebede2'; ctx.beginPath(); ctx.moveTo(0, center); ctx.lineTo(width, center); ctx.stroke(); return; }
  ctx.strokeStyle = '#b7bfa387'; ctx.lineWidth = 1;
  for (let i = 0; i < state.waveform.length; i++) {
    const x = i / state.waveform.length * width, a = state.waveform[i] * (height * 0.34);
    ctx.beginPath(); ctx.moveTo(x, center - a); ctx.lineTo(x, center + a); ctx.stroke();
  }
  const tx = t => t / state.duration * width;
  if (state.loopA !== null && state.loopB !== null) { ctx.fillStyle = '#ad5b4520'; ctx.fillRect(tx(state.loopA), 0, tx(state.loopB) - tx(state.loopA), height); }
  const v = view();
  if (v.span < state.duration) { const from = tx(Math.max(0, v.start)), to = tx(Math.min(state.duration, v.end)); ctx.fillStyle = '#778d6020'; ctx.fillRect(from, 2, to - from, height - 4); ctx.strokeStyle = '#a8b497'; ctx.strokeRect(from, 2, to - from, height - 4); }
  ctx.strokeStyle = '#ac6650'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(tx(visualTime()), 4); ctx.lineTo(tx(visualTime()), height - 4); ctx.stroke();
}
function timeAt(event) {
  const rect = $('pitch-chart').getBoundingClientRect(), m = chartMetrics(), v = view();
  return clamp(v.start + (event.clientX - rect.left - m.left) / (rect.width - m.left - m.right) * v.span, 0, state.duration || 24);
}
function hover(event) {
  if (!state.displayAnalysis) return;
  hoverT = timeAt(event); dirty = true;
  const index = Math.round((hoverT - (state.displayAnalysis.points[0]?.t || 0)) / state.displayAnalysis.hopSeconds);
  const p = state.displayAnalysis.points[clamp(index, 0, state.displayAnalysis.points.length - 1)];
  const hz = transposeHz(p?.hz, state.transpose || 0);
  const label = hz ? `${p.interpolated ? '参考连接 · ' : ''}${noteName(hzToMidi(hz))} · ${hz.toFixed(1)} Hz` : '无可靠音高';
  const box = $('chart-tooltip'), rect = $('pitch-chart').getBoundingClientRect();
  box.textContent = `${formatTime(hoverT, true)}  ${label}`; box.hidden = false;
  box.style.left = `${clamp(event.clientX - rect.left + 12, 8, rect.width - 170)}px`;
  box.style.top = `${clamp(event.clientY - rect.top - 35, 5, rect.height - 35)}px`;
  $('hover-note').textContent = label;
}
function renderLyrics() {
  const list = $('lyrics-list'); list.replaceChildren(); state.lyricActive = -2; state.activeWord = -2;
  state.lyricNodes = []; state.cues = lyricCues(state.lyrics, state.duration, state.lyricOffset);
  state.notes = state.lyrics.map((line, i) => annotateLine(line.text, state.dictionary, state.pronOverrides[i] || {}));
  updateVocalStart();
  if (!state.lyrics.length) {
    const empty = document.createElement('div'); empty.className = 'lyrics-empty';
    const title = document.createElement('span'); title.textContent = '字随声走，腔随字转。';
    const hint = document.createElement('p'); hint.textContent = '支持 .lrc / .txt；纯文本可边听边为每句标记时间。';
    empty.append(title, hint); list.append(empty); renderSubtitle(-1); applySubtitleVisibility(); return;
  }
  state.lyrics.forEach((line, index) => {
    const row = document.createElement('div'); row.className = 'lyric-row'; row.dataset.index = index;
    const time = document.createElement('span'); time.className = 'lyric-time'; time.textContent = line.t === null ? '待标记' : formatTime(line.t + state.lyricOffset, true);
    const text = document.createElement('button'); text.className = 'lyric-text';
    const content = lyricContent(index); text.append(content.element);
    text.title = line.t === null ? '点击右侧时钟为这句标记时间' : '点击跳转到这句';
    text.classList.toggle('untimed-text', line.t === null);
    text.onclick = () => { if (line.t !== null) studio.selectLine(index); else toast('播放到这句开始时，点击右侧时钟标记时间。'); };
    const stamp = document.createElement('button'); stamp.className = 'icon-button stamp-button'; stamp.title = '将这句标记在当前播放位置'; stamp.setAttribute('aria-label', `为“${line.text}”标记当前时间`);
    stamp.innerHTML = '<svg><use href="#i-clock"/></svg>';
    stamp.onclick = () => {
      if (!state.tracks.original) return toast('请先导入对应录音。');
      line.t = Math.max(0, visualTime() - state.lyricOffset); line.words = []; delete line.end; renderLyrics(); $('lyrics-type').textContent = '手动校准'; toast(`已标记到 ${formatTime(visualTime(), true)}`);
    };
    const edit = document.createElement('button'); edit.className = 'text-button edit-reading'; edit.textContent = '校音'; edit.title = '按本唱段校订字音'; edit.onclick = () => openPronunciation(index);
    row.append(time, text, edit, stamp); list.append(row); state.lyricNodes.push({row, words: content.words});
  });
  $('lyric-offset').hidden = false; applySubtitleVisibility(); updateLyrics(true); studio?.update(); studio?.changed();
}

function lyricContent(index) {
  const line = state.lyrics[index], notes = state.notes[index];
  const element = document.createElement('span'); element.className = 'annotated-phrase';
  const groups = line.words?.length ? line.words : [{text: line.text}], words = [];
  let position = 0;
  for (const word of groups) {
    const span = document.createElement('span'); span.className = 'lyric-word';
    for (const char of word.text) {
      const note = notes[position++];
      if (!note?.isZh || !note.isUpper || !note.special) { span.append(document.createTextNode(char)); continue; }
      const ruby = document.createElement('ruby'); ruby.className = 'lyric-ruby special-reading';
      ruby.title = `${char}：${note.reading}；普通话 ${note.ordinary}；${note.source}${note.details ? ' · ' + note.details : ''}${note.ambiguous ? '；多读法，请按唱段校音' : ''}`;
      ruby.append(document.createTextNode(char));
      const rt = document.createElement('rt'); rt.textContent = note.reading; ruby.append(rt); span.append(ruby);
    }
    words.push(span); element.append(span);
  }
  return {element, words};
}

function renderSubtitle(index) {
  const body = $('current-subtitle'); body.replaceChildren(); state.captionWords = [];
  if (index >= 0) {
    const content = lyricContent(index); body.append(content.element); state.captionWords = content.words;
    $('subtitle-mode').textContent = `${state.lyrics[index].words?.length ? '字／词同步' : '逐句同步'} · ${formatTime(state.lyrics[index].t + state.lyricOffset, true)}`;
  } else {
    const hint = document.createElement('span'); hint.className = 'subtitle-placeholder';
    hint.textContent = !state.lyrics.length ? '导入唱词，同步显示' : !state.cues.length ? '在唱词旁点时钟，为每句标记时间' : '间奏 / 等待唱词';
    body.append(hint); $('subtitle-mode').textContent = state.lyrics.length ? '按文件时间同步' : '尚未导入';
  }
}

function applySubtitleVisibility() {
  $('subtitle-body').hidden = !state.subtitlesVisible; $('lyrics-list').hidden = !state.subtitlesVisible;
  $('toggle-subtitles').textContent = state.subtitlesVisible ? '隐藏字幕' : '显示字幕';
  $('toggle-subtitles').setAttribute('aria-pressed', String(state.subtitlesVisible));
}

function updateLyrics(force = false) {
  const time = visualTime() - state.lyricOffset, index = activeLyricIndex(state.lyrics, time), previous = state.lyricActive;
  if (index !== state.lyricActive || force) {
    state.lyricNodes[previous]?.row.classList.remove('active');
    state.lyricNodes[previous]?.words.forEach(span => span.classList.remove('word-active'));
    state.lyricActive = index;
    state.lyricNodes[index]?.row.classList.add('active'); renderSubtitle(index); state.activeWord = -2;
    if (index >= 0 && !audio.paused && state.subtitlesVisible) {
      const row = state.lyricNodes[index]?.row, list = $('lyrics-list');
      if (row) { const rr = row.getBoundingClientRect(), lr = list.getBoundingClientRect(); if (rr.top < lr.top || rr.bottom > lr.bottom) list.scrollTop += rr.top - lr.top - list.clientHeight / 2 + row.clientHeight / 2; }
    }
  }
  const line = state.lyrics[index]; let word = -1;
  if (line?.words?.length) for (let w = 0; w < line.words.length; w++) if (time >= line.words[w].t && (w === line.words.length - 1 || time < line.words[w + 1].t)) word = w;
  if (word !== state.activeWord) {
    state.activeWord = word;
    state.lyricNodes[index]?.words.forEach((span, i) => span.classList.toggle('word-active', i === word));
    state.captionWords.forEach((span, i) => span.classList.toggle('word-active', i === word));
  }
}

function openPronunciation(index) {
  state.pronEditIndex = index; const container = $('pronunciation-fields'); container.replaceChildren();
  $('pronunciation-line').textContent = state.lyrics[index].text;
  state.notes[index].forEach(note => {
    if (!note.isZh) return;
    const row = document.createElement('div'); row.className = 'pron-row';
    const label = document.createElement('label'); label.textContent = `${note.char} · 普通话 ${note.ordinary}`;
    const input = document.createElement('input'); input.value = note.reading; input.maxLength = 48; input.dataset.index = note.index; input.dataset.initial = note.reading; input.setAttribute('aria-label', `${note.char}的本段读法`);
    const normal = document.createElement('button'); normal.className = 'text-button'; normal.textContent = '按普通话'; normal.onclick = () => { input.value = note.ordinary; input.dataset.normal = 'true'; };
    input.oninput = () => { input.dataset.normal = 'false'; };
    const hint = document.createElement('small'); hint.textContent = `${note.source}${note.candidates.length ? ' · 候选 ' + note.candidates.join(' / ') : ''}${note.details ? ' · ' + note.details : ''}`;
    row.append(label, input, normal, hint); container.append(row);
  });
  $('pronunciation-dialog').showModal();
}

function savePronunciation() {
  const index = state.pronEditIndex; state.pronOverrides[index] ||= {};
  for (const input of $('pronunciation-fields').querySelectorAll('input')) {
    const note = state.notes[index][Number(input.dataset.index)], value = input.value.trim() || note.ordinary;
    if (value !== input.dataset.initial || input.dataset.normal === 'true') state.pronOverrides[index][note.index] = {reading: value, special: input.dataset.normal === 'true' ? false : value !== note.ordinary || note.special};
  }
  $('pronunciation-dialog').close(); renderLyrics(); toast('本段字音已更新。');
}

async function loadDictionary() {
  try {
    const response = await fetch(new URL('./data/opera-pronunciation.json', import.meta.url)); if (!response.ok) throw new Error();
    const dictionary = await response.json(); if (!dictionary.jian || !dictionary.shang) throw new Error();
    state.dictionary = dictionary; $('dictionary-status').textContent = '上口字标红、注音'; renderLyrics();
  } catch { $('dictionary-status').textContent = '字表加载失败，暂不显示上口字提示；可刷新重试。'; }
}
async function importLyrics(file) {
  if (!file || file.size > 2 * 1024 * 1024) return toast('唱词文件请小于 2 MB。');
  try {
    const bytes = await file.arrayBuffer(); let text;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { text = new TextDecoder('gb18030').decode(bytes); }
    const lines = parseLyrics(text);
    if (!lines.length) throw new Error('没有找到可用唱词。');
    state.lyrics = lines; state.lyricOffset = 0; state.pronOverrides = {}; renderLyrics();
    const timed = lines.filter(line => line.t !== null).length, words = lines.some(line => line.words.length);
    $('lyrics-type').textContent = words ? '逐字 LRC' : timed ? '逐句 LRC' : '纯文本';
    $('lyrics-hint').textContent = timed ? '按文件时间同步；点击唱词定位，时钟按钮可重新标记。' : '播放到每句开始时，点击右侧时钟标记。未标记的句子不猜时间。';
    if (lines.some(line => line.t > state.duration) && state.duration) toast('部分唱词时间超出了录音长度，请检查是否为同一版本。');
    else toast(`已导入 ${lines.length} 句唱词`);
  } catch (error) { toast(`唱词导入失败：${error.message}`); }
}
function updateBeats() {
  const beats = state.beats;
  $('bpm-label').textContent = beats?.bpm ? `${beats.kind === 'manual' ? '手动' : '估计'} ${Math.round(beats.bpm)} BPM` : state.analysis ? '未找到稳定节拍' : '节拍尚未分析';
  dirty = true; studio?.changed();
}
function tapBeat() {
  if (audio.paused || !state.tracks.original) return toast('播放录音后，跟着听到的拍子连续点四次。');
  const now = audio.currentTime;
  if (state.tapTimes.length && (now - state.tapTimes.at(-1) > 3 || now <= state.tapTimes.at(-1))) state.tapTimes = [];
  state.tapTimes.push(now); if (state.tapTimes.length > 8) state.tapTimes.shift();
  if (state.tapTimes.length < 4) { $('tap-beat').textContent = `再点 ${4 - state.tapTimes.length} 次`; return; }
  const gaps = state.tapTimes.slice(1).map((t, i) => t - state.tapTimes[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)], bpm = 60 / median;
  if (bpm < 20 || bpm > 300) return toast('点拍间隔太短或太长，请重新点四次。');
  state.beats = manualBeats(bpm, state.tapTimes[0], state.duration); updateBeats(); $('tap-beat').textContent = '继续点拍';
}
async function loadDemo() {
  if (state.loading || studio.busy) return;
  await studio.beforeNew();
  ++state.generation; resetRecording(); state.demo = true;
  const demo = synthesizeDemo(); state.duration = demo.duration; state.title = '合成转腔练习';
  for (const kind of ['original', 'vocals', 'accompaniment']) installTrack(kind, new Blob([encodeWav([demo[kind]], demo.sampleRate)], {type: 'audio/wav'}));
  state.file = new File([state.tracks.original.blob], '合成转腔练习.wav', {type: 'audio/wav'});
  state.waveform = waveformFor(demo.original); audio.src = state.tracks.original.url;
  $('filename').textContent = '合成转腔练习'; $('filename').title = '程序合成的滑音练习，不是京剧录音'; $('filemeta').textContent = '00:24 · 合成音，非京剧唱段';
  $('current-recording').hidden = false; $('duration').textContent = '00:24';
  state.lyrics = [
    {t: 0, text: '平稳起音，听音高怎样向上走', words: []},
    {t: 4.5, text: '到达高处，再缓缓下滑', words: []},
    {t: 8.3, text: '第二次上行，留意细小的颤动', words: []},
    {t: 16.1, text: '选一个转折，循环慢听', words: []},
  ];
  $('lyrics-type').textContent = '示范提示'; $('lyrics-hint').textContent = '这些是练习提示，不是京剧唱词。'; renderLyrics();
  studio.newProject(); readyButtons(); $('analysis-source').value = 'vocals'; status('正在分析合成示范的人声…'); dirty = true; await analyze();
}

async function connectService(silent = false) {
  let base = $('service-url').value.trim().replace(/\/$/, '');
  if (base) {
    let url; try { url = new URL(base); } catch { if (!silent) toast('请填写完整服务地址，例如 https://example.com。'); return; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { if (!silent) toast('请填写不含账号密码、参数的 HTTP(S) 服务地址。'); return; }
    base = url.href.replace(/\/$/, '');
  }
  if (!silent) $('service-status').textContent = '正在连接…';
  state.service = false; readyButtons();
  try {
    const response = await fetch(`${base}/api/health`, {signal: AbortSignal.timeout(7000)});
    if (!response.ok) throw new Error(`服务返回 ${response.status}`);
    const result = await response.json();
    if (result.app !== 'tingqiang') throw new Error('这不是听腔增强服务');
    state.backend = base; state.service = !!result.demucs_available;
    $('service-tag').textContent = state.service ? '已连接' : '需要安装分离模型';
    $('service-status').textContent = state.service ? '已连接。点击分离时才会发送录音；首次使用可能需要下载模型。' : '服务可达，但未安装 Demucs。请按源码 README 安装分离依赖。';
    try { localStorage.setItem('tingqiang-backend', base); } catch {}
    readyButtons(); if (!silent) toast(state.service ? '增强服务已连接' : '基础服务已连接，分离功能待安装');
  } catch (error) {
    $('service-tag').textContent = '未连接';
    if (!silent) { $('service-status').textContent = `连接失败：${error.message}。可继续直接分析，或手动导入分轨。`; toast('连接失败，请检查服务地址和跨域设置。'); }
  }
}
async function separate() {
  if (!state.service || !state.file || state.separation) return;
  if (state.demo) return toast('合成示范已带有独立的人声与伴奏。');
  const generation = state.generation, pending = {controller: new AbortController(), backend: state.backend, id: null};
  cancelAnalysis({quiet: true});
  state.separation = pending; readyButtons(); $('cancel-separation').hidden = false;
  const message = text => { if (state.separation === pending) { $('service-status').textContent = text; status(text); } };
  try {
    message('正在发送录音到增强服务…');
    const form = new FormData(); form.append('file', state.file, state.file.name);
    const response = await fetch(`${pending.backend}/api/jobs`, {method: 'POST', body: form, signal: pending.controller.signal});
    if (!response.ok) { const info = await response.json().catch(() => ({})); throw new Error(info.detail || `服务返回 ${response.status}`); }
    const {id} = await response.json(); if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('服务任务编号无效'); pending.id = id;
    const started = Date.now();
    while (true) {
      if (pending.controller.signal.aborted || generation !== state.generation) throw new DOMException('已取消', 'AbortError');
      const res = await fetch(`${pending.backend}/api/jobs/${id}`, {signal: pending.controller.signal});
      if (!res.ok) throw new Error('无法读取分离进度，请重新连接服务。');
      const job = await res.json();
      if (job.status === 'failed') throw new Error(job.message || '分离失败');
      if (job.status === 'cancelled') throw new DOMException('已取消', 'AbortError');
      message(job.message || '正在分离人声与伴奏…');
      if (job.status === 'done') break;
      if (Date.now() - started > 30 * 60 * 1000) throw new Error('分离等待超时，可缩短唱段后重试。');
      await new Promise((resolve, reject) => {
        const done = () => { pending.controller.signal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(done, 1400);
        const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
        pending.controller.signal.addEventListener('abort', abort, {once: true});
      });
    }
    message('分离完成，正在读取人声与伴奏…');
    const tracks = await Promise.all(['vocals', 'accompaniment'].map(async kind => {
      const response = await fetch(`${pending.backend}/api/jobs/${pending.id}/${kind}.wav`, {signal: pending.controller.signal});
      if (!response.ok) throw new Error('分轨下载失败');
      const blob = await response.blob(), {duration} = await audioOverview(blob);
      if (Math.abs(duration - state.duration) > Math.max(0.5, state.duration * 0.002)) throw new Error('分离结果长度不匹配，未替换现有音源。');
      return {kind, blob};
    }));
    if (generation !== state.generation) return;
    if (state.mode !== 'original') await switchMode('original');
    if (generation !== state.generation || state.separation !== pending) return;
    for (const track of tracks) installTrack(track.kind, track.blob);
    $('analysis-source').value = 'vocals'; message('分离完成，开始分析人声曲线。');
    $('settings-dialog').close(); toast('人声与伴奏已就绪'); state.separation = null; readyButtons(); await analyze();
  } catch (error) {
    if (generation === state.generation) { message(error.name === 'AbortError' ? '分离已取消。' : `分离失败：${error.message}`); if (error.name !== 'AbortError') toast(error.message, 7000); }
    if (pending.id) fetch(`${pending.backend}/api/jobs/${pending.id}`, {method: 'DELETE'}).catch(() => {});
  } finally {
    if (state.separation === pending) state.separation = null;
    $('cancel-separation').hidden = true; readyButtons();
  }
}

async function stereoSamples(blob, targetRate = 44100) {
  let buffer = await decodeAt(blob, targetRate);
  if (buffer.numberOfChannels > 2) {
    // Surround files take the standard down-mix; mono and stereo copy straight across.
    const context = new OfflineAudioContext(2, buffer.length, targetRate);
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); source.start();
    buffer = await context.startRendering();
  }
  return [0, 1].map(channel => buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)).slice());
}

/** How the separation worker runs here. Both apps ship the model and try the graphics card first (web browsers would
 * need the model download and offer WebGPU too unevenly to rely on). The trial limit is what the CPU manages per pass:
 * 12 threads on the Windows client, a single thread on a phone, whose WebView offers no threads (docs/validation-v08.md). */
function separationOptions() {
  if (platform === 'windows') return {bundled: true, gpu: true, gpuPassLimitMs: 3000, blockFrames: 8 * 1024 * 1024};
  // A phone's app runs the model on its cores; without its library (a 32-bit phone) the graphics card is worth a try.
  if (platform === 'android') return shell.model.available() ? {bundled: true, native: true} : {bundled: true, gpu: true, gpuPassLimitMs: 12000};
  return {};
}

/** Carries the separation worker's model passes to the Android app and back (lib/native-ort.mjs). */
function relayModel(port) {
  port.onmessage = async ({data}) => {
    try {
      const reply = data.op === 'run' ? await shell.model.run(data.data, data.dims) : data.op === 'load' ? await shell.model.load() : await shell.model.release();
      port.postMessage({id: data.id, ...reply}, reply.bytes ? [reply.bytes] : []);
    } catch (error) { port.postMessage({id: data.id, error: error.message || '原生推理失败'}); }
  };
}

/** Graphics cards that lost to the CPU on this machine, so they are not tried again. */
function slowGpus() { try { return JSON.parse(localStorage.getItem('tingqiang-slow-gpus')) || []; } catch { return []; } }

async function separateInBrowser() {
  if (!state.file || state.loading || state.separation) return;
  if (state.demo) return toast('合成示范已带有独立人声与伴奏，可直接切换。');
  if (!browserSeparationAllowed(state.duration)) { if (!$('settings-dialog').open) $('settings-dialog').showModal(); return toast(shell ? '减弱伴奏支持 10 分钟以内的片段，请先剪短录音。' : '浏览器分离支持 10 分钟以内的片段；更长唱段可使用增强服务。', 6500); }
  const generation = state.generation;
  const pending = {kind: 'browser', controller: new AbortController(), worker: null, reject: null};
  cancelAnalysis({quiet: true});
  // The pitch workers idle for two minutes after analysing; their memory is better spent on the separation model.
  pool.dispose();
  state.separation = pending; readyButtons(); $('separation-progress').hidden = false;
  const report = (value, message) => {
    if (state.separation !== pending || generation !== state.generation) return;
    $('separation-progress').value = value; $('separation-note').textContent = message;
    $('browser-separation-status').textContent = message; status(message);
  };
  try {
    report(0, '正在准备分离音源…');
    const channels = await stereoSamples(state.tracks.original.blob);
    if (state.separation !== pending || generation !== state.generation) throw new DOMException('已取消', 'AbortError');
    let result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./separation-worker.mjs?v=0.8', import.meta.url), {type: 'module'});
      const options = separationOptions(), model = options.native ? new MessageChannel() : null;
      if (model) relayModel(model.port1);
      pending.worker = worker; pending.reject = reject;
      const finish = () => { worker.terminate(); model?.port1.close(); pending.worker = null; pending.reject = null; };
      worker.onmessage = ({data}) => {
        if (data.type === 'progress') report(data.value, data.message);
        else if (data.type === 'slow-gpu') { try { localStorage.setItem('tingqiang-slow-gpus', JSON.stringify([...slowGpus(), data.adapter])); } catch {} }
        else if (data.type === 'done') { finish(); resolve(data); }
        else if (data.type === 'error') { finish(); reject(new Error(data.message)); }
      };
      worker.onerror = event => { finish(); reject(new Error(event.message || `无法完成分离，${separationFallback}。`)); };
      worker.postMessage({channels, options, slowGpus: slowGpus(), modelPort: model?.port2}, [...channels.map(channel => channel.buffer), ...(model ? [model.port2] : [])]);
    });
    if (generation !== state.generation || state.separation !== pending) return;
    const tracks = ['vocals', 'accompaniment'].map(kind => ({kind, blob: new Blob([encodeWav(result[kind], result.sampleRate)], {type: 'audio/wav'})}));
    result = null;
    // Commit both stems together; cancellation/failure leaves existing tracks usable.
    if (state.mode !== 'original') await switchMode('original');
    if (generation !== state.generation || state.separation !== pending) return;
    for (const track of tracks) installTrack(track.kind, track.blob);
    $('analysis-source').value = 'vocals';
    state.separation = null; $('separation-progress').hidden = true; readyButtons();
    $('browser-separation-status').textContent = '分离完成。人声与伴奏已就绪，可切换原声对照。';
    $('separation-note').textContent = '已减弱伴奏';
    $('settings-dialog').close(); await switchMode('vocals');
    toast('人声已就绪，正在更新唱腔曲线。'); await analyze();
  } catch (error) {
    if (generation === state.generation && (!state.separation || state.separation === pending)) {
      const message = error.name === 'AbortError' ? '分离已取消，原录音仍可使用。' : `分离未完成：${error.message}`;
      $('browser-separation-status').textContent = message; $('separation-note').textContent = error.name === 'AbortError' ? '分离已取消 · 原录音仍可使用' : `分离未完成 · ${separationFallback}`;
      status(message); if (error.name !== 'AbortError') toast(message, 7500);
    }
  } finally {
    pending.worker?.terminate();
    // A cancelled worker cannot release the model it had the Android app load.
    shell?.model?.release().catch(() => {});
    if (state.separation === pending) state.separation = null;
    if (!state.separation) $('separation-progress').hidden = true;
    readyButtons();
  }
}

studio = new Studio({state, audio, $, pool, analyze, decodeAt, audioOverview, installTrack, resetRecording, monoSamples,
  updateCurve, updateBeats, updateLoop, updatePlayIcon, renderLyrics, readyButtons, seek, startPlayback,
  switchMode, ensureAudioGraph, firstVocalTime, toast, status, invalidate: () => { dirty = true; }});

// Interface events.
$('import-audio').onclick = () => $('audio-input').click();
$('audio-input').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) loadRecording(file); };
for (const name of ['dragenter', 'dragover']) $('import-audio').addEventListener(name, event => { event.preventDefault(); $('import-audio').classList.add('dragging'); });
$('import-audio').addEventListener('dragleave', () => $('import-audio').classList.remove('dragging'));
function openFile(file) {
  if (studio.busy || state.separation) return toast('录音或处理中，结束后再打开文件。');
  if (/\.tqproj$/i.test(file.name)) studio.importProject(file);
  else if (/\.(?:lrc|txt)$/i.test(file.name)) importLyrics(file);
  else loadRecording(file);
}
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => { event.preventDefault(); $('import-audio').classList.remove('dragging'); if (event.dataTransfer.files[0]) openFile(event.dataTransfer.files[0]); });
$('analyze-button').onclick = analyze; $('play-button').onclick = togglePlay;
$('jump-vocal').onclick = playFromFirstLine;
$('toggle-subtitles').onclick = () => { state.subtitlesVisible = !state.subtitlesVisible; applySubtitleVisibility(); try { localStorage.setItem('tingqiang-subtitles', String(state.subtitlesVisible)); } catch {} };
$('save-pronunciation').onclick = savePronunciation;
$('reset-pronunciation').onclick = () => { delete state.pronOverrides[state.pronEditIndex]; $('pronunciation-dialog').close(); renderLyrics(); };
$('sync-button').onclick = () => { $('sync-shift').value = state.syncShiftMs; $('auto-sync').checked = state.autoSync; $('sync-dialog').showModal(); };
function saveSyncPreferences() {
  const value = Number($('sync-shift').value); if (!Number.isFinite(value)) return;
  state.syncShiftMs = clamp(value, -1000, 1000); state.autoSync = $('auto-sync').checked;
  try { localStorage.setItem('tingqiang-sync', JSON.stringify({shiftMs: state.syncShiftMs, auto: state.autoSync})); } catch {}
  dirty = true;
}
$('sync-shift').oninput = saveSyncPreferences; $('auto-sync').onchange = saveSyncPreferences;
$('sync-later').onclick = () => { $('sync-shift').value = clamp(Number($('sync-shift').value) - 20, -1000, 1000); saveSyncPreferences(); };
$('sync-earlier').onclick = () => { $('sync-shift').value = clamp(Number($('sync-shift').value) + 20, -1000, 1000); saveSyncPreferences(); };
$('sync-reset').onclick = () => { $('sync-shift').value = 0; $('auto-sync').checked = true; state.outputDelay = 0; saveSyncPreferences(); };
$('back-button').onclick = () => { studio.stopPractice(); seek(visualTime() - 3); studio.changed(); };
$('forward-button').onclick = () => { studio.stopPractice(); seek(visualTime() + 3); studio.changed(); };
$('rate').onchange = () => { studio.stopPractice(); audio.playbackRate = Number($('rate').value); audio.preservesPitch = true; if (studio.take) { takeAudio.playbackRate = Number($('rate').value) / studio.take.rate; takeAudio.preservesPitch = true; } studio.changed(); };
$('loop-button').onclick = toggleLoop; $('set-a').onclick = () => setPoint('a'); $('set-b').onclick = () => setPoint('b');
$('clear-loop').onclick = () => { studio.stopPractice(); state.selectedLine = -1; state.loopA = state.loopB = null; state.looping = false; updateLoop(); };
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => switchMode(button.dataset.mode));
$('zoom').onchange = () => { dirty = true; };
$('show-beats').onchange = () => dirty = true;
$('curve-profile').onchange = updateCurve;
$('connect-gaps').onchange = updateCurve;
$('overview').onpointerdown = event => { if (state.capture) return; studio.stopPractice(); const rect = $('overview').getBoundingClientRect(); seek((event.clientX - rect.left) / rect.width * state.duration); studio.changed(); };
$('pitch-chart').onpointerdown = event => { if (!state.tracks.original || state.capture) return; studio.stopPractice(); state.selectedLine = -1; const frozenView = view(); drag = {start: timeAt(event), x: event.clientX, moved: false, a: state.loopA, b: state.loopB, looping: state.looping, view: frozenView}; $('pitch-chart').setPointerCapture(event.pointerId); };
$('pitch-chart').onpointermove = event => {
  if (drag && (Math.abs(event.clientX - drag.x) > 5 || drag.moved)) { drag.moved = true; const end = timeAt(event); state.loopA = Math.min(drag.start, end); state.loopB = Math.max(drag.start, end); updateLoop(); }
  hover(event);
};
$('pitch-chart').onpointerup = event => {
  if (!drag) return;
  if (drag.moved && state.loopB - state.loopA >= 0.15) { state.looping = true; seek(state.loopA); updateLoop(); }
  else { state.loopA = drag.a; state.loopB = drag.b; state.looping = drag.looping; seek(timeAt(event)); updateLoop(); }
  drag = null;
};
$('pitch-chart').onpointercancel = () => { if (drag) { state.loopA = drag.a; state.loopB = drag.b; state.looping = drag.looping; drag = null; updateLoop(); } };
$('pitch-chart').onpointerleave = () => { hoverT = null; $('chart-tooltip').hidden = true; $('hover-note').textContent = '拖动选段 · 点击定位'; dirty = true; };
$('demo-button').onclick = loadDemo;
$('import-lyrics').onclick = () => $('lyrics-input').click();
$('lyrics-input').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) importLyrics(file); };
for (const id of ['settings-button', 'source-button']) $(id).onclick = () => $('settings-dialog').showModal();
$('help-button').onclick = () => $('help-dialog').showModal();
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
$('import-vocals').onclick = () => { stemKind = 'vocals'; $('stem-input').click(); };
$('import-accompaniment').onclick = () => { stemKind = 'accompaniment'; $('stem-input').click(); };
$('stem-input').onchange = event => { const file = event.target.files[0], kind = stemKind; event.target.value = ''; if (file) loadStem(file, kind); };
$('connect-service').onclick = () => connectService(); $('separate-button').onclick = separate;
$('enhance-vocals').onclick = separateInBrowser;
$('browser-separate-button').onclick = separateInBrowser;
$('cancel-browser-separation').onclick = cancelSeparation;
$('cancel-browser-dialog').onclick = cancelSeparation;
$('cancel-separation').onclick = () => { cancelSeparation(); $('service-status').textContent = '已取消分离。'; status('已取消分离。'); };
$('tap-beat').onclick = tapBeat;
$('edit-bpm').onclick = () => { if (!state.duration) return toast('请先导入录音。'); $('settings-dialog').close(); $('bpm-input').value = Math.round(state.beats?.bpm || 100); $('beat-offset').value = audio.currentTime.toFixed(2); $('bpm-dialog').showModal(); };
$('save-bpm').onclick = () => {
  const bpm = Number($('bpm-input').value), offset = Number($('beat-offset').value);
  if (bpm < 20 || bpm > 300 || !Number.isFinite(bpm) || offset < 0 || offset >= state.duration) return toast('速度需为 20–300 BPM，起点需在录音范围内。');
  state.beats = manualBeats(bpm, offset, state.duration); updateBeats(); $('show-beats').checked = true; $('bpm-dialog').close();
};
$('lyric-offset').onclick = () => { $('offset-input').value = state.lyricOffset; $('offset-dialog').showModal(); };
$('save-offset').onclick = () => {
  const value = Number($('offset-input').value); if (!Number.isFinite(value) || Math.abs(value) > 1800) return toast('请输入有效的偏移秒数。');
  state.lyricOffset = value; renderLyrics(); $('offset-dialog').close();
};
$('fmin').onchange = $('fmax').onchange = () => document.querySelector('.pitch-settings summary span').textContent = `${$('fmin').value}–${$('fmax').value} Hz`;
audio.addEventListener('play', updatePlayIcon); audio.addEventListener('pause', updatePlayIcon);
audio.addEventListener('ended', () => { if (state.practice?.phase === 'listen') studio.tick(); else if (!state.practice && !state.capture && state.looping && state.loopA !== null) { audio.currentTime = state.loopA; startPlayback().catch(() => {}); } updatePlayIcon(); dirty = true; });
audio.addEventListener('error', () => { if (audio.getAttribute('src')) toast('录音无法播放，请换一种音频格式重试。'); });
audio.addEventListener('loadedmetadata', () => { audio.playbackRate = Number($('rate').value); audio.preservesPitch = true; dirty = true; });
audio.addEventListener('timeupdate', () => {
  if (!state.practice && !state.capture && state.listening !== 'take' && state.looping && state.loopA !== null && state.loopB !== null && audio.currentTime >= state.loopB) audio.currentTime = state.loopA;
  dirty = true;
});
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || /INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName) || event.target.isContentEditable || document.querySelector('dialog[open]')) return;
  event.preventDefault(); togglePlay();
});
new ResizeObserver(() => { dirty = true; }).observe($('chart-wrap'));
let lastLogic = 0;
/** Loop points, practice phases and automatic stops. */
function runLogic() {
  lastLogic = performance.now();
  studio.tick();
  const rawTime = audio.currentTime || 0;
  if (!state.practice && !state.capture && state.listening !== 'take' && state.looping && !audio.paused && state.loopA !== null && state.loopB !== null && rawTime >= state.loopB) audio.currentTime = state.loopA;
}
// Frames all but stop while the window is minimized or the tab is hidden; practice should carry on regardless.
setInterval(() => { if (performance.now() - lastLogic > 100) runLogic(); }, 50);
function animate() {
  runLogic();
  const now = clockTime(); state.frameTime = now;
  if (now !== lastPaint) dirty = true;
  if ($('sync-dialog').open) $('sync-measured').textContent = state.playbackContext ? `当前可测输出延迟约 ${Math.round(state.outputDelay * 1000)} ms；曲线与字幕共用同一播放时钟。` : '点击播放后测量音频输出延迟。';
  if (dirty) { drawChart(); drawOverview(); $('current-time').textContent = formatTime(now); updateLyrics(); lastPaint = now; dirty = false; }
  requestAnimationFrame(animate);
}
try {
  const preferences = JSON.parse(localStorage.getItem('tingqiang-sync') || '{}');
  state.syncShiftMs = clamp(Number(preferences.shiftMs) || 0, -1000, 1000); state.autoSync = preferences.auto !== false;
  state.subtitlesVisible = localStorage.getItem('tingqiang-subtitles') !== 'false';
} catch {}
readyButtons(); applySubtitleVisibility(); renderSubtitle(-1); animate(); loadDictionary();
const restored = studio.init();
if (shell) shell.onOpenFile(async ({name, url}) => {
  try { const file = new File([await (await fetch(url)).blob()], name); await restored; openFile(file); }
  catch (error) { toast(`无法打开 ${name}：${error.message}`); }
});
else {
  try { $('service-url').value = localStorage.getItem('tingqiang-backend') || ''; } catch {}
  connectService(true);
}
if (platform === 'android') {
  // Back closes the open dialog, then ends a recording or practice; only after that does the app go behind others.
  shell.onBack(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].pop();
    if (dialog) { dialog.close(); return true; }
    if (state.capture) { studio.endRecording(); return true; }
    if (state.practice) { studio.stopPractice('已暂停练习'); return true; }
    return false;
  });
  // Android silences the microphone of an app that leaves the screen, so a take would go on recording nothing.
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.capture) studio.endRecording(); });
  // While something should carry on behind the lock screen, the phone keeps the app awake and its notification says what.
  let reported = '';
  setInterval(() => {
    const processing = state.separation ? $('separation-note').textContent.replace(/（[^）]*）/g, '') || '正在减弱伴奏' : state.analysisRun ? '正在分析唱腔' : '';
    const playing = state.capture ? '正在录音' : state.practice ? `逐句练习 · ${state.title}` : !audio.paused || !takeAudio.paused ? `正在播放 · ${state.title}` : '';
    const kind = processing ? 'processing' : playing ? 'playing' : '', text = processing || playing;
    if (`${kind}|${text}` !== reported) { reported = `${kind}|${text}`; shell.setBusy(kind, text); }
  }, 1000);
  const {android, webview} = shell.info();
  if (android) document.querySelector('.version').textContent += ` · 安卓 ${android} · WebView ${String(webview).split('.')[0]}`;
}
window.addEventListener('beforeunload', event => { if (state.capture || state.separation) event.preventDefault(); });
// Release browser-only recordings when leaving; no audio is persisted by the frontend.
window.addEventListener('pagehide', event => { cancelAnalysis(); cancelSeparation(); if (!event.persisted) { pool.dispose(); studio.dispose(); revokeTracks(); state.playbackContext?.close().catch(() => {}); } });
