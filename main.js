const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

let ffmpegStatic = null;
try { ffmpegStatic = require('ffmpeg-static'); } catch (e) { /* se usará ffmpeg del sistema */ }

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'IPTV Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  // título con la versión, para saber si ya se actualizó
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('IPTV Player v' + app.getVersion());
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  setupUpdater(win);
}

// Actualizaciones (solo en la app instalada): revisa cada 3 días y permite
// buscarlas a mano. El estado se muestra en la barra lateral de la app.
let autoUpdater = null;
let updState = { state: 'idle', msg: '', version: app.getVersion() };

function updSend(state, msg, extra) {
  updState = Object.assign({ state, msg, version: app.getVersion() }, extra || {});
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('upd-status', updState);
  });
}

function setupUpdater(win) {
  if (!app.isPackaged) {
    updSend('dev', 'Las actualizaciones solo funcionan en la app instalada.');
    return;
  }
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { updSend('error', 'No se pudo cargar el actualizador.'); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => updSend('checking', 'Buscando actualizaciones…'));
  autoUpdater.on('update-not-available', () => updSend('uptodate', 'Estás al día.'));
  autoUpdater.on('update-available', (info) => updSend('available',
    'Hay una versión nueva (' + info.version + '). Descargando…', { newVersion: info.version }));
  autoUpdater.on('download-progress', (p) => updSend('downloading',
    'Descargando ' + Math.round(p.percent) + '%…', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    updSend('ready', 'La versión ' + info.version + ' está lista para instalar.', { newVersion: info.version });
    dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Reiniciar ahora', 'Más tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualización lista',
      message: 'La versión ' + info.version + ' está lista.',
      detail: 'Reinicia la app para aplicarla. Si eliges "Más tarde", se instalará al cerrarla.'
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', (err) => updSend('error',
    'No se pudo revisar: ' + ((err && err.message) ? err.message.split('\n')[0] : 'sin conexión')));

  // Revisa cada 3 días. Se guarda la fecha de la última revisión para que,
  // al abrir la app, espere solo lo que falte (no vuelve a revisar al reiniciar).
  const check = () => {
    markUpdateCheck();
    autoUpdater.checkForUpdates().catch(() => {});
  };
  const wait = Math.max(5000, UPDATE_EVERY - (Date.now() - lastUpdateCheck()));
  setTimeout(() => {
    check();
    setInterval(check, UPDATE_EVERY);
  }, wait);
}

ipcMain.handle('upd-check', () => {
  if (!autoUpdater) { updSend('dev', 'Las actualizaciones solo funcionan en la app instalada.'); return false; }
  markUpdateCheck();
  autoUpdater.checkForUpdates().catch(() => {});
  return true;
});
ipcMain.handle('upd-state', () => updState);
ipcMain.handle('upd-releases', () =>
  shell.openExternal('https://github.com/emasanta66-beep/iptv-player/releases'));

const UPDATE_EVERY = 3 * 24 * 60 * 60 * 1000;
const updateStamp = () => path.join(app.getPath('userData'), 'update-check.json');
function lastUpdateCheck() {
  try { return JSON.parse(fs.readFileSync(updateStamp(), 'utf8')).t || 0; } catch (e) { return 0; }
}
function markUpdateCheck() {
  try { fs.writeFileSync(updateStamp(), JSON.stringify({ t: Date.now() })); } catch (e) { /* nada */ }
}

app.whenReady().then(() => {
  dlLoad();
  // Los servidores IPTV rara vez envían cabeceras CORS: se agregan aquí
  // para que hls.js pueda leer los segmentos de video.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.assign({}, details.responseHeaders);
    if (/^https?:/i.test(details.url)) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase().startsWith('access-control-allow-')) delete headers[k];
      }
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Allow-Headers'] = ['*'];
      headers['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
    }
    callback({ responseHeaders: headers });
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopTranscode();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { stopTranscode(); stopDualTranscode(); dlPauseAll(); });

function maybeGunzip(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf); } catch (e) { return buf; }
  }
  return buf;
}

// GET desde el proceso principal (sin CORS). Descomprime .gz (EPG XMLTV).
ipcMain.handle('http-get', async (_e, url) => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' },
      signal: ctrl.signal
    });
    const buf = maybeGunzip(Buffer.from(await r.arrayBuffer()));
    clearTimeout(timer);
    return { ok: r.ok, status: r.status, text: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Abrir un archivo .m3u local
ipcMain.handle('open-m3u-file', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Listas M3U', extensions: ['m3u', 'm3u8', 'txt'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const buf = maybeGunzip(fs.readFileSync(res.filePaths[0]));
  return { name: path.basename(res.filePaths[0]), text: buf.toString('utf8') };
});

