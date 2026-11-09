// Stands in for onnxruntime-web inside the separation worker on Android (vendor/separator-native.mjs). Each model pass
// runs in the app, with ONNX Runtime's Android build on several cores (android/.../NativeModel.java), because Android
// WebView gives pages no threads. The worker cannot reach the app's bridge itself: the page relays every call over the
// MessagePort the worker was given (app.mjs, relayModel). Everything around the passes stays in the page, so the stems
// are computed the same way as in the browser and on Windows.
let port = null, next = 0;
const waiting = new Map();

function call(op, payload = {}, transfer = []) {
  if (!port) {
    port = globalThis.tingqiangModelPort;
    if (!port) return Promise.reject(new Error('没有原生推理通道'));
    port.onmessage = ({data}) => {
      const pending = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve(data);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, {resolve, reject});
    port.postMessage({op, id, ...payload}, transfer);
  });
}

export const env = {versions: {web: 'android'}, wasm: {numThreads: 0}, webgpu: {}};

export class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}

class Session {
  async run({input}) {
    // A copy goes to the app: the separator keeps using its own buffer.
    const data = input.data.slice();
    const {bytes, dims} = await call('run', {data, dims: input.dims}, [data.buffer]);
    return {output: new Tensor('float32', new Float32Array(bytes), dims)};
  }
  async release() { await call('release'); }
}

export const InferenceSession = {
  async create() { await call('load'); return new Session(); },
};
