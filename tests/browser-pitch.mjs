import {chromium} from './harness.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
try{
 const p=await browser.newPage();await p.goto(process.env.TINGQIANG_TEST_URL||'http://127.0.0.1:8000/');
 const result=await p.evaluate(async()=>{
  const {PitchOutput}=await import('/lib/pitch-output.mjs');const ctx=new AudioContext({sampleRate:48000});await ctx.resume();
  const osc=ctx.createOscillator();osc.frequency.value=440;const gain=ctx.createGain();gain.gain.value=.2;osc.connect(gain);
  const output=new PitchOutput(ctx,gain),analyser=ctx.createAnalyser();analyser.fftSize=16384;analyser.smoothingTimeConstant=0;output.output.connect(analyser);osc.start();
  const rows=[];for(const semitones of [-3,0,4]){await output.setSemitones(semitones);await new Promise(r=>setTimeout(r,650));const spectrum=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(spectrum);let k=1;for(let i=2;i<1500;i++)if(spectrum[i]>spectrum[k])k=i;const a=spectrum[k-1],b=spectrum[k],c=spectrum[k+1],delta=.5*(a-c)/(a-2*b+c);rows.push({semitones,hz:(k+delta)*ctx.sampleRate/analyser.fftSize,latency:output.latency});}
  osc.stop();output.dispose();
  const source=ctx.createBufferSource(),length=ctx.sampleRate*2.5,buffer=ctx.createBuffer(1,length,ctx.sampleRate),x=buffer.getChannelData(0);for(let i=0;i<length;i++){const t=i/ctx.sampleRate;if(t>=.3&&t<.8||t>=1.3&&t<1.8)x[i]=.4*Math.sin(2*Math.PI*440*t);}source.buffer=buffer;
  const shifted=new PitchOutput(ctx,source);await shifted.setSemitones(-3);
  const code=`class Probe extends AudioWorkletProcessor{constructor(){super();this.hot=false;this.below=0;}process(inputs,outputs){const x=inputs[0]?.[0];if(x){outputs[0][0].set(x);for(let i=0;i<x.length;i++){if(Math.abs(x[i])>.025){if(!this.hot){this.port.postMessage({kind:'on',t:currentTime+i/sampleRate});this.hot=true;}this.below=0;}else if(this.hot&&++this.below>sampleRate*.02){this.port.postMessage({kind:'off',t:currentTime+(i-this.below)/sampleRate});this.hot=false;}}}return true}}registerProcessor('pitch-probe',Probe)`;
  const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await ctx.audioWorklet.addModule(url);const probe=new AudioWorkletNode(ctx,'pitch-probe');shifted.output.connect(probe);probe.connect(ctx.destination);const events=[];probe.port.onmessage=({data})=>events.push(data);
  const start=ctx.currentTime+.15;source.start(start);await new Promise(r=>source.onended=r);await new Promise(r=>setTimeout(r,300));
  const report={rows,events,start,reportedLatency:shifted.latency};shifted.dispose();URL.revokeObjectURL(url);await ctx.close();return report;
 });
 for(const row of result.rows) {
  const expected=440*2**(row.semitones/12);
  assert.ok(Math.abs(1200*Math.log2(row.hz/expected))<20,JSON.stringify(row));
 }
 const on=result.events.filter(e=>e.kind==='on'),off=result.events.filter(e=>e.kind==='off');assert.equal(on.length,2);assert.equal(off.length,2);
 assert.ok(Math.abs((on[1].t-on[0].t)-1)<.025,'Pitch shift changed tempo');
 for(let i=0;i<2;i++)assert.ok(Math.abs((off[i].t-on[i].t)-.5)<.06,'Pitch shift changed pulse duration');
 const observedLatency=on[0].t-result.start-.3;assert.ok(Math.abs(observedLatency-result.reportedLatency)<.05,`Latency mismatch ${observedLatency} vs ${result.reportedLatency}`);
 console.log('Actual AudioWorklet/WASM pitch checks passed:',JSON.stringify({frequencies:result.rows,observedLatency,reportedLatency:result.reportedLatency}));
}finally{await browser.close()}
