/**
 * Pure per-sample arithmetic used to derive stems from a demixed source.
 *
 * These are deliberately free of any browser or ONNX dependency so they can be
 * unit-tested directly. The level-parity bug against python-audio-separator
 * lived entirely in *which* of these ran and in *what order* -- see
 * mdx_separator.ts `separate()` -- so each step is isolated here rather than
 * inlined into that method.
 */

/** Largest absolute sample value across every channel. Returns 0 for empty input. */
export function peakAmplitude(wave: Float32Array[]): number {
  let peak = 0;
  for (const channel of wave) {
    for (let i = 0; i < channel.length; i++) {
      const abs = Math.abs(channel[i]);
      if (abs > peak) peak = abs;
    }
  }
  return peak;
}

/** Multiplies every sample by `gain`. Returns new arrays; does not mutate input. */
export function applyGain(wave: Float32Array[], gain: number): Float32Array[] {
  return wave.map(channel => {
    const out = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      out[i] = channel[i] * gain;
    }
    return out;
  });
}

/**
 * Derives the secondary stem: `mix - (primary * compensate)`.
 *
 * The `compensate` factor belongs here and ONLY here. Upstream's demix() returns
 * an uncompensated source and applies the factor at this subtraction, so the
 * estimate being removed is slightly larger than the raw prediction. Applying it
 * earlier (e.g. inside demix) scales the primary instead and leaves this
 * subtraction removing too little, which makes the derived stem too loud --
 * the exact ~15% divergence this function was extracted to pin down.
 *
 * Channel counts and lengths may differ; the result is sized to the larger of
 * each and the shorter input is treated as zero-padded.
 */
export function deriveSecondaryStem(
  mix: Float32Array[],
  primary: Float32Array[],
  compensate: number
): Float32Array[] {
  const channels = Math.max(mix.length, primary.length);
  const length = Math.max(mix[0]?.length ?? 0, primary[0]?.length ?? 0);

  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const m = mix[c];
    const p = primary[c];
    const dst = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const mv = m && i < m.length ? m[i] : 0;
      const pv = p && i < p.length ? p[i] : 0;
      dst[i] = mv - pv * compensate;
    }
    out.push(dst);
  }
  return out;
}

/**
 * Peak-normalizes a waveform: scaled down to `maxPeak` when it exceeds it,
 * up to `minPeak` when it falls below that (and is nonzero), else unchanged.
 * Mirrors spec_utils.normalize() upstream.
 */
export function normalizeToPeak(
  wave: Float32Array[],
  maxPeak = 1.0,
  minPeak?: number
): Float32Array[] {
  const peak = peakAmplitude(wave);

  let gain = 1;
  if (peak > maxPeak) {
    gain = maxPeak / peak;
  } else if (minPeak !== undefined && peak < minPeak && peak > 0) {
    gain = minPeak / peak;
  }

  return applyGain(wave, gain);
}
