/**
 * PffftSTFT: STFT/ISTFT using a real, mixed-radix wasm FFT (pffft) instead
 * of tfjs's FFT or onnxruntime-web's wasm Bluestein fallback.
 *
 * This class reproduces the exact numerics of
 * `src/separator/architectures/stft.ts` (the tfjs reference implementation
 * this replaces) -- reflect-pad (torch center=True semantics, no edge
 * repeat), periodic Hann window, unnormalized FFT with explicit 1/nFft
 * scaling on the inverse, hop-decomposed overlap-add, and the "sum of
 * squared shifted windows + 1e-8" OLA normalization envelope -- but does
 * the actual forward/inverse transforms via pffft instead of tf.spectral
 * rfft/irfft, and operates on plain Float32Arrays (no tensors).
 *
 * pffft's ordered real-FFT output is a *packed* onesided spectrum, not the
 * usual N/2+1 explicit complex bins: see build.sh's header comment and
 * scratch-pffft-bench/RESULTS.md section 5 for the empirically-confirmed
 * layout, summarized here:
 *   - N floats total (N/2 complex-sized slots) for a real transform of
 *     size N.
 *   - slot 0 is special: out[0] = Re(F(0)) (DC), out[1] = Re(F(N/2))
 *     (Nyquist) -- both purely real, packed together into one slot.
 *   - for k = 1 .. N/2-1: out[2k] = Re(F(k)), out[2k+1] = Im(F(k)).
 * The low-frequency masking (zeroing bins 0..2) that used to live partly
 * in mdx_separator's tfjs path and partly inside pre.onnx now lives here,
 * inside forward() -- downstream code doesn't need to do it separately.
 */

import createPffftModule, { type PffftModule } from './pffft-wasm.js';

const PFFFT_FORWARD = 0;
const PFFFT_BACKWARD = 1;
const PFFFT_REAL = 0;

const ZERO_BINS = 3; // low-frequency bins zeroed by forward(), matching pre.onnx's mask.

export class PffftSTFT {
  private nFft: number;
  private hopLength: number;
  private dimF: number;

  // Shared/static module-loading promise: multiple PffftSTFT instances (if
  // ever constructed) share one compiled+instantiated wasm module instead
  // of each paying compile/instantiate cost redundantly.
  private static modulePromise: Promise<PffftModule> | null = null;

  private mod!: PffftModule;
  private setup = 0;
  // Persistent heap buffers for the real transform, sized nFft floats each,
  // allocated once in init() and reused across every frame/signal/call.
  private inPtr = 0;
  private outPtr = 0;
  private workPtr = 0;

  // Precomputed periodic Hann window (float32), length nFft.
  private hannWindow: Float32Array;

  // Allocation-free per-frame scratch buffer (nFft floats), reused across
  // every frame iteration in forward()/inverse().
  private frameScratch: Float32Array;

  // ISTFT OLA normalization envelope cache, keyed by dimT (frame count).
  // The envelope only depends on dimT/nFft/hopLength (all fixed per
  // instance) so it's computed once per distinct dimT and reused.
  private normEnvelopeCache = new Map<number, Float32Array>();

