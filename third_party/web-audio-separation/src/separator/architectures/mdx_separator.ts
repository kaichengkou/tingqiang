import * as ort from 'onnxruntime-web';

import { CommonSeparator, SeparationStage, SeparatorConfig } from '../common_separator';
import { AudioUtils } from '../../utils/audio_utils';
import { applyGain, deriveSecondaryStem, peakAmplitude } from '../../utils/stem_math';
import { PffftSTFT } from './pffft/pffft_stft';

export interface MDXArchConfig {
  segmentSize?: number;
  overlap?: number;
  batchSize?: number;
  hopLength?: number;
  enableDenoise?: boolean;
  /**
   * @deprecated No longer has any effect. STFT/ISTFT now always run through
   * PffftSTFT (a mixed-radix wasm FFT operating on plain Float32Arrays); the
   * old tfjs (WebGL) and ONNX-session (pre.onnx/post.onnx) STFT paths have
   * been removed. Kept in the config type only so old call sites don't fail
   * to compile; passing it triggers a warning log, nothing more.
   */
  stftBackend?: 'onnx' | 'tfjs';
  /** ORT execution providers, in preference order. Default ['webgpu', 'wasm']. */
  executionProviders?: ('webgpu' | 'wasm' | 'webnn')[];
}

export class MDXSeparator extends CommonSeparator {
  // Architecture-specific configuration
  private segmentSize: number;
  private overlap: number;
  private batchSize: number;
  private hopLength: number;
  private enableDenoise: boolean;

  // Model-specific parameters from model data
  private compensate: number;
  private dimF: number;
  private dimT: number;
  private nFft: number;
  private configYaml?: string;

  // ONNX model and runtime
  private model?: ort.InferenceSession;

  private executionProviders: ('webgpu' | 'wasm' | 'webnn')[];

  // Processing parameters
  private nBins: number = 0;
  private trim: number = 0;
  private chunkSize: number = 0;
  private genSize: number = 0;
  private stft?: PffftSTFT;


  // State during processing
  private primarySource?: Float32Array[];
  private secondarySource?: Float32Array[];
  private audioFilePath?: string;

  // Per-category timing accumulators for the demix() TIMING_SUMMARY log.
  private timings: Map<string, number> = new Map();

  constructor(commonConfig: SeparatorConfig, archConfig: MDXArchConfig) {
    super(commonConfig);

    // Initialize architecture-specific parameters
    this.segmentSize = archConfig.segmentSize || 256;
    this.overlap = archConfig.overlap || 0.25;
    // ?? (not ||) so an explicit batchSize survives. The ONNX model accepts
    // dynamic batch (probed 2026-07: B=1/2/4 all run), but on Apple-silicon
    // WebGPU batched dispatches run serially with added overhead (full song:
    // 25.8s @ B1 vs 29.2s @ B4), so the default stays 1. Raise it only if
    // measurement on the target GPU says otherwise.
    this.batchSize = Math.max(1, archConfig.batchSize ?? 1);
    this.hopLength = archConfig.hopLength || 1024;
    this.enableDenoise = archConfig.enableDenoise || false;
    if (archConfig.stftBackend !== undefined) {
      this.warning(`stftBackend (${archConfig.stftBackend}) is deprecated and ignored; ` +
        `STFT/ISTFT always run through PffftSTFT now.`);
    }
    this.executionProviders = archConfig.executionProviders ?? ['webgpu', 'wasm'];

    this.debug(`MDX arch params: batchSize=${this.batchSize}, segmentSize=${this.segmentSize}`);
    this.debug(`MDX arch params: overlap=${this.overlap}, hopLength=${this.hopLength}, enableDenoise=${this.enableDenoise}`);
    this.debug(`MDX arch params: executionProviders=${this.executionProviders}`);

    // Initialize model-specific parameters
    this.compensate = this.modelData.compensate || 1.0;
    this.dimF = this.modelData.mdx_dim_f_set || 3072;
    this.dimT = Math.pow(2, this.modelData.mdx_dim_t_set || 8);
    this.nFft = this.modelData.mdx_n_fft_scale_set || 7680;
    this.configYaml = this.modelData.config_yaml;

    // Geometry guard: PffftSTFT requires nFft to be a multiple of 32 (its
    // real-transform requirement). Check here, at construction time, for a
    // clear error instead of a less legible throw from inside PffftSTFT's
    // constructor. nFft need not be a multiple of hopLength -- the chunk
    // size (computed from segmentSize/hopLength, independent of nFft) is
    // what has to divide evenly by hopLength, and that's enforced where it
    // matters, in PffftSTFT.forward().
    if (this.nFft % 32 !== 0) {
      throw new Error(`MDXSeparator: nFft (${this.nFft}) must be a multiple of 32 (pffft real-transform requirement)`);
    }

    this.debug(`MDX arch params: compensate=${this.compensate}, dimF=${this.dimF}, dimT=${this.dimT}, nFft=${this.nFft}`);
    this.debug(`MDX arch params: configYaml=${this.configYaml}`);
  }

