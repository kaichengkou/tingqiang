// The page's only way out of its sandbox. Each call is checked again in main.mjs.
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('tingqiangDesktop', {
  onOpenFile(callback) {
    ipcRenderer.removeAllListeners('open-file');
    ipcRenderer.on('open-file', (_event, file) => callback(file));
    ipcRenderer.send('renderer-ready');
  },
  microphoneAccess: () => ipcRenderer.invoke('microphone-access'),
  openMicrophoneSettings: () => ipcRenderer.invoke('open-microphone-settings'),
});
