import {clamp} from './analysis.mjs?v=0.6';

// AudioContext timestamps describe the output device, rather than the next
// render quantum. Bluetooth delays beyond the OS estimate still need a trim.
export function outputDelaySeconds(context, nowMs) {
  if (!context || context.state !== 'running') return 0;
  try {
    const stamp = context.getOutputTimestamp?.();
    if (stamp?.contextTime > 0 && stamp.performanceTime > 0) {
      const audibleContext = stamp.contextTime + (nowMs - stamp.performanceTime) / 1000;
      const difference = context.currentTime - audibleContext;
      if (difference >= 0 && difference <= 1) return difference;
    }
  } catch {}
  return clamp((Number(context.baseLatency) || 0) + (Number(context.outputLatency) || 0), 0, 1);
}

export function presentedMediaTime({currentTime = 0, playing = false, rate = 1, deviceDelay = 0, shiftMs = 0, duration = Infinity}) {
  const compensation = playing ? deviceDelay * rate : 0;
  return clamp(currentTime - compensation + shiftMs / 1000 * rate, 0, duration || Infinity);
}
