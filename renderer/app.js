'use strict';

/* ===================== utilidades ===================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const pad = (n) => String(n).padStart(2, '0');
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
}
function b64utf8(str) {
  try {
    const bin = atob(str || '');
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch (e) { return str || ''; }
}

/* ===================== estado persistente ===================== */
const S = Object.assign({ playlists: [], active: null, favs: {}, progress: {}, autoNext: true, catOrder: {} },
  JSON.parse(localStorage.getItem('iptv') || '{}'));
function save() {
  try { localStorage.setItem('iptv', JSON.stringify(S)); } catch (e) { /* cuota */ }
}

/* ===================== estado en memoria ===================== */
let tab = 'live';
let query = '';
let curCat = 'all';
let limit = 200;
let viewSeries = null;           // serie abierta (vista de episodios)
let viewSeason = 1;              // temporada mostrada
const cache = {};                // por lista: {live,movie,series,cats,epgUrl}
const xmltvCache = {};           // url -> texto
let current = null;              // reproducción actual
let hls = null;
let countdownTimer = null;
let lastSave = 0;
let checkTimer = null;           // detección de audio/video no compatible
let dlList = [];                 // descargas (las actualiza el proceso principal)

const activePl = () => S.playlists.find((p) => p.id === S.active) || null;

function setStatus(msg) { $('#status').textContent = msg; }

/* ===================== API Xtream ===================== */
function plBase(p) {
  let b = (p.server || '').trim();
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  return b.replace(/\/+$/, '');
}
async function api(p, action, extra) {
  const url = `${plBase(p)}/player_api.php?username=${enc(p.user)}&password=${enc(p.pass)}&action=${action}${extra || ''}`;
  const r = await window.iptv.get(url);
  if (!r.ok) throw new Error(r.error || ('HTTP ' + r.status));
  try { return JSON.parse(r.text); } catch (e) { throw new Error('Respuesta inválida del servidor'); }
}

/* ===================== parser M3U ===================== */
function parseM3U(text, pid) {
  const lines = text.split(/\r?\n/);
  const epgUrl = (text.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/i) || [])[1] || '';
  const out = { live: [], movie: [], series: [], cats: { live: {}, movie: {}, series: {} }, epgUrl };
  const seriesMap = {};
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_m, k, v) => { attrs[k.toLowerCase()] = v; return ''; });
      const title = (line.slice(line.lastIndexOf(',') + 1).trim()) || attrs['tvg-name'] || 'Sin nombre';
      cur = { title, logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || 'Sin categoría', epgId: attrs['tvg-id'] || '' };
    } else if (!line.startsWith('#') && cur) {
      cur.url = line;
      const se = cur.title.match(/^(.*?)[\s._-]*S(\d{1,2})\s?E(\d{1,3})/i);
      let type = 'live';
      if (/\/movie\//i.test(line)) type = 'movie';
      else if (/\/series\//i.test(line) || se) type = 'episode';

      if (type === 'episode') {
        const name = se ? se[1].trim() : cur.title;
        const season = se ? parseInt(se[2], 10) : 1;
        const num = se ? parseInt(se[3], 10) : 1;
        const skey = `${pid}:series:${hash(name)}`;
        if (!seriesMap[skey]) {
          seriesMap[skey] = { key: skey, pid, type: 'series', title: name, logo: cur.logo, cat: cur.group, episodes: [] };
        }
        seriesMap[skey].episodes.push({
          key: `${pid}:ep:${hash(cur.url)}`, season, num, url: cur.url,
          title: `T${pad(season)}E${pad(num)} - ${cur.title}`
        });
      } else {
        const item = {
          key: `${pid}:${type}:${hash(cur.url + cur.title)}`, pid, type,
          title: cur.title, logo: cur.logo, cat: cur.group, url: cur.url, epgId: cur.epgId
        };
        out[type].push(item);
        out.cats[type][cur.group] = cur.group;
      }
      cur = null;
    }
  }
  for (const s of Object.values(seriesMap)) {
    s.episodes.sort((a, b) => a.season - b.season || a.num - b.num);
    out.series.push(s);
    out.cats.series[s.cat] = s.cat;
  }
  return out;
}

/* ===================== carga de datos ===================== */
async function ensureLoaded(tabName) {
  const p = activePl();
  if (!p) return null;
  cache[p.id] = cache[p.id] || { loaded: {} };
  const c = cache[p.id];

  if (p.type === 'm3u') {
    if (c.m3u) return c;
    setStatus('Cargando lista M3U…');
    let text = '';
    if (p.url) {
      const r = await window.iptv.get(p.url);
      if (!r.ok) throw new Error(r.error || ('HTTP ' + r.status));
      text = r.text;
    } else {
      text = localStorage.getItem('iptv_m3u_' + p.id) || '';
      if (!text) throw new Error('El archivo de esta lista ya no está guardado. Vuelve a añadirla.');
    }
    Object.assign(c, parseM3U(text, p.id));
    c.m3u = true;
    c.epgUrl = p.epg || c.epgUrl;
    return c;
  }

  // Xtream
  if (c.loaded[tabName]) return c;
  const catAction = { live: 'get_live_categories', movie: 'get_vod_categories', series: 'get_series_categories' }[tabName];
  const listAction = { live: 'get_live_streams', movie: 'get_vod_streams', series: 'get_series' }[tabName];
  setStatus('Cargando…');
  const [cs, ls] = await Promise.all([api(p, catAction), api(p, listAction)]);
  c.cats = c.cats || { live: {}, movie: {}, series: {} };
  c.cats[tabName] = {};
  (Array.isArray(cs) ? cs : []).forEach((x) => { c.cats[tabName][String(x.category_id)] = x.category_name; });
  c[tabName] = (Array.isArray(ls) ? ls : []).map((r) => {
    const id = r.stream_id != null ? r.stream_id : r.series_id;
    return {
      key: `${p.id}:${tabName}:${id}`, pid: p.id, type: tabName,
      title: String(r.name || '?'), logo: r.stream_icon || r.cover || '',
      cat: String(r.category_id), id, ext: r.container_extension || '',
      epgId: r.epg_channel_id || ''
    };
  });
  c.loaded[tabName] = true;
  return c;
}

