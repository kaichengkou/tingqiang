const modules = new WeakMap();

/** Microphone capture inside the playback graph. Nothing is routed to the speakers. */
export async function openMicCapture(context, {onSamples, onEnded} = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
  const [track] = stream.getAudioTracks();
  try {
    if (!modules.has(context)) modules.set(context, context.audioWorklet.addModule(new URL('./capture-worklet.mjs?v=0.6', import.meta.url)));
    await modules.get(context);
  } catch (error) { stream.getTracks().forEach(item => item.stop()); throw error; }
  const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'tingqiang-capture'), mute = context.createGain();
  mute.gain.value = 0; source.connect(node); node.connect(mute); mute.connect(context.destination);
  const chunks = [];
  let started, stopped, frames = 0;
  node.port.onmessage = ({data}) => {
    if (data.type === 'samples') { chunks.push(data.samples); frames += data.samples.length; onSamples?.(data.samples, frames); }
    else if (data.type === 'started') started?.(data.frame);
    else if (data.type === 'stopped') stopped?.();
  };
  track.onended = () => onEnded?.();
  return {
    inputLatency: Number(track.getSettings?.().latency) || 0.01,
    start: () => new Promise(resolve => { started = resolve; node.port.postMessage('start'); }),
    stop: () => new Promise(resolve => {
      stopped = () => {
        const samples = new Float32Array(frames);
        let at = 0;
        for (const chunk of chunks) { samples.set(chunk, at); at += chunk.length; }
        chunks.length = 0;
        resolve({samples, sampleRate: context.sampleRate});
      };
      node.port.postMessage('stop');
    }),
    close() {
      track.onended = null;
      stream.getTracks().forEach(item => item.stop());
      source.disconnect(); node.disconnect(); mute.disconnect(); node.port.onmessage = null;
    },
  };
}

/** A short tick on the shared clock, for count-ins and latency measurement. */
export function beep(context, when, hz = 1320, seconds = 0.04, level = 0.35) {
  const tone = context.createOscillator(), gain = context.createGain();
  tone.frequency.value = hz; gain.gain.setValueAtTime(level, when); gain.gain.exponentialRampToValueAtTime(0.001, when + seconds);
  tone.connect(gain); gain.connect(context.destination);
  tone.start(when); tone.stop(when + seconds);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
}
