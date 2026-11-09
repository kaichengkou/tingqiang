import {finalizeBrowserStems} from './stem-mix.mjs?v=0.4';

/** One session shared by threads: extra sessions each cost about 1 GB and ran slower past four (docs/validation-v07.md).
 * Threads gain little past about 12, and playback needs what is left. Threads require cross-origin isolation. */
export const separationThreads = (cores, isolated) => isolated ? Math.max(1, Math.min(12, (cores || 1) - 2)) : 1;

/** Bound the model/STFT workspace for long recordings; all output indices are
 * original sample indices. Context and crossfade prevent audible block seams. */
export async function separateAudioBlocks(channels, predict, {blockFrames = 1024 * 1024, contextFrames = 1024 * 86, fadeFrames = 4096, compensate = 1.065, progress = () => {}} = {}) {
  const length = channels[0].length;
  let peak = 1e-8;
  for (const channel of channels) for (const x of channel) peak = Math.max(peak, Math.abs(x));
  const accompaniment = channels.map(() => new Float32Array(length));
  for (let core = 0; core < length; core += blockFrames) {
    const end = Math.min(length, core + blockFrames), writeEnd = Math.min(length, end + fadeFrames);
    const from = Math.max(0, core - contextFrames), to = Math.min(length, writeEnd + contextFrames);
    const block = channels.map(channel => Float32Array.from(channel.subarray(from, to), x => x / peak));
    const result = await predict(block, {start: core / length, end: end / length});
    for (let ch = 0; ch < channels.length; ch++) for (let i = core; i < writeEnd; i++) {
      const value = result[ch][i - from] * peak * compensate;
      const u = core && i < core + fadeFrames ? Math.min(1, (i - core) / fadeFrames) : 1;
      accompaniment[ch][i] = accompaniment[ch][i] * (1 - u) + value * u;
    }
    progress(end / length);
  }
  // Reuse the shared gain/reconstruction policy, with an already scaled stem.
  return finalizeBrowserStems(channels, accompaniment);
}