/* ===================== URLs de reproducción ===================== */
function streamUrl(item) {
  if (item.url) return item.url;
  const p = activePl();
  const b = plBase(p), u = enc(p.user), pw = enc(p.pass);
  if (item.type === 'live') return `${b}/live/${u}/${pw}/${item.id}.m3u8`;
  if (item.type === 'movie') return `${b}/movie/${u}/${pw}/${item.id}.${item.ext || 'mp4'}`;
  return '';
}

/* ===================== render ===================== */
function itemsForView() {
  const p = activePl();
  if (!p) return [];
  const c = cache[p.id] || {};
  let items;
  if (tab === 'favs') items = Object.values(S.favs).filter((f) => f.pid === p.id);
  else items = c[tab] || [];
  const q = query.trim().toLowerCase();
  return items.filter((i) =>
    (tab === 'favs' || curCat === 'all' || String(i.cat) === curCat) &&
    (!q || i.title.toLowerCase().includes(q)));
}

function fillCategories() {
  const sel = $('#catSelect');
  const p = activePl();
  const show = p && ['live', 'movie', 'series'].includes(tab) && !viewSeries;
  sel.classList.toggle('hidden', !show);
  $('#btnCatEdit').classList.toggle('hidden', !show);
  if (!show) return;
  const cats = ((cache[p.id] || {}).cats || {})[tab] || {};
  const entries = orderedCats(p.id, tab, Object.entries(cats));
  sel.innerHTML = '<option value="all">(Todas las categorías)</option>' +
    entries.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  sel.value = entries.some(([id]) => id === curCat) ? curCat : 'all';
  curCat = sel.value;
}

function cardHtml(item) {
  const isFav = !!S.favs[item.key];
  const pr = S.progress[item.key];
  const pct = pr && pr.d ? Math.min(100, (pr.t / pr.d) * 100) : 0;
  const img = item.logo ? `style="background-image:url('${esc(item.logo)}')"` : '';
  return `<div class="card ${item.type === 'live' ? 'live' : ''}" data-key="${esc(item.key)}">
    <div class="img" ${img}>${item.logo ? '' : '▶'}</div>
    <button class="star ${isFav ? 'on' : ''}" data-fav="${esc(item.key)}" title="Favorito">★</button>
    ${item.type === 'movie' ? `<button class="dlb" data-dlkey="${esc(item.key)}" title="Descargar">⬇</button>` : ''}
    ${pct ? `<div class="bar" style="width:${pct}%"></div>` : ''}
    <div class="ttl" title="${esc(item.title)}">${esc(item.title)}</div>
  </div>`;
}

function render() {
  const grid = $('#grid');
  const crumb = $('#crumb');
  const more = $('#btnMore');
  const p = activePl();
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  more.classList.add('hidden');
  $('#toolbar').classList.toggle('hidden', tab === 'continue' || tab === 'downloads' || !!viewSeries);
  if (tab === 'downloads') { crumb.classList.add('hidden'); renderDownloads(); return; }

  if (!p) {
    grid.innerHTML = '<p class="muted">Pulsa “+ Añadir” para agregar una lista Xtream o M3U.</p>';
    crumb.classList.add('hidden');
    return;
  }

  if (viewSeries) { renderEpisodes(); return; }
  crumb.classList.add('hidden');
  fillCategories();

  if (tab === 'continue') { renderContinue(); return; }

  grid.className = '';
  grid.id = 'grid';
  const all = itemsForView();
  const shown = all.slice(0, limit);
  grid.innerHTML = shown.length ? shown.map(cardHtml).join('')
    : '<p class="muted">No hay elementos.</p>';
  more.classList.toggle('hidden', all.length <= limit);
  setStatus(`${all.length} elementos`);
}

function renderContinue() {
  const p = activePl();
  const seen = {};
  const list = Object.values(S.progress)
    .filter((e) => e.pid === p.id && !e.done && !e.hidden)
    .sort((a, b) => b.updated - a.updated)
    .filter((e) => {                       // una sola entrada por serie (la más reciente)
      const k = e.seriesRef ? 's:' + e.seriesRef.key : e.key;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    })
    .slice(0, 60);
  const grid = $('#grid');
  grid.className = 'episodes';
  if (!list.length) {
    grid.innerHTML = '<p class="muted">Aún no has empezado nada.</p>';
    setStatus('');
    return;
  }
  grid.innerHTML = '<div class="eps">' + list.map((e) => {
    const img = e.img || (e.seriesRef && e.seriesRef.logo) || (e.itemRef && e.itemRef.logo) || '';
    const pct = e.d ? Math.min(100, (e.t / e.d) * 100) : 0;
    const left = e.d ? Math.max(1, Math.round((e.d - e.t) / 60)) + ' min restantes' : 'Siguiente capítulo';
    const m = String(e.title).match(/^T(\d+)E(\d+)/i);
    const head = e.seriesRef ? e.seriesRef.title : e.title;
    const sub = e.seriesRef
      ? (m ? `T${+m[1]} · E${pad(+m[2])} · ` : '') + cleanEpTitle(e.title)
      : (e.type === 'live' ? 'En vivo' : 'Película');
    return `<div class="epc" data-cont="${esc(e.key)}">
      <div class="thumb" ${img ? `style="background-image:url('${esc(img)}')"` : ''}>
        <span class="play">▶</span>
        ${pct ? `<div class="pbar" style="width:${pct}%"></div>` : ''}
      </div>
      <div class="epbody">
        <div class="eptitle">${esc(head)}</div>
        <div class="epplot">${esc(sub)}</div>
        <div class="epmeta">${esc(left)}</div>
      </div>
      <button class="rm" data-rm="${esc(e.key)}" title="Quitar de la lista">✕</button>
    </div>`;
  }).join('') + '</div>';
  setStatus(`${list.length} para continuar`);
}

