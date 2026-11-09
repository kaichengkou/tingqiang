import {analyzePitch} from './lib/analysis.mjs?v=0.6';
import {decodeCrepe} from './lib/crepe.mjs';

const inference = () => import('./lib/crepe-inference.mjs');
self.onmessage = async ({data}) => {
  const {id} = data;
  try {
    if (data.type === 'chunk') {
      const {inferChunk} = await inference();
      const {activations, energy} = await inferChunk(data.samples, data.first, data.count, data.sampleOffset);
      // A chunk-local pass gives a quick look at the curve; the final pass still tracks the whole recording.
      const {points} = decodeCrepe(activations, data.count, energy, {...data.options, beats: false});
      const rms = Float64Array.from(energy, frame => frame.value);
      self.postMessage({type: 'chunk', id, first: data.first, count: data.count, activations, rms, points}, [activations.buffer, rms.buffer]);
    } else if (data.type === 'decode') {
      const energy = Array.from(data.rms, (value, frame) => ({t: frame * 320 / 16000, value}));
      const {energy: _, ...analysis} = decodeCrepe(data.activations, data.frameCount, energy, data.options, value => self.postMessage({type: 'progress', id, value}));
      self.postMessage({type: 'done', id, result: analysis});
    } else if (data.type === 'live') {
      const {inferLive} = await inference();
      self.postMessage({type: 'live', id, hz: await inferLive(data.samples, data.options)});
    } else {
      // Energy only feeds the beat estimate already in the result; every point keeps its own rms.
      const {energy: _, ...analysis} = analyzePitch(data.samples, data.sampleRate, data.options, value => self.postMessage({type: 'progress', id, value}));
      self.postMessage({type: 'done', id, result: analysis});
    }
  } catch (error) { self.postMessage({type: 'error', id, message: error.message}); }
};