// Abrir una URL en VLC (alternativa cuando el reproductor integrado no soporta el formato)
ipcMain.handle('open-vlc', async (_e, url, opts) => {
  opts = opts || {};
  // Con varios episodios se crea una lista .m3u8 para que VLC los reproduzca seguidos
  let target = url;
  if (Array.isArray(opts.entries) && opts.entries.length) {
    const lines = ['#EXTM3U'];
    opts.entries.forEach((e, i) => {
      lines.push('#EXTINF:-1,' + String(e.title || '').replace(/[\r\n]+/g, ' '));
      if (i === 0 && e.startTime > 5) lines.push('#EXTVLCOPT:start-time=' + Math.floor(e.startTime));
      lines.push(e.url);
    });
    target = path.join(os.tmpdir(), 'iptv-player-playlist.m3u8');
    fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');
  }
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/VLC.app/Contents/MacOS/VLC');
  }
  candidates.push('vlc');
  for (const exe of candidates) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) continue;
    try {
      const child = spawn(exe, [target], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true };
    } catch (e) { /* probar el siguiente */ }
  }
  return { ok: false, error: 'No se encontró VLC' };
});

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

/* ===================== descargas (cola de 3 a la vez) ===================== */
// Cada descarga guarda en disco lo que lleva. Pausar o cerrar la app conserva el
// archivo parcial, y al reanudar se pide solo la parte que falta (cabecera Range).
const DL_MAX = 3;
const dlJobs = new Map();   // id -> trabajo
const dlWaiting = [];       // ids esperando turno
const dlLive = new Map();   // id -> control de la descarga en curso
let dlRunning = 0;
let dlBcTimer = null;

const dlRoot = () => path.join(app.getPath('videos'), 'IPTV Player');
const dlStore = () => path.join(app.getPath('userData'), 'downloads.json');
const catalogStore = () => path.join(app.getPath('userData'), 'catalog-cache.json');
let catalogData = null;
let catalogLoad = null;
let catalogWrite = Promise.resolve();

async function getCatalogData() {
  if (catalogData) return catalogData;
  if (!catalogLoad) {
    catalogLoad = fs.promises.readFile(catalogStore(), 'utf8')
      .then((raw) => JSON.parse(raw))
      .then((data) => catalogData = data && typeof data === 'object' && !Array.isArray(data) ? data : {})
      .catch(() => catalogData = {});
  }
  return catalogLoad;
}

function persistCatalogData() {
  const serialized = JSON.stringify(catalogData || {});
  // Avoid letting a malformed or unexpectedly huge IPTV catalog fill userData.
  if (Buffer.byteLength(serialized, 'utf8') > 100 * 1024 * 1024) return Promise.resolve(false);
  const target = catalogStore();
  const temp = target + '.tmp';
  catalogWrite = catalogWrite.then(async () => {
    await fs.promises.writeFile(temp, serialized, 'utf8');
    await fs.promises.rename(temp, target);
    return true;
  }).catch(() => false);
  return catalogWrite;
}

ipcMain.handle('catalog-cache-get', async (_e, id) => {
  if (typeof id !== 'string' || id.length > 100) return null;
  const data = await getCatalogData();
  return data[id] || null;
});
ipcMain.handle('catalog-cache-set', async (_e, id, entry) => {
  if (typeof id !== 'string' || id.length > 100 || !entry || typeof entry !== 'object') return false;
  const data = await getCatalogData();
  data[id] = entry;
  return persistCatalogData();
});
ipcMain.handle('catalog-cache-delete', async (_e, id) => {
  if (typeof id !== 'string' || id.length > 100) return false;
  const data = await getCatalogData();
  delete data[id];
  return persistCatalogData();
});

function dlLoad() {
  try {
    JSON.parse(fs.readFileSync(dlStore(), 'utf8')).forEach((j) => {
      if (j.status === 'downloading' || j.status === 'queued') j.status = 'paused';
      dlJobs.set(j.id, j);
    });
  } catch (e) { /* primera vez */ }
}