// "T01E01 - Serie - S01E01 - Nombre (Parte 1)" -> "Nombre (Parte 1)"
function cleanEpTitle(t) {
  const raw = String(t || '').replace(/^T\d+E\d+\s*-\s*/i, '');
  const clean = raw.replace(/^.*?S\d{1,2}\s?E\d{1,3}\s*[-–:._]*\s*/i, '').trim();
  return clean || raw;
}

function renderEpisodes() {
  const s = viewSeries;
  const crumb = $('#crumb');
  crumb.classList.remove('hidden');
  crumb.innerHTML = `<button class="btn" id="btnBack">← Volver</button>
    <div class="serieinfo"><b>${esc(s.title)}</b>${s.plot ? `<div class="plot">${esc(s.plot)}</div>` : ''}</div>`;
  const grid = $('#grid');
  grid.className = 'episodes';
  if (!s.episodes || !s.episodes.length) {
    grid.innerHTML = '<p class="muted">Esta serie no tiene episodios.</p>';
    return;
  }
  const seasons = Array.from(new Set(s.episodes.map((e) => e.season))).sort((a, b) => a - b);
  if (!seasons.includes(viewSeason)) viewSeason = seasons[0];

  let html = '<div class="chips">' + seasons.map((n) =>
    `<button class="chip ${n === viewSeason ? 'active' : ''}" data-season="${n}">Temporada ${n}</button>`).join('')
    + `<span class="chipsp"></span><button class="chip" data-dlseason="1">⬇ Temporada ${viewSeason}</button><button class="chip" data-dlseries="1">⬇ Toda la serie</button></div>`;
  html += '<div class="eps">';
  s.episodes.forEach((ep, i) => {
    if (ep.season !== viewSeason) return;
    const pr = S.progress[ep.key];
    const pct = pr && pr.d && !pr.done ? Math.min(100, (pr.t / pr.d) * 100) : 0;
    const playing = current && current.key === ep.key;
    const bg = [ep.img, s.logo].filter(Boolean).map((u) => `url('${esc(u)}')`).join(',');
    const meta = [ep.dur, pr && pr.done ? '✓ visto' : (pct ? fmtTime(pr.t) + ' / ' + fmtTime(pr.d) : '')]
      .filter(Boolean).join(' · ');
    html += `<div class="epc ${pr && pr.done ? 'done' : ''} ${playing ? 'playing' : ''}" data-ep="${i}">
      <div class="thumb" ${bg ? `style="background-image:${bg}"` : ''}>
        <span class="badge">E${pad(ep.num)}</span>
        <button class="dlb" data-dlep="${i}" title="Descargar">⬇</button>
        <span class="play">${playing ? '▶ Reproduciendo' : '▶'}</span>
        ${pct ? `<div class="pbar" style="width:${pct}%"></div>` : ''}
      </div>
      <div class="epbody">
        <div class="eptitle">${esc(cleanEpTitle(ep.title))}</div>
        ${ep.plot ? `<div class="epplot">${esc(ep.plot)}</div>` : ''}
        ${meta ? `<div class="epmeta">${esc(meta)}</div>` : ''}
      </div>
    </div>`;
  });
  grid.innerHTML = html + '</div>';
  setStatus(`${s.episodes.length} episodios`);
}

/* ===================== series ===================== */
function buildXtreamEpisodes(p, info) {
  const raw = info && info.episodes ? info.episodes : {};
  const seasons = Array.isArray(raw) ? raw.map((l, i) => [i + 1, l]) : Object.entries(raw);
  const b = plBase(p), u = enc(p.user), pw = enc(p.pass);
  const eps = [];
  seasons.forEach(([sk, list]) => {
    (Array.isArray(list) ? list : []).forEach((e) => {
      const season = parseInt(e.season, 10) || parseInt(sk, 10) || 1;
      const num = parseInt(e.episode_num, 10) || 0;
      const inf = e.info && !Array.isArray(e.info) ? e.info : {};
      eps.push({
        key: `${p.id}:ep:${e.id}`, season, num,
        url: `${b}/series/${u}/${pw}/${e.id}.${e.container_extension || 'mp4'}`,
        title: `T${pad(season)}E${pad(num)} - ${e.title || ''}`,
        img: inf.movie_image || '',
        plot: inf.plot || '',
        dur: inf.duration || ''
      });
    });
  });
  eps.sort((a, b2) => a.season - b2.season || a.num - b2.num);
  return eps;
}

async function openSeries(item, autoPlayKey) {
  const p = activePl();
  try {
    if (!item.episodes) {
      setStatus('Cargando episodios…');
      const info = await api(p, 'get_series_info', `&series_id=${enc(item.id)}`);
      item.episodes = buildXtreamEpisodes(p, info);
      const sinf = info && info.info && !Array.isArray(info.info) ? info.info : {};
      item.plot = sinf.plot || '';
    }
    viewSeries = item;
    // temporada inicial: la del capítulo a reproducir o la última que viste
    const target = autoPlayKey ? item.episodes.find((e) => e.key === autoPlayKey) : null;
    if (target) viewSeason = target.season;
    else {
      const seen = item.episodes.filter((e) => S.progress[e.key])
        .sort((a, b) => S.progress[b.key].updated - S.progress[a.key].updated)[0];
      viewSeason = seen ? seen.season : (item.episodes[0] ? item.episodes[0].season : 1);
    }
    render();
    if (autoPlayKey) {
      const i = item.episodes.findIndex((e) => e.key === autoPlayKey);
      if (i >= 0) playEpisode(i);
    }
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
}

function seriesRefOf(s) {
  return { key: s.key, pid: s.pid, title: s.title, logo: s.logo, id: s.id, type: 'series' };
}

function playEpisode(i) {
  const s = viewSeries;
  if (!s) return;
  playQueue(s.episodes, i, s);
}

/* ===================== reproducción ===================== */
function playQueue(queue, index, seriesItem) {
  const ep = queue[index];
  playMedia({
    key: ep.key, title: ep.title, url: ep.url, type: 'episode',
    img: ep.img || (seriesItem && seriesItem.logo) || '',
    queue, index, seriesItem
  });
}

function destroyHls() {
  if (hls) { try { hls.destroy(); } catch (e) { /* nada */ } hls = null; }
}

function hideNextOverlay() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  $('#nextOverlay').classList.add('hidden');
}

