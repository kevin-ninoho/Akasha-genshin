// 启动页与主进程之间的桥。
// 只用 contextBridge 暴露两个只读回调，渲染层拿不到任何 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boot', {
  onStage: (cb) => ipcRenderer.on('boot:stage', (_e, d) => { try { cb(d); } catch { /* ignore */ } }),
  onData: (cb) => ipcRenderer.on('boot:data', (_e, d) => { try { cb(d); } catch { /* ignore */ } }),
  skip: () => ipcRenderer.send('boot:skip'),
});

contextBridge.exposeInMainWorld('akashaLocal',{importVideos:()=>ipcRenderer.invoke('local:import-videos')});
