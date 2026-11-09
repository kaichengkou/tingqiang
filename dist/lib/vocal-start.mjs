export function firstVocalTime(analysis, {preroll = 0.12, minVoiced = 0.18, maxGap = 0.06} = {}) {
  if (!analysis?.points.length) return null;
  const hop = analysis.hopSeconds || 0.02;
  let start = null, voiced = 0, gap = 0;
  for (const p of analysis.points) {
    if (p.hz && p.confidence >= 0.13 && p.rms >= 0.003) {
      if (start === null) start = p.t;
      gap = 0; voiced += hop;
      if (voiced >= minVoiced - 1e-8) return Math.max(0, start - preroll);
    } else {
      gap += hop;
      if (gap > maxGap + 1e-8) { start = null; voiced = 0; }
    }
  }
  return null;
}