function showError(msg) {
  const el = $('#playerError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function playMedia(m) {
  const v = $('#video');
  window.iptv.transcodeStop();
  clearTimeout(checkTimer);
  m.tOffset = 0;
  m.transcoding = false;
  m.converting = false;
  m.checked = false;
  current = m;
  hideNextOverlay();
  $('#playerError').classList.add('hidden');
  $('#playerWrap').classList.remove('hidden');
  $('#nowTitle').textContent = (m.seriesItem ? m.seriesItem.title + ' — ' : '') + m.title;
  $('#btnPrev').classList.toggle('hidden', !m.queue);
  $('#btnNext').classList.toggle('hidden', !m.queue);
  $('#btnFavNow').classList.toggle('hidden', !!m.queue || !m.item);
  updateFavNow();
  destroyHls();
  // al avanzar de capítulo, mostrar su temporada y resaltarlo en la lista
  if (viewSeries && m.seriesItem === viewSeries && m.queue && m.queue[m.index]) {
    viewSeason = m.queue[m.index].season;
    renderEpisodes();
  }

  const saved = S.progress[m.key];
  const resumeAt = saved && !saved.done && saved.t > 10 && (!saved.d || saved.t < saved.d - 30) ? saved.t : 0;
  v.onloadedmetadata = () => {
    if (isFinite(v.duration) && v.duration > 0) m.knownD = v.duration;
    if (resumeAt && m.type !== 'live') v.currentTime = resumeAt;
  };

  const isHls = /\.m3u8(\?|$)/i.test(m.url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ maxBufferLength: 30 });
    hls.on(window.Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (current && !current.converting) startTranscode(false);
      else showError('No se pudo reproducir aquí. Prueba “Abrir en VLC”.');
    });
    hls.loadSource(m.url);
    hls.attachMedia(v);
  } else {
    v.src = m.url;
  }
  v.play().catch(() => { /* autoplay bloqueado */ });

  // EPG
  $('#epg').innerHTML = '';
  if (m.type === 'live' && m.item) showEpg(m.item);
}

function playItem(item) {
  playMedia({ key: item.key, title: item.title, url: streamUrl(item), type: item.type, item, img: item.logo || '' });
}

function saveProgress(force) {
  if (!current || current.type === 'live') return;
  const v = $('#video');
  const dur = current.knownD || v.duration;
  if (!isFinite(dur) || dur <= 0) return;
  if (current.transcoding && !current.knownD) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  const entry = {
    key: current.key, pid: activePl().id, title: current.title, url: current.url,
    type: current.type, t: (current.tOffset || 0) + v.currentTime, d: dur, updated: now, done: false,
    img: current.img || ''
  };
  if (current.seriesItem) entry.seriesRef = seriesRefOf(current.seriesItem);
  else if (current.item) entry.itemRef = { key: current.item.key, title: current.item.title, logo: current.item.logo, type: current.item.type, url: streamUrl(current.item), pid: current.item.pid };
  S.progress[current.key] = entry;
  save();
}

function onEnded() {
  if (!current || current.type === 'live') return;
  const now = Date.now();
  const prev = S.progress[current.key] || {};
  S.progress[current.key] = Object.assign({}, prev, {
    key: current.key, pid: activePl().id, title: current.title, type: current.type,
    seriesRef: current.seriesItem ? seriesRefOf(current.seriesItem) : prev.seriesRef,
    done: true, updated: now
  });
  // Dejar el siguiente capítulo listo en "Continuar viendo"
  if (current.queue && current.index + 1 < current.queue.length) {
    const nx = current.queue[current.index + 1];
    if (!S.progress[nx.key]) {
      S.progress[nx.key] = {
        key: nx.key, pid: activePl().id, title: nx.title, url: nx.url, type: 'episode',
        t: 0, d: 0, updated: now + 1, done: false,
        img: nx.img || (current.seriesItem && current.seriesItem.logo) || '',
        seriesRef: current.seriesItem ? seriesRefOf(current.seriesItem) : null
      };
    }
  }
  save();
  if (current.queue && current.index + 1 < current.queue.length) {
    if (S.autoNext) startCountdown(); else if (viewSeries) render();
  } else if (viewSeries) render();
}

function startCountdown() {
  const nx = current.queue[current.index + 1];
  $('#nextTitle').textContent = nx.title;
  let n = 5;
  $('#nextCount').textContent = n;
  $('#nextOverlay').classList.remove('hidden');
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    n--;
    $('#nextCount').textContent = n;
    if (n <= 0) goNext();
  }, 1000);
}

function goNext() {
  if (!current || !current.queue) return;
  const i = current.index + 1;
  if (i >= current.queue.length) return;
  playQueue(current.queue, i, current.seriesItem);
}
function goPrev() {
  if (!current || !current.queue || current.index <= 0) return;
  playQueue(current.queue, current.index - 1, current.seriesItem);
}

function closePlayer() {
  const v = $('#video');
  saveProgress(true);
  hideNextOverlay();
  clearTimeout(checkTimer);
  destroyHls();
  window.iptv.transcodeStop();
  v.pause();
  v.removeAttribute('src');
  v.load();
  current = null;
  $('#playerWrap').classList.add('hidden');
  if (tab === 'continue' || viewSeries) render();
}

