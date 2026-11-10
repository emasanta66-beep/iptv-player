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
const S = Object.assign({ playlists: [], active: null, favs: {}, progress: {}, autoNext: true, catOrder: {},
  trackPref: { audio: null, sub: null, subOff: false, everUsed: false } },
  JSON.parse(localStorage.getItem('iptv') || '{}'));
function save() {
  try { localStorage.setItem('iptv', JSON.stringify(S)); } catch (e) { /* cuota */ }
}

/* ===================== estado en memoria ===================== */
let tab = 'home';
let query = '';
let curCat = 'all';
let limit = 200;
let viewSeries = null;           // serie abierta (vista de episodios)
let viewMovie = null;            // película abierta en su ficha
let viewSeason = 1;              // temporada mostrada
const cache = {};                // por lista: {live,movie,series,cats,epgUrl}
const xmltvCache = {};           // url -> texto
let current = null;              // reproducción actual
let hls = null;
let dualMode = false;
let dualTarget = 'b';
let dualAudio = 'a';
let secondaryCurrent = null;
let secondaryHls = null;
let dualAudioSaved = null;
let secondaryFallback = false;
let countdownTimer = null;
let lastSave = 0;
let ignoredPauseEvents = 0;
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
      cur = {
        title, logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || 'Sin categoría',
        epgId: attrs['tvg-id'] || '', tvgName: attrs['tvg-name'] || '',
        catchup: attrs.catchup || '', catchupDays: Number(attrs['catchup-days'] || attrs['tvg-rec'] || attrs.timeshift) || 0,
        catchupSource: attrs['catchup-source'] || '', timeshift: attrs.timeshift || ''
      };
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
          title: cur.title, logo: cur.logo, cat: cur.group, url: cur.url, epgId: cur.epgId,
          tvgName: cur.tvgName, catchup: cur.catchup, catchupDays: cur.catchupDays,
          catchupSource: cur.catchupSource, timeshift: cur.timeshift
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
  cache[p.id] = cache[p.id] || { loaded: {}, catsLoaded: {}, byCat: {} };
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

  // Xtream: aquí solo se cargan las categorías (es rápido).
  // Los elementos se piden por categoría con ensureCategory(), para no bajar todo el catálogo.
  if (c.catsLoaded[tabName]) return c;
  const catAction = { live: 'get_live_categories', movie: 'get_vod_categories', series: 'get_series_categories' }[tabName];
  setStatus('Cargando categorías…');
  const cs = await api(p, catAction);
  c.cats = c.cats || { live: {}, movie: {}, series: {} };
  c.cats[tabName] = {};
  (Array.isArray(cs) ? cs : []).forEach((x) => { c.cats[tabName][String(x.category_id)] = x.category_name; });
  c.catsLoaded[tabName] = true;
  return c;
}

// ¿Falta pedir al servidor los elementos de esta categoría? (solo listas Xtream)
function categoryPending(tabName, catId) {
  const p = activePl();
  const c = p && cache[p.id];
  if (!p || p.type === 'm3u' || !c || c.loaded[tabName]) return false;
  return catId === 'all' || !((c.byCat[tabName] || {})[catId]);
}

// Xtream: trae solo los elementos de una categoría ('all' trae todo el catálogo, tarda más).
// Las listas M3U ya vienen completas, así que no hacen nada aquí.
async function ensureCategory(tabName, catId) {
  if (!categoryPending(tabName, catId)) return;
  const p = activePl();
  const c = cache[p.id];
  const listAction = { live: 'get_live_streams', movie: 'get_vod_streams', series: 'get_series' }[tabName];
  setStatus('Cargando…');
  const ls = await api(p, listAction, catId === 'all' ? '' : '&category_id=' + enc(catId));
  const items = (Array.isArray(ls) ? ls : []).map((r) => {
    const id = r.stream_id != null ? r.stream_id : r.series_id;
    return {
      key: `${p.id}:${tabName}:${id}`, pid: p.id, type: tabName,
      title: String(r.name || '?'), logo: r.stream_icon || r.cover || '',
      cat: String(r.category_id), id, ext: r.container_extension || '',
      epgId: r.epg_channel_id || '', added: Number(r.added) || 0,
      tvArchive: Number(r.tv_archive) === 1,
      archiveDays: Number(r.tv_archive_duration) || 0
    };
  });
  if (catId === 'all') {
    c[tabName] = items;
    c.loaded[tabName] = true;
  } else {
    const have = new Set((c[tabName] || []).map((i) => i.key));
    c[tabName] = (c[tabName] || []).concat(items.filter((i) => !have.has(i.key)));
    c.byCat[tabName] = c.byCat[tabName] || {};
    c.byCat[tabName][catId] = true;
  }
}

const CATALOG_CACHE_TTL = 6 * 60 * 60 * 1000;
function catalogCacheSnapshot(c) {
  const fields = ['key', 'pid', 'type', 'title', 'logo', 'cat', 'id', 'ext', 'epgId', 'added', 'tvArchive', 'archiveDays'];
  const pickItems = (items) => (items || []).map((item) => {
    const copy = {};
    fields.forEach((field) => { if (item[field] != null) copy[field] = item[field]; });
    return copy;
  });
  return {
    version: 1, savedAt: Date.now(),
    cats: { movie: Object.assign({}, c.cats?.movie || {}), series: Object.assign({}, c.cats?.series || {}) },
    movie: pickItems(c.movie), series: pickItems(c.series)
  };
}

function restoreCatalogCache(pid, saved) {
  if (!saved || saved.version !== 1 || !Array.isArray(saved.movie) || !Array.isArray(saved.series)) return null;
  const c = cache[pid] || {};
  Object.assign(c, {
    cats: { live: {}, movie: saved.cats?.movie || {}, series: saved.cats?.series || {} },
    catsLoaded: { movie: true, series: true },
    loaded: { movie: true, series: true },
    byCat: { movie: {}, series: {} },
    movie: saved.movie, series: saved.series
  });
  cache[pid] = c;
  return c;
}

