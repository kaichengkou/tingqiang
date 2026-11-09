import * as store from './project-store.mjs?v=0.7';
import {formatTime, clamp, hzToMidi, encodeWav} from './analysis.mjs?v=0.6';
import {practiceCurve, curveRuns} from './practice-curve.mjs';
import {sentenceRange, nextPracticePhase, takeToReference, referenceToTake} from './training.mjs';
import {exportProjectFile, importProjectFile} from './project-file.mjs';
import {outputDelaySeconds} from './playback-clock.mjs';
import {openMicCapture, beep} from './mic-capture.mjs';
import {singAlongPlan, takeAnchor, median, measureRoundTrip, alignTake, suggestVoiceGain, LiveResampler, TAKE_LIMIT_SECONDS} from './sing-along.mjs';
import SignalsmithStretch from '../vendor/signalsmith-stretch.mjs';
import {platform, shell} from './shell.mjs';

const BACKING_NAMES = {accompaniment: '伴奏', original: '原声', vocals: '人声'};

export class Studio {
  constructor(api) {
    this.api = api; this.s = api.state; this.$ = api.$; this.audio = api.audio; this.takeAudio = this.$('take-audio');
    Object.assign(this.s, {projectId: null, transpose: 0, takes: [], activeTakeId: null, listening: 'reference', selectedLine: -1, practice: null, capture: null});
    this.backingChoice = 'accompaniment';
    this.assetDirty = new Map(); this.removed = new Set(); this.savedAnalyses = new Map(); this.revision = 0; this.savedRevision = 0; this.restoring = false; this.takeBlob = null;
  }
  get take() { return this.s.takes.find(t => t.id === this.s.activeTakeId); }
  get overlay() {
    const take = this.take; if (!take?.analysis || !this.$('take-show').checked || this.s.capture) return null;
    if (this.overlaySource !== take.analysis) {
      const display = practiceCurve(take.analysis);
      const pitches = display.points.filter(p => p.hz).map(p => hzToMidi(p.hz)).sort((a, b) => a - b);
      this.overlaySource = take.analysis; this.overlayCache = {display, runs: curveRuns(display.points), range: pitches.length ? [pitches[Math.floor(pitches.length * .01)] - 2, pitches[Math.floor(pitches.length * .99)] + 2] : null};
    }
    return {...this.overlayCache, take};
  }
  /** The pitch heard so far while singing along, for the chart. */
  get liveCurve() {
    const capture = this.s.capture;
    return capture?.kind === 'along' && capture.liveAnchor !== undefined ? {points: capture.live, anchor: capture.liveAnchor, rate: capture.rate} : null;
  }
  get busy() { return !!this.s.capture || !!this.takeJob || !!this.pitchBusy; }
  changed(kind) {
    if (this.restoring) return;
    if (kind && this.s.tracks[kind]) this.assetDirty.set(kind, this.s.tracks[kind].blob);
    if (!this.s.projectId) return;
    this.revision++; this.$('project-save-status').textContent = '待保存';
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 650);
  }
  snapshot() {
    const value = id => this.$(id).value;
    return {schema: 1, id: this.s.projectId, title: this.s.title, filename: this.s.file?.name, duration: this.s.duration, waveform: this.s.waveform,
      updatedAt: Date.now(), hasVocals: !!this.s.tracks.vocals, demo: this.s.demo,
      position: this.mediaTime().currentTime, mode: this.s.mode, analysis: this.s.analysis, analysisSource: this.s.analysisSource,
      beats: this.s.beats, yRange: this.s.yRange, lyrics: this.s.lyrics, lyricOffset: this.s.lyricOffset, pronOverrides: this.s.pronOverrides,
      loopA: this.s.loopA, loopB: this.s.loopB, looping: this.s.looping, selectedLine: this.s.selectedLine,
      takes: this.s.takes, activeTakeId: this.s.activeTakeId,
      ui: {rate: value('rate'), zoom: value('zoom'), curve: value('curve-profile'), connect: this.$('connect-gaps').checked,
        beats: this.$('show-beats').checked, transpose: this.s.transpose, method: value('analysis-method'), fmin: value('fmin'), fmax: value('fmax'),
        practiceMode: value('practice-mode'), repeats: value('practice-repeats'), gap: value('practice-gap')}};
  }
  async save() {
    clearTimeout(this.saveTimer);
    if (this.restoring || !this.s.projectId || !this.s.tracks.original) return false;
    if (this.saving) { try { await this.saving; } catch { return false; } if (this.revision !== this.savedRevision) return this.save(); return true; }
    const revision = this.revision, snapshot = this.snapshot(), assets = [...this.assetDirty].map(([kind, blob]) => ({kind, blob})), removed = [...this.removed];
    // Analyses are replaced, never edited in place, so identity tells which ones still need writing.
    const analyses = store.projectAnalyses(snapshot).filter(({kind, analysis}) => this.savedAnalyses.get(kind) !== analysis);
    this.$('project-save-status').textContent = '保存中';
    this.saving = store.saveProject(snapshot, {assets, analyses, removed});
    try {
      await this.saving;
      for (const asset of assets) if (this.assetDirty.get(asset.kind) === asset.blob) this.assetDirty.delete(asset.kind);
      for (const kind of removed) { this.removed.delete(kind); this.savedAnalyses.delete(kind); }
      for (const {kind, analysis} of analyses) this.savedAnalyses.set(kind, analysis);
      this.savedRevision = revision;
      this.$('project-save-status').textContent = '已保存本机'; this.$('project-save-status').dataset.error = 'false';
      try { localStorage.setItem('tingqiang-last-project', snapshot.id); } catch {}
      return true;
    } catch (error) {
      this.$('project-save-status').textContent = '未保存'; this.$('project-save-status').dataset.error = 'true';
      this.api.toast(error.name === 'QuotaExceededError' ? '本机空间不足，请导出练习备份，或删除旧练习。' : `保存失败：${error.message}`, 6500);
      return false;
    } finally { this.saving = null; }
  }
  async beforeNew() {
    await this.save(); this.stopPractice(); this.stopTakePlayback(); this.cancelCapture(); this.cancelTakeAnalysis();
  }
  reset() {
    clearTimeout(this.saveTimer); this.stopPractice(); this.stopTakePlayback(); this.cancelCapture(); this.cancelTakeAnalysis();
    if (this.takeUrl) URL.revokeObjectURL(this.takeUrl);
    this.takeAudio.removeAttribute('src'); this.takeAudio.load(); this.takeBlob = null;
    this.assetDirty.clear(); this.removed.clear(); this.savedAnalyses.clear(); this.revision = this.savedRevision = 0;
    Object.assign(this.s, {projectId: null, transpose: 0, takes: [], activeTakeId: null, listening: 'reference', selectedLine: -1, practice: null, capture: null});
    this.$('transpose').value = '0'; this.$('take-details').hidden = true; this.$('take-legend').hidden = true;
    this.$('take-status').textContent = '点一句唱词，再点「跟着伴奏唱」。'; this.$('project-save-status').textContent = '本机练习';
    this.s.pitchOutput?.setSemitones(0).catch(() => {});
  }
  newProject() { this.s.projectId = crypto.randomUUID(); this.savedAnalyses.clear(); this.changed(); this.update(); }
  async openLibrary() {
    this.$('library-dialog').showModal(); await this.save(); await this.refreshLibrary();
  }
  async refreshLibrary() {
    const body = this.$('project-list'); body.replaceChildren();
    try {
      const projects = await store.listProjects();
      if (!projects.length) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '还没有练习。导入录音后会自动保存。'; body.append(hint); }
      for (const project of projects) {
        const row = document.createElement('div'); row.className = 'project-card';
        const open = document.createElement('button'), title = document.createElement('strong'), detail = document.createElement('small');
        title.textContent = project.title; detail.textContent = `${formatTime(project.duration)} · ${project.hasVocals ? '含分离人声 · ' : ''}${project.takes || 0} 遍录音`;
        open.append(title, detail); open.onclick = () => this.load(project.id);
        const remove = document.createElement('button'); remove.className = 'text-button'; remove.textContent = '删除';
        remove.onclick = async () => {
          if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = '确认删除'; return; }
          if (this.s.projectId === project.id) {
            await this.beforeNew(); this.restoring = true; this.api.resetRecording();
            Object.assign(this.s, {file: null, title: '', duration: 0, waveform: []});
            this.$('filename').textContent = '导入唱段，开始练习'; this.$('filemeta').textContent = ''; this.$('duration').textContent = '00:00';
            this.$('chart-empty').querySelector('strong').textContent = '导入一段京剧录音'; this.$('chart-empty').querySelector('p').textContent = '或先试试合成示范'; this.$('demo-button').hidden = false;
            try { localStorage.removeItem('tingqiang-last-project'); } catch {}
            this.restoring = false; this.api.readyButtons();
          }
          try { await store.deleteProject(project.id); await this.refreshLibrary(); } catch (error) { this.api.toast(error.message); }
        };
        row.append(open, remove); body.append(row);
      }
      const quota = await navigator.storage?.estimate?.();
      this.$('storage-usage').textContent = quota ? `本机占用约 ${(quota.usage / 1048576).toFixed(0)} MB` : '';
    } catch (error) { body.textContent = `读取失败：${error.message}`; }
  }
  async load(id) {
    if (this.s.loading || this.busy) return this.api.toast('请先停止当前处理。');
    await this.beforeNew(); this.restoring = true; this.s.loading = true; this.api.readyButtons();
    let opened = false;
    try {
      const project = await store.readProject(id); if (!project) throw new Error('练习已不存在。');
      const kinds = ['original', 'vocals', 'accompaniment'];
      const tracks = await Promise.all(kinds.map(async kind => { const blob = await store.readAsset(id, kind); return blob ? {kind, blob} : null; }));
      if (!tracks[0]) throw new Error('原录音缺失，请重新导入。');
      // Saved projects carry their overview; older or imported ones decode the original once, at a low rate.
      const overview = Array.isArray(project.waveform) && project.waveform.length ? {duration: project.duration, waveform: project.waveform} : await this.api.audioOverview(tracks[0].blob);
      ++this.s.generation; this.api.resetRecording();
      Object.assign(this.s, {projectId: id, file: new File([tracks[0].blob], project.filename || `${project.title}.wav`, {type: tracks[0].blob.type}),
        title: project.title, duration: overview.duration, demo: !!project.demo, analysis: project.analysis || null,
        analysisSource: project.analysisSource || 'original', beats: project.beats, yRange: project.yRange || [48, 84],
        lyrics: project.lyrics || [], lyricOffset: project.lyricOffset || 0, pronOverrides: project.pronOverrides || {},
        loopA: project.loopA ?? null, loopB: project.loopB ?? null, looping: !!project.looping, selectedLine: project.selectedLine ?? -1,
        takes: project.takes || [], activeTakeId: project.activeTakeId || null, transpose: clamp(Number(project.ui?.transpose) || 0, -6, 6)});
      this.savedAnalyses = new Map(store.projectAnalyses(this.s).map(({kind, analysis}) => [kind, analysis]));
      for (const track of tracks) if (track) this.api.installTrack(track.kind, track.blob);
      const ui = project.ui || {}, set = (key, value) => { if (value !== undefined && [...this.$(key).options].some(o => o.value === String(value))) this.$(key).value = value; };
      set('rate', ui.rate); set('zoom', ui.zoom); set('curve-profile', ui.curve); set('analysis-method', ui.method);
      set('practice-mode', ui.practiceMode); set('practice-repeats', ui.repeats); set('practice-gap', ui.gap);
      this.$('fmin').value = clamp(Number(ui.fmin) || 75, 50, 500); this.$('fmax').value = clamp(Number(ui.fmax) || 1400, 600, 2000);
      this.$('connect-gaps').checked = ui.connect !== false; this.$('show-beats').checked = !!ui.beats; this.$('transpose').value = this.s.transpose;
      this.$('analysis-source').value = this.s.analysisSource === 'vocals' && this.s.tracks.vocals ? 'vocals' : 'original';
      this.s.waveform = overview.waveform; this.audio.src = this.s.tracks.original.url;
      this.audio.playbackRate = Number(this.$('rate').value); this.audio.preservesPitch = true;
      this.$('filename').textContent = this.s.title; this.$('filemeta').textContent = formatTime(this.s.duration); this.$('current-recording').hidden = false;
      this.$('duration').textContent = formatTime(this.s.duration);
      this.$('curve-source').textContent = this.s.analysisSource === 'vocals' ? '人声分析' : '原录音分析';
      this.$('chart-empty').hidden = !!this.s.analysis?.points.some(p => p.hz);
      this.$('lyrics-type').textContent = this.s.lyrics.some(l => l.words?.length) ? '逐字 LRC' : '唱词';
      this.api.updateCurve(); this.api.renderLyrics(); this.api.updateBeats(); this.api.updateLoop();
      if (project.mode && this.s.tracks[project.mode]) await this.api.switchMode(project.mode);
      if (this.take) await this.activateTake(this.take.id);
      this.s.detectedStart = this.api.firstVocalTime(this.s.analysis);
      this.audio.currentTime = clamp(Number(project.position) || 0, 0, this.s.duration);
      this.api.status('已恢复练习'); this.$('library-dialog').close(); this.$('project-save-status').textContent = '已保存本机';
      try { localStorage.setItem('tingqiang-last-project', id); } catch {}
      opened = true;
    } catch (error) { this.api.toast(`打开失败：${error.message}`); }
    finally { this.restoring = false; this.s.loading = false; this.api.readyButtons(); this.api.invalidate(); this.update(); }
    if (opened && !this.s.analysis) this.api.analyze();
  }
  mediaTime() {
    const capture = this.s.capture;
    if (capture?.phase === 'recording' && capture.kind !== 'along') return {currentTime: Math.min(this.s.duration, capture.anchor + (performance.now() - capture.started) / 1000 * capture.rate), rate: capture.rate, playing: false};
    const practice = this.s.practice;
    if (practice?.phase === 'tail') return {currentTime: Math.max(practice.start, practice.end - Math.max(0, practice.deadline - performance.now()) / 1000 * practice.rate), rate: practice.rate, playing: false};
    if (practice?.phase === 'sing') return {currentTime: Math.min(practice.end, practice.start + (performance.now() - practice.phaseStart) / 1000 * practice.rate), rate: practice.rate, playing: false};
    if (this.s.listening === 'take' && this.take) return {currentTime: takeToReference(this.takeAudio.currentTime || 0, this.take), rate: this.takeAudio.playbackRate * this.take.rate, playing: !this.takeAudio.paused};
    return {currentTime: this.audio.currentTime || 0, rate: this.audio.playbackRate || 1, playing: !this.audio.paused};
  }
  seekMedia(time) {
    if (this.s.listening === 'take' && this.take) this.takeAudio.currentTime = clamp(referenceToTake(time, this.take), 0, this.take.duration);
  }
  stopTakePlayback() {
    const leavingMix = this.s.listening === 'mix';
    this.takeAudio.pause(); this.s.listening = 'reference';
    if (this.s.takeGain) this.s.takeGain.gain.value = 1;
    if (leavingMix && this.mixReturnMode) { this.api.switchMode(this.mixReturnMode); this.mixReturnMode = null; }
  }
  selectLine(index) {
    const range = sentenceRange(this.s.lyrics, index, this.s.duration, this.s.lyricOffset);
    if (!range) return this.api.toast('先为这句标记时间。');
    this.stopPractice(); this.stopTakePlayback(); this.s.selectedLine = index;
    this.s.loopA = range.start; this.s.loopB = range.end; this.s.looping = true;
    this.api.seek(range.start); this.api.updateLoop(); this.update(); this.changed();
  }
  update() {
    const ready = !!this.s.tracks.original && !this.s.loading, range = this.s.loopA !== null && this.s.loopB !== null;
    this.$('save-project').disabled = !ready; this.$('export-project').disabled = !ready;
    this.$('import-audio').disabled = this.s.loading || this.busy;
    for (const id of ['play-button', 'back-button', 'forward-button', 'set-a', 'set-b', 'loop-button']) this.$(id).disabled = !ready || !!this.s.capture || !!this.pitchBusy;
    this.$('record-button').disabled = !ready || this.busy || !!this.s.separation;
    this.$('singalong-button').disabled = !ready || this.busy || !!this.s.separation;
    this.$('latency-button').disabled = this.busy;
    const hasBacking = !!this.s.tracks.accompaniment, backingSelect = this.$('backing-source');
    backingSelect.querySelector('[value="accompaniment"]').disabled = !hasBacking;
    backingSelect.value = hasBacking ? this.backingChoice : 'original';
    this.$('along-hint').textContent = this.s.tracks.original && !hasBacking ? '还没有伴奏，会跟着原声唱；点「减弱伴奏」可先分离。请戴耳机。' : '请戴耳机，避免把音乐录进去。';
    this.$('import-take').disabled = !ready || this.busy;
    this.$('transpose').disabled = !ready || this.busy;
    this.$('practice-start').disabled = !ready || !range || this.busy;
    this.$('practice-prev').disabled = !this.s.lyrics.length || this.busy; this.$('practice-next').disabled = !this.s.lyrics.length || this.busy;
    this.$('practice-title').textContent = range ? (this.s.selectedLine >= 0 ? this.s.lyrics[this.s.selectedLine]?.text || '选段' : `${formatTime(this.s.loopA, true)} — ${formatTime(this.s.loopB, true)}`) : '点一句唱词，或拖选曲线';
    this.s.lyricNodes.forEach((node, i) => node.row.classList.toggle('selected', i === this.s.selectedLine));
    for (const [id, kind] of [['listen-reference', 'reference'], ['listen-take', 'take'], ['listen-mix', 'mix']]) this.$(id).setAttribute('aria-pressed', String(this.s.listening === kind));
    this.$('take-details').hidden = !this.take;
    this.$('listen-reference').disabled = this.busy; this.$('listen-take').disabled = this.busy; this.$('listen-mix').disabled = this.busy;
    this.$('voice-gain-label').hidden = this.s.listening !== 'mix';
    this.$('take-legend').hidden = this.s.capture?.kind !== 'along' && (!this.take?.analysis || !this.$('take-show').checked);
    this.api.invalidate();
  }
  async setTranspose(value) {
    if (this.busy || !this.s.tracks.original) return;
    const previous = this.s.transpose, playing = !this.audio.paused && this.s.listening === 'reference';
    this.stopPractice(); this.pitchBusy = true; this.audio.pause(); this.update();
    try {
      this.api.ensureAudioGraph(); if (!this.s.pitchOutput) throw new Error('当前浏览器不支持降调，请使用新版 Chrome、Edge 或 Safari。');
      await this.s.playbackContext.resume(); await this.s.pitchOutput.setSemitones(value);
      this.s.transpose = value; this.changed();
      if (playing) await this.api.startPlayback();
    } catch (error) { this.s.transpose = previous; this.$('transpose').value = previous; this.api.toast(error.message); }
    finally { this.pitchBusy = false; this.update(); }
  }
  async startPractice() {
    if (this.s.practice) { this.stopPractice(); return; }
    if (this.s.loopA === null || this.s.loopB === null || this.busy) return;
    this.stopTakePlayback();
    this.s.practice = {phase: 'listen', round: 1, mode: this.$('practice-mode').value, repeats: Number(this.$('practice-repeats').value), gap: Number(this.$('practice-gap').value), start: this.s.loopA, end: this.s.loopB, duration: this.s.loopB - this.s.loopA, rate: Number(this.$('rate').value)};
    this.$('practice-start').querySelector('span').textContent = '停止练习'; this.$('practice-start').classList.add('running');
    this.api.seek(this.s.practice.start); this.changed(); this.update();
    try { await this.api.startPlayback(); } catch (error) { this.stopPractice(); this.api.toast(error.message); }
  }
  stopPractice(message = '尚未开始') {
    if (this.s.practice) { this.audio.pause(); this.s.practice = null; this.s.looping = false; this.api.updateLoop(); }
    this.$('practice-start').querySelector('span').textContent = '开始练习'; this.$('practice-start').classList.remove('running'); this.$('practice-phase').textContent = message;
  }
  tick() {
    this.tickAlong(); this.syncMix();
    const p = this.s.practice;
    if (!p) return;
    const label = `第 ${p.round}${p.repeats ? ` / ${p.repeats}` : ''} 遍`;
    if (p.phase === 'listen') {
      this.$('practice-phase').textContent = `${label} · 听原唱`;
      if (this.audio.currentTime >= p.end - 0.015 || this.audio.ended) {
        this.audio.pause(); this.audio.currentTime = p.end;
        p.phase = 'tail'; p.deadline = performance.now() + ((this.s.pitchOutput?.latency || 0) + this.s.outputDelay) * 1000;
      }
    } else if (p.phase === 'tail') {
      this.$('practice-phase').textContent = `${label} · 听原唱`;
      if (performance.now() >= p.deadline) this.finishPhase('listen');
    } else {
      const remaining = Math.max(0, (p.deadline - performance.now()) / 1000);
      this.$('practice-phase').textContent = `${label} · ${p.phase === 'sing' ? '轮到你唱' : '准备'} ${Math.ceil(remaining)} 秒`;
      if (remaining <= 0) {
        if (p.phase === 'sing') this.finishPhase('sing');
        else { p.phase = 'listen'; this.api.seek(p.start); this.api.startPlayback().catch(error => { this.stopPractice(); this.api.toast(error.message); }); }
      }
    }
  }
  finishPhase(completed) {
    const p = this.s.practice; if (!p) return;
    this.audio.pause(); this.audio.currentTime = p.end;
    const next = nextPracticePhase(p, completed);
    if (next.phase === 'done') { this.stopPractice(`已练 ${p.round} 遍`); this.changed(); return; }
    Object.assign(p, next, {phaseStart: performance.now(), deadline: performance.now() + next.seconds * 1000});
    this.api.invalidate();
  }
  cancelTakeAnalysis() { this.takeJob?.cancel(); this.takeJob = null; }
  showRecording(active) {
    this.$('stop-recording').hidden = !active; this.$('record-button').hidden = active; this.$('singalong-button').hidden = active;
    this.$('mic-level').hidden = true; this.$('sing-cue').hidden = true;
    if (!active) this.$('take-status').dataset.recording = 'false';
  }
  cancelCapture() {
    const capture = this.s.capture; if (!capture) return;
    capture.cancelled = true; clearTimeout(capture.timer); clearInterval(capture.counter); capture.wake?.();
    if (capture.recorder?.state !== 'inactive') try { capture.recorder.stop(); } catch {}
    capture.stream?.getTracks().forEach(track => track.stop()); this.s.capture = null;
    this.showRecording(false);
    if (capture.kind === 'along') { capture.mic?.close(); this.audio.pause(); this.restoreAfterAlong(capture); }
    this.api.pool.pump();
    this.update();
  }
  restoreAfterAlong(capture) {
    capture.wakeLock?.release().catch(() => {});
    this.api.switchMode(capture.previousMode);
    this.s.looping = capture.looping; this.api.seek(capture.plan.entry); this.api.updateLoop();
  }
  /** Saved latency applies only to the audio devices it was measured on. */
  async deviceSignature() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return ['audioinput', 'audiooutput'].map(kind => devices.find(device => device.kind === kind)?.label || '').join('|');
  }
  async measuredLatency() {
    try { const saved = JSON.parse(localStorage.getItem('tingqiang-latency') || 'null'); return saved && saved.device === await this.deviceSignature() ? saved.seconds : null; }
    catch { return null; }
  }
  async roundTrip(inputLatency) {
    return await this.measuredLatency() ?? outputDelaySeconds(this.s.playbackContext, performance.now()) + inputLatency;
  }
  async beginSingAlong() {
    if (this.busy || !this.s.tracks.original) return;
    if (this.s.takes.length >= 20) return this.api.toast('每个练习最多保存 20 遍录音，请先删除旧录音。');
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) return this.api.toast('当前浏览器不支持边听边录，可用「清唱录一遍」或导入录音。');
    this.stopPractice(); this.audio.pause(); this.stopTakePlayback();
    const wanted = this.$('backing-source').value, backing = this.s.tracks[wanted] ? wanted : 'original', previousMode = this.s.mode;
    const plan = singAlongPlan({loopA: this.s.loopA, loopB: this.s.loopB, position: this.audio.currentTime, duration: this.s.duration, leadIn: Number(this.$('lead-in').value)});
    await this.api.switchMode(backing);
    const line = this.s.lyrics.find(item => item.t !== null && item.t + this.s.lyricOffset >= plan.entry - 0.05);
    const capture = {kind: 'along', phase: 'permission', plan, backing, previousMode, looping: this.s.looping, line: line?.text, rate: Number(this.$('rate').value), transpose: this.s.transpose, cancelled: false, generation: this.s.generation, offsets: [], live: [], sound: 0, peak: 0};
    this.s.capture = capture; this.showRecording(true);
    this.$('take-status').textContent = '等待麦克风权限…'; this.update();
    try {
      this.api.ensureAudioGraph();
      const context = this.s.playbackContext;
      if (!context) throw new Error('当前浏览器无法边播放边录音。');
      await context.resume();
      const resampler = new LiveResampler(context.sampleRate);
      const mic = await openMicCapture(context, {onSamples: (samples, frames) => this.onMicSamples(capture, samples, frames, resampler), onEnded: () => this.endRecording()});
      if (capture.cancelled) return mic.close();
      capture.mic = mic; capture.phase = 'countdown';
      navigator.wakeLock?.request('screen').then(lock => { if (capture.cancelled) lock.release(); else capture.wakeLock = lock; }).catch(() => {});
      this.$('chart-wrap').scrollIntoView({block: 'center', behavior: 'smooth'});
      this.s.looping = false; this.api.seek(plan.start); this.api.updateLoop();
      await this.s.pitchOutput?.setSemitones(this.s.transpose || 0);
      capture.roundTrip = await this.roundTrip(mic.inputLatency);
      if (capture.cancelled) return;
      capture.startFrame = await mic.start();
      this.$('mic-level').hidden = false; this.$('take-status').dataset.recording = 'true';
      this.$('take-status').textContent = '马上开始…';
      if (plan.silence) {
        const when = context.currentTime + 0.1, ticks = Math.round(plan.silence);
        for (let i = 0; i < ticks; i++) beep(context, when + i, i === ticks - 1 ? 1760 : 1320);
        capture.silentUntil = performance.now() + plan.silence * 1000;
        await new Promise(resolve => { capture.wake = resolve; capture.timer = setTimeout(resolve, plan.silence * 1000); });
        if (capture.cancelled) return;
      }
      capture.phase = 'recording';
      this.$('take-status').textContent = `正在录音 · 跟着${BACKING_NAMES[backing]}唱，唱完可点停止`;
      await this.api.startPlayback();
      this.api.invalidate();
    } catch (error) {
      if (!capture.cancelled) this.cancelCapture();
      this.$('take-status').textContent = await this.micProblem(error, '麦克风未授权。请在浏览器地址栏允许麦克风后重试，或用 Chrome、Edge 打开本页。'); this.update();
    }
  }
  /** Why the microphone would not open. In the apps no page prompt can fix it: Windows or Android decides. */
  async micProblem(error, denied) {
    const access = shell ? await shell.microphoneAccess() : 'unknown';
    // Android asks again after one refusal; after a second only its settings can allow the microphone.
    const blocked = platform === 'android' ? access === 'denied' : platform === 'windows' && (error.name === 'NotAllowedError' || access === 'denied');
    this.$('mic-settings').hidden = !blocked;
    if (blocked && platform === 'android') return '麦克风权限已关闭。点「打开麦克风设置」，在「权限 → 麦克风」里选「仅在使用该应用时允许」，再回来重试。';
    if (blocked) return 'Windows 禁止了麦克风。请在「设置 → 隐私和安全性 → 麦克风」打开「允许桌面应用访问麦克风」，再重试。';
    if (error.name === 'NotAllowedError' && platform === 'android') return '录音需要麦克风权限。再点一次，在系统的询问里选「允许」。';
    if (error.name === 'NotFoundError') return '没有找到麦克风。请接上麦克风或耳麦后重试。';
    if (error.name === 'NotReadableError') return '麦克风正被其他应用占用（比如正在通话），请稍后重试。';
    return error.name === 'NotAllowedError' ? denied : `无法录音：${error.message}`;
  }
  onMicSamples(capture, samples, frames, resampler) {
    let peak = 0;
    for (let i = 0; i < samples.length; i += 8) peak = Math.max(peak, Math.abs(samples[i]));
    capture.peak = Math.max(capture.peak, peak); capture.sound = Math.max(peak, capture.sound * 0.85);
    this.$('mic-level').value = Math.min(1, capture.sound * 2.5);
    resampler.push(samples);
    if (capture.phase !== 'recording' || capture.liveBusy) return;
    const window = resampler.latest();
    if (!window) return;
    const at = frames / this.s.playbackContext.sampleRate - 0.032;
    capture.liveBusy = true;
    this.api.pool.live(window, {fmin: Number(this.$('fmin').value), fmax: Number(this.$('fmax').value)}).then(hz => {
      capture.liveBusy = false; capture.live.push({t: at, hz}); this.api.invalidate();
    });
  }
  /** Follows the backing while singing: the cue, the media-to-audio clock mapping and the automatic stop. */
  tickAlong() {
    const capture = this.s.capture;
    if (capture?.kind !== 'along' || capture.cancelled || capture.phase === 'permission' || capture.phase === 'finishing') return;
    const {plan, rate} = capture, context = this.s.playbackContext;
    let left = (plan.entry - plan.start) / rate;
    if (capture.phase === 'countdown') left += capture.silentUntil ? Math.max(0, capture.silentUntil - performance.now()) / 1000 : 0;
    else {
      left = (plan.entry - this.s.frameTime) / rate;
      if (!this.audio.paused && this.audio.currentTime > plan.start + 0.1 * rate) {
        capture.offsets.push(this.audio.currentTime - rate * context.currentTime);
        if (capture.offsets.length % 30 === 0) capture.liveAnchor = takeAnchor({mediaOffset: median(capture.offsets.slice(-240)), rate, captureStart: capture.startFrame / context.sampleRate, roundTrip: capture.roundTrip, processing: this.s.pitchOutput?.latency || 0});
      }
      if (this.audio.ended || this.audio.currentTime >= plan.end + 0.5 * rate) { this.endRecording(); return; }
    }
    const cue = this.$('sing-cue');
    cue.hidden = left < -1.2;
    if (!cue.hidden) {
      cue.querySelector('strong').textContent = left > 0.05 ? String(Math.ceil(left)) : '唱';
      cue.querySelector('span').textContent = left > 0.05 ? (capture.line ? `下一句：${capture.line}` : '准备起唱') : capture.line || '';
    }
  }
  async finishAlong(capture) {
    capture.phase = 'finishing'; clearTimeout(capture.timer);
    this.audio.pause(); this.$('take-status').textContent = '正在整理录音…';
    const context = this.s.playbackContext, {samples, sampleRate} = await capture.mic.stop();
    const roundTrip = await this.roundTrip(capture.mic.inputLatency);
    capture.mic.close();
    if (capture.cancelled || capture.generation !== this.s.generation) return;
    const anchor = takeAnchor({mediaOffset: median(capture.offsets) ?? capture.plan.start - capture.rate * context.currentTime, rate: capture.rate, captureStart: capture.startFrame / sampleRate, roundTrip, processing: this.s.pitchOutput?.latency || 0});
    // Anything before the recording's own start cannot appear on its timeline.
    const voice = samples.subarray(Math.min(samples.length, anchor < 0 ? Math.ceil(-anchor / capture.rate * sampleRate) : 0));
    this.s.capture = null; this.showRecording(false); this.restoreAfterAlong(capture);
    this.api.pool.pump();
    if (voice.length < sampleRate * 0.3) { this.$('take-status').textContent = '录音太短，没有保存。'; this.update(); return; }
    await this.addTake(new Blob([encodeWav([voice], sampleRate)], {type: 'audio/wav'}), {anchor: Math.max(0, anchor), rate: capture.rate, transpose: capture.transpose, backing: capture.backing, nearlySilent: capture.peak < 0.01});
    this.update();
  }
  async calibrateLatency() {
    if (this.busy) return;
    const note = this.$('latency-result'), start = this.$('latency-start');
    let mic;
    start.disabled = true; note.textContent = '正在打开麦克风…';
    try {
      this.api.ensureAudioGraph();
      const context = this.s.playbackContext;
      if (!context) throw new Error('当前浏览器无法边播放边录音。');
      await context.resume();
      mic = await openMicCapture(context);
      const startFrame = await mic.start(), first = context.currentTime + 1, clicks = Array.from({length: 8}, (_, i) => first + i * 0.8);
      clicks.forEach(when => beep(context, when));
      note.textContent = '听到「嗒」就拍一下手，共 8 次…';
      await new Promise(resolve => setTimeout(resolve, (clicks.at(-1) - context.currentTime + 0.9) * 1000));
      const {samples, sampleRate} = await mic.stop();
      const result = measureRoundTrip(samples, sampleRate, clicks.map(when => when - startFrame / sampleRate));
      if (!result) { note.textContent = '没有听清拍手声。请靠近麦克风，跟着节奏再试一次。'; return; }
      localStorage.setItem('tingqiang-latency', JSON.stringify({seconds: result.seconds, device: await this.deviceSignature()}));
      note.textContent = `测得往返延迟约 ${Math.round(result.seconds * 1000)} ms，之后的跟唱录音会按它对齐。换耳机后请重测。`;
    } catch (error) { note.textContent = await this.micProblem(error, '麦克风未授权。'); }
    finally { mic?.close(); start.disabled = false; }
  }
  async beginRecording() {
    if (this.busy || !this.s.tracks.original) return;
    if (this.s.takes.length >= 20) return this.api.toast('每个练习最多保存 20 遍录音，请先删除旧录音。');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return this.api.toast('当前浏览器不支持录音，可导入自己的录音。');
    this.stopPractice(); this.audio.pause(); this.stopTakePlayback();
    const capture = {kind: 'free', phase: 'permission', anchor: this.s.loopA ?? this.audio.currentTime, rate: Number(this.$('rate').value), transpose: this.s.transpose, cancelled: false, generation: this.s.generation};
    this.s.capture = capture; this.$('take-status').textContent = '等待麦克风权限…'; this.update();
    this.showRecording(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
      if (capture.cancelled || this.s.capture !== capture) { stream.getTracks().forEach(t => t.stop()); return; }
      capture.stream = stream; capture.phase = 'countdown'; let left = 3;
      this.$('take-status').dataset.recording = 'true'; this.$('take-status').textContent = `准备 · ${left}`;
      capture.counter = setInterval(() => { left--; if (left > 0) this.$('take-status').textContent = `准备 · ${left}`; }, 1000);
      capture.timer = setTimeout(() => {
        clearInterval(capture.counter); if (capture.cancelled) return;
        const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(mime => MediaRecorder.isTypeSupported(mime));
        const recorder = new MediaRecorder(stream, mimeType ? {mimeType} : undefined), chunks = []; capture.recorder = recorder;
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstart = () => { capture.phase = 'recording'; capture.started = performance.now(); this.$('take-status').textContent = '正在录音 · 唱完可点停止'; this.api.invalidate(); };
        recorder.onerror = event => { this.cancelCapture(); this.api.toast(event.error?.message || '录音中断'); this.update(); };
        recorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop()); clearTimeout(capture.timer);
          if (capture.cancelled || capture.generation !== this.s.generation) return;
          this.s.capture = null; this.showRecording(false); this.api.pool.pump();
          if (chunks.length) await this.addTake(new Blob(chunks, {type: recorder.mimeType}), capture);
          this.update();
        };
        recorder.start();
        const duration = this.s.loopB !== null ? Math.max(0.4, (this.s.loopB - capture.anchor) / capture.rate + 0.25) : Math.min(120, (this.s.duration - capture.anchor) / capture.rate + 0.25);
        capture.timer = setTimeout(() => this.endRecording(), Math.min(120, duration) * 1000);
      }, 3000);
    } catch (error) { this.cancelCapture(); this.$('take-status').textContent = await this.micProblem(error, '麦克风未授权，可重新录音或导入文件。'); this.update(); }
  }
  endRecording() {
    const capture = this.s.capture; if (!capture) return;
    if (capture.phase === 'finishing') return;
    if (capture.phase !== 'recording') { this.cancelCapture(); this.$('take-status').textContent = '已取消录音'; this.update(); return; }
    if (capture.kind === 'along') return this.finishAlong(capture);
    capture.phase = 'finishing'; clearTimeout(capture.timer); capture.recorder.stop(); this.$('take-status').textContent = '正在整理录音…';
  }
  async addTake(blob, context = {}) {
    if (!this.s.projectId || this.takeJob) return;
    if (this.s.takes.length >= 20) return this.api.toast('每个练习最多保存 20 遍录音，请先删除旧录音。');
    const generation = this.s.generation; let created = false;
    this.$('take-status').textContent = '正在读取录音…';
    try {
      if (blob.size > 120 * 1024 * 1024) throw new Error('自己的录音请小于 120 MB。');
      const buffer = await this.api.decodeAt(blob, 16000);
      if (buffer.duration < 0.3 || buffer.duration > TAKE_LIMIT_SECONDS) throw new Error('录音长度需在 0.3 秒至 10 分钟之间。');
      if (generation !== this.s.generation) return;
      const take = {id: crypto.randomUUID(), title: `第 ${this.s.takes.length + 1} 遍`, anchor: context.anchor ?? this.s.loopA ?? this.audio.currentTime,
        rate: context.rate || Number(this.$('rate').value), transpose: context.transpose ?? this.s.transpose, offset: 0, duration: buffer.duration, createdAt: Date.now(), analysis: null, ...(context.backing ? {backing: context.backing} : {})};
      this.assetDirty.set(`take:${take.id}`, blob); this.s.takes.push(take); this.takeBlob = blob;
      await this.activateTake(take.id, blob); created = true; this.changed(); await this.save();
      this.$('take-status').textContent = '正在分析自己的唱腔…';
      const samples = await this.api.monoSamples(buffer, 16000);
      if (generation !== this.s.generation) return;
      this.takeJob = this.api.pool.analyze(samples, {method: 'crepe', fmin: Number(this.$('fmin').value), fmax: Number(this.$('fmax').value)}, {
        priority: 1, onProgress: ({done, total}) => { if (total) this.$('take-status').textContent = `分析自己的唱腔 · ${Math.round(done / total * 100)}%`; },
      });
      this.update();
      take.analysis = await this.takeJob.promise; this.takeJob = null;
      if (generation !== this.s.generation) return;
      this.changed(); const saved = await this.save();
      if (generation !== this.s.generation) return;
      this.$('take-status').textContent = context.nearlySilent ? '录音几乎没有声音，请检查麦克风后重录。' : !saved ? '录音可回听 · 请导出练习备份' : take.backing ? '录音已保存 · 蓝线是你的唱腔，点「合成」听人声加伴奏' : '录音已保存 · 蓝线为自己的唱腔'; this.update();
    } catch (error) { if (error.name === 'AbortError' || generation !== this.s.generation) return; this.cancelTakeAnalysis(); this.$('take-status').textContent = created ? `录音可回听，曲线分析未完成：${error.message}` : `无法读取录音：${error.message}`; this.api.toast(error.message); this.update(); }
  }
  async activateTake(id, provided) {
    const take = this.s.takes.find(t => t.id === id); if (!take) return;
    const blob = provided || this.assetDirty.get(`take:${id}`) || await store.readAsset(this.s.projectId, `take:${id}`);
    if (!blob) throw new Error('这遍录音的文件缺失。');
    this.stopTakePlayback(); if (this.takeUrl) URL.revokeObjectURL(this.takeUrl);
    this.s.activeTakeId = id; this.takeBlob = blob; this.takeUrl = URL.createObjectURL(blob); this.takeAudio.src = this.takeUrl; this.takeAudio.preservesPitch = true;
    this.$('take-select').replaceChildren(...this.s.takes.map(item => { const o = document.createElement('option'); o.value = item.id; o.textContent = item.title; return o; }));
    this.$('take-select').value = id; this.$('take-alignment').value = take.offset || 0;
    this.$('take-meta').textContent = `${formatTime(take.duration)} · 录制 ${take.rate}× · ${take.transpose ? `${take.transpose > 0 ? '+' : ''}${take.transpose} 半音` : '原调'}${take.backing ? ` · 跟${BACKING_NAMES[take.backing]}` : ''}`;
    this.$('take-status').textContent = take.analysis ? '录音已就绪' : '录音已保存，可直接回听';
    this.takeAudio.playbackRate = Number(this.$('rate').value) / take.rate;
    this.update(); this.changed();
  }
  async listen(kind) {
    if (this.busy || kind !== 'reference' && !this.take) return;
    this.stopPractice();
    const position = this.mediaTime().currentTime, playing = !this.audio.paused || !this.takeAudio.paused;
    this.audio.pause(); this.takeAudio.pause();
    const wasMix = this.s.listening === 'mix';
    this.s.listening = kind;
    this.api.ensureAudioGraph();
    if (this.s.takeGain) this.s.takeGain.gain.value = kind === 'mix' ? this.voiceGain(this.take) : 1;
    if (kind === 'mix') {
      const backing = [this.take.backing, 'accompaniment', 'original'].find(mode => this.s.tracks[mode]);
      this.mixReturnMode ??= this.s.mode; await this.api.switchMode(backing);
      this.$('voice-gain').value = this.voiceGain(this.take);
    } else if (wasMix && this.mixReturnMode) { await this.api.switchMode(this.mixReturnMode); this.mixReturnMode = null; }
    const minimum = this.take ? takeToReference(0, this.take) : 0, outside = this.take && (position < minimum || position >= takeToReference(this.take.duration, this.take));
    this.api.seek(kind !== 'reference' && outside ? Math.max(0, minimum) : position);
    if (kind === 'take') this.takeAudio.playbackRate = Number(this.$('rate').value) / this.take.rate;
    this.update(); if (playing) try { await this.api.startPlayback(); } catch (error) { this.api.toast(error.message); }
  }
  voiceGain(take) { return take.voiceGain ?? suggestVoiceGain(this.s.analysis, take.analysis); }
  /** The voice follows the backing, with small speed trims instead of audible jumps. */
  syncMix() {
    const take = this.take, voice = this.takeAudio;
    if (this.s.listening !== 'mix' || !take) return;
    const speed = Number(this.$('rate').value) / take.rate;
    const want = referenceToTake(this.audio.currentTime - (this.s.pitchOutput?.latency || 0) * this.audio.playbackRate, take);
    if (this.audio.paused || want < 0 || want >= take.duration) { if (!voice.paused) voice.pause(); return; }
    if (voice.paused) { voice.currentTime = want; voice.playbackRate = speed; voice.play().catch(() => {}); return; }
    const error = voice.currentTime - want;
    if (Math.abs(error) > 0.25) voice.currentTime = want;
    else voice.playbackRate = speed * (Math.abs(error) > 0.015 ? clamp(1 - error, 0.97, 1.03) : 1);
  }
  autoAlign() {
    const take = this.take, result = take && alignTake(this.s.analysis, take, take.analysis);
    if (!result) return this.api.toast('需要原唱和这遍录音都有曲线才能自动对齐。');
    if (result.score > result.current - 0.03) return this.api.toast('当前对齐已接近最佳。');
    take.offset = clamp(result.offset, -30, 30); this.$('take-alignment').value = take.offset.toFixed(2);
    this.api.toast(`已对齐，偏移 ${take.offset >= 0 ? '+' : ''}${take.offset.toFixed(2)} 秒。可继续微调。`);
    this.changed(); this.api.invalidate();
  }
  /** Backing and voice rendered together, at the speed and key the take was sung in. */
  async downloadMix() {
    const take = this.take, backing = [take?.backing, 'accompaniment', 'original'].find(mode => this.s.tracks[mode]);
    if (!take || !this.takeBlob) return;
    const button = this.$('download-mix');
    button.disabled = true; button.textContent = '正在合成…';
    try {
      const sampleRate = 44100, [music, voice] = await Promise.all([this.api.decodeAt(this.s.tracks[backing].blob, sampleRate), this.api.decodeAt(this.takeBlob, sampleRate)]);
      const context = new OfflineAudioContext(2, Math.ceil(take.duration * sampleRate), sampleRate), from = takeToReference(0, take);
      const voiceSource = context.createBufferSource(), voiceLevel = context.createGain();
      voiceSource.buffer = voice; voiceLevel.gain.value = this.voiceGain(take); voiceSource.connect(voiceLevel); voiceLevel.connect(context.destination);
      let delay = 0;
      if (take.rate === 1 && !take.transpose) {
        const source = context.createBufferSource(); source.buffer = music; source.connect(context.destination);
        source.start(Math.max(0, -from), Math.max(0, from));
      } else {
        const stretch = await SignalsmithStretch(context);
        await stretch.addBuffers(Array.from({length: music.numberOfChannels}, (_, channel) => music.getChannelData(channel).slice()));
        delay = (await stretch.latency()) / 2;
        await stretch.schedule({active: true, input: Math.max(0, from), output: Math.max(0, -from / take.rate), rate: take.rate, semitones: take.transpose || 0, formantCompensation: true});
        stretch.connect(context.destination);
      }
      voiceSource.start(delay);
      const rendered = await context.startRendering(), channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
      let peak = 0;
      for (const channel of channels) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
      if (peak > 0.98) for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= 0.98 / peak;
      this.download(new Blob([encodeWav(channels, sampleRate)], {type: 'audio/wav'}), `${this.s.title}-${take.title}-合成.wav`);
    } catch (error) { this.api.toast(`合成失败：${error.message}`); }
    finally { button.disabled = false; button.textContent = '下载合成'; }
  }
  async export() {
    await this.save(); if (!this.s.projectId) return;
    try {
      const stored = await store.allAssets(this.s.projectId).catch(() => []);
      const assets = new Map(stored.map(a => [a.kind, a.blob]));
      for (const [kind, track] of Object.entries(this.s.tracks)) assets.set(kind, track.blob);
      for (const [kind, blob] of this.assetDirty) assets.set(kind, blob);
      if (this.take && this.takeBlob) assets.set(`take:${this.take.id}`, this.takeBlob);
      for (const kind of this.removed) assets.delete(kind);
      if (this.s.takes.some(take => !assets.has(`take:${take.id}`))) throw new Error('部分录音暂不可读，请重新打开练习后导出。');
      const blob = await exportProjectFile(this.snapshot(), [...assets].map(([kind, blob]) => ({kind, blob})));
      this.download(blob, `${this.s.title}.tqproj`);
    }
    catch (error) { this.api.toast(error.message); }
  }
  async importProject(file) {
    try { const {project, assets} = await importProjectFile(file); await store.saveProject(project, {assets, analyses: store.projectAnalyses(project)}); await this.load(project.id); }
    catch (error) { this.api.toast(`导入失败：${error.message}`); }
  }
  download(blob, filename) {
    // A phone has no downloads folder to drop the file in: it offers to send the file or save it instead.
    if (shell?.save) {
      if (blob.size > 8e6) this.api.toast('正在准备文件…', 2500);
      return shell.save(blob, filename).catch(error => this.api.toast(`无法导出：${error.message}`));
    }
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async init() {
    this.$('save-project').onclick = async () => { if (!this.s.projectId && this.s.tracks.original) this.newProject(); await this.save(); };
    this.$('library-button').onclick = () => this.openLibrary(); this.$('export-project').onclick = () => this.export();
    this.$('import-project').onclick = () => this.$('project-input').click();
    this.$('project-input').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) this.importProject(file); };
    this.$('mic-settings').onclick = () => shell?.openMicrophoneSettings();
    this.$('transpose').onchange = () => this.setTranspose(Number(this.$('transpose').value));
    this.$('practice-start').onclick = () => this.startPractice();
    for (const [id, delta] of [['practice-prev', -1], ['practice-next', 1]]) this.$(id).onclick = () => {
      let index = this.s.selectedLine + delta; if (this.s.selectedLine < 0) index = delta > 0 ? 0 : this.s.lyrics.length - 1;
      while (index >= 0 && index < this.s.lyrics.length) { if (sentenceRange(this.s.lyrics, index, this.s.duration, this.s.lyricOffset)) return this.selectLine(index); index += delta; }
    };
    for (const id of ['practice-mode', 'practice-repeats', 'practice-gap']) this.$(id).onchange = () => { this.stopPractice(); this.changed(); };
    this.$('record-button').onclick = () => this.beginRecording(); this.$('singalong-button').onclick = () => this.beginSingAlong(); this.$('stop-recording').onclick = () => this.endRecording();
    this.$('latency-button').onclick = () => { this.$('latency-result').textContent = ''; this.$('latency-dialog').showModal(); };
    this.$('backing-source').onchange = () => { this.backingChoice = this.$('backing-source').value; };
    this.$('latency-start').onclick = () => this.calibrateLatency();
    this.$('latency-reset').onclick = () => { try { localStorage.removeItem('tingqiang-latency'); } catch {} this.$('latency-result').textContent = '已恢复自动估计。'; };
    this.$('auto-align').onclick = () => this.autoAlign(); this.$('download-mix').onclick = () => this.downloadMix();
    this.$('voice-gain').oninput = () => { if (!this.take) return; this.take.voiceGain = clamp(Number(this.$('voice-gain').value) || 0, 0, 4); if (this.s.takeGain) this.s.takeGain.gain.value = this.take.voiceGain; this.changed(); };
    this.$('import-take').onclick = () => this.$('take-input').click();
    this.$('take-input').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) this.addTake(file); };
    this.$('take-select').onchange = () => this.activateTake(this.$('take-select').value).catch(error => this.api.toast(error.message));
    this.$('listen-reference').onclick = () => this.listen('reference'); this.$('listen-take').onclick = () => this.listen('take'); this.$('listen-mix').onclick = () => this.listen('mix');
    this.$('take-show').onchange = () => this.update();
    this.$('take-alignment').oninput = () => { if (!this.take) return; this.take.offset = clamp(Number(this.$('take-alignment').value) || 0, -30, 30); this.changed(); this.api.invalidate(); };
    this.$('download-take').onclick = () => { if (this.takeBlob) { const ext = this.takeBlob.type.includes('mp4') ? 'm4a' : this.takeBlob.type.includes('wav') ? 'wav' : this.takeBlob.type.includes('mpeg') ? 'mp3' : this.takeBlob.type.includes('ogg') ? 'ogg' : 'webm'; this.download(this.takeBlob, `${this.s.title}-${this.take.title}.${ext}`); } };
    this.$('delete-take').onclick = async () => {
      if (!this.take || this.busy) return; const id = this.take.id; this.stopTakePlayback();
      this.s.takes = this.s.takes.filter(t => t.id !== id); this.assetDirty.delete(`take:${id}`); this.removed.add(`take:${id}`);
      this.s.activeTakeId = null; if (this.s.takes.length) await this.activateTake(this.s.takes.at(-1).id);
      else { if (this.takeUrl) URL.revokeObjectURL(this.takeUrl); this.takeBlob = null; this.takeAudio.removeAttribute('src'); this.takeAudio.load(); this.$('take-status').textContent = '已删除本遍录音'; }
      this.changed(); this.update();
    };
    this.takeAudio.onplay = this.takeAudio.onpause = () => { this.api.updatePlayIcon(); this.api.invalidate(); this.changed(); };
    this.audio.addEventListener('pause', () => this.changed());
    document.addEventListener('change', event => { if (event.target.matches('input:not([type=file]),select')) this.changed(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { if (this.s.capture?.phase === 'recording') this.endRecording(); else if (this.s.capture) this.cancelCapture(); this.save(); } });
    this.positionTimer = setInterval(() => { if (!this.audio.paused || !this.takeAudio.paused) this.changed(); }, 5000);
    this.update();
    try { const id = localStorage.getItem('tingqiang-last-project'); if (id && !this.s.file) await this.load(id); } catch {}
  }
  dispose() { clearInterval(this.positionTimer); clearTimeout(this.saveTimer); this.cancelCapture(); this.cancelTakeAnalysis(); this.stopTakePlayback(); if (this.takeUrl) URL.revokeObjectURL(this.takeUrl); }
}