function updateFavNow() {
  const b = $('#btnFavNow');
  const on = current && current.item && S.favs[current.item.key];
  b.style.color = on ? 'var(--accent2)' : '';
}

/* ===================== descargas ===================== */
function episodeDlItem(ep, group) {
  const ext = (ep.url.match(/\.(\w+)$/) || [])[1] || 'mp4';
  return {
    id: ep.key, kind: 'episode', group,
    title: `S${pad(ep.season)}E${pad(ep.num)} - ${cleanEpTitle(ep.title)}`,
    img: ep.img || (viewSeries && viewSeries.logo) || '',
    plot: ep.plot || '',
    url: ep.url, ext
  };
}

function downloadEpisodes(eps) {
  if (!viewSeries || !eps || !eps.length) return;
  queueDl(eps.map((ep) => episodeDlItem(ep, viewSeries.title)));
}

function downloadItem(item) {
  if (!item || item.type !== 'movie') return;
  queueDl([{ id: item.key, kind: 'movie', title: item.title, img: item.logo || '', url: streamUrl(item), ext: item.ext || 'mp4' }]);
}

function queueDl(items) {
  window.iptv.dlEnqueue(items).then((n) => {
    setStatus(n ? `${n} en cola de descarga (de 3 en 3)` : 'Ya estaban descargando o descargados');
  });
}

function playDownloaded(id) {
  const j = dlList.find((x) => x.id === id);
  window.iptv.dlFileUrl(id).then((url) => {
    if (!url) { setStatus('El archivo ya no existe'); return; }
    playMedia({ key: 'dl:' + id, title: j ? j.title : 'Descarga', url, type: 'download', img: '' });
  });
}

const DL_LABEL = { queued: 'En cola', downloading: 'Descargando', paused: 'Pausada', done: 'Lista', error: 'Error' };
function fmtMB(b) { return (b / 1048576).toFixed(1) + ' MB'; }
function fmtMBs(bps) { return (bps / 1048576).toFixed(1) + ' MB/s'; }
function fmtEta(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + ' s';
  if (sec < 3600) return Math.round(sec / 60) + ' min';
  return Math.floor(sec / 3600) + ' h ' + Math.round((sec % 3600) / 60) + ' min';
}

function dlRowHtml(j) {
  const id = esc(j.id);
  const pct = j.status === 'done' ? 100 : (j.total ? Math.min(100, (j.received / j.total) * 100) : 0);
  const size = j.total ? `${fmtMB(j.received)} de ${fmtMB(j.total)}` : (j.received ? fmtMB(j.received) : '');
  const speed = j.status === 'downloading' && j.speed ? fmtMBs(j.speed) : '';
  const eta = speed && j.total ? fmtEta((j.total - j.received) / j.speed) : '';
  const parts = [size, (j.status !== 'done' && pct) ? Math.round(pct) + '%' : '', speed, eta ? 'quedan ' + eta : ''];
  if (j.error) parts.push(j.error);
  const meta = parts.filter(Boolean).map((x) => esc(x)).join(' · ');

  let btns;
  if (j.status === 'done') {
    btns = `<button class="btn primary" data-dlplay="${id}">▶ Reproducir</button>
      <button class="btn" data-dlreveal="${id}">Abrir carpeta</button>
      <button class="btn" data-dla="remove" data-id="${id}">Quitar de la lista</button>`;
  } else {
    btns = (j.status === 'downloading' || j.status === 'queued')
      ? `<button class="btn" data-dla="pause" data-id="${id}">⏸ Pausar</button>`
      : `<button class="btn primary" data-dla="resume" data-id="${id}">▶ Reanudar</button>`;
    btns += `<button class="btn" data-dla="cancel" data-id="${id}">Cancelar</button>`;
  }
  const thumbStyle = j.img ? `style="background-image:url('${esc(j.img)}')"` : '';
  const playAttr = j.status === 'done' ? `data-dlplay="${id}" title="Reproducir"` : '';
  return `<div class="dlrow ${j.status}">
    <div class="dlthumb ${j.kind === 'movie' ? 'poster' : ''}" ${thumbStyle} ${playAttr}>
      <span class="dlstate">${esc(DL_LABEL[j.status] || j.status)}</span>
    </div>
    <div class="dlinfo">
      <div class="dlgroup">${esc(j.group || (j.kind === 'movie' ? 'Película' : ''))}</div>
      <div class="dltitle">${esc(j.title)}</div>
      ${j.plot ? `<div class="dlplot">${esc(j.plot)}</div>` : ''}
      <div class="dlbar"><div style="width:${pct}%"></div></div>
      <div class="dlmeta">${meta}</div>
      <div class="row dlbtns">${btns}</div>
    </div>
  </div>`;
}

function renderDownloads() {
  const grid = $('#grid');
  grid.className = '';
  const list = dlList;
  if (!list.length) {
    grid.innerHTML = '<p class="muted">No hay descargas. Usa los botones ⬇ en películas, capítulos o temporadas.</p>';
    setStatus('');
    return;
  }
  const n = (st) => list.filter((j) => j.status === st).length;
  grid.innerHTML = '<div class="dllist">' + list.map(dlRowHtml).join('') + '</div>';
  setStatus(`${n('downloading')} descargando · ${n('queued')} en cola · ${n('done')} listas · ${n('paused') + n('error')} pausadas`);
}

/* ===================== reparar audio / video (ffmpeg) ===================== */
// Si el video suena mudo (AC3/DTS/EAC3) o no se ve (códec no soportado),
// se convierte al vuelo con ffmpeg y se reproduce desde un servidor local.
function scheduleCheck() {
  clearTimeout(checkTimer);
  const m = current;
  if (!m || m.transcoding || m.converting || m.checked) return;
  checkTimer = setTimeout(() => {
    if (current !== m || m.transcoding || m.converting) return;
    const v = $('#video');
    if (v.paused || v.currentTime < 1.5) { scheduleCheck(); return; }
    m.checked = true;
    const noVideo = v.videoWidth === 0;
    const noAudio = typeof v.webkitAudioDecodedByteCount === 'number' &&
      v.webkitAudioDecodedByteCount === 0 && !v.muted && v.volume > 0;
    if (noVideo) startTranscode(true);
    else if (noAudio) startTranscode(false);
  }, 4000);
}

