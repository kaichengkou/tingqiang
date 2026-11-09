import { normalizeToPeak } from '../utils/stem_math';

/** Coarse phase a separator is in when it reports progress. */
export enum SeparationStage {
  LoadingModel = 'loading-model',
  Demixing = 'demixing',
  WritingOutput = 'writing-output',
}

export interface SeparationProgress {
  stage: SeparationStage;
  /** 0-1 fraction complete within `stage` (not overall across all stages). */
  fraction: number;
  /** Present for stage === SeparationStage.Demixing: the batch just completed and the total batch count. */
  chunk?: number;
  totalChunks?: number;
}

// Base class for all separator architectures
export abstract class CommonSeparator {
  protected outputDir: string;
  protected outputFormat: string;
  protected normalizationThreshold: number;
  protected amplificationThreshold: number;
  protected logLevel: string;
  protected sampleRate: number;
  protected onProgress?: (progress: SeparationProgress) => void;

  // Model-specific parameters
  protected modelPath: string | Uint8Array;
  protected modelData: any;
  protected modelName: string;
  protected modelUrl?: string;
  protected primaryStemName: string;
  protected secondaryStemName: string;
  protected outputSingleStem?: string;
  protected invertUsingSpec: boolean;

  constructor(config: SeparatorConfig) {
    this.outputDir = config.outputDir || './output';
    this.outputFormat = config.outputFormat || 'wav';
    this.normalizationThreshold = config.normalizationThreshold ?? 0.9;
    this.amplificationThreshold = config.amplificationThreshold ?? 0.6;
    this.logLevel = config.logLevel || 'info';
    this.sampleRate = config.sampleRate || 44100;
    this.onProgress = config.onProgress;

    this.modelPath = config.modelPath;
    this.modelData = config.modelData || {};
    this.modelName = config.modelName;
    this.modelUrl = config.modelUrl;
    this.primaryStemName = config.primaryStemName || 'vocals';
    this.secondaryStemName = config.secondaryStemName || 'instrumental';
    this.outputSingleStem = config.outputSingleStem;
    this.invertUsingSpec = config.invertUsingSpec ?? false;
  }

  // Abstract methods that subclasses must implement
  abstract loadModel(): Promise<void>;
  abstract separate(audioFilePath: string, customOutputNames?: Record<string, string>): Promise<string[]>;

  // Common utility methods
  protected log(level: string, message: string): void {
    if (this.shouldLog(level)) {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  protected debug(message: string): void {
    this.log('debug', message);
  }

  protected info(message: string): void {
    this.log('info', message);
  }

  protected warning(message: string): void {
    this.log('warning', message);
  }

  protected error(message: string): void {
    this.log('error', message);
  }

  private shouldLog(level: string): boolean {
    const levels = ['error', 'warning', 'info', 'debug'];
    const configLevel = levels.indexOf(this.logLevel);
    const messageLevel = levels.indexOf(level);
    return messageLevel <= configLevel;
  }

  /** Report progress to the caller's onProgress, if one was configured. Swallows callback errors so a broken UI handler can't abort separation. */
  protected reportProgress(progress: SeparationProgress): void {
    if (!this.onProgress) return;
    try {
      this.onProgress(progress);
    } catch (error) {
      this.warning(`onProgress callback threw: ${error}`);
    }
  }

  // Utility method to get stem output path
  protected getStemOutputPath(stemName: string, customOutputNames?: Record<string, string>): string {
    if (customOutputNames && customOutputNames[stemName]) {
      return customOutputNames[stemName];
    }
    return `${this.outputDir}/${this.modelName}_${stemName}.${this.outputFormat}`;
  }

  /**
   * Converts mono -> stereo (duplicating the single channel) and passes
   * through existing multi-channel audio as-is.
   * @param audioData Either a single Float32Array (mono) or an array of
   *   per-channel Float32Arrays (already [channels][samples]).
   */
  protected async prepareMix(audioData: Float32Array | Float32Array[]): Promise<Float32Array[]> {
    if (Array.isArray(audioData)) {
      // Already [channels][samples] - return as-is.
      return audioData;
    }
    if (audioData instanceof Float32Array) {
      // Duplicate the mono channel -> [2][samples].
      return [audioData, audioData];
    }
    throw new Error('Invalid audio data format (expect 1-D or 2-D Float32Array)');
  }

  /**
   * Peak-normalizes a multichannel waveform. Computes the peak absolute
   * sample value across all channels, then scales every sample by a single
   * gain: brought down to maxPeak if it exceeds it, brought up to minPeak if
   * it's below that (and nonzero), otherwise left unchanged.
   * @returns A new array of per-channel Float32Arrays (does not mutate input).
   */
  protected async normalize(
    wave: Float32Array[],
    maxPeak = 1.0,
    minPeak?: number
  ): Promise<Float32Array[]> {
    return normalizeToPeak(wave, maxPeak, minPeak);
  }
}

export interface SeparatorConfig {
  outputDir?: string;
  outputFormat?: string;
  normalizationThreshold?: number;
  amplificationThreshold?: number;
  logLevel?: string;
  sampleRate?: number;
  modelPath: string | Uint8Array;
  modelData?: any;
  modelName: string;
  /** Download URL used by downloadModel(); falls back to a legacy hardcoded URL when unset. */
  modelUrl?: string;
  primaryStemName?: string;
  secondaryStemName?: string;
  outputSingleStem?: string;
  invertUsingSpec?: boolean;
  /** Called as separation advances through loading/demixing/writing-output. See SeparationProgress. */
  onProgress?: (progress: SeparationProgress) => void;
}