// Primera categoría según el orden de la lista (el que el usuario eligió con “Ordenar”)
function firstCat(p, tabName) {
  const cats = ((cache[p.id] || {}).cats || {})[tabName] || {};
  const first = orderedCats(p.id, tabName, Object.entries(cats))[0];
  return first ? first[0] : 'all';
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
  $('#toolbar').classList.toggle('hidden', tab === 'continue' || tab === 'downloads' || !!viewSeries || !!viewMovie);
  if (tab === 'downloads') { crumb.classList.add('hidden'); renderDownloads(); return; }

  if (!p) {
    grid.innerHTML = '<p class="muted">Pulsa “+ Añadir” para agregar una lista Xtream o M3U.</p>';
    crumb.classList.add('hidden');
    return;
  }

  if (viewSeries) { renderEpisodes(); return; }
  if (viewMovie) { renderMovieDetail(); return; }
  crumb.classList.add('hidden');
  crumb.classList.remove('movie-crumb');
  fillCategories();
  if (tab === 'home') { renderHome(); return; }

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

function resumeEntries(includeDone = false) {
  const p = activePl();
  const seen = new Set();
  return Object.values(S.progress)
    .filter((e) => p && e.pid === p.id && (includeDone || !e.done) && !e.hidden)
    .sort((a, b) => b.updated - a.updated)
    .filter((e) => {
      const key = e.seriesRef ? 's:' + e.seriesRef.key : e.key;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
}

function renderHome() {
  const p = activePl();
  const c = cache[p.id] || {};
  const recentMovies = [...(c.movie || [])].sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 5);
  const recentSeries = [...(c.series || [])].sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 5);
  const continueList = resumeEntries();
  const feature = resumeEntries(true)[0] || continueList[0];
  const featureItem = feature && (feature.itemRef || feature.seriesRef);
  if (featureItem && featureItem.id == null) {
    const catalogItem = [...(c.movie || []), ...(c.series || [])].find((x) => x.key === featureItem.key);
    if (catalogItem) Object.assign(featureItem, { id: catalogItem.id, type: catalogItem.type });
  }
  if (feature && !feature.plot && featureItem && !featureItem.plot && featureItem.id != null && !feature.loadingPlot) {
    feature.loadingPlot = true;
    const detailAction = featureItem.type === 'series' ? 'get_series_info' : 'get_vod_info';
    const idParam = featureItem.type === 'series' ? 'series_id' : 'vod_id';
    api(p, detailAction, `&${idParam}=${enc(featureItem.id)}`).then((data) => {
      const info = data && data.info && !Array.isArray(data.info) ? data.info : {};
      feature.plot = info.plot || '';
      featureItem.plot = feature.plot;
      if (S.progress[feature.key]) {
        S.progress[feature.key].plot = feature.plot;
        if (S.progress[feature.key].itemRef) S.progress[feature.key].itemRef.plot = feature.plot;
        if (S.progress[feature.key].seriesRef) S.progress[feature.key].seriesRef.plot = feature.plot;
        save();
      }
      if (tab === 'home') renderHome();
    }).catch(() => { feature.loadingPlot = false; });
  }
  const featureImg = (feature && feature.img) || (featureItem && featureItem.logo) || '';
  const featureTitle = featureItem ? featureItem.title : (feature && feature.title) || '';
  const featureAction = feature ? `<button class="btn primary" data-cont="${esc(feature.key)}">▶ ${feature.done ? 'Ver de nuevo' : 'Continuar viendo'}</button>` :
    '<span class="home-hint">Elige una película o serie para empezar</span>';
  const shelf = (title, items, empty) => `<section class="home-shelf"><div class="home-shelf-head"><h2>${title}</h2><span>${items.length ? items.length + ' títulos' : ''}</span></div><div class="home-recent-grid">${items.length ? items.map(cardHtml).join('') : `<p class="muted">${empty}</p>`}</div></section>`;
  const continueCards = continueList.map((e) => {
    const item = e.itemRef || e.seriesRef || {};
    const img = e.img || item.logo || '';
    const pct = e.d ? Math.min(100, (e.t / e.d) * 100) : 0;
    return `<div class="home-resume" data-cont="${esc(e.key)}"><div class="home-resume-art" ${img ? `style="background-image:url('${esc(img)}')"` : ''}><span>▶</span><i style="width:${pct}%"></i></div><b>${esc(item.title || e.title)}</b><small>${e.d ? fmtTime(Math.max(0, e.d - e.t)) + ' restantes' : 'Continuar'}</small></div>`;
  }).join('');
  const searchText = query.trim().toLowerCase();
  const filter = (arr) => searchText ? arr.filter((x) => x.title.toLowerCase().includes(searchText)) : arr;
  const moviesFiltered = filter(recentMovies), seriesFiltered = filter(recentSeries);
  const grid = $('#grid');
  grid.className = 'dashboard';
  grid.innerHTML = `<section class="home-hero" ${featureImg ? `style="--hero-image:url('${esc(featureImg)}')"` : ''}>
      <div class="home-hero-copy"><span class="home-eyebrow">TU BIBLIOTECA</span><h1>${feature ? 'Vuelve a tu historia' : '¿Qué vemos hoy?'}</h1>
      <p>${feature ? esc(feature.plot || feature.itemRef?.plot || feature.seriesRef?.plot || 'Retoma donde lo dejaste y descubre qué pasa después.') : `Hola, ${esc(p.name || 'bienvenido')}. Explora tus películas y series.`}</p>${featureAction}</div>
    </section>
    <section class="home-shelf home-continue-section"><div class="home-shelf-head"><h2>Continuar viendo</h2><span>${continueList.length} títulos</span></div><div class="home-resume-rail">${continueCards || '<p class="muted">Aquí aparecerán las películas y series que dejes a medias.</p>'}</div></section>
    ${shelf('Películas agregadas recientemente', moviesFiltered, 'No hay películas disponibles.')}
    ${shelf('Series agregadas recientemente', seriesFiltered, 'No hay series disponibles.')}`;
  setStatus(`${continueList.length} por continuar · ${recentMovies.length} películas · ${recentSeries.length} series`);
}

function openMovie(item) {
  // Compatibilidad con elementos quitados por versiones anteriores, que solo los ocultaban.
  if (S.progress[item.key]?.hidden) {
    delete S.progress[item.key];
    save();
  }
  viewMovie = item;
  render();
  const p = activePl();
  if (!p || p.type !== 'xtream' || item.id == null || item.detailLoaded) return;
  api(p, 'get_vod_info', `&vod_id=${enc(item.id)}`).then((data) => {
    if (viewMovie !== item) return;
    const info = data && data.info && !Array.isArray(data.info) ? data.info : {};
    item.plot = info.plot || item.plot || '';
    item.releaseDate = info.releasedate || info.releaseDate || item.releaseDate || '';
    item.rating = info.rating || item.rating || '';
    item.cast = info.cast || item.cast || '';
    item.detailLoaded = true;
    renderMovieDetail();
  }).catch(() => { item.detailLoaded = true; });
}

function renderMovieDetail() {
  const item = viewMovie;
  if (!item) return;
  const crumb = $('#crumb');
  crumb.classList.add('movie-crumb');
  crumb.classList.remove('hidden');
  const catName = (((cache[item.pid] || {}).cats || {}).movie || {})[item.cat] || '';
  const year = (item.releaseDate || (item.title.match(/\b(19|20)\d{2}\b/) || [])[0] || '').slice(0, 4);
  const progress = S.progress[item.key];
  const resumable = progress && !progress.hidden && !progress.done && progress.t > 10;
  const meta = [year, catName, item.rating ? '★ ' + item.rating : ''].filter(Boolean).map(esc).join('<span>·</span>');
  crumb.innerHTML = `<button class="btn" id="btnBack">← Volver</button><section class="movie-detail" ${item.logo ? `style="--detail-image:url('${esc(item.logo)}')"` : ''}>
    <div class="movie-detail-poster" ${item.logo ? `style="background-image:url('${esc(item.logo)}')"` : ''}></div>
    <div class="movie-detail-copy"><span class="home-eyebrow">PELÍCULA</span><h1>${esc(item.title)}</h1><div class="movie-meta">${meta}</div>
    <p>${esc(item.plot || 'Reproduce esta película desde tu lista.')}</p>
    <div class="row"><button class="btn primary" data-play-detail>▶ ${resumable ? 'Continuar viendo' : 'Reproducir película'}</button>
    <button class="btn" data-fav-detail>${S.favs[item.key] ? '★ En favoritos' : '☆ Añadir a favoritos'}</button>
    ${item.type === 'movie' ? `<button class="btn" data-dl-detail>⬇ Descargar</button>` : ''}</div>
    ${resumable ? `<div class="detail-progress"><i style="width:${Math.min(100, (progress.t / progress.d) * 100)}%"></i></div><small>Continúa en ${fmtTime(progress.t)}</small>` : ''}</div>
  </section>`;
  const grid = $('#grid');
  grid.className = 'dashboard';
  grid.innerHTML = '';
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
  crumb.classList.remove('movie-crumb');
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
  return { key: s.key, pid: s.pid, title: s.title, logo: s.logo, id: s.id, type: 'series', plot: s.plot || '' };
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
    img: ep.img || (seriesItem && seriesItem.logo) || '', plot: ep.plot || (seriesItem && seriesItem.plot) || '',
    queue, index, seriesItem
  });
}

function destroyHls() {
  if (hls) { try { hls.destroy(); } catch (e) { /* nada */ } hls = null; }
}

function pauseForSourceReset(video) {
  if (!video.paused) ignoredPauseEvents++;
  video.pause();
}

function createHls(options) {
  return new window.Hls(Object.assign({ maxBufferLength: 20, backBufferLength: 15 }, options || {}));
}

function hideNextOverlay() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  $('#nextOverlay').classList.add('hidden');
}

function showError(msg) {
  const el = $('#playerError');
  el.textContent = msg;
  el.classList.remove('soft');
  el.classList.remove('hidden');
}

// Aviso discreto: no tapa el video ni bloquea los clics (p. ej. "Cargando subtítulo…")
function showToast(msg) {
  const el = $('#playerError');
  el.textContent = msg;
  el.classList.add('soft');
  el.classList.remove('hidden');
}

function hideError() {
  const el = $('#playerError');
  el.classList.add('hidden');
  el.classList.remove('soft');
}