function dlSave() {
  try { fs.writeFileSync(dlStore(), JSON.stringify([...dlJobs.values()])); } catch (e) { /* nada */ }
}

function dlList() {
  return [...dlJobs.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function dlBroadcast() {
  const list = dlList();
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('dl-update', list);
  });
}

function dlBroadcastSoon() {
  if (!dlBcTimer) dlBcTimer = setTimeout(() => { dlBcTimer = null; dlBroadcast(); }, 400);
}

function safeName(s, max) {
  return String(s || '').replace(/[<>:"\/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 150) || 'sin nombre';
}

function dlFilePath(it) {
  const ext = String(it.ext || 'mp4').replace(/[^\w]/g, '') || 'mp4';
  const dir = it.kind === 'movie'
    ? path.join(dlRoot(), 'Películas')
    : path.join(dlRoot(), 'Series', safeName(it.group || 'Sin serie'));
  return path.join(dir, safeName(it.title) + '.' + ext);
}

function dlEnqueue(items) {
  let added = 0;
  for (const it of items || []) {
    if (!it || !it.id || !it.url) continue;
    const old = dlJobs.get(it.id);
    if (old && ['done', 'queued', 'downloading'].includes(old.status)) continue;
    const job = Object.assign({ createdAt: Date.now(), received: 0, total: 0 }, old || {}, {
      id: it.id, kind: it.kind, title: it.title, group: it.group || '',
      img: it.img || '', plot: it.plot || '',
      url: it.url, file: dlFilePath(it), status: 'queued', error: ''
    });
    dlJobs.set(it.id, job);
    dlWaiting.push(it.id);
    added++;
  }
  dlSave();
  dlPump();
  return added;
}

function dlPump() {
  while (dlRunning < DL_MAX && dlWaiting.length) {
    const id = dlWaiting.shift();
    const job = dlJobs.get(id);
    if (!job || job.status !== 'queued') continue;
    dlRunning++;
    dlRun(job).then(() => {
      dlRunning--;
      dlSave();
      dlPump();
    });
  }
  dlBroadcastSoon();
}

function dlRun(job) {
  return new Promise((resolve) => {
    const rt = { stopping: null, done: false, wsClosed: false, req: null, ws: null };
    dlLive.set(job.id, rt);
    job.status = 'downloading';
    job.error = '';

    const finish = (status, err) => {
      if (rt.done) return;
      rt.done = true;
      dlLive.delete(job.id);
      try { job.received = fs.statSync(job.file).size; } catch (e) { job.received = 0; }
      job.speed = 0;
      if (status) job.status = status;
      if (err) job.error = err;
      if (status === 'done') job.total = job.total || job.received;
      dlSave();
      dlBroadcast();
      resolve();
    };
    const fail = (msg) => {
      if (rt.stopping || rt.done) return;
      if (rt.ws && !rt.wsClosed) rt.ws.destroy();
      finish('error', msg);
    };
    const onStopped = () => {
      if (rt.stopping === 'cancel') {
        try { fs.unlinkSync(job.file); } catch (e) { /* nada */ }
        finish(null);
      } else {
        finish('paused');
      }
    };
    rt.stop = (kind) => {
      if (rt.stopping || rt.done) return;
      rt.stopping = kind;
      if (rt.req) rt.req.destroy();
      if (rt.ws && !rt.wsClosed) rt.ws.destroy();
      else onStopped();
    };

    const get = (url, redirects, offset) => {
      const lib = /^https:/i.test(url) ? https : http;
      const headers = { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' };
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      let req;
      try {
        req = lib.get(url, { headers }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
            res.resume();
            return get(new URL(res.headers.location, url).href, redirects + 1, offset);
          }
          if (res.statusCode === 416 && offset > 0) {   // ya estaba completo
            res.resume();
            job.total = offset;
            return finish('done');
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            return fail('El servidor respondió ' + res.statusCode);
          }
          const resumed = res.statusCode === 206 && offset > 0;
          const base = resumed ? offset : 0;
          const len = parseInt(res.headers['content-length'], 10) || 0;
          job.total = len ? base + len : 0;
          job.received = base;

          const ws = fs.createWriteStream(job.file, { flags: resumed ? 'a' : 'w' });
          rt.ws = ws;
          let got = 0;
          ws.on('close', () => { rt.wsClosed = true; if (rt.stopping) onStopped(); });
          ws.on('error', (e) => fail(e.message));
          ws.on('finish', () => {
            if (rt.stopping) return;
            if (job.total && base + got < job.total) fail('Descarga incompleta, pulsa Reanudar');
            else finish('done');
          });
          let sampleAt = Date.now();
          let sampleBase = base;
          res.on('data', (c) => {
            got += c.length;
            job.received = base + got;
            const now = Date.now();
            if (now - sampleAt >= 1000) {
              job.speed = (job.received - sampleBase) / ((now - sampleAt) / 1000);
              sampleAt = now;
              sampleBase = job.received;
            }
            dlBroadcastSoon();
          });
          res.on('aborted', () => fail('Conexión cortada'));
          res.on('error', (e) => fail(e.message));
          res.pipe(ws);
        });
      } catch (e) {
        return fail(e.message);
      }
      rt.req = req;
      req.setTimeout(60000, () => req.destroy(new Error('Tiempo de espera agotado')));
      req.on('error', (e) => { if (!rt.stopping) fail(e.message); });
    };

    try { fs.mkdirSync(path.dirname(job.file), { recursive: true }); }
    catch (e) { return fail(e.message); }
    const offset = fs.existsSync(job.file) ? fs.statSync(job.file).size : 0;
    job.received = offset;
    get(job.url, 0, offset);
  });
}

function dlAction(action, id) {
  const job = dlJobs.get(id);
  if (!job) return false;
  const i = dlWaiting.indexOf(id);
  if (action === 'pause') {
    if (job.status === 'queued') {
      if (i >= 0) dlWaiting.splice(i, 1);
      job.status = 'paused';
    } else if (job.status === 'downloading') {
      const rt = dlLive.get(id);
      if (rt) rt.stop('paused');
    }
  } else if (action === 'resume') {
    if (job.status === 'paused' || job.status === 'error') {
      job.status = 'queued';
      job.error = '';
      dlWaiting.push(id);
      dlPump();
    }
  } else if (action === 'cancel') {
    if (i >= 0) dlWaiting.splice(i, 1);
    dlJobs.delete(id);
    const rt = dlLive.get(id);
    if (rt) rt.stop('cancel');
    else { try { fs.unlinkSync(job.file); } catch (e) { /* nada */ } }
  } else if (action === 'remove') {
    dlJobs.delete(id);   // quita de la lista, el archivo descargado se conserva
  }
  dlSave();
  dlBroadcast();
  return true;
}

function dlPauseAll() {
  for (const id of [...dlLive.keys()]) {
    const rt = dlLive.get(id);
    if (rt) rt.stop('paused');
  }
  dlWaiting.length = 0;
  dlSave();
}

ipcMain.handle('dl-enqueue', (_e, items) => dlEnqueue(items));
ipcMain.handle('dl-action', (_e, action, id) => dlAction(action, id));
ipcMain.handle('dl-list', () => dlList());
ipcMain.handle('dl-file-url', (_e, id) => {
  const j = dlJobs.get(id);
  return j && fs.existsSync(j.file) ? pathToFileURL(j.file).href : null;
});
ipcMain.handle('dl-reveal', (_e, id) => {
  const j = dlJobs.get(id);
  if (j && fs.existsSync(j.file)) shell.showItemInFolder(j.file);
  return true;
});

/* ===================== conversión de audio/video con ffmpeg ===================== */
// Muchas series traen audio AC3/DTS/EAC3 que el reproductor integrado no puede sonar.
// ffmpeg convierte el audio a AAC (y el video solo si hace falta) y lo entrega
// como HLS desde un servidor local, que hls.js reproduce.

const HLS_ROOT = path.join(os.tmpdir(), 'iptv-player-hls');
let hlsServer = null;
let hlsPort = 0;
let ffProc = null;
let ffDir = null;
let transcodeGeneration = 0;
let dualFfProc = null;
let dualFfDir = null;
let dualTranscodeGeneration = 0;
let dualSequence = 0;
let subProcs = new Set();   // procesos que extraen los subtítulos aparte
let probeProcs = new Set(); // sondeos de pistas activos
let trackProcs = new Set(); // extracción directa de subtítulos
let trackDirs = new Set();
let txInfo = null;          // datos de la conversión actual (para extraer subtítulos)


function startHlsServer() {
  return new Promise((resolve, reject) => {
    if (hlsServer) return resolve(hlsPort);
    hlsServer = http.createServer((req, res) => {
      const m = (req.url || '').split('?')[0].match(/^\/([\w-]+)\/([\w.-]+)$/);
      if (!m) { res.writeHead(404); return res.end(); }
      const file = path.join(HLS_ROOT, m[1], path.basename(m[2]));
      fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); return res.end(); }
        const ct = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
          : file.endsWith('.vtt') ? 'text/vtt; charset=utf-8' : 'video/mp2t';
        res.writeHead(200, {
          'Content-Type': ct,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        const stream = fs.createReadStream(file);
        stream.on('error', (streamErr) => {
          if (!res.headersSent) { res.writeHead(404); res.end(); }
          else res.destroy(streamErr);
        });
        res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
        stream.pipe(res);
      });
    });
    hlsServer.on('error', reject);
    hlsServer.listen(0, '127.0.0.1', () => {
      hlsPort = hlsServer.address().port;
      resolve(hlsPort);
    });
  });
}

