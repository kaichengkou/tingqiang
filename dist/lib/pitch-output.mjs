import SignalsmithStretch from '../vendor/signalsmith-stretch.mjs';

/** Live pitch shift leaves source timestamps and playback speed intact. */
export class PitchOutput {
  constructor(context, source) {
    this.context = context; this.source = source;
    this.output = context.createGain(); this.output.connect(context.destination);
    source.connect(this.output); this.semitones = 0; this.latency = 0;
  }
  async setSemitones(value) {
    if (!Number.isFinite(value) || Math.abs(value) > 12) throw new Error('调门范围为 ±12 半音。');
    if (value === this.semitones) return;
    if (value) {
      if (!this.node) {
        this.node = await SignalsmithStretch(this.context);
        await this.node.configure({preset: 'default'});
        this.node.connect(this.output);
      }
      await this.node.schedule({active: true, semitones: value, formantCompensation: true});
      const latency = await this.node.latency();
      this.source.disconnect(); this.source.connect(this.node); this.latency = latency;
    } else {
      this.source.disconnect(); this.source.connect(this.output); this.node?.stop(); this.latency = 0;
    }
    this.semitones = value;
  }
  dispose() { this.source.disconnect(); this.node?.disconnect(); this.node?.port.close(); this.output.disconnect(); }
}