function dualLabels() {
  const name = (item, fallback) => item ? item.title : fallback;
  $('#dualLabelA').textContent = 'A · ' + name(current && current.item, current ? current.title : 'CANAL PRINCIPAL');
  $('#dualLabelB').textContent = 'B · ' + name(secondaryCurrent && secondaryCurrent.item, 'ELIGE UN CANAL');
  $('#dualAudioBadgeB').textContent = dualAudio === 'b' ? 'AUDIO ACTIVO' : 'SILENCIADO';
  $('#dualAudioBadgeB').classList.toggle('muted', dualAudio !== 'b');
  $('#dualEmpty').classList.toggle('hidden', !!secondaryCurrent);
  $('#btnDualPlayB').classList.toggle('hidden', !secondaryCurrent);
  $('#btnDualFsB').classList.toggle('hidden', !secondaryCurrent);
  $('#btnDualTargetA').classList.toggle('active', dualTarget === 'a');
  $('#btnDualTargetB').classList.toggle('active', dualTarget === 'b');
  $('#btnDualAudioA').classList.toggle('active', dualAudio === 'a');
  $('#btnDualAudioB').classList.toggle('active', dualAudio === 'b');
  $('#dualHint').textContent = secondaryCurrent
    ? 'Elige una pantalla y pulsa otro canal de la lista para cambiarlo.'
    : 'Elige un canal de la lista para completar la pantalla B.';
}
function setDualAudio(slot) {
  dualAudio = slot === 'b' && secondaryCurrent ? 'b' : 'a';
  const a = $('#video'), b = $('#videoSecondary');
  a.muted = dualAudio !== 'a';
  b.muted = dualAudio !== 'b';
  if (dualAudio === 'a' && a.volume === 0) a.volume = 0.5;
  if (dualAudio === 'b' && b.volume === 0) b.volume = 0.5;
  dualLabels();
  updateVolUi();
}
function openDualMode() {
  if (!current || current.type !== 'live') return;
  if (!dualMode) dualAudioSaved = { muted: $('#video').muted, volume: $('#video').volume };
  dualMode = true;
  dualTarget = 'b';
  $('#videoBox').classList.add('dual-live');
  $('#dualSecond').classList.remove('hidden');
  $('#dualControls').classList.remove('hidden');
  $('#dualLabelA').classList.remove('hidden');
  $('#btnDual').textContent = '▣ Salir de doble vista';
  setDualAudio('a');
  dualLabels();
}
function destroySecondary() {
  if (secondaryHls) { try { secondaryHls.destroy(); } catch (_) {} secondaryHls = null; }
  const v = $('#videoSecondary');
  v.onerror = null;
  v.pause();
  v.removeAttribute('src');
  v.load();
  window.iptv.dualTranscodeStop().catch(() => {});
  secondaryCurrent = null;
  secondaryFallback = false;
}
function closeDualMode() {
  if (!dualMode) return;
  destroySecondary();
  dualMode = false;
  $('#videoBox').classList.remove('dual-live');
  $('#dualSecond').classList.add('hidden');
  $('#dualControls').classList.add('hidden');
  $('#dualLabelA').classList.add('hidden');
  $('#btnDual').textContent = '▣ Doble en vivo';
  if (dualAudioSaved) {
    $('#video').muted = dualAudioSaved.muted;
    $('#video').volume = dualAudioSaved.volume;
    dualAudioSaved = null;
  }
  updateVolUi();
}
async function transcodeSecondary(item, full) {
  if (!dualMode || secondaryCurrent !== item || item.converting) return;
  item.converting = true;
  if (secondaryHls) { try { secondaryHls.destroy(); } catch (_) {} secondaryHls = null; }
  const video = $('#videoSecondary');
  video.pause();
  video.removeAttribute('src');
  video.load();
  try {
    const r = await window.iptv.dualTranscodeStart(item.url, !!full);
    if (secondaryCurrent !== item || !dualMode) return;
    if (!r || !r.ok) throw new Error(r && r.error || 'No se pudo preparar el canal');
    item.converting = false;
    item.transcoded = true;
    const v = $('#videoSecondary');
    const player = createHls({ maxBufferLength: 12, backBufferLength: 5 });
    secondaryHls = player;
    player.on(window.Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || secondaryCurrent !== item || secondaryHls !== player) return;
      $('#dualSecondaryError').textContent = 'No se pudo reproducir este canal.';
      $('#dualSecondaryError').classList.remove('hidden');
    });
    player.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (secondaryCurrent === item && secondaryHls === player) v.play().catch(() => {});
    });
    player.loadSource(r.url);
    player.attachMedia(v);
    $('#dualSecondaryError').classList.add('hidden');
  } catch (err) {
    if (secondaryCurrent !== item) return;
    item.converting = false;
    $('#dualSecondaryError').textContent = err.message || 'No se pudo cargar el canal.';
    $('#dualSecondaryError').classList.remove('hidden');
  }
}
function loadDualSecondary(item) {
  destroySecondary();
  const m = { key: item.key, title: item.title, url: streamUrl(item), type: 'live', item };
  secondaryCurrent = m;
  dualLabels();
  $('#dualSecondaryError').classList.add('hidden');
  const v = $('#videoSecondary');
  const isHls = /\\.m3u8(\\?|$)/i.test(m.url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    const player = createHls({ maxBufferLength: 12, backBufferLength: 5 });
    secondaryHls = player;
    player.on(window.Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || secondaryCurrent !== m || secondaryHls !== player) return;
      if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR && !m.recovered) {
        m.recovered = true; player.recoverMediaError(); return;
      }
      if (!m.fallbackStarted) {
        m.fallbackStarted = true;
        transcodeSecondary(m, d.type === window.Hls.ErrorTypes.MEDIA_ERROR);
      } else {
        $('#dualSecondaryError').textContent = 'No se pudo reproducir este canal.';
        $('#dualSecondaryError').classList.remove('hidden');
      }
    });
    player.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (secondaryCurrent === m && secondaryHls === player) v.play().catch(() => {});
    });
    player.loadSource(m.url);
    player.attachMedia(v);
  } else {
    v.onerror = () => {
      if (secondaryCurrent === m && !m.fallbackStarted) {
        m.fallbackStarted = true; transcodeSecondary(m, true);
      } else if (secondaryCurrent === m) {
        $('#dualSecondaryError').textContent = 'No se pudo reproducir este canal.';
        $('#dualSecondaryError').classList.remove('hidden');
      }
    };
    v.src = m.url;
    v.play().catch(() => {});
  }
  if (dualAudio === 'b') setDualAudio('b');
  dualLabels();
}
function playDualItem(item) {
  if (!item || item.type !== 'live') return;
  if (dualTarget === 'a') {
    playMedia({ key: item.key, title: item.title, url: streamUrl(item), type: 'live', item, img: item.logo || '', plot: item.plot || '' }, true);
  } else {
    loadDualSecondary(item);
  }
}

function playMedia(m, preserveDual) {
  if (dualMode && !preserveDual) closeDualMode();
  const v = $('#video');
  if (current) saveProgress(true);
  current = null;
  v.onloadedmetadata = null;
  pauseForSourceReset(v);
  destroyHls();
  clearSubTracks();
  v.removeAttribute('src');
  v.load();
  window.iptv.transcodeStop().catch(() => {});
  clearTimeout(checkTimer);
  m.tOffset = 0;
  m.transcoding = false;
  m.converting = false;
  m.checked = false;
  m.mediaRecoveryAttempted = false;
  m.fallbackStarted = false;
  current = m;
  lastSave = 0;
  hideNextOverlay();
  hideError();
  $('#playerWrap').classList.remove('hidden');
  $('#nowTitle').textContent = (m.seriesItem ? m.seriesItem.title + ' — ' : '') + m.title;
  $('#btnDual').classList.toggle('hidden', m.type !== 'live');
  if (dualMode) { setDualAudio('a'); dualLabels(); }
  $('#btnPrev').classList.toggle('hidden', !m.queue);
  $('#btnNext').classList.toggle('hidden', !m.queue);
  $('#btnFavNow').classList.toggle('hidden', !!m.queue || !m.item);
  updateFavNow();
  // al avanzar de capítulo, mostrar su temporada y resaltarlo en la lista
  if (viewSeries && m.seriesItem === viewSeries && m.queue && m.queue[m.index]) {
    viewSeason = m.queue[m.index].season;
    renderEpisodes();
  }

  const saved = S.progress[m.key];
  const resumeAt = saved && !saved.done && saved.t > 10 && (!saved.d || saved.t < saved.d - 30) ? saved.t : 0;
  v.onloadedmetadata = () => {
    if (current !== m) return;
    if (isFinite(v.duration) && v.duration > 0) m.knownD = v.duration;
    if (resumeAt && m.type !== 'live') v.currentTime = resumeAt;
    onTracksKnown();
  };

  const isHls = /\.m3u8(\?|$)/i.test(m.url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    const player = createHls();
    hls = player;
    player.on(window.Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || current !== m || hls !== player) return;
      if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR && !m.mediaRecoveryAttempted) {
        m.mediaRecoveryAttempted = true;
        player.recoverMediaError();
        return;
      }
      if (m.fallbackStarted) {
        showError('No se pudo reproducir aquí. Prueba “Abrir en VLC”.');
        return;
      }
      m.fallbackStarted = true;
      startTranscode(d.type === window.Hls.ErrorTypes.MEDIA_ERROR);
    });
    player.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (current === m && hls === player) v.play().catch(() => {});
    });
    player.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, onTracksKnown);
    player.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, onTracksKnown);
    player.loadSource(m.url);
    player.attachMedia(v);
  } else {
    v.src = m.url;
    v.play().catch(() => {});
  }

  // EPG
  $('#epg').innerHTML = '';
  if (m.type === 'live' && m.item) showEpg(m.item);
}