  async loadModel(): Promise<void> {
    this.debug('Loading ONNX model for inference...');
    this.reportProgress({ stage: SeparationStage.LoadingModel, fraction: 0 });

    // Download model if not already downloaded
    if (!this.model) {
      await this.downloadModel();
    }

    // Initialize ONNX runtime
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      // Prefer WebGPU for inference; ORT falls back to wasm (CPU) when no GPU adapter.
      executionProviders: this.executionProviders,
      logSeverityLevel: this.logLevel === 'debug' ? 0 : 3,
    };

    // Configure WASM paths. The .wasm assets must match the version of the
    // onnxruntime-web JS glue that loads them, so read the version off ORT
    // itself rather than hardcoding it -- onnxruntime-web is a peer dep on a
    // caret range, so a hardcoded constant silently goes stale as consumers
    // pick up newer minors.
    const wasmVersion = ort.env.versions.web;
    ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;

    // Multithreaded wasm needs SharedArrayBuffer, which requires cross-origin
    // isolation (COOP/COEP headers). The caller sets ort.env.wasm.numThreads.
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    const webgpuPossible = typeof navigator !== 'undefined' && 'gpu' in navigator;
    this.info(`Backend availability: webgpu=${webgpuPossible ? 'possible (navigator.gpu present)' : 'unavailable (no navigator.gpu)'}, crossOriginIsolated=${isolated}`);
    this.info(`WASM fallback threads: ${isolated ? ort.env.wasm.numThreads : 'default (single-threaded; serve with COOP/COEP headers to enable multithreading)'}`);

    // Load the model
    this.model = await ort.InferenceSession.create(this.modelPath, sessionOptions);
    this.debug('Model loaded successfully using ONNXruntime inferencing session.');

    // Initialize processing parameters
    this.initializeModelSettings();

    // PffftSTFT compiles/instantiates its wasm module here; it logs its own
    // "pffft wasm FFT ready (simd_arch=...)" info line.
    await this.stft!.init();