async function startTranscode(full) {
  const m = current;
  if (!m || m.converting) return;
  const v = $('#video');
  if (!window.Hls) { showError('Falta hls.js: ejecuta "npm install" en la carpeta del proyecto.'); return; }
  m.converting = true;
  const pos = m.type === 'live' ? 0 : (m.tOffset || 0) + (v.currentTime || 0);
  if (!m.knownD && !m.transcoding && isFinite(v.duration) && v.duration > 0) m.knownD = v.duration;
  clearTimeout(checkTimer);
  destroyHls();
  v.onloadedmetadata = null;
  v.pause();
  v.removeAttribute('src');
  v.load();
  showError(full ? 'Convirtiendo video y audio para reproducirlo…' : 'Preparando audio compatible…');
  const r = await window.iptv.transcodeStart(m.url, { start: pos, full, live: m.type === 'live' });
  if (current !== m) return;
  if (!r.ok) { showError(r.error || 'No se pudo convertir el video'); return; }
  m.transcoding = true;
  m.tOffset = pos > 1 ? Math.floor(pos) : 0;
  $('#playerError').classList.add('hidden');
  hls = new window.Hls({ startPosition: 0, maxBufferLength: 30 });
  hls.on(window.Hls.Events.ERROR, (_e, d) => {
    if (d.fatal) showError('No se pudo reproducir. Prueba “Abrir en VLC”.');
  });
  hls.loadSource(r.url);
  hls.attachMedia(v);
  v.play().catch(() => { /* nada */ });
}

