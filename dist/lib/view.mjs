// The timeline moves continuously beneath a fixed centre playhead.
export function centeredTimeView(currentTime, windowSeconds = 8) {
  const span = Number.isFinite(Number(windowSeconds)) && Number(windowSeconds) > 0 ? Number(windowSeconds) : 8;
  const now = Math.max(0, Number(currentTime) || 0);
  return {start: now - span / 2, end: now + span / 2, span};
}

export function pitchAtTime(analysis, time) {
  if (!analysis?.points.length) return null;
  const points = analysis.points;
  const index = Math.floor((time - points[0].t) / analysis.hopSeconds);
  const a = points[index], b = points[index + 1];
  if (!a?.hz || !b?.hz || b.t - a.t > 0.05 || Math.abs(12 * Math.log2(a.hz / b.hz)) > 3) return null;
  const u = Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
  return a.hz * (b.hz / a.hz) ** u;
}
