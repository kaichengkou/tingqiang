/** Keep stem level and timing in one shared domain. */
export function normalizeMix(channels) {
  let peak = 1e-8;
  for (const channel of channels) for (const x of channel) peak = Math.max(peak, Math.abs(x));
  return {peak, channels: channels.map(channel => Float32Array.from(channel, x => x / peak))};
}

export function deriveBrowserStems(mix, prediction, peak, compensate = 1.065) {
  const accompaniment = prediction.map(channel => Float32Array.from(channel, x => x * peak * compensate));
  return finalizeBrowserStems(mix, accompaniment);
}

export function finalizeBrowserStems(mix, accompaniment) {
  const vocals = accompaniment.map((channel, ch) => Float32Array.from(channel, (x, i) => mix[ch][i] - x));
  let max = 1;
  for (const channel of [...vocals, ...accompaniment]) for (const x of channel) max = Math.max(max, Math.abs(x));
  const gain = max > 1 ? 0.98 / max : 1;
  if (gain !== 1) for (const channel of [...vocals, ...accompaniment]) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
  return {vocals, accompaniment, gain};
}
