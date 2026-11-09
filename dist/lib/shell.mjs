// The page runs in a browser, in the Windows client (desktop/preload.cjs) or in the Android app
// (android/src/com/tingqiang/app/MainActivity.java). Both apps add a native bridge; this gives the page one shape for
// them, so the rest of the code asks `platform` and `shell` instead of probing globals.
const windows = globalThis.tingqiangDesktop, android = globalThis.tingqiangAndroid;

/** 'windows', 'android' or 'web'. */
export const platform = windows ? 'windows' : android ? 'android' : 'web';

// Files go to the app in pieces: a WebView bridge takes only strings, and one huge string would stall the page.
const CHUNK = 3 * 256 * 1024;
const base64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
  reader.onerror = () => reject(reader.error || new Error('读取失败'));
  reader.readAsDataURL(blob);
});

function androidShell() {
  let back = () => false, modelIds = 0;
  // The app answers model calls on its own threads and calls back here when one is done.
  const modelCalls = new Map();
  globalThis.__tingqiangModel = (id, json) => {
    const pending = modelCalls.get(id);
    modelCalls.delete(id);
    const reply = JSON.parse(json);
    if (reply.error) pending?.reject(new Error(reply.error)); else pending?.resolve(reply);
  };
  const modelCall = (start, id = ++modelIds) => new Promise((resolve, reject) => { modelCalls.set(id, {resolve, reject}); start(id); });
  globalThis.__tingqiangBack = () => { try { return Boolean(back()); } catch { return false; } };
  let info;
  return {
    onOpenFile(callback) { globalThis.__tingqiangOpen = (name, url) => callback({name, url}); android.ready(); },
    microphoneAccess: async () => android.microphoneAccess(),
    openMicrophoneSettings: () => android.openMicrophoneSettings(),
    /** The back button asks the page first; true means the page used it (closed a dialog, stopped a recording). */
    onBack(handler) { back = handler; },
    /** 'playing' or 'processing' keeps the screen on and lets the work continue behind other apps; '' ends that. */
    setBusy: (kind, text) => android.setBusy(kind, text),
    info() { try { info ||= JSON.parse(android.info()); } catch { info = {}; } return info; },
    /** The separation model, run by the app with ONNX Runtime's Android build (dist/lib/native-ort.mjs). */
    model: {
      available() { try { return android.modelAvailable(); } catch { return false; } },
      load: () => modelCall(id => android.modelLoad(id)),
      async run(data, dims) {
        const id = ++modelIds, bytes = new Blob([data]);
        if (!android.modelBegin(id, bytes.size)) throw new Error('无法开始原生推理');
        for (let offset = 0; offset < bytes.size; offset += CHUNK) {
          if (!android.modelAppend(id, await base64(bytes.slice(offset, offset + CHUNK)))) throw new Error('原生推理的输入没有送达');
        }
        const {dims: shape} = await modelCall(() => android.modelRun(id, JSON.stringify(dims)), id);
        const response = await fetch(new URL(`/__model/${id}`, location.href));
        if (!response.ok) throw new Error('取不到原生推理的结果');
        return {bytes: await response.arrayBuffer(), dims: shape};
      },
      release: () => modelCall(id => android.modelRelease(id)),
    },
    /** Hands a file to the phone, which offers 发送给 (WeChat and the like) or 保存到手机. */
    async save(blob, filename) {
      const id = android.beginSave(filename, blob.type || 'application/octet-stream');
      if (!id) throw new Error('手机存储空间不足。');
      try {
        for (let offset = 0; offset < blob.size; offset += CHUNK) {
          if (!android.appendSave(id, await base64(blob.slice(offset, offset + CHUNK)))) throw new Error('写入失败，手机存储空间可能不足。');
        }
        android.finishSave(id);
      } catch (error) { android.cancelSave(id); throw error; }
    },
  };
}

/** The app's bridge, or null in a browser. */
export const shell = windows || (android ? androidShell() : null);