/* ===================== EPG ===================== */
function renderEpg(list) {
  const now = Date.now();
  const el = $('#epg');
  if (!list.length) { el.innerHTML = '<div class="muted">Sin guía de programación para este canal.</div>'; return; }
  el.innerHTML = '<div class="lbl muted">Guía</div>' + list.map((e) => {
    const isNow = e.start <= now && now < e.stop;
    const t = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="prog ${isNow ? 'now' : ''}"><div class="t">${t(e.start)} – ${t(e.stop)}${isNow ? ' · ahora' : ''}</div><div>${esc(e.title)}</div></div>`;
  }).join('');
}

function parseXmltvDate(s) {
  const m = String(s).match(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-])?(\d{2})?(\d{2})?/);
  if (!m) return 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7] && m[8]) {
    const off = (+m[8] * 60 + +(m[9] || 0)) * 60000;
    t -= m[7] === '-' ? -off : off;
  }
  return t;
}
function decodeEntities(s) {
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

async function showEpg(item) {
  const p = activePl();
  const el = $('#epg');
  try {
    if (p.type === 'xtream' && item.id) {
      const r = await api(p, 'get_short_epg', `&stream_id=${enc(item.id)}&limit=6`);
      const list = (r.epg_listings || []).map((e) => ({
        title: b64utf8(e.title),
        start: (+e.start_timestamp || 0) * 1000,
        stop: (+e.stop_timestamp || 0) * 1000
      }));
      if (current && current.item === item) renderEpg(list);
    } else if (item.epgId) {
      const url = p.epg || (cache[p.id] || {}).epgUrl;
      if (!url) { el.innerHTML = '<div class="muted">Esta lista no tiene EPG.</div>'; return; }
      el.innerHTML = '<div class="muted">Cargando guía…</div>';
      if (!xmltvCache[url]) {
        const r = await window.iptv.get(url);
        if (!r.ok) throw new Error('EPG no disponible');
        xmltvCache[url] = r.text;
      }
      const text = xmltvCache[url];
      const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
      const now = Date.now();
      const list = [];
      let m;
      while ((m = re.exec(text)) && list.length < 6) {
        const attrs = m[1];
        const ch = (attrs.match(/channel="([^"]*)"/) || [])[1];
        if (ch !== item.epgId) continue;
        const stop = parseXmltvDate((attrs.match(/stop="([^"]*)"/) || [])[1]);
        if (stop < now) continue;
        list.push({
          title: decodeEntities((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || ''),
          start: parseXmltvDate((attrs.match(/start="([^"]*)"/) || [])[1]),
          stop
        });
      }
      if (current && current.item === item) renderEpg(list);
    } else {
      el.innerHTML = '<div class="muted">Sin guía para este canal.</div>';
    }
  } catch (err) {
    el.innerHTML = '<div class="muted">No se pudo cargar la guía.</div>';
  }
}

/* ===================== listas / pestañas ===================== */
function refreshPlaylistSelect() {
  const sel = $('#playlistSelect');
  sel.innerHTML = S.playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (S.active) sel.value = S.active;
}

async function setTab(t) {
  tab = t;
  query = '';
  $('#search').value = '';
  curCat = 'all';
  limit = 200;
  viewSeries = null;
  const p = activePl();
  if (!p) { render(); return; }
  try {
    if (['live', 'movie', 'series'].includes(t)) await ensureLoaded(t);
    else await ensureLoadedForFavs();
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
  render();
}

async function ensureLoadedForFavs() {
  const p = activePl();
  if (p && p.type === 'm3u') await ensureLoaded('live');
}

async function switchPlaylist(id) {
  S.active = id;
  save();
  await setTab(tab);
}

/* ===================== eventos ===================== */
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});
$('#playlistSelect').addEventListener('change', (e) => switchPlaylist(e.target.value));
$('#catSelect').addEventListener('change', (e) => { curCat = e.target.value; limit = 200; render(); });
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = e.target.value; limit = 200; render(); }, 200);
});
$('#btnMore').addEventListener('click', () => { limit += 200; render(); });

$('#grid').addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.stopPropagation();
    const key = fav.dataset.fav;
    if (S.favs[key]) delete S.favs[key];
    else {
      const it = findItem(key);
      if (it) {
        const copy = Object.assign({}, it);
        delete copy.episodes;
        S.favs[key] = copy;
      }
    }
    save();
    render();
    updateFavNow();
    return;
  }
  const card = e.target.closest('.card');
  if (card) {
    const it = findItem(card.dataset.key);
    if (!it) return;
    if (it.type === 'series') openSeries(it.episodes ? it : resolveSeries(it));
    else playItem(it);
    return;
  }
  const dlk = e.target.closest('[data-dlkey]');
  if (dlk) { downloadItem(findItem(dlk.dataset.dlkey)); return; }
  const dle = e.target.closest('[data-dlep]');
  if (dle) { downloadEpisodes([viewSeries.episodes[parseInt(dle.dataset.dlep, 10)]]); return; }
  if (e.target.closest('[data-dlseason]')) {
    downloadEpisodes(viewSeries.episodes.filter((x) => x.season === viewSeason));
    return;
  }
  if (e.target.closest('[data-dlseries]')) { downloadEpisodes(viewSeries.episodes); return; }
  const dla = e.target.closest('[data-dla]');
  if (dla) { window.iptv.dlAction(dla.dataset.dla, dla.dataset.id); return; }
  const dlp = e.target.closest('[data-dlplay]');
  if (dlp) { playDownloaded(dlp.dataset.dlplay); return; }
  const dlr = e.target.closest('[data-dlreveal]');
  if (dlr) { window.iptv.dlReveal(dlr.dataset.dlreveal); return; }
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    e.stopPropagation();
    const en = S.progress[rm.dataset.rm];
    if (en) { en.hidden = true; save(); render(); }
    return;
  }
  const chip = e.target.closest('[data-season]');
  if (chip) { viewSeason = parseInt(chip.dataset.season, 10); renderEpisodes(); return; }
  const ep = e.target.closest('[data-ep]');
  if (ep) { playEpisode(parseInt(ep.dataset.ep, 10)); return; }
  const cont = e.target.closest('[data-cont]');
  if (cont) resumeEntry(S.progress[cont.dataset.cont]);
});

$('#crumb').addEventListener('click', (e) => {
  if (e.target.id === 'btnBack') { viewSeries = null; render(); }
});

function findItem(key) {
  const p = activePl();
  const c = cache[p.id] || {};
  for (const t of ['live', 'movie', 'series']) {
    const f = (c[t] || []).find((i) => i.key === key);
    if (f) return f;
  }
  return S.favs[key] || null;
}
function resolveSeries(it) {
  // favoritos guardan copia sin episodios: usar la versión en caché si existe
  const p = activePl();
  const full = ((cache[p.id] || {}).series || []).find((s) => s.key === it.key);
  return full || it;
}

function resumeEntry(e) {
  if (!e) return;
  if (e.seriesRef) {
    const p = activePl();
    const full = ((cache[p.id] || {}).series || []).find((s) => s.key === e.seriesRef.key);
    openSeries(full || Object.assign({}, e.seriesRef), e.key);
  } else if (e.itemRef) {
    playItem(e.itemRef);
  } else if (e.url) {
    playMedia({ key: e.key, title: e.title, url: e.url, type: e.type });
  }
}

// reproductor
const video = $('#video');
video.addEventListener('timeupdate', () => saveProgress(false));
video.addEventListener('pause', () => saveProgress(true));
video.addEventListener('ended', onEnded);
video.addEventListener('playing', () => {
  if (current && current.transcoding) $('#playerError').classList.add('hidden');
  scheduleCheck();
});
video.addEventListener('error', () => {
  if (!current || current.converting || hls) return;
  if (current.type === 'live') startTranscode(false);
  else startTranscode(true);
});
$('#btnAudio').addEventListener('click', () => {
  if (current && !current.converting) startTranscode(false);
});
$('#btnNext').addEventListener('click', goNext);
$('#btnPrev').addEventListener('click', goPrev);
$('#btnNextNow').addEventListener('click', goNext);
$('#btnNextCancel').addEventListener('click', hideNextOverlay);
$('#btnClose').addEventListener('click', closePlayer);
$('#btnVlc').addEventListener('click', async () => {
  if (!current) return;
  v_pause();
  const pos = (current.tOffset || 0) + (video.currentTime || 0);
  const opts = {};
  if (current.queue) {
    // el capítulo actual y todos los siguientes, para que VLC avance solo
    const prefix = current.seriesItem ? current.seriesItem.title + ' ' : '';
    opts.entries = current.queue.slice(current.index).map((e, i) => ({
      title: prefix + e.title, url: e.url, startTime: i === 0 ? pos : 0
    }));
  }
  const r = await window.iptv.openVlc(current.url, opts);
  if (!r.ok) showError(r.error || 'No se pudo abrir VLC');
});
function v_pause() { video.pause(); }
$('#autoNext').checked = !!S.autoNext;
$('#autoNext').addEventListener('change', (e) => { S.autoNext = e.target.checked; save(); });
$('#btnFavNow').addEventListener('click', () => {
  if (!current || !current.item) return;
  const k = current.item.key;
  if (S.favs[k]) delete S.favs[k]; else S.favs[k] = Object.assign({}, current.item);
  save();
  updateFavNow();
  render();
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'n' || e.key === 'N') goNext();
  if (e.key === 'p' || e.key === 'P') goPrev();
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen(); else $('#videoBox').requestFullscreen();
  }
});

/* ===================== diálogo añadir lista ===================== */
let addKind = 'xtream';
let fileText = null;
const dlg = $('#dlgAdd');

function setKind(k) {
  addKind = k;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.kind === k));
  $('#boxXtream').classList.toggle('hidden', k !== 'xtream');
  $('#boxM3u').classList.toggle('hidden', k !== 'm3u');
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
$('#btnAdd').addEventListener('click', () => {
  fileText = null;
  ['#fName', '#fServer', '#fUser', '#fPass', '#fUrl', '#fEpg'].forEach((s) => { $(s).value = ''; });
  $('#fileName').textContent = '';
  setKind('xtream');
  dlg.showModal();
});
$('#btnCancelAdd').addEventListener('click', () => dlg.close());
$('#btnFile').addEventListener('click', async () => {
  const f = await window.iptv.openM3uFile();
  if (f) {
    fileText = f.text;
    $('#fileName').textContent = f.name;
    if (!$('#fName').value) $('#fName').value = f.name.replace(/\.\w+$/, '');
  }
});
$('#formAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = 'p' + Date.now().toString(36);
  const name = $('#fName').value.trim() || 'Mi lista';
  let p;
  if (addKind === 'xtream') {
    const server = $('#fServer').value.trim();
    const user = $('#fUser').value.trim();
    const pass = $('#fPass').value;
    if (!server || !user) { setStatus('Completa servidor y usuario'); return; }
    p = { id, name, type: 'xtream', server, user, pass };
  } else {
    const url = $('#fUrl').value.trim();
    if (!url && !fileText) { setStatus('Indica una URL o elige un archivo'); return; }
    p = { id, name, type: 'm3u', url, epg: $('#fEpg').value.trim() };
    if (!url) {
      try { localStorage.setItem('iptv_m3u_' + id, fileText); }
      catch (err) { setStatus('El archivo es muy grande para guardarlo. Súbelo a una URL.'); return; }
    }
  }
  S.playlists.push(p);
  S.active = id;
  save();
  dlg.close();
  refreshPlaylistSelect();
  setTab('live');
});

$('#btnDel').addEventListener('click', () => {
  const p = activePl();
  if (!p || !confirm(`¿Quitar la lista “${p.name}”?`)) return;
  S.playlists = S.playlists.filter((x) => x.id !== p.id);
  localStorage.removeItem('iptv_m3u_' + p.id);
  delete cache[p.id];
  S.active = S.playlists[0] ? S.playlists[0].id : null;
  save();
  refreshPlaylistSelect();
  setTab(tab);
});

/* ===================== actualizaciones ===================== */
function renderUpd(s) {
  $('#verLbl').textContent = s.version ? 'Versión ' + s.version : '';
  $('#updMsg').textContent = s.msg || '';
  $('#updMsg').className = 'updmsg ' + (s.state || '');
  $('#btnUpd').disabled = s.state === 'checking' || s.state === 'downloading';
}
$('#btnUpd').addEventListener('click', () => { window.iptv.updCheck(); });
$('#btnRel').addEventListener('click', () => { window.iptv.updReleases(); });
window.iptv.onUpdStatus(renderUpd);
window.iptv.updState().then(renderUpd);

/* ===================== orden de categorías ===================== */
// Las categorías que el usuario ordenó van primero, en ese orden; el resto sigue alfabético.
function orderedCats(pid, t, entries) {
  const order = (S.catOrder[pid] && S.catOrder[pid][t]) || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return entries.slice().sort((a, b) => {
    const ra = rank.has(a[0]) ? rank.get(a[0]) : Infinity;
    const rb = rank.has(b[0]) ? rank.get(b[0]) : Infinity;
    if (ra !== rb) return ra - rb;
    return String(a[1]).localeCompare(String(b[1]));
  });
}

let catDraft = [];
function renderCatDraft() {
  $('#catList').innerHTML = catDraft.map((c, i) => `<div class="catrow">
      <span class="catname">${esc(c[1])}</span>
      <button class="btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Subir">▲</button>
      <button class="btn" data-down="${i}" ${i === catDraft.length - 1 ? 'disabled' : ''} title="Bajar">▼</button>
    </div>`).join('') || '<p class="muted">No hay categorías.</p>';
}
$('#btnCatEdit').addEventListener('click', () => {
  const p = activePl();
  if (!p || !['live', 'movie', 'series'].includes(tab)) return;
  const cats = ((cache[p.id] || {}).cats || {})[tab] || {};
  catDraft = orderedCats(p.id, tab, Object.entries(cats));
  renderCatDraft();
  $('#dlgCats').showModal();
});
$('#catList').addEventListener('click', (e) => {
  const up = e.target.closest('[data-up]');
  const dn = e.target.closest('[data-down]');
  if (up) {
    const i = parseInt(up.dataset.up, 10);
    [catDraft[i - 1], catDraft[i]] = [catDraft[i], catDraft[i - 1]];
    renderCatDraft();
  } else if (dn) {
    const i = parseInt(dn.dataset.down, 10);
    [catDraft[i + 1], catDraft[i]] = [catDraft[i], catDraft[i + 1]];
    renderCatDraft();
  }
});
$('#btnCatSave').addEventListener('click', () => {
  const p = activePl();
  if (p) {
    S.catOrder[p.id] = S.catOrder[p.id] || {};
    S.catOrder[p.id][tab] = catDraft.map((c) => c[0]);
    save();
  }
  $('#dlgCats').close();
  fillCategories();
});
$('#btnCatReset').addEventListener('click', () => {
  const p = activePl();
  if (p && S.catOrder[p.id]) { delete S.catOrder[p.id][tab]; save(); }
  $('#dlgCats').close();
  fillCategories();
});
$('#btnCatCancel').addEventListener('click', () => $('#dlgCats').close());

/* ===================== inicio ===================== */
window.iptv.onDlUpdate((list) => {
  dlList = list;
  if (tab === 'downloads' && !viewSeries) renderDownloads();
});
window.iptv.dlList().then((l) => { dlList = l; });
if (!S.active && S.playlists[0]) S.active = S.playlists[0].id;
refreshPlaylistSelect();
setTab('live');
