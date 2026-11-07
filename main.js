const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const net = require('net');
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
app.on('before-quit', () => { stopTranscode(); dlPauseAll(); vlcStop(); });

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
  vlcStop();
  const port = 49152 + Math.floor(Math.random() * 10000);
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
      const t0 = Date.now();
      // stdin abierto: si VLC lo ve cerrado, se apaga solo
      const child = spawn(exe, [target, '--extraintf=rc', '--rc-host=127.0.0.1:' + port, '--rc-quiet', '--no-one-instance'],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => {});
      child.unref();
      // si VLC se cierra al instante (no acepta alguna opción), se abre otra vez sin la conexión de control
      child.on('exit', () => {
        if (Date.now() - t0 < 5000 && !(vlcSess && vlcSess.started)) {
          vlcStop();
          const plain = spawn(exe, [target], { detached: true, stdio: 'ignore' });
          plain.on('error', () => {});
          plain.unref();
        }
      });
      if (Array.isArray(opts.entries) && opts.entries.length) {
        vlcSess = { port, pid: opts.entries[0].pid, started: false, fails: 0, tries: 0, cur: null,
          byUrl: new Map(), byKey: new Map(), timer: null };
        opts.entries.forEach((e) => { vlcSess.byUrl.set(e.url, e); vlcSess.byKey.set(e.key, e); });
        vlcSess.timer = setInterval(vlcTick, 3000);
      }
      return { ok: true };
    } catch (e) { /* probar el siguiente */ }
  }
  return { ok: false, error: 'No se encontró VLC' };
});

/* ===================== seguimiento de VLC (qué capítulo se vio) ===================== */
// VLC se abre con su interfaz de control en un puerto local. Cada 3 s se pregunta
// qué está reproduciendo y en qué segundo va. Al pasar el 90% se marca como visto.
let vlcSess = null;

function vlcStop() {
  if (vlcSess && vlcSess.timer) clearInterval(vlcSess.timer);
  vlcSess = null;
}

function vlcSend(m) {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('vlc-progress', m);
  });
}

function vlcRead(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => sock.destroy(), 2000);
    sock.on('connect', () => sock.write('get_time\nget_length\nstatus\nquit\n'));
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
    sock.on('close', () => { clearTimeout(timer); resolve(buf || null); });
  });
}

function vlcParse(buf) {
  const nums = [...buf.matchAll(/^\s*(?:>\s*)?(\d+)\s*$/gm)].map((m) => parseInt(m[1], 10));
  const inp = buf.match(/new input:\s*(\S+)/);
  return { t: nums[0], d: nums[1], uri: inp ? inp[1] : '' };
}

function vlcFind(s, uri) {
  if (s.byUrl.has(uri)) return s.byUrl.get(uri);
  const m = uri.match(/\/(series|movie)\/[^/]+\/[^/]+\/(\d+)\./);
  if (!m) return null;
  return s.byKey.get(`${s.pid}:${m[1] === 'series' ? 'ep' : 'movie'}:${m[2]}`) || null;
}

function vlcTick() {
  const s = vlcSess;
  if (!s) return;
  vlcRead(s.port).then((buf) => {
    if (vlcSess !== s) return;
    if (!buf) {
      if (s.started) { if (++s.fails >= 3) vlcStop(); }   // VLC se cerró
      else if (++s.tries >= 20) vlcStop();                 // nunca abrió la interfaz
      return;
    }
    s.started = true;
    s.fails = 0;
    const { t, d, uri } = vlcParse(buf);
    const e = vlcFind(s, uri);
    if (!e || !d || !isFinite(t)) return;
    vlcSend(Object.assign({}, e, { t, d, done: t >= d * 0.9 }));
  });
}

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

function startHlsServer() {
  return new Promise((resolve, reject) => {
    if (hlsServer) return resolve(hlsPort);
    hlsServer = http.createServer((req, res) => {
      const m = (req.url || '').split('?')[0].match(/^\/([\w-]+)\/([\w.-]+)$/);
      if (!m) { res.writeHead(404); return res.end(); }
      const file = path.join(HLS_ROOT, m[1], path.basename(m[2]));
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        const isPl = file.endsWith('.m3u8');
        res.writeHead(200, {
          'Content-Type': isPl ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
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
  if (ffProc) {
    try { ffProc.kill('SIGKILL'); } catch (e) { /* nada */ }
    ffProc = null;
  }
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

ipcMain.handle('transcode-start', async (_e, url, opts) => {
  opts = opts || {};
  stopTranscode();
  try {
    const port = await startHlsServer();
    const id = 's' + Date.now().toString(36);
    const dir = path.join(HLS_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    ffDir = dir;

    const args = ['-hide_banner', '-loglevel', 'error',
      '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    if (opts.start && opts.start > 1 && !opts.live) args.push('-ss', String(Math.floor(opts.start)));
    args.push('-i', url, '-map', '0:v:0?', '-map', '0:a:0?');
    if (opts.full) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-f', 'hls', '-hls_time', '4',
      '-hls_segment_filename', path.join(dir, 'seg%05d.ts'));
    if (opts.live) args.push('-hls_list_size', '6', '-hls_flags', 'delete_segments');
    else args.push('-hls_list_size', '0', '-hls_playlist_type', 'event');
    args.push(path.join(dir, 'index.m3u8'));

    let stderr = '';
    let exited = null;
    const proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    ffProc = proc;
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1500); });
    proc.on('error', (err) => { exited = 'error:' + err.message; });
    proc.on('exit', (code) => { exited = 'code:' + code; });

    const playlist = path.join(dir, 'index.m3u8');
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if (fs.existsSync(playlist)) {
        const txt = fs.readFileSync(playlist, 'utf8');
        if (txt.includes('.ts')) {
          return { ok: true, url: `http://127.0.0.1:${port}/${id}/index.m3u8` };
        }
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