function stopTranscode() {
  transcodeGeneration++;
  if (ffProc) {
    try { ffProc.kill('SIGKILL'); } catch (e) { /* nada */ }
    ffProc = null;
  }
  for (const p of subProcs) {
    try { p.kill('SIGKILL'); } catch (e) { /* nada */ }
  }
  subProcs.clear();
  for (const p of probeProcs) {
    try { p.kill('SIGKILL'); } catch (e) { /* nada */ }
  }
  probeProcs.clear();
  for (const p of trackProcs) {
    try { p.kill('SIGKILL'); } catch (e) { /* nada */ }
  }
  trackProcs.clear();
  for (const d of trackDirs) {
    setTimeout(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* nada */ } }, 500);
  }
  trackDirs.clear();
  directTrackContext = null;
  txInfo = null;
  if (ffDir) {
    const d = ffDir;
    ffDir = null;
    setTimeout(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* nada */ } }, 500);
  }
}

function resolveFfmpeg() {
  if (ffmpegStatic) {
    // en la app empaquetada el binario queda fuera del .asar
    const real = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(real)) return real;
    if (fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  }
  return 'ffmpeg'; // del sistema, si existe
}

ipcMain.handle('transcode-stop', () => { stopTranscode(); return true; });
function stopDualTranscode() {
  dualTranscodeGeneration++;
  if (dualFfProc) {
    try { dualFfProc.kill('SIGKILL'); } catch (e) { /* nada */ }
    dualFfProc = null;
  }
  if (dualFfDir) {
    const dir = dualFfDir;
    dualFfDir = null;
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* nada */ } }, 500);
  }
}

