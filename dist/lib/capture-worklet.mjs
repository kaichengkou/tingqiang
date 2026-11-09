// Runs on the audio thread, so every sample is placed on the same clock as the backing track.
const BLOCK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false; this.started = false; this.block = new Float32Array(BLOCK); this.fill = 0;
    this.port.onmessage = ({data}) => {
      if (data === 'start') { this.active = true; this.started = false; this.fill = 0; }
      else if (data === 'stop') { this.flush(); this.active = false; this.port.postMessage({type: 'stopped'}); }
    };
  }
  flush() {
    if (!this.fill) return;
    const samples = this.block.slice(0, this.fill);
    this.port.postMessage({type: 'samples', samples}, [samples.buffer]);
    this.fill = 0;
  }
  process(inputs) {
    if (!this.active) return true;
    if (!this.started) { this.started = true; this.port.postMessage({type: 'started', frame: currentFrame}); }
    const channels = inputs[0], length = channels[0]?.length || 128;
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i];
      this.block[this.fill++] = channels.length ? sum / channels.length : 0;
      if (this.fill === BLOCK) this.flush();
    }
    return true;
  }
}
registerProcessor('tingqiang-capture', CaptureProcessor);