  constructor(nFft: number, hopLength: number, dimF: number) {
    if (nFft % 32 !== 0) {
      throw new Error(`PffftSTFT: nFft (${nFft}) must be a multiple of 32 (pffft real-transform requirement)`);
    }

    this.nFft = nFft;
    this.hopLength = hopLength;
    this.dimF = dimF;

    this.hannWindow = new Float32Array(nFft);
    for (let i = 0; i < nFft; i++) {
      this.hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / nFft));
    }

    this.frameScratch = new Float32Array(nFft);
  }

  async init(): Promise<void> {
    if (!PffftSTFT.modulePromise) {
      PffftSTFT.modulePromise = createPffftModule();
    }
    this.mod = await PffftSTFT.modulePromise;

    this.setup = this.mod._pffft_new_setup(this.nFft, PFFFT_REAL);
    if (this.setup === 0) {
      throw new Error(`PffftSTFT: pffft_new_setup(${this.nFft}, PFFFT_REAL) failed (returned NULL)`);
    }

    const nBytes = this.nFft * 4;
    this.inPtr = this.mod._pffft_aligned_malloc(nBytes);
    this.outPtr = this.mod._pffft_aligned_malloc(nBytes);
    this.workPtr = this.mod._pffft_aligned_malloc(nBytes);
    if (!this.inPtr || !this.outPtr || !this.workPtr) {
      throw new Error('PffftSTFT: pffft_aligned_malloc failed');
    }

    const simdArch = this.simdArchString();
    console.info(`pffft wasm FFT ready (simd_arch=${simdArch})`);
  }

  private simdArchString(): string {
    const ptr = this.mod._pffft_simd_arch();
    const bytes = this.mod.HEAPU8;
    let s = '';
    for (let i = ptr; bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  private dimTFor(chunkSize: number): number {
    const pad = this.nFft / 2;
    return Math.floor((chunkSize + 2 * pad - this.nFft) / this.hopLength) + 1;
  }

  /**
   * Reflect-pad `pad` samples on each end of `src` (length `n`, read from
   * `src[srcOffset .. srcOffset+n)`), writing `n + 2*pad` samples into
   * `dst` starting at `dstOffset`. Torch center=True semantics: reflect
   * WITHOUT repeating the edge sample (matches tf.mirrorPad's 'reflect'
   * mode). E.g. pad=2 on [1,2,3,4,5] -> [3,2,1,2,3,4,5,4,3].
   */
  private reflectPadInto(
    src: Float32Array,
    srcOffset: number,
    n: number,
    pad: number,
    dst: Float32Array,
    dstOffset: number
  ): void {
    for (let i = 0; i < pad; i++) {
      dst[dstOffset + i] = src[srcOffset + pad - i];
    }
    for (let i = 0; i < n; i++) {
      dst[dstOffset + pad + i] = src[srcOffset + i];
    }
    for (let i = 0; i < pad; i++) {
      dst[dstOffset + pad + n + i] = src[srcOffset + n - 2 - i];
    }
  }

  /**
   * forward(): [batch, 2, chunkSize] -> [batch, 4, dimF, dimT]
   * Channel order in dim-1: L_re, L_im, R_re, R_im.
   */
  forward(batchData: Float32Array, batch: number, chunkSize: number): Float32Array {
    const { nFft, hopLength, dimF } = this;
    // chunkSize (not nFft) must be an exact multiple of hopLength: the
    // reflect-pad adds exactly nFft samples total (pad on each end), which
    // cancels out of dimTFor's frame-count formula, so dimTFor is exact --
    // and inverse() reconstructs the same chunkSize -- only when this holds.
    if (chunkSize % hopLength !== 0) {
      throw new Error(`PffftSTFT.forward: chunkSize (${chunkSize}) must be an exact multiple of hopLength (${hopLength})`);
    }
    const pad = nFft / 2;
    const dimT = this.dimTFor(chunkSize);
    const paddedLength = chunkSize + 2 * pad;

    const out = new Float32Array(batch * 4 * dimF * dimT);
    const padded = new Float32Array(paddedLength);

    const heap = this.mod.HEAPF32;
    const inIdx = this.inPtr >> 2;
    const outIdx = this.outPtr >> 2;

    for (let b = 0; b < batch; b++) {
      for (let ch = 0; ch < 2; ch++) {
        const srcOffset = (b * 2 + ch) * chunkSize;
        this.reflectPadInto(batchData, srcOffset, chunkSize, pad, padded, 0);

        const reChanIdx = 2 * ch + 0;
        const imChanIdx = 2 * ch + 1;
        const reBase = ((b * 4 + reChanIdx) * dimF) * dimT;
        const imBase = ((b * 4 + imChanIdx) * dimF) * dimT;

        for (let t = 0; t < dimT; t++) {
          const frameStart = t * hopLength;
          // Window this frame into the scratch buffer (allocation-free).
          for (let i = 0; i < nFft; i++) {
            this.frameScratch[i] = padded[frameStart + i] * this.hannWindow[i];
          }

          // Copy into wasm heap, run forward transform, read back.
          heap.set(this.frameScratch, inIdx);
          this.mod._pffft_transform_ordered(this.setup, this.inPtr, this.outPtr, this.workPtr, PFFFT_FORWARD);
          const heapAfter = this.mod.HEAPF32;

          // Scatter packed pffft output into [dimF] re/im bins, skipping
          // (leaving zero) the first ZERO_BINS bins (low-frequency mask).
          // bin 0: (heapAfter[outIdx+0], 0) -- imaginary part of DC is
          // definitionally 0, so it's simply never written (stays
          // zero-initialized) even when bin 0 is not part of the mask.
          for (let f = ZERO_BINS; f < dimF; f++) {
            let re: number;
            let im: number;
            if (f === 0) {
              re = heapAfter[outIdx + 0];
              im = 0;
            } else {
              re = heapAfter[outIdx + 2 * f];
              im = heapAfter[outIdx + 2 * f + 1];
            }
            out[reBase + f * dimT + t] = re;
            out[imBase + f * dimT + t] = im;
          }
        }
      }
    }

    return out;
  }

  /**
   * Sum of squared, hop-shifted periodic Hann windows (+1e-8), used to
   * normalize overlap-add output. Depends only on dimT (nFft/hopLength are
   * fixed per instance), so cached and computed once per distinct dimT.
   */
  private getNormEnvelope(dimT: number): Float32Array {
    let env = this.normEnvelopeCache.get(dimT);
    if (env) return env;

    const { nFft, hopLength } = this;
    const paddedLength = (dimT - 1) * hopLength + nFft;
    env = new Float32Array(paddedLength);
    for (let t = 0; t < dimT; t++) {
      const offset = t * hopLength;
      for (let i = 0; i < nFft; i++) {
        const w = this.hannWindow[i];
        env[offset + i] += w * w;
      }
    }
    for (let i = 0; i < paddedLength; i++) {
      env[i] += 1e-8;
    }
    this.normEnvelopeCache.set(dimT, env);
    return env;
  }

  /**
   * inverse(): [batch, 4, dimF, dimT] -> [batch, 2, chunkSize]
   */
  inverse(specData: Float32Array, batch: number): Float32Array {
    const { nFft, hopLength, dimF } = this;
    const pad = nFft / 2;
    const totalLen = specData.length;
    const dimT = totalLen / (batch * 4 * dimF);
    if (!Number.isInteger(dimT)) {
      throw new Error(
        `PffftSTFT.inverse: specData length (${totalLen}) not consistent with batch=${batch}, dimF=${dimF}`
      );
    }

    const paddedLength = (dimT - 1) * hopLength + nFft;
    const chunkSize = paddedLength - 2 * pad;
    const halfN = nFft / 2; // Nyquist bin index; dimF (2048) < halfN (2560) in production.

    const out = new Float32Array(batch * 2 * chunkSize);
    const accumulator = new Float32Array(paddedLength);
    const envelope = this.getNormEnvelope(dimT);

    const heap = this.mod.HEAPF32;
    const inIdx = this.inPtr >> 2;
    const outIdx = this.outPtr >> 2;

    for (let b = 0; b < batch; b++) {
      for (let ch = 0; ch < 2; ch++) {
        accumulator.fill(0);

        const reChanIdx = 2 * ch + 0;
        const imChanIdx = 2 * ch + 1;
        const reBase = ((b * 4 + reChanIdx) * dimF) * dimT;
        const imBase = ((b * 4 + imChanIdx) * dimF) * dimT;

        for (let t = 0; t < dimT; t++) {
          // Assemble the packed pffft onesided spectrum for this frame.
          // Bins >= dimF (up to and including Nyquist, halfN) are zero.
          this.frameScratch.fill(0);

          // slot 0: [Re(bin0), Re(bin halfN)]. Re(bin halfN) is zero since
          // dimF (2048) < halfN (2560) in production, so it's always 0
          // here unless dimF happened to equal halfN (not the case for
          // this geometry, but the code below is written generally: if
          // dimF > halfN this indexing would need adjustment, which we
          // don't support -- dimF is expected to be <= halfN).
          if (dimF > 0) {
            this.frameScratch[0] = specData[reBase + 0 * dimT + t];
          }
          if (dimF > halfN) {
            this.frameScratch[1] = specData[reBase + halfN * dimT + t];
          }
          // f = 1 .. min(dimF, halfN) - 1 read from specData; rest stay zero.
          const fMax = Math.min(dimF, halfN);
          for (let f = 1; f < fMax; f++) {
            this.frameScratch[2 * f] = specData[reBase + f * dimT + t];
            this.frameScratch[2 * f + 1] = specData[imBase + f * dimT + t];
          }

          // Run backward transform.
          heap.set(this.frameScratch, inIdx);
          this.mod._pffft_transform_ordered(this.setup, this.inPtr, this.outPtr, this.workPtr, PFFFT_BACKWARD);
          const heapAfter = this.mod.HEAPF32;

          // Scale by 1/nFft, window, and overlap-add into the accumulator.
          const frameStart = t * hopLength;
          for (let i = 0; i < nFft; i++) {
            const sample = (heapAfter[outIdx + i] / nFft) * this.hannWindow[i];
            accumulator[frameStart + i] += sample;
          }
        }

        // Normalize by the OLA envelope, then trim pad from both ends.
        const dstOffset = (b * 2 + ch) * chunkSize;
        for (let i = 0; i < chunkSize; i++) {
          out[dstOffset + i] = accumulator[pad + i] / envelope[pad + i];
        }
      }
    }

    return out;
  }
}