ipcMain.handle('dual-transcode-stop', () => { stopDualTranscode(); return true; });

// Conversión HLS aislada para el segundo reproductor en modo doble.
ipcMain.handle('dual-transcode-start', async (_e, url, full) => {
  stopDualTranscode();
  const generation = dualTranscodeGeneration;
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return { ok: false, error: 'La dirección del canal no es válida.' };
  try {
    const port = await startHlsServer();
    if (generation !== dualTranscodeGeneration) return { ok: false, error: 'Conversión cancelada' };
    const id = 'd' + Date.now().toString(36) + (++dualSequence).toString(36);
    const dir = path.join(HLS_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    dualFfDir = dir;
    const args = ['-hide_banner', '-loglevel', 'error',
      '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url, '-map', '0:v:0?', '-map', '0:a:0?'];
    if (full) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-f', 'hls', '-hls_time', '4',
      '-hls_list_size', '6', '-hls_flags', 'delete_segments',
      '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8'));
    let stderr = '';
    let exited = null;
    const proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    dualFfProc = proc;
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1200); });
    proc.on('error', (err) => { exited = 'error:' + err.message; });
    proc.on('exit', (code) => { exited = 'code:' + code; });
    const playlist = path.join(dir, 'index.m3u8');
    const hasSegments = (file) => { try { return fs.readFileSync(file, 'utf8').includes('.ts'); } catch (e) { return false; } };
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (generation !== dualTranscodeGeneration) return { ok: false, error: 'Conversión cancelada' };
      if (fs.existsSync(playlist) && hasSegments(playlist)) {
        return { ok: true, url: `http://127.0.0.1:${port}/${id}/index.m3u8` };
      }
      if (exited && exited.startsWith('error:')) {
        return { ok: false, error: 'No se pudo iniciar ffmpeg para el segundo canal.' };
      }
      if (exited && exited !== 'code:0') {
        return { ok: false, error: 'No se pudo convertir este canal: ' + (stderr.trim().split('\\n').pop() || exited) };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    stopDualTranscode();
    return { ok: false, error: 'La conversión del segundo canal tardó demasiado.' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
/* ===================== pistas de audio y subtítulos del video ===================== */
const LANG_NAMES = {
  spa: 'Español', es: 'Español', eng: 'Inglés', en: 'Inglés', por: 'Portugués', pt: 'Portugués',
  fra: 'Francés', fre: 'Francés', fr: 'Francés', ita: 'Italiano', it: 'Italiano', deu: 'Alemán', ger: 'Alemán',
  de: 'Alemán', jpn: 'Japonés', ja: 'Japonés', kor: 'Coreano', ko: 'Coreano', zho: 'Chino', chi: 'Chino',
  rus: 'Ruso', ru: 'Ruso', lat: 'Latino'
};
// Subtítulos de texto que ffmpeg sabe convertir a WebVTT (los de imagen, como PGS, no)
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

function trackLabel(t, kind, n) {
  const lang = LANG_NAMES[t.lang] || '';
  const title = t.title || '';
  if (title && lang && !title.toLowerCase().includes(lang.toLowerCase())) return lang + ' – ' + title;
  return title || lang || t.lang || (kind + ' ' + n);
}

function parseProbe(txt) {
  const out = { audio: [], subs: [] };
  let last = null;
  for (const line of String(txt).split(/\r?\n/)) {
    const mm = line.match(/^\s*Stream #0:\d+(?:\[[^\]]*\])?(?:\(([^)]*)\))?[^:]*: (Video|Audio|Subtitle|Data|Attachment): ?(\w+)?/);
    if (mm) {
      last = null;
      const lang = (mm[1] || '').toLowerCase();
      const codec = (mm[3] || '').toLowerCase();
      if (mm[2] === 'Audio') {
        last = { i: out.audio.length, lang, codec, title: '' };
        out.audio.push(last);
      } else if (mm[2] === 'Subtitle') {
        last = { i: out.subs.length, lang, codec, title: '', text: TEXT_SUBS.has(codec) };
        out.subs.push(last);
      }
      continue;
    }
    const t = last && line.match(/^\s+title\s*:\s*(.+)$/i);
    if (t) last.title = t[1].trim();
  }
  out.audio.forEach((t, n) => { t.label = trackLabel(t, 'Audio', n + 1); });
  out.subs.forEach((t, n) => { t.label = trackLabel(t, 'Subtítulo', n + 1); });
  return out;
}

// Lee solo la cabecera del video con ffmpeg (no lo descarga entero)
ipcMain.handle('probe-tracks', (_e, url) => new Promise((resolve) => {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return resolve({ audio: [], subs: [], error: true });
  let err = '';
  let done = false;
  let timedOut = false;
  let proc = null;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (proc) probeProcs.delete(proc);
    const result = parseProbe(err);
    result.error = timedOut || (!result.audio.length && !result.subs.length);
    resolve(result);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc && proc.kill('SIGKILL'); } catch (e) { /* nada */ }
    finish();
  }, 12000);
  try {
    proc = spawn(resolveFfmpeg(), ['-hide_banner', '-probesize', '2M', '-analyzeduration', '2000000',
      '-rw_timeout', '8000000', '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20', '-i', url],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    probeProcs.add(proc);
    proc.stderr.on('data', (d) => { if (err.length < 300000) err += d.toString(); });
    proc.on('error', () => { err = ''; finish(); });
    proc.on('exit', finish);
  } catch (e) { err = ''; finish(); }
}));

ipcMain.handle('transcode-start', async (_e, url, opts) => {
  opts = opts || {};
  stopTranscode();
  const generation = transcodeGeneration;
  try {
    const port = await startHlsServer();
    if (generation !== transcodeGeneration) return { ok: false, error: 'Conversión cancelada' };
    const id = 's' + Date.now().toString(36);
    const dir = path.join(HLS_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    ffDir = dir;

    const args = ['-hide_banner', '-loglevel', 'error',
      '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    const startArg = (opts.start && opts.start > 1 && !opts.live) ? Math.floor(opts.start) : 0;
    if (startArg) args.push('-ss', String(startArg));
    // Con varios audios: todos van al HLS como pistas alternativas (el reproductor deja elegir)
    const multi = !opts.live && opts.audioCount > 1;
    const subIdx = (!opts.live && Array.isArray(opts.subs)) ? opts.subs.filter((n) => Number.isInteger(n) && n >= 0) : [];
    args.push('-i', url, '-map', '0:v:0?');
    if (multi) for (let k = 0; k < opts.audioCount; k++) args.push('-map', '0:a:' + k);
    else args.push('-map', '0:a:0?');
    // With video stream-copy, input-side -ss can retain the preceding keyframe.
    // Re-encode only when resuming from a nonzero position so audio and external
    // subtitles share the exact same start point; at the beginning, keep it fast.
    if (opts.full || startArg > 0) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-f', 'hls', '-hls_time', '4');
    if (multi) {
      const vm = ['v:0,agroup:aud,name:video'];
      for (let k = 0; k < opts.audioCount; k++) vm.push('a:' + k + ',agroup:aud,name:audio' + k + (k === 0 ? ',default:yes' : ''));
      args.push('-master_pl_name', 'index.m3u8', '-var_stream_map', vm.join(' '),
        '-hls_segment_filename', path.join(dir, '%v_%05d.ts'));
    } else {
      args.push('-hls_segment_filename', path.join(dir, 'seg%05d.ts'));
    }
    if (opts.live) args.push('-hls_list_size', '6', '-hls_flags', 'delete_segments');
    else args.push('-hls_list_size', '0', '-hls_playlist_type', 'event');
    args.push(path.join(dir, multi ? '%v.m3u8' : 'index.m3u8'));
    // Los subtítulos NO van en esta misma pasada: ffmpeg escribe el .vtt recién al
    // terminar, así que durante la reproducción el archivo estaría vacío. Se extraen
    // aparte con "extract-sub" (ver extractSubtitle).

    let stderr = '';
    let exited = null;
    const proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    ffProc = proc;
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1500); });
    proc.on('error', (err) => { exited = 'error:' + err.message; });
    proc.on('exit', (code) => { exited = 'code:' + code; });

    const playlist = path.join(dir, 'index.m3u8');
    const hasTs = (f) => { try { return fs.readFileSync(f, 'utf8').includes('.ts'); } catch (e) { return false; } };
    const readyFiles = multi
      ? [path.join(dir, 'video.m3u8')].concat(Array.from({ length: opts.audioCount }, (_v, k) => path.join(dir, 'audio' + k + '.m3u8')))
      : [playlist];
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if (generation !== transcodeGeneration) return { ok: false, error: 'Conversión cancelada' };
      if (fs.existsSync(playlist) && readyFiles.every(hasTs)) {
        txInfo = {
          src: url, start: startArg, dir, port, id, subIdx,
          jobs: new Map(), done: new Set(), errors: new Map()
        };
        return {
          ok: true,
          url: `http://127.0.0.1:${port}/${id}/index.m3u8`,
          subs: subIdx.map((s) => ({ i: s, url: `http://127.0.0.1:${port}/${id}/sub${s}.vtt` }))
        };
      }
      if (exited && exited.startsWith('error:')) {
        return { ok: false, error: 'No se pudo ejecutar ffmpeg. Ejecuta "npm install" de nuevo en la carpeta del proyecto.' };
      }
      if (exited && exited !== 'code:0') {
        return { ok: false, error: 'ffmpeg falló: ' + (stderr.trim().split('\n').pop() || exited) };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    stopTranscode();
    return { ok: false, error: 'ffmpeg tardó demasiado en arrancar. ' + (stderr.trim().split('\n').pop() || '') };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Extrae un subtítulo a .vtt con un ffmpeg aparte, para que los textos se puedan
// ver mientras el video todavía se está convirtiendo (con -flush_packets van
// apareciendo a medida que se leen, no todos al final).
function subUrlOf(tx, i) {
  return `http://127.0.0.1:${tx.port}/${tx.id}/sub${i}.vtt`;
}

function extractSubtitle(i, url, start) {
  const tx = txInfo;
  if (tx && tx.src === url) {
    if (!tx.subIdx.includes(i)) tx.subIdx.push(i);
    if (tx.done.has(i) || tx.jobs.has(i)) return { ok: true, url: subUrlOf(tx, i), offset: 0 };
    return extractFromContext(tx, i);
  }
  if (!url || !/^https?:/i.test(url) || !Number.isInteger(i) || i < 0) return { ok: false, error: 'Datos de pista inválidos' };
  if (directTrackContext && directTrackContext.src === url && Math.floor(directTrackContext.start) === Math.floor(Math.max(0, Number(start) || 0))) {
    if (!directTrackContext.subIdx.includes(i)) directTrackContext.subIdx.push(i);
    return startDirectSubtitle(directTrackContext, i);
  }
  const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(HLS_ROOT, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  trackDirs.add(dir);
  // Match the offset applied in the renderer to the integer -ss used below.
  const context = { src: url, start: Math.floor(Math.max(0, Number(start) || 0)), dir, port: hlsPort, id,
    subIdx: [i], jobs: new Map(), done: new Set(), errors: new Map() };
  return startDirectSubtitle(context, i);
}

function extractFromContext(tx, i) {
  if (tx.done.has(i) || tx.jobs.has(i)) return { ok: true, url: subUrlOf(tx, i), offset: 0 };
  tx.errors.delete(i);
  const file = path.join(tx.dir, 'sub' + i + '.vtt');
  const args = ['-hide_banner', '-loglevel', 'error',
    '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  if (tx.start > 1) args.push('-ss', String(tx.start));
  args.push('-i', tx.src, '-map', '0:s:' + i, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', file);
  let proc;
  try {
    proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  const job = { error: '' };
  tx.jobs.set(i, job);
  subProcs.add(proc);
  proc.stderr.on('data', (d) => { job.error = (job.error + d.toString()).slice(-800); });
  proc.on('error', (e) => {
    subProcs.delete(proc);
    tx.jobs.delete(i);
    tx.errors.set(i, String(e && e.message || e));
  });
  proc.on('exit', (code) => {
    subProcs.delete(proc);
    tx.jobs.delete(i);
    if (code === 0) tx.done.add(i);
    else tx.errors.set(i, job.error.trim().split('\n').pop() || ('ffmpeg terminó con código ' + code));
  });
  return { ok: true, url: subUrlOf(tx, i) };
}

function startDirectSubtitle(tx, i) {
  return startHlsServer().then((port) => {
    tx.port = port;
    if (!tx.jobs) tx.jobs = new Map();
    if (!tx.done) tx.done = new Set();
    if (!tx.errors) tx.errors = new Map();
    if (tx.done.has(i) || tx.jobs.has(i)) return { ok: true, url: subUrlOf(tx, i), offset: tx.start };
    tx.errors.delete(i);
    const file = path.join(tx.dir, 'sub' + i + '.vtt');
    const args = ['-hide_banner', '-loglevel', 'error', '-probesize', '2M', '-analyzeduration', '2M',
      '-rw_timeout', '15000000', '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    if (tx.start > 1) args.push('-ss', String(Math.floor(tx.start)));
    args.push('-i', tx.src, '-map', '0:s:' + i, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', file);
    let proc;
    try { proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { trackDirs.delete(tx.dir); return { ok: false, error: String(e.message || e) }; }
    const job = { error: '' }; tx.jobs.set(i, job); trackProcs.add(proc);
    proc.stderr.on('data', (d) => { job.error = (job.error + d.toString()).slice(-800); });
    proc.on('error', (e) => { trackProcs.delete(proc); tx.jobs.delete(i); tx.errors.set(i, String(e.message || e)); });
    proc.on('exit', (code) => {
      trackProcs.delete(proc); tx.jobs.delete(i);
      if (code === 0) tx.done.add(i);
      else tx.errors.set(i, job.error.trim().split('\n').pop() || ('ffmpeg terminó con código ' + code));
    });
    // Retain only the latest direct extraction context for status polling.
    directTrackContext = tx;
    return { ok: true, url: subUrlOf(tx, i), offset: tx.start };
  }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
}

let directTrackContext = null;
ipcMain.handle('extract-sub', (_e, i, url, start) => extractSubtitle(i, url, start));

ipcMain.handle('sub-status', (_e, i, url) => {
  const tx = txInfo && txInfo.subIdx.includes(i) ? txInfo : directTrackContext;
  if (!tx || !tx.subIdx.includes(i) || (url && tx.src !== url)) return { state: 'none' };
  if (tx.done.has(i)) return { state: 'done' };
  if (tx.jobs.has(i)) return { state: 'working' };
  if (tx.errors.has(i)) return { state: 'error', error: tx.errors.get(i) };
  return { state: 'idle' };
});
