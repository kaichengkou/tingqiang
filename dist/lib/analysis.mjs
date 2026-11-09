/* Browser-local DSP. Frequencies are estimates; unvoiced frames remain gaps. */
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = midi => 440 * 2 ** ((midi - 69) / 12);
export function noteName(midi) {
  const n = Math.round(midi);
  return ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}
export function formatTime(seconds, fine = false) {
  const s = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  const ticks = Math.floor(s * 10 + 1e-7), whole = fine ? Math.floor(ticks / 10) : Math.floor(s);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}${fine ? '.' + ticks % 10 : ''}`;
}

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let xr = 1, xi = 0;
      for (let j = 0; j < len / 2; j++) {
        const p = i + j, q = p + len / 2;
        const vr = re[q] * xr - im[q] * xi, vi = re[q] * xi + im[q] * xr;
        re[q] = re[p] - vr; im[q] = im[p] - vi;
        re[p] += vr; im[p] += vi;
        const tr = xr * wr - xi * wi; xi = xr * wi + xi * wr; xr = tr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export function analyzePitch(samples, sampleRate, options = {}, progress = () => {}) {
  const fmin = clamp(Number(options.fmin) || 75, 50, 500);
  const fmax = clamp(Number(options.fmax) || 1400, fmin + 100, sampleRate / 3);
  let size = 1024;
  while (size < sampleRate / fmin * 3) size *= 2;
  const hop = Math.max(1, Math.round(sampleRate * 0.02));
  const minTau = Math.max(2, Math.floor(sampleRate / fmax));
  const maxTau = Math.min(size / 2 - 1, Math.ceil(sampleRate / fmin));
  const re = new Float64Array(size * 2), im = new Float64Array(size * 2);
  const prefix = new Float64Array(size + 1), cmnd = new Float64Array(maxTau + 2);
  const points = [], energy = [];
  const nFrames = Math.max(0, Math.floor((samples.length - size) / hop) + 1);
  for (let frame = 0; frame < nFrames; frame++) {
    const start = frame * hop;
    re.fill(0); im.fill(0); prefix[0] = 0;
    let mean = 0;
    for (let j = 0; j < size; j++) mean += samples[start + j];
    mean /= size;
    for (let j = 0; j < size; j++) {
      const v = samples[start + j] - mean;
      re[j] = v; prefix[j + 1] = prefix[j] + v * v;
    }
    const rms = Math.sqrt(prefix[size] / size);
    const t = (start + size / 2) / sampleRate;
    energy.push({t, value: rms});
    let hz = null, confidence = 0;
    if (rms >= 0.003) {
      fft(re, im);
      for (let j = 0; j < re.length; j++) { re[j] = re[j] * re[j] + im[j] * im[j]; im[j] = 0; }
      fft(re, im, true);
      let cumulative = 0;
      cmnd[0] = 1;
      for (let tau = 1; tau <= maxTau + 1; tau++) {
        const difference = Math.max(0, (prefix[size - tau] + prefix[size] - prefix[tau] - 2 * re[tau]) / (size - tau));
        cumulative += difference;
        cmnd[tau] = cumulative > 1e-15 ? difference * tau / cumulative : 1;
      }
      let tau = -1;
      for (let j = minTau; j <= maxTau; j++) {
        if (cmnd[j] < 0.16) {
          while (j < maxTau && cmnd[j + 1] < cmnd[j]) j++;
          tau = j; break;
        }
      }
      if (tau < 0) {
        let best = minTau;
        for (let j = minTau + 1; j <= maxTau; j++) if (cmnd[j] < cmnd[best]) best = j;
        if (cmnd[best] < 0.25 && best > minTau && best < maxTau) tau = best;
      }
      if (tau > 0) {
        const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
        const divisor = 2 * (2 * b - a - c);
        const shift = Math.abs(divisor) > 1e-10 ? clamp((c - a) / divisor, -0.5, 0.5) : 0;
        const f = sampleRate / (tau + shift);
        if (f >= fmin && f <= fmax) { hz = f; confidence = clamp(1 - b, 0, 1); }
      }
    }
    points.push({t, hz, confidence, rms});
    if (frame % 100 === 0) progress(frame / Math.max(nFrames, 1));
  }
  // Remove isolated octave errors only. Keep slides and vibrato in the raw trace.
  const cleaned = points.map(p => ({...p}));
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1].hz, b = points[i].hz, c = points[i + 1].hz;
    if (a && b && c && Math.abs(hzToMidi(a) - hzToMidi(c)) < 1 && Math.abs(hzToMidi(b) - (hzToMidi(a) + hzToMidi(c)) / 2) > 9) {
      cleaned[i].hz = null;
    }
  }
  progress(1);
  return {points: cleaned, energy, beats: estimateBeats(energy), sampleRate, hopSeconds: hop / sampleRate};
}

export function estimateBeats(energy) {
  const none = {bpm: null, times: [], confidence: 0, kind: 'estimated'};
  if (energy.length < 150) return none;
  const dt = energy[1].t - energy[0].t;
  const novelty = energy.map((p, i) => i ? Math.max(0, p.value - energy[i - 1].value) : 0);
  const peak = Math.max(...novelty);
  if (peak < 0.001) return none;
  for (let i = 0; i < novelty.length; i++) novelty[i] = Math.max(0, novelty[i] / peak - 0.05);
  const minLag = Math.round(60 / 180 / dt), maxLag = Math.min(Math.round(60 / 50 / dt), novelty.length / 3 | 0);
  let best = 0, lag = 0;
  for (let k = minLag; k <= maxLag; k++) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = k; i < novelty.length; i++) { dot += novelty[i] * novelty[i - k]; normA += novelty[i] ** 2; normB += novelty[i - k] ** 2; }
    const score = dot / (Math.sqrt(normA * normB) + 1e-12);
    if (score > best) { best = score; lag = k; }
  }
  if (best < 0.28 || !lag) return none;
  let phase = 0, phaseScore = -1;
  for (let p = 0; p < lag; p++) {
    let score = 0;
    for (let i = p; i < novelty.length; i += lag) score += novelty[i];
    if (score > phaseScore) { phase = p; phaseScore = score; }
  }
  if (phaseScore < 2) return none;
  const times = [];
  for (let i = phase; i < novelty.length; i += lag) times.push(energy[i].t);
  return {bpm: 60 / (lag * dt), times, confidence: best, kind: 'estimated'};
}

export function manualBeats(bpm, offset, duration) {
  const times = [];
  const interval = 60 / clamp(bpm, 20, 300);
  let t = offset - Math.floor(offset / interval) * interval;
  for (; t < duration; t += interval) times.push(t);
  return {bpm, times, confidence: 1, kind: 'manual'};
}

/** LRC line timestamps, enhanced LRC character/word timestamps, or untimed text. */
export function parseLyrics(text) {
  const entries = [], endings = [];
  let offset = 0;
  // A positive [offset:] (milliseconds) makes lyrics appear sooner.
  const offsetMatch = text.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  if (offsetMatch) offset = -Number(offsetMatch[1]) / 1000;
  const time = (m, s) => Number(m) * 60 + Number(s);
  for (const original of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = original.trim();
    // ID tags such as [ti:\u2026], [au:\u2026], [tool:\u2026] or [#:\u2026] carry no lyrics; timestamps start with digits.
    if (!line || /^\[(?:[a-z][\w-]*|#):/i.test(line)) continue;
    const stamps = [...line.matchAll(/\[(\d+):(\d{1,2}(?:\.\d+)?)\]/g)];
    const content = line.replace(/\[\d+:\d{1,2}(?:\.\d+)?\]/g, '').trim();
    const words = [];
    const segments = [...content.matchAll(/<(\d+):(\d{1,2}(?:\.\d+)?)>([^<]*)/g)];
    if (segments.length && segments[0].index > 0 && stamps.length) words.push({t: Math.max(0, time(stamps[0][1], stamps[0][2]) + offset), text: content.slice(0, segments[0].index)});
    for (const segment of segments) if (segment[3]) words.push({t: Math.max(0, time(segment[1], segment[2]) + offset), text: segment[3]});
    const clean = content.replace(/<\d+:\d{1,2}(?:\.\d+)?>/g, '');
    if (!clean) { for (const stamp of stamps) endings.push(Math.max(0, time(stamp[1], stamp[2]) + offset)); continue; }
    if (stamps.length) for (const stamp of stamps) {
      const entry = {t: Math.max(0, time(stamp[1], stamp[2]) + offset), text: clean, words: stamps.length === 1 ? words : []};
      const last = segments.at(-1); if (stamps.length === 1 && last && !last[3]) entry.end = Math.max(0, time(last[1], last[2]) + offset);
      entries.push(entry);
    }
    else entries.push({t: null, text: clean, words: []});
  }
  entries.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
  for (const entry of entries) if (entry.t !== null) {
    const next = entries.find(q => q.t !== null && q.t > entry.t)?.t ?? Infinity;
    const end = endings.filter(t => t > entry.t && t <= next).sort((a, b) => a - b)[0];
    if (end !== undefined) entry.end = Math.min(entry.end ?? Infinity, end);
  }
  return entries;
}

export function activeLyricIndex(lyrics, t) {
  let index = -1, latest = -Infinity;
  for (let i = 0; i < lyrics.length; i++) if (lyrics[i].t !== null && lyrics[i].t <= t && lyrics[i].t >= latest) { index = i; latest = lyrics[i].t; }
  return index >= 0 && lyrics[index].end !== undefined && t >= lyrics[index].end ? -1 : index;
}

export function encodeWav(channels, sampleRate) {
  const length = channels[0].length, count = channels.length;
  const data = new ArrayBuffer(44 + length * count * 2), view = new DataView(data);
  const str = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + length * count * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * count * 2, true); view.setUint16(32, count * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, length * count * 2, true);
  const pcm = new Int16Array(data, 44);
  for (let c = 0; c < count; c++) {
    const channel = channels[c];
    for (let i = 0, at = c; i < length; i++, at += count) {
      const v = channel[i];
      pcm[at] = v <= -1 ? -32768 : v >= 1 ? 32767 : v < 0 ? v * 32768 : v * 32767;
    }
  }
  return data;
}

// A generated glide/vibrato exercise, explicitly not a Peking-opera recording.
export function synthesizeDemo(sampleRate = 12000) {
  const duration = 24, length = duration * sampleRate;
  const vocals = new Float32Array(length), accompaniment = new Float32Array(length), original = new Float32Array(length);
  const anchors = [[0, 293.66], [2, 293.66], [3.2, 349.23], [4.5, 440], [5.4, 392], [7, 329.63], [8, 293.66], [9, 293.66], [10, 440], [11.5, 523.25], [12.7, 493.88], [14, 440], [16, 349.23], [17, 392], [18.2, 440], [19.2, 349.23], [21, 329.63], [23, 293.66], [24, 293.66]];
  let phase = 0, index = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    while (index < anchors.length - 2 && t > anchors[index + 1][0]) index++;
    const a = anchors[index], b = anchors[index + 1], u = clamp((t - a[0]) / (b[0] - a[0]), 0, 1);
    const hz = a[1] * (b[1] / a[1]) ** (u * u * (3 - 2 * u)) * 2 ** (0.16 * Math.sin(t * 2 * Math.PI * 5.3) / 12);
    phase += 2 * Math.PI * hz / sampleRate;
    const pause = (t > 7.5 && t < 8.3) || (t > 15.2 && t < 16.1);
    const env = Math.min(1, t * 4, (duration - t) * 3) * (pause ? 0 : 1);
    vocals[i] = env * (0.21 * Math.sin(phase) + 0.08 * Math.sin(2 * phase) + 0.04 * Math.sin(3 * phase));
    const pulse = Math.exp(-(t % 0.6) * 36);
    accompaniment[i] = 0.035 * Math.sin(2 * Math.PI * 146.83 * t) + 0.025 * Math.sin(2 * Math.PI * 220 * t) + 0.09 * pulse * Math.sin(2 * Math.PI * 1046.5 * t);
    original[i] = vocals[i] + accompaniment[i];
  }
  return {sampleRate, duration, original, vocals, accompaniment};
}