function playItem(item) {
  if (dualMode && item.type === 'live') { playDualItem(item); return; }
  playMedia({ key: item.key, title: item.title, url: streamUrl(item), type: item.type, item, img: item.logo || '', plot: item.plot || '' });
}

function saveProgress(force) {
  if (!current || current.type === 'live' || current.catchup) return;
  const playlist = activePl();
  if (!playlist) return;
  const v = $('#video');
  const dur = current.knownD || v.duration;
  if (!isFinite(dur) || dur <= 0) return;
  if (current.transcoding && !current.knownD) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  const entry = {
    key: current.key, pid: playlist.id, title: current.title, url: current.url,
    type: current.type, t: (current.tOffset || 0) + v.currentTime, d: dur, updated: now, done: false,
    img: current.img || '', plot: current.plot || current.item?.plot || current.seriesItem?.plot || ''
  };
  if (current.seriesItem) entry.seriesRef = seriesRefOf(current.seriesItem);
  else if (current.item) entry.itemRef = { key: current.item.key, title: current.item.title, logo: current.item.logo, type: current.item.type, url: streamUrl(current.item), pid: current.item.pid, id: current.item.id, plot: current.item.plot || '' };
  S.progress[current.key] = entry;
  save();
}

function onEnded() {
  if (!current || current.type === 'live' || current.catchup) return;
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
  closeDualMode();
  $('#btnDual').classList.add('hidden');
  const v = $('#video');
  saveProgress(true);
  current = null;
  v.onloadedmetadata = null;
  hideNextOverlay();
  clearTimeout(checkTimer);
  destroyHls();
  window.iptv.transcodeStop().catch(() => {});
  pauseForSourceReset(v);
  v.removeAttribute('src');
  v.load();
  current = null;
  $('#playerWrap').classList.add('hidden');
  $('#app').classList.remove('cinema');
  $('#btnCinema').textContent = '▣ Modo cine';
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

async function startTranscode(full, extra) {
  const m = current;
  if (!m || m.converting) return;
  const v = $('#video');
  if (!window.Hls) { showError('Falta hls.js: ejecuta "npm install" en la carpeta del proyecto.'); return; }
  if (extra) m.lastExtra = extra;
  else extra = m.lastExtra;
  m.fullMode = !!full;
  m.converting = true;
  const pos = m.type === 'live' ? 0 : (m.tOffset || 0) + (v.currentTime || 0);
  if (!m.knownD && !m.transcoding && isFinite(v.duration) && v.duration > 0) m.knownD = v.duration;
  saveProgress(true);
  m.transcoding = false;
  clearTimeout(checkTimer);
  destroyHls();
  v.onloadedmetadata = null;
  pauseForSourceReset(v);
  v.removeAttribute('src');
  v.load();
  showError(full ? 'Convirtiendo video y audio para reproducirlo…' : 'Preparando audio compatible…');
  let r;
  try {
    r = await window.iptv.transcodeStart(m.url, Object.assign({ start: pos, full, live: m.type === 'live' }, extra || {}));
  } catch (err) {
    m.converting = false;
    if (current === m) showError('No se pudo iniciar la conversión: ' + (err && err.message || 'error desconocido'));
    return;
  }
  if (current !== m) { m.converting = false; return; }
  if (!r || !r.ok) {
    m.converting = false;
    showError((r && r.error) || 'No se pudo convertir el video');
    return;
  }
  m.converting = false;
  m.transcoding = true;
  m.tOffset = pos > 1 ? Math.floor(pos) : 0;
  if (m.trackInfo && r.subs) {
    // une cada archivo .vtt con la información de su pista (nombre, idioma)
    m.trackInfo.subs = m.trackInfo.subs.map((s) => Object.assign({}, s, { url: (r.subs.find((x) => x.i === s.i) || {}).url }))
      .filter((s) => s.url);
  }
  if (m.trackInfo) setSubTracks(m);
  hideError();
  const player = createHls({ startPosition: 0 });
  hls = player;
  player.on(window.Hls.Events.ERROR, (_e, d) => {
    if (d.fatal && current === m && hls === player) showError('No se pudo reproducir. Prueba “Abrir en VLC”.');
  });
  player.on(window.Hls.Events.MANIFEST_PARSED, () => {
    if (current === m && hls === player) v.play().catch(() => {});
  });
  player.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, onTracksKnown);
  player.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, onTracksKnown);
  player.loadSource(r.url);
  player.attachMedia(v);
}

/* ===================== EPG ===================== */
function renderEpg(list) {
  const now = Date.now();
  const el = $('#epg');
  if (!list.length) { el.innerHTML = '<div class="muted">Sin guía de programación para este canal.</div>'; return; }
  el.innerHTML = '<div class="lbl muted">Guía</div>' + list.map((e) => {
    const isNow = e.start <= now && now < e.stop;
    const t = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const catchup = e.catchupUrl ? `<button class="btn epg-play" data-url="${esc(e.catchupUrl)}" data-title="${esc(e.title)}" data-start="${e.start}">▶ Desde el inicio</button>` : '';
    return `<div class="prog ${isNow ? 'now' : ''}"><div class="t">${t(e.start)} – ${t(e.stop)}${isNow ? ' · ahora' : ''}</div><div>${esc(e.title)}</div>${catchup}</div>`;
  }).join('');
}

function xtreamCatchupUrl(p, item, e) {
  if (!item.tvArchive || !item.archiveDays || !item.id || !e.start || !e.stop) return '';
  const duration = Math.max(1, Math.ceil((e.stop - e.start) / 60000));
  const d = new Date(e.start);
  const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}:${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return `${plBase(p)}/timeshift/${enc(p.user)}/${enc(p.pass)}/${duration}/${start}/${enc(item.id)}.ts`;
}

function m3uCatchupUrl(item, e) {
  if (!item.catchup || item.catchup === 'none' || !item.catchupDays || !e.start || !e.stop) return '';
  const start = Math.floor(e.start / 1000), stop = Math.floor(e.stop / 1000);
  const base = item.catchupSource || item.url || '';
  if (!base) return '';
  const replacements = { '{utc}': start, '${utc}': start, '{lutc}': stop, '${lutc}': stop, '{start}': start, '{duration}': Math.max(1, Math.ceil((e.stop - e.start) / 60000)) };
  let url = base;
  for (const [token, value] of Object.entries(replacements)) url = url.split(token).join(String(value));
  if (!/\{[^}]+\}|\$\{[^}]+\}/.test(url) && !/[?&](?:utc|start)=/i.test(url)) {
    const sep = url.includes('?') ? '&' : '?';
    url += `${sep}utc=${start}&lutc=${stop}`;
  }
  return url;
}

