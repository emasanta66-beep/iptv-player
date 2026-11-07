const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iptv', {
  get: (url) => ipcRenderer.invoke('http-get', url),
  openM3uFile: () => ipcRenderer.invoke('open-m3u-file'),
  openVlc: (url, opts) => ipcRenderer.invoke('open-vlc', url, opts),
  transcodeStart: (url, opts) => ipcRenderer.invoke('transcode-start', url, opts),
  transcodeStop: () => ipcRenderer.invoke('transcode-stop'),
  dlEnqueue: (items) => ipcRenderer.invoke('dl-enqueue', items),
  dlAction: (action, id) => ipcRenderer.invoke('dl-action', action, id),
  dlList: () => ipcRenderer.invoke('dl-list'),
  dlFileUrl: (id) => ipcRenderer.invoke('dl-file-url', id),
  dlReveal: (id) => ipcRenderer.invoke('dl-reveal', id),
  onDlUpdate: (cb) => ipcRenderer.on('dl-update', (_e, list) => cb(list)),
  updCheck: () => ipcRenderer.invoke('upd-check'),
  updState: () => ipcRenderer.invoke('upd-state'),
  updReleases: () => ipcRenderer.invoke('upd-releases'),
  onUpdStatus: (cb) => ipcRenderer.on('upd-status', (_e, s) => cb(s)),
  onVlcProgress: (cb) => ipcRenderer.on('vlc-progress', (_e, m) => cb(m))
});