    this.reportProgress({ stage: SeparationStage.LoadingModel, fraction: 1 });
  }

  /** Milliseconds for one model pass once its shaders are compiled, so a caller can choose a backend on real speed. */
  async measureInference(): Promise<number> {
    const pass = () => this.model!.run({ input: new ort.Tensor('float32', new Float32Array(4 * this.dimF * this.dimT), [1, 4, this.dimF, this.dimT]) });
    await pass();
    const start = performance.now();
    await pass();
    return performance.now() - start;
  }

  async release(): Promise<void> {
    await this.model?.release();
    this.model = undefined;
  }

  private async downloadModel(): Promise<void> {
    if (this.modelPath instanceof Uint8Array) return;
    // Legacy fallback for callers constructing MDXSeparator directly without
    // modelUrl (e.g. pre-registry call sites); new code should go through
    // createSeparator()/MODEL_REGISTRY, which always sets modelUrl.
    const modelUrl = this.modelUrl ?? 'https://huggingface.co/AI4future/RVC/resolve/main/UVR_MDXNET_KARA_2.onnx';
    this.info(`Downloading ${this.modelName} model from ${modelUrl}...`);

    try {
      const buffer = await this.fetchModelWithCache(modelUrl);

      // Store the model data
      this.modelPath = URL.createObjectURL(new Blob([buffer]));

      this.info('Model downloaded successfully');
    } catch (error) {
      this.error(`Error downloading model: ${error}`);
      throw error;
    }
  }

  // Fetch the model bytes, using Cache Storage ('web-demix2-models') so runs after
  // the first skip the network. Any cache failure degrades to a plain fetch.
  private async fetchModelWithCache(modelUrl: string): Promise<ArrayBuffer> {
    let cache: Cache | undefined;

    if (typeof caches !== 'undefined') {
      try {
        cache = await caches.open('web-demix2-models');
        const cached = await cache.match(modelUrl);
        if (cached) {
          this.info('Model cache hit: using cached bytes, skipping network download');
          return await cached.arrayBuffer();
        }
        this.info('Model cache miss: downloading from network');
      } catch (error) {
        this.debug(`Cache Storage unavailable, falling back to network: ${error}`);
        cache = undefined;
      }
    }

    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`Failed to download model: ${response.statusText}`);
    }

    if (cache) {
      try {
        // Clone before consuming the body so the original stream stays readable
        await cache.put(modelUrl, response.clone());
        this.info('Model stored in Cache Storage for future runs');
      } catch (error) {
        this.debug(`Failed to store model in Cache Storage: ${error}`);
      }
    }

    return await response.arrayBuffer();
  }

  private initializeModelSettings(): void {
    this.debug('Initializing model settings...');

    // n_bins is half the FFT size plus one
    this.nBins = Math.floor(this.nFft / 2) + 1;

    // trim is half the FFT size
    this.trim = Math.floor(this.nFft / 2);

    // chunk_size calculation from Python: self.hop_length * (self.segment_size - 1)
    // (261120 for the default segmentSize=256/hopLength=1024). This is
    // independent of nFft, and is always a multiple of hopLength by
    // construction, which is all PffftSTFT.forward() requires.
    this.chunkSize = this.hopLength * (this.segmentSize - 1);


    // gen_size is the chunk size minus twice the trim size
    this.genSize = this.chunkSize - (2 * this.trim);

    // Initialize STFT (constructed once; subsequent calls to
    // initializeModelSettings() -- e.g. from demix() -- reuse the existing
    // instance rather than re-allocating and re-initializing the wasm module).
    if (!this.stft) {
      this.stft = new PffftSTFT(this.nFft, this.hopLength, this.dimF);
    }

    this.debug(`Model input params: nFft=${this.nFft} hopLength=${this.hopLength} dimF=${this.dimF}`);
    this.debug(`Model settings: nBins=${this.nBins}, trim=${this.trim}, chunkSize=${this.chunkSize}, genSize=${this.genSize}`);

    // Verify chunk size will produce correct frames
    const expectedFrames = Math.floor((this.chunkSize - this.nFft) / this.hopLength) + 1;
    this.debug(`Expected frames from chunk size: ${expectedFrames}, Target: ${this.segmentSize}`);
  }

  async separate(audioFilePath: string, customOutputNames?: Record<string, string>): Promise<string[]> {
    this.audioFilePath = audioFilePath;

    // Load audio file
    this.debug(`Loading audio file ${audioFilePath}...`);
    const audioChannels: Float32Array[] = await AudioUtils.loadAudioFile(audioFilePath, this.sampleRate);

    // Prepare the mix for processing
    this.debug(`Preparing mix for input audio file ${this.audioFilePath}...`);
    const mix = await this.prepareMix(audioChannels);

    this.debug('Normalizing mix before demixing...');
    // Capture the pre-normalization peak; the demixed source is scaled back up
    // by it so the stems return to the original recording's level.
    const peak = peakAmplitude(mix);
    const normalizedMix = await this.normalize(mix, this.normalizationThreshold, this.amplificationThreshold);

    // Start the demixing process
    const source = applyGain(await this.demix(normalizedMix), peak);
    this.debug('Demixing completed.');

    // Initialize the list for output files
    const outputFiles: string[] = [];
    this.debug('Processing output files...');
    this.reportProgress({ stage: SeparationStage.WritingOutput, fraction: 0 });

    // The primary source is the demixed source as-is. Upstream applies no
    // normalization here -- both stems are normalized at write time instead.
    if (!this.primarySource) {
      this.primarySource = source;
    }

    // Process the secondary source if not already an array
    if (!this.secondarySource) {
      this.debug('Producing secondary source');

      if (this.invertUsingSpec) {
        throw Error('invertUsingSpec is not implemented');
        // For spectral inversion, we'd need to implement invertStem method
        // const rawMix = await this.demix(normalizedMix, true);
        // this.secondarySource = this.invertStem(rawMix, source);
      } else {
        this.debug('Inverting secondary stem by subtracting demixed stem from original mix');
        // Upstream subtracts from the *normalized* mix (its `mix` is rebound to
        // the normalized array before demixing), even though `source` has been
        // scaled back up by `peak`. Mirror that exactly rather than "correcting"
        // the domain mismatch -- parity with upstream is the goal here.
        this.secondarySource = deriveSecondaryStem(normalizedMix, this.primarySource, this.compensate);
      }
    }

    // outputSingleStem, when set, restricts writing to just that one stem;
    // otherwise both are written. Drives the writing-output fraction below.
    const stemsToWrite = this.outputSingleStem ? 1 : 2;

    // Save and process the secondary stem if needed
    if (!this.outputSingleStem || this.outputSingleStem.toLowerCase() === this.secondaryStemName.toLowerCase()) {
      const secondaryPath = this.getStemOutputPath(this.secondaryStemName, customOutputNames);

      this.info(`Saving secondary ${this.secondaryStemName} stem to ${secondaryPath}...`);
      const secondaryUrl = await this.saveAudioOutput(secondaryPath, this.secondarySource!, this.secondaryStemName);
      outputFiles.push(secondaryUrl);
      this.reportProgress({ stage: SeparationStage.WritingOutput, fraction: outputFiles.length / stemsToWrite });
    }

    // Save and process the primary stem if needed
    if (!this.outputSingleStem || this.outputSingleStem.toLowerCase() === this.primaryStemName.toLowerCase()) {
      const primaryPath = this.getStemOutputPath(this.primaryStemName, customOutputNames);

      if (!this.primarySource) {
        this.primarySource = source;
      }

      this.info(`Saving primary ${this.primaryStemName} stem to ${primaryPath}...`);
      const primaryUrl = await this.saveAudioOutput(primaryPath, this.primarySource, this.primaryStemName);
      outputFiles.push(primaryUrl);
      this.reportProgress({ stage: SeparationStage.WritingOutput, fraction: outputFiles.length / stemsToWrite });
    }

    return outputFiles;
  }

  // Method to prepare mix for processing
  async prepareMix(audioData: Float32Array[]): Promise<Float32Array[]> {
    this.debug(`Preparing mix for input audio...`);
    return super.prepareMix(audioData);
  }

  // Method to normalize audio
  async normalize(
    wave: Float32Array[],
    maxPeak = 1.0,
    minPeak?: number            // optional
  ): Promise<Float32Array[]> {
    this.debug('Normalizing audio...');
    return super.normalize(wave, maxPeak, minPeak);
  }

  /**
   * Demix a [channels][samples] mix (2 channels expected) into a source
   * stem, also returned as [channels][samples] (single "batch" of 2
   * channels; there's no leading batch dimension since we only ever
   * process one file at a time here).
   */
  async demix(mix: Float32Array[], isMatchMix: boolean = false): Promise<Float32Array[]> {
    const start = performance.now();
    this.timings.clear();
    this.initializeModelSettings();

    this.debug(`Original mix stored. Channels: ${mix.length}, samples: ${mix[0]?.length}`);

    // Handling different chunk sizes and overlaps based on the matching requirement
    let chunkSize: number;
    let overlap: number;

    if (isMatchMix) {
      // Sets a smaller chunk size specifically for matching the mix
      chunkSize = this.hopLength * (this.segmentSize - 1);
      // Sets a small overlap for the chunks
      overlap = 0.02;
      this.debug(`Chunk size for matching mix: ${chunkSize}, Overlap: ${overlap}`);
    } else {
      // Uses the regular chunk size defined in model settings
      chunkSize = this.chunkSize;
      // Uses the overlap specified in the model settings
      overlap = this.overlap;
      this.debug(`Standard chunk size: ${chunkSize}, Overlap: ${overlap}`);
    }

    // Calculate the generated size after subtracting the trim from both ends of the chunk
    const genSize = chunkSize - 2 * this.trim;
    this.debug(`Generated size calculated: ${genSize}`);

    // Calculate padding to make the mix length a multiple of the generated size
    const mixLength = mix[0].length;  // mix is [channels][time]
    const pad = genSize + this.trim - (mixLength % genSize);

    // Build the padded mixture on the CPU: [2][trim + mixLength + pad].
    const mixtureLength = this.trim + mixLength + pad;
    const mixtureData = new Float32Array(2 * mixtureLength);
    for (let ch = 0; ch < 2; ch++) {
      const dstOffset = ch * mixtureLength;
      mixtureData.set(mix[ch], dstOffset + this.trim);
      // leading `trim` and trailing `pad` samples stay zero (fresh Float32Array).
    }
    this.debugArrayStats(mixtureData, `runModel: padded mixture`);

    // Calculate the step size for processing chunks based on the overlap
    const step = Math.floor((1 - overlap) * chunkSize);
    this.debug(`Step size for processing chunks: ${step} as overlap is set to ${overlap}.`);

    // CPU-side overlap-add accumulators over the full padded mixture.
    // Per-chunk GPU pad/add over the whole song was quadratic in song length;
    // adding each chunk's downloaded samples into flat buffers is O(chunkSize)
    // per chunk. The divider (sum of overlapping windows) is identical for
    // both channels, so a single buffer suffices.
    const resultBuffers = [new Float32Array(mixtureLength), new Float32Array(mixtureLength)];
    const dividerBuffer = new Float32Array(mixtureLength);

    // Hann windows on CPU, cached by length (all full chunks share one; only
    // the tail chunk can differ). overlap === 0 falls back to a flat window,
    // matching the old ones-divider path.
    const windowCache = new Map<number, Float32Array>();
    const getChunkWindow = (length: number): Float32Array => {
      let win = windowCache.get(length);
      if (!win) {
        win = overlap !== 0 ? this.hannWindowCpu(length) : new Float32Array(length).fill(1);
        windowCache.set(length, win);
      }
      return win;
    };

    this.debug(`Initialized CPU result/divider buffers of length ${mixtureLength}`);

    // Initialize counters for processing chunks
    let total = 0;

    // Calculate total chunks more accurately
    // We need at least one full chunk worth of data to process
    const effectiveLength = mixtureLength - chunkSize;
    const totalChunks = effectiveLength > 0 ? Math.floor(effectiveLength / step) + 1 : 1;

    this.debug(`Mixture length: ${mixtureLength}, Effective length for stepping: ${effectiveLength}`);
    this.debug(`Total chunks to process: ${totalChunks} in batches of ${this.batchSize}`);

    // Pending chunks for the current batch: their overlap-add coordinates.
    // Chunk waveform data is copied out of mixtureData lazily inside
    // flushBatch, straight into one [N, 2, chunkSize] buffer for PffftSTFT.
    const pendingChunks: { start: number; actualChunkSize: number }[] = [];

    // Accumulate one batch of windowed chunk results into the CPU buffers.
    const overlapAddBatch = (data: Float32Array, samplesPerChannel: number): void => {
      const tOverlap = performance.now();
      for (let b = 0; b < pendingChunks.length; b++) {
        const { start: chunkStart, actualChunkSize } = pendingChunks[b];
        const window = getChunkWindow(actualChunkSize);
        for (let ch = 0; ch < 2; ch++) {
          const base = (b * 2 + ch) * samplesPerChannel;
          const out = resultBuffers[ch];
          for (let j = 0; j < actualChunkSize; j++) {
            out[chunkStart + j] += data[base + j] * window[j];
          }
        }
        for (let j = 0; j < actualChunkSize; j++) {
          dividerBuffer[chunkStart + j] += window[j];
        }
      }
      pendingChunks.length = 0;
      this.addTiming('overlapAdd', performance.now() - tOverlap);
    };

    // Chunks completed so far, across all flushBatch() calls -- drives the
    // Demixing-stage progress fraction reported below.
    let chunksCompleted = 0;

    // Copy the pending chunks out of the CPU mixture into one
    // [N, 2, chunkSize] buffer and run STFT -> model -> ISTFT.
    const flushBatch = async (): Promise<void> => {
      const n = pendingChunks.length;
      if (n === 0) return;

      const tChunkPrep = performance.now();
      const batchData = new Float32Array(n * 2 * chunkSize);
      for (let b = 0; b < n; b++) {
        const { start: chunkStart, actualChunkSize } = pendingChunks[b];
        for (let ch = 0; ch < 2; ch++) {
          const srcOffset = ch * mixtureLength + chunkStart;
          batchData.set(
            mixtureData.subarray(srcOffset, srcOffset + actualChunkSize),
            (b * 2 + ch) * chunkSize);
          // the tail beyond actualChunkSize stays zero (fresh Float32Array)
        }
      }
      this.addTiming('chunkPrep', performance.now() - tChunkPrep);

      this.debug(`Running STFT -> model -> ISTFT on batch of ${n} chunks`);
      const data = await this.runModel(batchData, n, chunkSize, isMatchMix);
      overlapAddBatch(data, chunkSize);

      chunksCompleted += n;
      this.reportProgress({
        stage: SeparationStage.Demixing,
        fraction: Math.min(chunksCompleted / totalChunks, 1),
        chunk: chunksCompleted,
        totalChunks,
      });
    };

    // Collect chunks of the mixture, flushing a model batch whenever
    // batchSize chunks are pending.
    for (let i = 0; i <= effectiveLength && i < mixtureLength; i += step) {
      total++;
      const start = i;
      const end = Math.min(i + chunkSize, mixtureLength);
      const actualChunkSize = end - start;

      // Skip if we don't have enough samples for a meaningful chunk
      if (actualChunkSize < this.nFft) {
        this.debug(`Skipping chunk ${total} - too small (${actualChunkSize} < ${this.nFft})`);
        break;
      }

      this.debug(`Collecting chunk ${total}/${totalChunks}: Start ${start}, End ${end}, Size ${actualChunkSize}`);

      pendingChunks.push({ start, actualChunkSize });

      if (pendingChunks.length >= this.batchSize) {
        await flushBatch();
      }
    }

    // Flush any remaining partial batch (e.g. the tail chunks)
    await flushBatch();

    const tFinalize = performance.now();

    // Normalize by the divider to account for overlap (epsilon guards the
    // never-covered padding samples), slice out the valid portion
    // [trim, trim + mixLength).
    const epsilon = 1e-8;
    const validStart = this.trim;
    this.debug(`Extracting valid portion: start=${validStart}, end=${validStart + mixLength}, length=${mixLength}`);

    const source: Float32Array[] = [];
    for (let ch = 0; ch < 2; ch++) {
      const res = resultBuffers[ch];
      const out = new Float32Array(mixLength);
      for (let t = 0; t < mixLength; t++) {
        out[t] = res[validStart + t] / (dividerBuffer[validStart + t] + epsilon);
      }
      source.push(out);
    }
    this.debug(`Final source channels: ${source.length}, samples: ${source[0].length}`);

    this.addTiming('demixFinalize', performance.now() - tFinalize);

    const end = performance.now();
    console.log(`demix took ${(end - start).toFixed(2)}ms`);
    this.logTimingSummary(end - start);

    // NOTE: `compensate` is deliberately NOT applied here. Upstream's demix()
    // returns the raw source, and applies compensate only when deriving the
    // secondary stem (see separate()). Applying it here would scale the primary
    // stem and leave the secondary subtracting an under-scaled estimate.
    console.debug('Demixing process completed.');
    return source;
  }

  /**
   * Hann window computed on CPU, matching tf.signal.hannWindow exactly
   * (tfjs cosineWindow: periodic for even lengths, symmetric for odd), so the
   * CPU overlap-add reproduces the previous GPU windowing bit-for-bit.
   */
  private hannWindowCpu(windowLength: number): Float32Array {
    const even = 1 - (windowLength % 2);
    const values = new Float32Array(windowLength);
    for (let i = 0; i < windowLength; ++i) {
      const cosArg = (2.0 * Math.PI * i) / (windowLength + even - 1);
      values[i] = 0.5 - 0.5 * Math.cos(cosArg);
    }
    return values;
  }
  // --- Timing instrumentation (Phase 0 of PLAN_SINGLE_RUNTIME_PIPELINE.md) ---

  /** Add elapsed milliseconds to a named timing category. */
  private addTiming(category: string, ms: number): void {
    this.timings.set(category, (this.timings.get(category) ?? 0) + ms);
  }

  /** Run fn (sync or async) and charge its wall time to a timing category. */
  private async timed<T>(category: string, fn: () => T | Promise<T>): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    this.addTiming(category, performance.now() - t0);
    return result;
  }

  /** Log the accumulated per-category timings as one grep-friendly line. */
  private logTimingSummary(totalMs: number): void {
    let accounted = 0;
    const parts: string[] = [];
    for (const [category, ms] of this.timings) {
      accounted += ms;
      parts.push(`${category}=${ms.toFixed(0)}ms(${((ms / totalMs) * 100).toFixed(1)}%)`);
    }
    const other = totalMs - accounted;
    parts.push(`other=${other.toFixed(0)}ms(${((other / totalMs) * 100).toFixed(1)}%)`);
    console.log(`TIMING_SUMMARY demixTotal=${totalMs.toFixed(0)}ms ${parts.join(' ')}`);
  }

  /**
   * Run waveform chunks through STFT -> model -> ISTFT. forward() applies
   * center padding, STFT, the [L_re, L_im, R_re, R_im] layout, the dimF
   * slice and the 3-bin low-frequency mask; inverse() inverts all of it back
   * to waveform. In isMatchMix mode the model is skipped (forward()'s masked
   * spectrogram goes straight to inverse()).
   *
   * @param batchData Waveform chunks, row-major [batch, 2, chunkSize]
   * @returns Waveform chunks, row-major [batch, 2, chunkSize]
   */
  private async runModel(
    batchData: Float32Array,
    batch: number,
    chunkSize: number,
    isMatchMix: boolean
  ): Promise<Float32Array> {
    this.debugArrayStats(batchData, `runModel input (isMatchMix=${isMatchMix})`);

    const spec = await this.timed('stftForward', () =>
      this.stft!.forward(batchData, batch, chunkSize));
    this.debugArrayStats(spec, 'STFT output');

    let specPred: Float32Array;

    if (isMatchMix) {
      // In match_mix mode, use the STFT output directly (already has the
      // 3-bin low-frequency mask applied inside forward()).
      specPred = spec;
      this.debug('isMatchMix: spectrum prediction obtained directly from STFT output.');
    } else {
      if (this.enableDenoise) {
        throw new Error('Denoising mode is not yet implemented');
      }
      const input = new ort.Tensor('float32', spec, [batch, 4, this.dimF, this.dimT]);
      const results = await this.timed('onnxRun', () => this.model!.run({ input }));
      specPred = results.output.data as Float32Array;
      this.debug('Model run on the spectrum without denoising.');
    }

    const wave = await this.timed('istft', () =>
      this.stft!.inverse(specPred, batch));
    this.debugArrayStats(wave, `runModel output (isMatchMix=${isMatchMix})`);

    return wave;
  }

  /**
   * Save audio output to a file (in browser, creates a blob URL)
   * @param outputPath The path where the audio would be saved (used as identifier)
   * @param audioData Float32Array[] containing per-channel audio data
   * @param stemName Name of the stem for logging purposes
   * @returns URL for the blob containing the WAV file
   */
  private async saveAudioOutput(outputPath: string, audioData: Float32Array[], stemName: string): Promise<string> {
    // Since we're running in a browser, we can't actually save to the filesystem
    // Instead, we'll create a blob and return a downloadable URL
    this.debug(`Saving ${stemName} to ${outputPath}`);

    try {
      this.debug(`Audio data has ${audioData.length} channels with ${audioData[0]?.length || 0} samples each`);

      // Upstream normalizes every stem at write time (write_audio_pydub /
      // write_audio_soundfile), not during derivation -- so both the primary and
      // the derived secondary get the same treatment here.
      const normalized = await this.normalize(audioData, this.normalizationThreshold, this.amplificationThreshold);

      // Create a WAV blob
      const blob = await AudioUtils.saveAudioFile(normalized, this.sampleRate, outputPath);

      // Create a blob URL
      const blobUrl = URL.createObjectURL(blob);

      this.info(`Created ${stemName} output blob: ${blob.size} bytes`);

      return blobUrl;

    } catch (error) {
      this.error(`Error saving ${stemName} output: ${error}`);
      throw error;
    }
  }

  /**
  * Debug utility to check array stats including NaN/Inf detection
  */
  private debugArrayStats(data: Float32Array, name: string): void {
    // ~9% of demix time when enabled -- so only pay for it when debug
    // logging is actually on.
    if (this.logLevel !== 'debug') return;

    let max = 0;
    let sum = 0;
    let nonZeroCount = 0;
    let nanCount = 0;
    let infCount = 0;
    const total = data.length;

    for (let i = 0; i < total; i++) {
      const v = data[i];
      if (Number.isNaN(v)) {
        nanCount++;
        continue;
      }
      if (!Number.isFinite(v)) {
        infCount++;
        continue;
      }
      const abs = Math.abs(v);
      if (abs > max) max = abs;
      sum += abs;
      if (abs > 1e-8) nonZeroCount++;
    }

    const mean = sum / total;
    const nonZeroPercent = (nonZeroCount / total * 100).toFixed(2);
    const status = nanCount > 0 ? "🚨 NaN" : infCount > 0 ? "⚠️ Inf" : max < 1e-8 ? "🤔 Zero" : "✅ OK";

    console.log(`${status} ${name}: length=${total}, max=${max.toFixed(6)}, mean=${mean.toFixed(6)}, nonZero=${nonZeroCount}/${total} (${nonZeroPercent}%)`);

    if (nanCount > 0) {
      console.error(`   └─ Contains ${nanCount} NaN values!`);
    }
    if (infCount > 0) {
      console.error(`   └─ Contains ${infCount} Inf values!`);
    }
    if (max < 1e-8 && nanCount === 0) {
      console.warn(`   └─ Array appears to be essentially zero`);
    }
  }
}