$('#epg').addEventListener('click', (event) => {
  const button = event.target.closest('.epg-play');
  if (!button || !current?.item) return;
  const item = current.item;
  playMedia({
    key: `${item.key}:catchup:${button.dataset.start}`, title: button.dataset.title,
    url: button.dataset.url, type: 'catchup', item, img: item.logo || '', catchup: true
  });
});

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
      let r;
      try { r = await api(p, 'get_simple_data_table', `&stream_id=${enc(item.id)}`); }
      catch (_) { r = await api(p, 'get_short_epg', `&stream_id=${enc(item.id)}&limit=24`); }
      const now = Date.now();
      const list = (r.epg_listings || []).map((e) => ({
        title: b64utf8(e.title),
        start: (+e.start_timestamp || 0) * 1000,
        stop: (+e.stop_timestamp || 0) * 1000
      })).filter((e) => e.start && e.stop && e.stop >= now - (Math.max(0, item.archiveDays || 0) * 86400000) && e.start <= now + 86400000)
        .sort((a, b) => a.start - b.start).slice(-80);
      for (const e of list) if (e.stop <= now) e.catchupUrl = xtreamCatchupUrl(p, item, e);
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
      const maxAge = Math.max(0, item.catchupDays || 0) * 86400000;
      let m;
      while ((m = re.exec(text)) && list.length < 500) {
        const attrs = m[1];
        const ch = (attrs.match(/channel="([^"]*)"/) || [])[1];
        if (ch !== item.epgId) continue;
        const stop = parseXmltvDate((attrs.match(/stop="([^"]*)"/) || [])[1]);
        const start = parseXmltvDate((attrs.match(/start="([^"]*)"/) || [])[1]);
        if (stop < now - maxAge || start > now + 86400000) continue;
        const program = {
          title: decodeEntities((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || ''),
          start,
          stop
        };
        if (stop <= now) program.catchupUrl = m3uCatchupUrl(item, program);
        list.push(program);
      }
      list.sort((a, b) => a.start - b.start);
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
  viewMovie = null;
  const p = activePl();
  if (!p) { render(); return; }
  // Mostrar la estructura de Inicio de inmediato; la carga del catálogo puede tardar.
  if (t === 'home') {
    render();
    setStatus('Cargando tu biblioteca…');
    if (p.type === 'xtream') {
      const memory = cache[p.id];
      if (memory?.loaded?.movie && memory?.loaded?.series) return render();
      let saved = null;
      try { saved = await window.iptv.catalogCacheGet(p.id); } catch (e) { /* sigue con la lista */ }
      if (tab !== t || activePl()?.id !== p.id) return;
      if (restoreCatalogCache(p.id, saved)) {
        render();
        const age = Math.max(0, Date.now() - (Number(saved.savedAt) || 0));
        if (age < CATALOG_CACHE_TTL) {
          setStatus('Biblioteca guardada · se actualizará en unas horas');
          return;
        }
        // Conserva las filas antiguas en pantalla mientras pide la versión actual.
        cache[p.id].loaded = {};
        cache[p.id].catsLoaded = {};
        cache[p.id].byCat = { movie: {}, series: {} };
        setStatus('Mostrando biblioteca guardada · actualizando…');
      }
    }
  }
  try {
    if (t === 'home') {
      if (p.type === 'm3u') await ensureLoaded('movie');
      else {
        await Promise.all(['movie', 'series'].map((kind) => ensureLoaded(kind)));
        await Promise.all(['movie', 'series'].map((kind) => ensureCategory(kind, 'all')));
        window.iptv.catalogCacheSet(p.id, catalogCacheSnapshot(cache[p.id])).catch(() => {});
      }
      if (tab !== t) return;
    } else if (['live', 'movie', 'series'].includes(t)) {
      await ensureLoaded(t);
      if (tab !== t) return;                 // cambió de sección mientras cargaba
      // empieza en la primera categoría de la lista, no en “todas”
      curCat = firstCat(p, t);
      if (categoryPending(t, curCat)) {
        $('#grid').innerHTML = '<p class="muted">Cargando…</p>';
        $('#btnMore').classList.add('hidden');
      }
      await ensureCategory(t, curCat);
      if (tab !== t) return;
    } else {
      await ensureLoadedForFavs();
    }
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
  closeDualMode();
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
$('#catSelect').addEventListener('change', async (e) => {
  const cat = e.target.value;
  curCat = cat;
  limit = 200;
  try {
    if (categoryPending(tab, cat)) {
      $('#grid').innerHTML = '<p class="muted">Cargando…</p>';
      $('#btnMore').classList.add('hidden');
    }
    await ensureCategory(tab, cat);
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
  if (curCat === cat) render();             // si eligió otra mientras cargaba, esa se encarga
});
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = e.target.value; limit = 200; render(); }, 200);
});
$('#btnMore').addEventListener('click', () => { limit += 200; render(); });

$('#grid').addEventListener('click', (e) => {
  const openTab = e.target.closest('[data-open-tab]');
  if (openTab) { setTab(openTab.dataset.openTab); return; }
  if (e.target.closest('[data-play-detail]') && viewMovie) { playItem(viewMovie); return; }
  if (e.target.closest('[data-fav-detail]') && viewMovie) {
    if (S.favs[viewMovie.key]) delete S.favs[viewMovie.key];
    else S.favs[viewMovie.key] = Object.assign({}, viewMovie);
    save(); renderMovieDetail(); return;
  }
  if (e.target.closest('[data-dl-detail]') && viewMovie) { downloadItem(viewMovie); return; }
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
  const dlk = e.target.closest('[data-dlkey]');
  if (dlk) { downloadItem(findItem(dlk.dataset.dlkey)); return; }
  const card = e.target.closest('.card');
  if (card) {
    const it = findItem(card.dataset.key);
    if (!it) return;
    if (it.type === 'series') openSeries(it.episodes ? it : resolveSeries(it));
    else if (it.type === 'movie') openMovie(it);
    else playItem(it);
    return;
  }
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
    if (en) {
      // Quitar una serie de Continuar viendo también limpia sus capítulos guardados,
      // para que no reaparezca por el progreso de un episodio anterior.
      if (en.seriesRef) {
        const seriesKey = en.seriesRef.key;
        Object.keys(S.progress).forEach((key) => {
          if (S.progress[key].seriesRef?.key === seriesKey) delete S.progress[key];
        });
      } else {
        delete S.progress[en.key];
      }
      save();
      render();
    }
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
  if (e.target.id === 'btnBack') { viewSeries = null; viewMovie = null; render(); }
  if (e.target.closest('[data-play-detail]') && viewMovie) playItem(viewMovie);
  if (e.target.closest('[data-fav-detail]') && viewMovie) {
    if (S.favs[viewMovie.key]) delete S.favs[viewMovie.key];
    else S.favs[viewMovie.key] = Object.assign({}, viewMovie);
    save(); renderMovieDetail();
  }
  if (e.target.closest('[data-dl-detail]') && viewMovie) downloadItem(viewMovie);
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
video.addEventListener('pause', () => {
  if (ignoredPauseEvents > 0) { ignoredPauseEvents--; return; }
  saveProgress(true);
});
video.addEventListener('ended', onEnded);
video.addEventListener('playing', () => {
  if (current && current.transcoding) hideError();
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

$('#btnCinema').addEventListener('click', () => {
  const enabled = $('#app').classList.toggle('cinema');
  $('#btnCinema').textContent = enabled ? '▣ Salir del modo cine' : '▣ Modo cine';
});
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
  if (e.key === 'j' || e.key === 'J') skip(-10);
  if (e.key === 'l' || e.key === 'L') skip(10);
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  if (e.key === 'ArrowLeft') skip(-10);
  if (e.key === 'ArrowRight') skip(10);
  if ((e.key === 'k' || e.key === 'K' || (e.key === ' ' && e.target.tagName !== 'BUTTON')) && current) {
    e.preventDefault();
    togglePlay();
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
  window.iptv.catalogCacheDelete(p.id).catch(() => {});
  S.playlists = S.playlists.filter((x) => x.id !== p.id);
  localStorage.removeItem('iptv_m3u_' + p.id);
  delete cache[p.id];
  S.active = S.playlists[0] ? S.playlists[0].id : null;
  save();
  refreshPlaylistSelect();
  setTab(tab);
});

/* ===================== reproductor: saltar 10 s, audio y subtítulos ===================== */
function skip(sec) {
  if (!current) return;
  const v = $('#video');
  const max = isFinite(v.duration) ? v.duration : Infinity;
  v.currentTime = Math.min(max, Math.max(0, (v.currentTime || 0) + sec));
}

function textTracksOf(v) {
  return Array.from(v.textTracks || []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
}

function trackList() {
  const v = $('#video');
  const out = { audio: [], subs: [] };
  if (hls) {
    const info = current && current.trackInfo;
    (hls.audioTracks || []).forEach((t, i) => out.audio.push({
      i, label: (info && info.audio[i] && info.audio[i].label) || t.name || t.lang || ('Audio ' + (i + 1)),
      active: hls.audioTrack === i
    }));
    if ((hls.subtitleTracks || []).length) {
      hls.subtitleTracks.forEach((t, i) => out.subs.push({
        i, label: t.name || t.lang || ('Subtítulo ' + (i + 1)), active: hls.subtitleTrack === i
      }));
      return out;
    }
    // subtítulos que ffmpeg extrajo del video (pistas de texto del propio <video>)
    textTracksOf(v).forEach((t, i) => out.subs.push({
      i, label: t.label || t.language || ('Subtítulo ' + (i + 1)), active: t.mode === 'showing'
    }));
    return out;
  }
  if (v.audioTracks) {
    for (let i = 0; i < v.audioTracks.length; i++) {
      const t = v.audioTracks[i];
      out.audio.push({ i, label: t.label || t.language || ('Audio ' + (i + 1)), active: !!t.enabled });
    }
  }
  textTracksOf(v).forEach((t, i) => out.subs.push({
    i, label: t.label || t.language || ('Subtítulo ' + (i + 1)), active: t.mode === 'showing'
  }));
  return out;
}

function renderTrackMenu() {
  const { audio, subs } = trackList();
  const row = (kind, t) => `<button class="tm ${t.active ? 'on' : ''}" data-kind="${kind}" data-i="${t.i}">${t.active ? '✓ ' : ''}${esc(t.label)}</button>`;
  let html = '<div class="tmh">Audio</div>';
  // El reproductor integrado no ve todas las pistas de un video (p. ej. .mkv): se buscan
  // solas con ffmpeg apenas se abre este menú, así no hace falta un botón aparte.
  const canLoad = !!current && current.type !== 'live' && !current.trackInfo && /^https?:/i.test(current.url || '');
  const loading = !!current && current.loadingTracks;
  if (audio.length) html += audio.map((t) => row('audio', t)).join('');
  else if (!canLoad && !loading) html += '<div class="tmn">Este video no tiene otras pistas de audio</div>';
  html += '<div class="tmh">Subtítulos</div>';
  html += `<button class="tm ${subs.some((s) => s.active) ? '' : 'on'}" data-kind="sub" data-i="-1">Desactivados</button>`;
  html += subs.map((t) => row('sub', t)).join('');
  if (subs.some((s) => s.active) && !(hls && (hls.subtitleTracks || []).length)) {
    const delay = Number(S.trackPref && S.trackPref.subDelay) || 0;
    const shown = (delay > 0 ? '+' : '') + delay.toFixed(1) + ' s';
    html += `<div class="sub-delay"><span>Sincronía</span><button data-delay="-0.5" title="Adelantar subtítulos 0,5 s">−0,5</button><b>${shown}</b><button data-delay="0.5" title="Retrasar subtítulos 0,5 s">+0,5</button><button data-delay="reset" title="Restablecer retraso">↺</button></div>`;
  }
  if (loading) html += '<div class="tmn">Buscando más audios y subtítulos…</div>';
  else if (!subs.length && !canLoad) html += '<div class="tmn">Este video no trae subtítulos</div>';
  else if (canLoad) html += '<button class="tm" data-kind="load" data-i="0">🔍 Buscar más audios y subtítulos</button>';
  $('#trackMenu').innerHTML = html;
}

// Aplica la pista sin tocar la preferencia guardada (la usa tanto la elección manual
// como la restauración automática al cambiar de capítulo).
function applyTrackChoice(kind, i) {
  const v = $('#video');
  const hlsSubs = !!hls && (hls.subtitleTracks || []).length > 0;
  if (hls && kind === 'audio') {
    hls.audioTrack = i;
  } else if (hls && hlsSubs) {
    hls.subtitleDisplay = i >= 0; hls.subtitleTrack = i;
  } else if (kind === 'audio') {
    if (v.audioTracks) for (let k = 0; k < v.audioTracks.length; k++) v.audioTracks[k].enabled = (k === i);
  } else {
    selectTextTrack(i);
    return;
  }
  renderTrackMenu();
  updateTrackIcon();
}

const trackPrefKey = (label) => String(label || '').trim().toLowerCase();

// Recuerda el audio/subtítulo que el usuario eligió a mano, para aplicarlo solo
// (sin que tenga que volver a elegirlo) en el próximo capítulo o video.
function rememberTrackChoice(kind, i) {
  S.trackPref = S.trackPref || { audio: null, sub: null, subOff: false, everUsed: false };
  if (kind === 'audio') {
    const t = trackList().audio.find((x) => x.i === i);
    S.trackPref.audio = t ? t.label : null;
  } else {
    if (i < 0) { S.trackPref.sub = null; S.trackPref.subOff = true; }
    else {
      const t = trackList().subs.find((x) => x.i === i);
      S.trackPref.sub = t ? t.label : null;
      S.trackPref.subOff = false;
    }
  }
  S.trackPref.everUsed = true;
  save();
}

function selectTrack(kind, i) {
  if (kind === 'load') { loadAllTracks(); return; }
  rememberTrackChoice(kind, i);
  applyTrackChoice(kind, i);
}

function setSubtitleDelay(value) {
  S.trackPref = S.trackPref || { audio: null, sub: null, subOff: false, everUsed: false };
  const previous = Number(S.trackPref.subDelay) || 0;
  const next = Math.max(-10, Math.min(10, value));
  S.trackPref.subDelay = next;
  save();
  const tracks = textTracksOf($('#video'));
  const tt = tracks.find((track) => track.mode === 'showing') || tracks[subSel];
  if (tt && tt.cues) {
    const delta = next - previous;
    Array.from(tt.cues).forEach((cue) => {
      try {
        cue.startTime = Math.max(0, cue.startTime + delta);
        cue.endTime = Math.max(cue.startTime + 0.05, cue.endTime + delta);
      } catch (e) { /* algunas pistas nativas no admiten edición */ }
    });
  }
  renderTrackMenu();
}

// Aplica en silencio, apenas se conocen las pistas de este video, el audio/subtítulo
// que el usuario venía usando (por nombre), sin que tenga que volver a elegirlo.
function applyTrackPref() {
  const pref = S.trackPref;
  if (!pref || !pref.everUsed || !current) return;
  const { audio, subs } = trackList();
  if (pref.audio) {
    const t = audio.find((x) => trackPrefKey(x.label) === trackPrefKey(pref.audio));
    if (t && !t.active) applyTrackChoice('audio', t.i);
  }
  if (pref.subOff) {
    const act = subs.find((x) => x.active);
    if (act) applyTrackChoice('sub', -1);
  } else if (pref.sub) {
    const t = subs.find((x) => trackPrefKey(x.label) === trackPrefKey(pref.sub));
    if (t && !t.active) applyTrackChoice('sub', t.i);
  }
}

// Algunos videos (HLS con subtítulos en el propio m3u8) ya traen sus pistas sin
// necesidad de buscarlas con ffmpeg; esto las aplica/muestra en cuanto aparecen.
function onTracksKnown() {
  applyTrackPref();
  if (!trackMenu.classList.contains('hidden')) renderTrackMenu();
}

// Subtítulos extraídos con ffmpeg aparte: los textos se van añadiendo a medida que llegan
let subTimer = null;        // refresco mientras ffmpeg sigue escribiendo el .vtt
let subSel = -1;            // pista de subtítulos elegida
let subOffset = 0;          // tiempo real donde empieza una extracción directa
const subSeen = new Set();  // textos ya añadidos (evita duplicados)

function stopSubRefresh() {
  clearInterval(subTimer);
  subTimer = null;
}

// Convierte un archivo .vtt en una lista de textos con sus tiempos
function parseVtt(txt) {
  const out = [];
  const secs = (h, mm, ss, ms) => (h ? parseInt(h, 10) * 3600 : 0) + parseInt(mm, 10) * 60 + parseInt(ss, 10) +
    (ms ? parseInt(String(ms).padEnd(3, '0'), 10) / 1000 : 0);
  for (const block of String(txt).replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim().length);
    const k = lines.findIndex((l) => l.includes('-->'));
    if (k < 0) continue;
    const m = lines[k].match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
    if (!m) continue;
    const text = lines.slice(k + 1).join('\n').trim();
    if (!text) continue;
    out.push({ start: subOffset + secs(m[1], m[2], m[3], m[4]),
      end: subOffset + secs(m[5], m[6], m[7], m[8]), text });
  }
  return out;
}

// Descarga el .vtt y añade a la pista solo los textos nuevos. Devuelve true si ya hay alguno.
async function addSubText(i, url) {
  const tt = textTracksOf($('#video'))[i];
  if (!tt) return false;
  // mientras la pista está "disabled" el navegador no muestra su lista de textos
  if (tt.mode !== 'showing') tt.mode = 'showing';
  const r = await fetch(url + '?t=' + Date.now());
  const txt = await r.text();
  for (const c of parseVtt(txt)) {
    const key = c.start + '|' + c.end + '|' + c.text;
    if (subSeen.has(key)) continue;
    subSeen.add(key);
    const delay = Number(S.trackPref && S.trackPref.subDelay) || 0;
    const start = Math.max(0, c.start + delay);
    try { tt.addCue(new VTTCue(start, Math.max(start + 0.05, c.end + delay), c.text)); } catch (e) { /* nada */ }
  }
  return !!(tt.cues && tt.cues.length);
}

async function selectTextTrack(i) {
  const m = current;
  stopSubRefresh();
  subSel = i;
  subOffset = 0;
  const tts = textTracksOf($('#video'));
  tts.forEach((t, k) => { if (k !== i) t.mode = 'disabled'; });
  const s = m && m.trackInfo && m.trackInfo.subs && m.trackInfo.subs[i];
  if (i < 0 || !tts[i] || !s) { renderTrackMenu(); updateTrackIcon(); return; }

  // empieza de cero con esta pista
  subSeen.clear();
  try {
    if (tts[i].mode !== 'showing') tts[i].mode = 'showing';
    for (const c of Array.from(tts[i].cues || [])) tts[i].removeCue(c);
  } catch (e) { /* nada */ }

  showToast('Cargando subtítulo…');
  let url = s.url;
  try {
    const direct = !m.transcoding;
    const ex = await window.iptv.extractSub(s.i, m.url, direct ? ($('#video').currentTime || 0) : 0);
    if (current !== m || subSel !== i) return;
    if (!ex.ok) throw new Error(ex.error || 'no se pudo extraer');
    url = ex.url;
    subOffset = Number(ex.offset) || 0;
  } catch (e) {
    showError('No se pudo cargar el subtítulo' + (e && e.message ? ': ' + e.message : ''));
    renderTrackMenu();
    updateTrackIcon();
    return;
  }

  // espera a que ffmpeg escriba los primeros textos (suele ser casi inmediato)
  let ok = false;
  let fail = '';
  for (let k = 0; k < 120 && !ok && !fail; k++) {
    try { ok = await addSubText(i, url); } catch (e) { /* reintenta */ }
    if (current !== m || subSel !== i) return;
    if (ok) break;
    let st = null;
    try { st = await window.iptv.subStatus(s.i, m.url); } catch (e) { /* nada */ }
    if (st && st.state === 'error') { fail = st.error || 'ffmpeg falló'; break; }
    if (st && (st.state === 'done' || st.state === 'none')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (current !== m || subSel !== i) return;

  if (!ok) {
    showError(fail ? ('No se pudo cargar el subtítulo: ' + fail) : 'Este subtítulo no tiene texto compatible.');
    setTimeout(() => { if (current === m) hideError(); }, 3000);
  } else {
    tts[i].mode = 'showing';
    hideError();
    // ffmpeg sigue escribiendo el .vtt: se refresca hasta que termine
    subTimer = setInterval(async () => {
      if (current !== m || subSel !== i) { stopSubRefresh(); return; }
      try { await addSubText(i, url); } catch (e) { /* nada */ }
      let st = null;
      try { st = await window.iptv.subStatus(s.i, m.url); } catch (e) { /* nada */ }
      if (st && (st.state === 'done' || st.state === 'none')) stopSubRefresh();
      if (st && st.state === 'error') {
        stopSubRefresh();
        showError('No se pudo cargar el subtítulo: ' + (st.error || ''));
      }
    }, 4000);
  }
  renderTrackMenu();
  updateTrackIcon();
}

function clearSubTracks() {
  stopSubRefresh();
  subSel = -1;
  subSeen.clear();
  const v = $('#video');
  v.querySelectorAll('track').forEach((el) => {
    if (el.dataset.blob) URL.revokeObjectURL(el.dataset.blob);
    el.remove();
  });
}

function setSubTracks(m) {
  clearSubTracks();
  const v = $('#video');
  ((m.trackInfo && m.trackInfo.subs) || []).forEach((s) => {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = s.label;
    if (s.lang) el.srclang = s.lang.slice(0, 2);
    v.appendChild(el);
    if (el.track) el.track.mode = 'disabled';
  });
}

// Busca con ffmpeg todos los audios y subtítulos del video y lo reproduce con ellos disponibles
// Busca audios y subtítulos y deja el menú abierto actualizándose solo, sin un botón aparte:
// se dispara en cuanto se abre el engranaje (ver #btnTracks), no hace falta pedirlo dos veces.
async function loadAllTracks() {
  const m = current;
  if (!m || m.type === 'live' || m.trackInfo || m.loadingTracks || !/^https?:/i.test(m.url || '')) return;
  m.loadingTracks = true;
  renderTrackMenu();
  trackMenu.classList.remove('hidden');
  speedMenu.classList.add('hidden');
  let info = { audio: [], subs: [], error: true };
  try { info = await window.iptv.probeTracks(m.url); } catch (e) { /* permite reintentar */ }
  if (current !== m) return;
  if (info.error && !(info.audio || []).length && !(info.subs || []).length) {
    m.loadingTracks = false;
    m.trackInfo = null;
    renderTrackMenu();
    showToast('No se pudieron buscar las pistas. Puedes volver a intentarlo.');
    return;
  }
  const subs = (info.subs || []).filter((s) => s.text);
  if ((info.audio || []).length < 2 && !subs.length) {
    m.loadingTracks = false;
    m.trackInfo = { audio: info.audio || [], subs: [] };
    renderTrackMenu();
    return;
  }
  m.trackInfo = { audio: info.audio || [], subs };
  if ((info.audio || []).length > 1) {
    m.converting = false;
    await startTranscode(!!m.fullMode, {
      audioCount: info.audio.length,
      subs: subs.map((s) => s.i)
    });
  } else {
    // Para subtítulos se extrae solo la pista elegida; no hace falta reiniciar el video.
    setSubTracks(m);
  }
  if (current !== m) return;
  m.loadingTracks = false;
  if ((info.audio || []).length > 1 && !m.transcoding) { m.trackInfo = null; renderTrackMenu(); return; }   // si falló, permite reintentar
  applyTrackPref();   // deja listo el audio/subtítulo que se venía usando
  renderTrackMenu();
}

/* ===================== reproductor: barra de controles ===================== */
const vbox = $('#videoBox');
const vSeek = $('#vSeek');
const trackMenu = $('#trackMenu');
const speedMenu = $('#speedMenu');
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
let vDragging = false;   // el usuario está arrastrando la barra de progreso
let idleTimer = null;    // oculta los controles en pantalla completa

function fmtClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

// Tiempo y duración "reales": si se está convirtiendo con ffmpeg el video empieza en tOffset
function playerTimes() {
  const off = (current && current.tOffset) || 0;
  const cur = off + (video.currentTime || 0);
  let dur = current && current.knownD;
  if (!dur && isFinite(video.duration) && video.duration > 0) dur = off + video.duration;
  return { cur, dur: dur || 0, off };
}

function updateSeekUi() {
  if (!current) return;
  const live = current.type === 'live';
  vbox.classList.toggle('is-live', live);
  if (live) return;
  const { cur, dur } = playerTimes();
  vSeek.max = dur || 0;
  if (!vDragging) vSeek.value = dur ? Math.min(cur, dur) : 0;
  const shown = vDragging ? parseFloat(vSeek.value) : cur;
  vSeek.style.setProperty('--p', (dur ? Math.min(100, (shown / dur) * 100) : 0) + '%');
  $('#vCur').textContent = fmtClock(shown);
  $('#vDur').textContent = dur ? fmtClock(dur) : '--:--';
}

function updatePlayUi() {
  const playing = !video.paused && !video.ended;
  vbox.classList.toggle('is-playing', playing);
  $('#vPlay').title = playing ? 'Pausar' : 'Reproducir';
}

function updateVolUi() {
  const muted = video.muted || video.volume === 0;
  const vol = muted ? 0 : video.volume;
  vbox.classList.toggle('is-muted', muted);
  $('#vVol').value = vol;
  $('#vVol').style.setProperty('--p', (vol * 100) + '%');
  $('#vMute').title = muted ? 'Activar sonido' : 'Silenciar';
}

function updateTrackIcon() {
  vbox.classList.toggle('has-subs', trackList().subs.some((s) => s.active));
}

function updateFsUi() {
  vbox.classList.toggle('is-fs', document.fullscreenElement === vbox);
}

function togglePlay() {
  if (!current) return;
  if (video.paused) video.play().catch(() => { /* nada */ }); else video.pause();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else vbox.requestFullscreen().catch(() => { /* nada */ });
}

async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (document.pictureInPictureEnabled && video.readyState > 0) await video.requestPictureInPicture();
  } catch (e) { /* no disponible para este video */ }
}

/* menús: audio/subtítulos y velocidad */
function closeMenus() {
  trackMenu.classList.add('hidden');
  speedMenu.classList.add('hidden');
}

function toggleMenu(menu, render) {
  const wasHidden = menu.classList.contains('hidden');
  closeMenus();
  if (wasHidden) { render(); menu.classList.remove('hidden'); }
}

function renderSpeedMenu() {
  const r = video.playbackRate;
  speedMenu.innerHTML = '<div class="tmh">Velocidad</div>' + SPEEDS.map((s) =>
    `<button class="tm ${s === r ? 'on' : ''}" data-speed="${s}">${s === r ? '✓ ' : ''}${s === 1 ? 'Normal' : s + '×'}</button>`
  ).join('');
}

function renderInfo() {
  const rows = [];
  const { dur } = playerTimes();
  if (video.videoWidth) rows.push(['Resolución', video.videoWidth + '×' + video.videoHeight]);
  if (current.type !== 'live' && dur) rows.push(['Duración', fmtClock(dur)]);
  if (current.transcoding) rows.push(['Modo', 'Convertido con ffmpeg']);
  $('#vinfo').innerHTML = `<div class="vi-t">${esc($('#nowTitle').textContent)}</div>` +
    rows.map((r) => `<div class="vi-r"><span>${r[0]}</span><b>${esc(r[1])}</b></div>`).join('');
}

/* en pantalla completa los controles se esconden tras 3 s sin mover el mouse */
function wakeControls() {
  vbox.classList.remove('idle');
  clearTimeout(idleTimer);
  if (document.fullscreenElement !== vbox) return;
  idleTimer = setTimeout(() => {
    const menuOpen = !trackMenu.classList.contains('hidden') || !speedMenu.classList.contains('hidden');
    if (!video.paused && !menuOpen) vbox.classList.add('idle');
  }, 3000);
}

/* eventos del video → actualizar la barra */
['timeupdate', 'durationchange', 'loadedmetadata', 'loadstart', 'emptied'].forEach((ev) => video.addEventListener(ev, updateSeekUi));
['play', 'pause', 'ended', 'playing', 'emptied'].forEach((ev) => video.addEventListener(ev, updatePlayUi));
['loadedmetadata', 'playing'].forEach((ev) => video.addEventListener(ev, updateTrackIcon));
video.addEventListener('volumechange', updateVolUi);

/* botones */\n$('#btnDual').addEventListener('click', () => dualMode ? closeDualMode() : openDualMode());
$('#btnDualTargetA').addEventListener('click', () => { dualTarget = 'a'; dualLabels(); });
$('#btnDualTargetB').addEventListener('click', () => { dualTarget = 'b'; dualLabels(); });
$('#btnDualAudioA').addEventListener('click', () => setDualAudio('a'));
$('#btnDualAudioB').addEventListener('click', () => setDualAudio('b'));
$('#btnDualPlayB').addEventListener('click', () => {
  const v = $('#videoSecondary');
  if (v.paused) v.play().catch(() => {}); else v.pause();
});
$('#btnDualFsB').addEventListener('click', () => {
  const pane = $('#dualSecond');
  if (document.fullscreenElement) document.exitFullscreen();
  else pane.requestFullscreen().catch(() => {});
});

$('#vPlay').addEventListener('click', togglePlay);
$('#btnBack10').addEventListener('click', () => skip(-10));
$('#btnFwd10').addEventListener('click', () => skip(10));
$('#btnTracks').addEventListener('click', () => {
  const m = current;
  const canLoad = !!m && m.type !== 'live' && !m.trackInfo && !m.loadingTracks && /^https?:/i.test(m.url || '');
  // primera vez en este video: busca los audios/subtítulos y deja el menú abierto con el resultado
  if (canLoad) { loadAllTracks(); return; }
  toggleMenu(trackMenu, renderTrackMenu);
});
$('#btnSpeed').addEventListener('click', () => toggleMenu(speedMenu, renderSpeedMenu));
$('#btnPip').addEventListener('click', togglePip);
$('#btnFs').addEventListener('click', toggleFullscreen);
$('#btnInfo').addEventListener('click', () => {
  const p = $('#vinfo');
  if (p.classList.contains('hidden')) { renderInfo(); p.classList.remove('hidden'); }
  else p.classList.add('hidden');
});
$('#vMute').addEventListener('click', () => {
  if (video.muted || video.volume === 0) {
    video.muted = false;
    if (video.volume === 0) video.volume = 0.5;
  } else {
    video.muted = true;
  }
});
$('#vVol').addEventListener('input', (e) => {
  video.muted = false;
  video.volume = parseFloat(e.target.value);
});
// Soltar el foco del botón para que la barra espaciadora siga pausando/reproduciendo
$('#vbar').addEventListener('click', () => {
  const a = document.activeElement;
  if (a && a.tagName === 'BUTTON') a.blur();
});
if (!document.pictureInPictureEnabled) $('#btnPip').classList.add('hidden');

/* barra de progreso: mientras se arrastra solo se muestra el tiempo; al soltar se salta */
vSeek.addEventListener('input', () => { vDragging = true; updateSeekUi(); });
vSeek.addEventListener('change', () => {
  const off = (current && current.tOffset) || 0;
  const max = isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.min(max, Math.max(0, parseFloat(vSeek.value) - off));
  vDragging = false;
  updateSeekUi();
});

/* clic en el video: pausar/reproducir; doble clic: pantalla completa */
$('#vstage').addEventListener('click', (e) => { if (e.target === video) togglePlay(); });
$('#vstage').addEventListener('dblclick', (e) => { if (e.target === video) toggleFullscreen(); });

/* menús */
trackMenu.addEventListener('click', (e) => {
  const delay = e.target.closest('[data-delay]');
  if (delay) {
    const currentDelay = Number(S.trackPref && S.trackPref.subDelay) || 0;
    setSubtitleDelay(delay.dataset.delay === 'reset' ? 0 : currentDelay + Number(delay.dataset.delay));
    return;
  }
  const b = e.target.closest('[data-kind]');
  if (b) selectTrack(b.dataset.kind, parseInt(b.dataset.i, 10));
});
speedMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-speed]');
  if (!b) return;
  video.playbackRate = parseFloat(b.dataset.speed);
  renderSpeedMenu();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#btnTracks, #btnSpeed')) return;
  [trackMenu, speedMenu].forEach((m) => {
    if (!m.classList.contains('hidden') && !m.contains(e.target)) m.classList.add('hidden');
  });
});

vbox.addEventListener('mousemove', wakeControls);
document.addEventListener('fullscreenchange', () => { updateFsUi(); wakeControls(); });

updatePlayUi();
updateVolUi();
updateFsUi();

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
let dragIdx = null;
function renderCatDraft() {
  $('#catList').innerHTML = catDraft.map((c, i) => `<div class="catrow" draggable="true" data-idx="${i}">
      <span class="grip" title="Arrastra para mover">⠿</span>
      <span class="catname">${esc(c[1])}</span>
      <button class="btn" data-top="${i}" ${i === 0 ? 'disabled' : ''} title="Poner al tope">⤒ Al tope</button>
      <button class="btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Subir">▲</button>
      <button class="btn" data-down="${i}" ${i === catDraft.length - 1 ? 'disabled' : ''} title="Bajar">▼</button>
    </div>`).join('') || '<p class="muted">No hay categorías.</p>';
}
function moveCat(from, to) {
  if (from === to || from < 0 || to < 0 || from >= catDraft.length || to >= catDraft.length) return;
  const [item] = catDraft.splice(from, 1);
  catDraft.splice(to, 0, item);
  renderCatDraft();
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
  const top = e.target.closest('[data-top]');
  const up = e.target.closest('[data-up]');
  const dn = e.target.closest('[data-down]');
  if (top) moveCat(parseInt(top.dataset.top, 10), 0);
  else if (up) { const i = parseInt(up.dataset.up, 10); moveCat(i, i - 1); }
  else if (dn) { const i = parseInt(dn.dataset.down, 10); moveCat(i, i + 1); }
});
// arrastrar y soltar una fila sobre otra
$('#catList').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.catrow');
  if (!row) return;
  dragIdx = parseInt(row.dataset.idx, 10);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragIdx));
});
$('#catList').addEventListener('dragover', (e) => {
  const row = e.target.closest('.catrow');
  if (dragIdx === null || !row) return;
  e.preventDefault();
  $$('.catrow').forEach((r) => r.classList.toggle('dropHere', r === row));
});
$('#catList').addEventListener('drop', (e) => {
  const row = e.target.closest('.catrow');
  if (dragIdx === null || !row) return;
  e.preventDefault();
  const to = parseInt(row.dataset.idx, 10);
  const from = dragIdx;
  dragIdx = null;
  moveCat(from, to);
});
$('#catList').addEventListener('dragend', () => { dragIdx = null; renderCatDraft(); });
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
setTab('home');
