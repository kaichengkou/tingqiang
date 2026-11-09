export class AudioUtils {
  static async loadAudioFile(url: string, targetSampleRate: number = 44100): Promise<Float32Array[]> {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();

    // Create an offline audio context for decoding
    const audioContext = new OfflineAudioContext(2, 1, targetSampleRate);
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Extract channels
    const channels: Float32Array[] = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    // If mono, duplicate to stereo
    if (channels.length === 1) {
      channels.push(new Float32Array(channels[0]));
    }

    return channels;
  }

  static async saveAudioFile(channels: Float32Array[], sampleRate: number, _filename: string): Promise<Blob> {
    // For now, we'll just create a WAV blob
    // In a real implementation, you might support different formats
    return AudioUtils.createWAVBlob(channels, sampleRate);
  }

  private static createWAVBlob(channels: Float32Array[], sampleRate: number): Blob {
    const length = channels[0].length;
    const numberOfChannels = channels.length;
    const bytesPerSample = 2; // 16-bit

    // Calculate sizes
    const blockAlign = numberOfChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    // Create buffer
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    // Write WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // Write audio data (interleaved)
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i]));
        const intSample = Math.floor(sample * 32767);
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  static interleaveChannels(channels: Float32Array[]): Float32Array {
    const length = channels[0].length;
    const numberOfChannels = channels.length;
    const interleaved = new Float32Array(length * numberOfChannels);

    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        interleaved[i * numberOfChannels + ch] = channels[ch][i];
      }
    }

    return interleaved;
  }

  static deinterleaveChannels(interleaved: Float32Array, numberOfChannels: number): Float32Array[] {
    const length = interleaved.length / numberOfChannels;
    const channels: Float32Array[] = [];

    for (let ch = 0; ch < numberOfChannels; ch++) {
      channels[ch] = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        channels[ch][i] = interleaved[i * numberOfChannels + ch];
      }
    }

    return channels;
  }
}
