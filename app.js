/* Sur — personal, ad-free music player.
   Storage: IndexedDB in this browser (songs you upload + songs you save from Discover).
   Optional: a server library at library/songs.json (see README). */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { if (!isFinite(s) || s <= 0) return '–:––'; s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const icon = (n, cls = 'i') => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const store = {
  get(k, d) { try { const v = localStorage.getItem('sur:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sur:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0; return Math.abs(h); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const OWNER = 'Ankur'; // shown in the greeting
const isMobile = () => matchMedia('(max-width: 680px)').matches;

/* ---------------- IndexedDB ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sur', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('songs', { keyPath: 'id' });
        d.createObjectStore('blobs');
        d.createObjectStore('playlists', { keyPath: 'id' });
        d.createObjectStore('meta');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(storeName, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(storeName, mode);
      const rq = fn(t.objectStore(storeName));
      t.oncomplete = () => res(rq ? rq.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  all: (s) => DB.req(s, 'readonly', o => o.getAll()),
  get: (s, k) => DB.req(s, 'readonly', o => o.get(k)),
  put: (s, v, k) => DB.req(s, 'readwrite', o => (k === undefined ? o.put(v) : o.put(v, k))),
  del: (s, k) => DB.req(s, 'readwrite', o => o.delete(k)),
};

/* ---------------- state ---------------- */
const S = {
  songs: new Map(),      // library: id -> song
  temp: new Map(),       // discover results not yet in library
  likes: new Set(),
  playlists: [],
  recent: [],
  queue: [], qi: -1,
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'), // off | all | one
  view: { name: 'home' },
  lists: {},             // rendered list key -> ids (for click-to-play context)
  libFilter: 'all', libSort: store.get('libSort', 'added'),
  search: '',
  disc: { source: store.get('discSource', 'ia'), preset: 'hindi78', q: '', items: [], loading: false, error: '', key: store.get('jamendoKey', '') },
  iaItems: new Map(),    // identifier -> {meta, tracks}
};
const getSong = id => S.songs.get(id) || S.temp.get(id);
const persistable = s => { const o = {}; for (const k in s) if (!k.startsWith('_')) o[k] = s[k]; return o; };

/* ---------------- ID3 tag reader (v2.2 / 2.3 / 2.4) ---------------- */
const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
const syncsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];
const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
function decodeText(enc, bytes) {
  try {
    if (enc === 0) return new TextDecoder('iso-8859-1').decode(bytes);
    if (enc === 3) return new TextDecoder('utf-8').decode(bytes);
    if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    return new TextDecoder('utf-16le').decode(bytes);
  } catch { return ''; }
}
const cleanTxt = s => s.replace(/﻿/g, '').split('\u0000').map(x => x.trim()).filter(Boolean).join(', ');
function readPicture(d, v22) {
  const enc = d[0];
  let p, mime;
  if (v22) { const f = ascii(d, 1, 3).toLowerCase(); mime = f === 'png' ? 'image/png' : 'image/jpeg'; p = 4; }
  else { const z = d.indexOf(0, 1); mime = ascii(d, 1, z - 1).toLowerCase() || 'image/jpeg'; p = z + 1; }
  p += 1; // picture type
  if (enc === 1 || enc === 2) { while (p < d.length - 1 && !(d[p] === 0 && d[p + 1] === 0)) p += 2; p += 2; }
  else { while (p < d.length && d[p] !== 0) p++; p++; }
  if (!mime.includes('/')) mime = 'image/' + (mime === 'jpg' ? 'jpeg' : mime);
  const data = d.slice(p);
  return data.length > 64 ? new Blob([data], { type: mime }) : null;
}
async function readTags(file) {
  const out = {};
  try {
    const h = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) {
      const ver = h[3], flags = h[5], size = syncsafe(h, 6);
      const b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      let p = 0;
      if (flags & 0x40) p = ver === 4 ? syncsafe(b, 0) : be32(b, 0) + 4;
      while (p < b.length - 10) {
        let id, sz, hl;
        if (ver === 2) { id = ascii(b, p, 3); sz = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]; hl = 6; }
        else { id = ascii(b, p, 4); sz = ver === 4 ? syncsafe(b, p + 4) : be32(b, p + 4); hl = 10; }
        if (!/^[A-Z0-9]{3,4}$/.test(id) || sz <= 0 || p + hl + sz > b.length) break;
        const d = b.subarray(p + hl, p + hl + sz);
        if (id === 'TIT2' || id === 'TT2') out.title = cleanTxt(decodeText(d[0], d.subarray(1)));
        else if (id === 'TPE1' || id === 'TP1') out.artist = cleanTxt(decodeText(d[0], d.subarray(1)));
        else if (id === 'TALB' || id === 'TAL') out.album = cleanTxt(decodeText(d[0], d.subarray(1)));
        else if ((id === 'APIC' || id === 'PIC') && !out.picture) out.picture = readPicture(d, id === 'PIC');
        p += hl + sz;
      }
    }
  } catch { /* unreadable tags: fall back to file name */ }
  if (!out.title) {
    let base = file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d{1,3}[\s.\-]+/, '').trim();
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2 && !out.artist) { out.artist = parts.shift(); base = parts.join(' - '); }
    out.title = base || file.name;
  }
  return out;
}
function getDuration(blob) {
  return new Promise(res => {
    const a = new Audio(), url = URL.createObjectURL(blob);
    const done = v => { clearTimeout(t); URL.revokeObjectURL(url); res(v); };
    const t = setTimeout(() => done(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    a.src = url;
  });
}

/* ---------------- art ---------------- */
function coverOf(s) { return s?._cover || s?.coverUrl || ''; }
function gradFor(s) {
  const h = hash((s?.title || '') + (s?.artist || '')) % 360;
  return `linear-gradient(135deg, hsl(${h} 55% 42%), hsl(${(h + 48) % 360} 62% 30%))`;
}
function artHTML(s, cls) {
  const c = coverOf(s);
  const letter = esc([...(s?.title || '♪').trim()][0] || '♪');
  return `<div class="art ${cls}" style="--g:${gradFor(s)}">${c ? `<img src="${esc(c)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${c ? '' : letter}</div>`;
}

/* ---------------- toast / menu / modal ---------------- */
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function closeMenu() { $('#menuHost').innerHTML = ''; }
function openMenu(anchor, html) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu'; m.innerHTML = html; m.setAttribute('role', 'menu');
  $('#menuHost').appendChild(m);
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  let x = Math.min(r.right - mw, innerWidth - mw - 8); x = Math.max(8, x);
  let y = r.bottom + 4; if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  m.querySelector('button, a')?.focus();
}
function modal({ title, body = '', input, okText = 'Save', danger = false }) {
  return new Promise(res => {
    const host = $('#modalHost');
    host.innerHTML = `<div class="modal-back"><form class="modal" id="mForm">
      <span class="h2">${esc(title)}</span>${body ? `<p class="sub">${body}</p>` : ''}
      ${input !== undefined ? `<label class="field"><input id="mInput" value="${esc(input)}" maxlength="80" required autocomplete="off"></label>` : ''}
      <div class="actions"><button type="button" class="btn ghost" id="mCancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}">${esc(okText)}</button></div>
    </form></div>`;
    const close = v => { host.innerHTML = ''; res(v); };
    $('#mCancel').onclick = () => close(null);
    host.querySelector('.modal-back').onclick = e => { if (e.target.classList.contains('modal-back')) close(null); };
    $('#mForm').onsubmit = e => { e.preventDefault(); close(input !== undefined ? $('#mInput').value.trim() : true); };
    const i = $('#mInput'); if (i) { i.focus(); i.select(); } else host.querySelector('.btn:last-child').focus();
  });
}

/* ---------------- library ops ---------------- */
async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|flac|ogg|opus|wav)$/i.test(f.name));
  if (!files.length) { toast('Those aren\'t audio files. Add MP3, M4A, FLAC, OGG or WAV.'); return; }
  const known = new Set([...S.songs.values()].map(s => s.fileKey).filter(Boolean));
  let added = 0, skipped = 0;
  for (const [i, f] of files.entries()) {
    const key = f.name + ':' + f.size;
    if (known.has(key)) { skipped++; continue; }
    toast(`Adding ${i + 1} of ${files.length}: ${f.name}`, 60000);
    try {
      const tags = await readTags(f);
      const duration = await getDuration(f);
      const id = 'loc:' + uid();
      const song = { id, title: tags.title, artist: tags.artist || '', album: tags.album || '', duration, source: 'local', hasBlob: true, hasCover: false, fileKey: key, addedAt: Date.now() };
      await DB.put('blobs', f, 'audio:' + id);
      if (tags.picture) { await DB.put('blobs', tags.picture, 'cover:' + id); song.hasCover = true; song._cover = URL.createObjectURL(tags.picture); }
      await DB.put('songs', persistable(song));
      S.songs.set(id, song); known.add(key); added++;
    } catch (e) {
      console.error(e);
      if (e && e.name === 'QuotaExceededError') { toast('This device is out of space for more songs.'); break; }
    }
  }
  navigator.storage?.persist?.().catch(() => {});
  toast(added ? `Added ${plural(added, 'song')}${skipped ? ` · ${skipped} already in library` : ''}` : skipped ? 'Those songs are already in your library' : 'Couldn\'t add those files');
  render(); renderSide();
}
async function addToLibrary(s) {
  if (S.songs.has(s.id)) return S.songs.get(s.id);
  const song = { ...s, addedAt: Date.now() };
  S.songs.set(song.id, song); S.temp.delete(song.id);
  await DB.put('songs', persistable(song));
  return song;
}
async function toggleLike(id) {
  const s = getSong(id); if (!s) return;
  if (S.likes.has(id)) { S.likes.delete(id); toast('Removed from Liked songs'); }
  else { if (!S.songs.has(id)) await addToLibrary(s); S.likes.add(id); toast('Added to Liked songs'); }
  await DB.put('meta', [...S.likes], 'likes');
  if (S.view.name === 'liked') render();
  refreshLikes();
}
async function saveOffline(id) {
  const s = getSong(id); if (!s || s.hasBlob || !s.url) return;
  toast(`Saving “${s.title}” for offline…`, 60000);
  try {
    const r = await fetch(s.url); if (!r.ok) throw new Error(r.status);
    const blob = await r.blob();
    const song = await addToLibrary(s);
    await DB.put('blobs', blob, 'audio:' + song.id);
    song.hasBlob = true; await DB.put('songs', persistable(song));
    toast('Saved. It will play without internet.'); render();
  } catch { toast('This source doesn\'t allow saving offline. You can still stream it.'); }
}
async function removeSong(id) {
  const s = S.songs.get(id); if (!s || s.source === 'server') return;
  const ok = await modal({ title: 'Remove from library?', body: `“${esc(s.title)}” will be removed from this device, your playlists and Liked songs.`, okText: 'Remove', danger: true });
  if (!ok) return;
  S.songs.delete(id); S.likes.delete(id);
  await DB.del('songs', id); await DB.del('blobs', 'audio:' + id); await DB.del('blobs', 'cover:' + id);
  await DB.put('meta', [...S.likes], 'likes');
  for (const p of S.playlists) if (p.songIds.includes(id)) { p.songIds = p.songIds.filter(x => x !== id); await DB.put('playlists', p); }
  S.recent = S.recent.filter(x => x !== id); await DB.put('meta', S.recent, 'recent');
  toast('Removed'); render(); renderSide();
}
async function newPlaylist(firstSongId) {
  const name = await modal({ title: 'New playlist', input: `My playlist #${S.playlists.length + 1}`, okText: 'Create' });
  if (!name) return null;
  const p = { id: 'pl:' + uid(), name, songIds: [], createdAt: Date.now() };
  S.playlists.push(p);
  if (firstSongId) await addToPlaylist(p.id, firstSongId, true);
  await DB.put('playlists', p); renderSide();
  if (!firstSongId) go({ name: 'playlist', id: p.id });
  return p;
}
async function addToPlaylist(pid, sid, quiet) {
  const p = S.playlists.find(x => x.id === pid); const s = getSong(sid); if (!p || !s) return;
  if (!S.songs.has(sid)) await addToLibrary(s);
  if (p.songIds.includes(sid)) { if (!quiet) toast(`Already in ${p.name}`); return; }
  p.songIds.push(sid); await DB.put('playlists', p);
  toast(`Added to ${p.name}`); renderSide();
  if (S.view.name === 'playlist' && S.view.id === pid) render();
}

/* ---------------- player ---------------- */
const audio = $('#audio');
let blobUrl = null;
audio.volume = store.get('vol', 0.8);
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function playList(ids, start = 0, forceShuffle) {
  ids = ids.filter(id => getSong(id)); if (!ids.length) return;
  if (forceShuffle !== undefined) { S.shuffle = forceShuffle; store.set('shuffle', S.shuffle); }
  if (S.shuffle) { const first = forceShuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[start]; ids = [first, ...shuffleArr(ids.filter(x => x !== first))]; start = 0; }
  S.queue = ids; S.qi = start;
  await loadCurrent(true);
}
async function loadCurrent(autoplay) {
  const s = getSong(S.queue[S.qi]); if (!s) return;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  let src = s.url || '';
  if (s.hasBlob) { const b = await DB.get('blobs', 'audio:' + s.id); if (b) { blobUrl = URL.createObjectURL(b); src = blobUrl; } }
  if (!src) { toast(`“${s.title}” isn't available on this device`); return; }
  audio.src = src;
  if (autoplay) {
    audio.play().catch(() => {});
    S.recent = [s.id, ...S.recent.filter(x => x !== s.id)].slice(0, 30);
    if (S.songs.has(s.id)) DB.put('meta', S.recent, 'recent').catch(() => {});
  }
  store.set('session', { queue: S.queue.filter(id => S.songs.has(id)), id: s.id });
  updateNow(); mediaSession(s); renderQueue(); markPlaying();
}
function next(auto) {
  if (!S.queue.length) return;
  if (S.qi < S.queue.length - 1) S.qi++;
  else if (S.repeat === 'all' || !auto) S.qi = 0;
  else { audio.pause(); audio.currentTime = 0; return; }
  loadCurrent(true);
}
function prev() {
  if (audio.currentTime > 3 || S.qi <= 0) { audio.currentTime = 0; return; }
  S.qi--; loadCurrent(true);
}
function toggle() {
  if (!audio.src) { const ids = sortedLibrary(); if (ids.length) playList(ids, 0); else toast('Add songs to your library first'); return; }
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}
audio.addEventListener('ended', () => { if (S.repeat === 'one') { audio.currentTime = 0; audio.play(); } else next(true); });
audio.addEventListener('play', syncPlayState);
audio.addEventListener('pause', syncPlayState);
audio.addEventListener('error', () => {
  const s = getSong(S.queue[S.qi]); if (!s || !audio.src) return;
  toast(`Couldn't play “${s.title}”. Skipping.`);
  if (S.qi < S.queue.length - 1) setTimeout(() => next(true), 800);
});
audio.addEventListener('timeupdate', updateTime);
audio.addEventListener('loadedmetadata', updateTime);

function setRange(el, v) { el.value = v; el.style.setProperty('--p', (v / el.max * 100) + '%'); }
function updateTime() {
  const d = audio.duration, c = audio.currentTime;
  const v = d ? Math.round(c / d * 1000) : 0;
  if (!seeking) { setRange($('#pSeek'), v); setRange($('#sSeek'), v); }
  $('#pCur').textContent = $('#sCur').textContent = fmt(c) === '–:––' ? '0:00' : fmt(c);
  $('#pDur').textContent = $('#sDur').textContent = fmt(d || getSong(S.queue[S.qi])?.duration);
  $('#pMiniBar').style.width = (v / 10) + '%';
  if ('mediaSession' in navigator && d && isFinite(d)) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: 1 }); } catch { } }
}
let seeking = false;
for (const id of ['#pSeek', '#sSeek']) {
  const el = $(id);
  el.addEventListener('input', () => { seeking = true; el.style.setProperty('--p', (el.value / 10) + '%'); });
  el.addEventListener('change', () => { if (audio.duration) audio.currentTime = el.value / 1000 * audio.duration; seeking = false; });
}
const vol = $('#pVol');
setRange(vol, Math.round(audio.volume * 100));
vol.addEventListener('input', () => { audio.volume = vol.value / 100; audio.muted = false; setRange(vol, vol.value); store.set('vol', audio.volume); syncMute(); });
function syncMute() { $('#pMute use').setAttribute('href', audio.muted || audio.volume === 0 ? '#i-mute' : '#i-volume'); }

function syncPlayState() {
  const playing = !audio.paused;
  for (const id of ['#pPlay', '#sPlay', '#pMiniPlay']) {
    $(id + ' use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    $(id).setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  document.body.classList.toggle('paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
function updateNow() {
  const s = getSong(S.queue[S.qi]);
  $('#pArt').innerHTML = s ? artHTML(s, '') : '';
  $('#sArt').innerHTML = s ? artHTML(s, 'art-md') : '';
  $('#pTitle').textContent = s ? s.title : 'Nothing playing';
  $('#pArtist').textContent = s ? (s.artist || 'Unknown artist') : 'Pick a song to start';
  $('#sTitle').textContent = s?.title || ''; $('#sArtist').textContent = s?.artist || '';
  $('#sheet').style.setProperty('--sheet-g', s ? `hsl(${hash((s.title || '') + (s.artist || '')) % 360} 40% 30%)` : '');
  refreshLikes(); syncModes(); updateTime();
  document.title = s && !audio.paused ? `${s.title} · Sur` : 'Sur';
}
function syncModes() {
  for (const id of ['#pShuffle', '#sShuffle']) { $(id).classList.toggle('on', S.shuffle); $(id).setAttribute('aria-pressed', S.shuffle); }
  for (const id of ['#pRepeat', '#sRepeat']) {
    $(id).classList.toggle('on', S.repeat !== 'off');
    $(id + ' use').setAttribute('href', S.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
    $(id).setAttribute('aria-label', { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one song' }[S.repeat]);
  }
}
function refreshLikes() {
  const cur = S.queue[S.qi];
  for (const id of ['#pLike', '#sLike']) {
    const on = cur && S.likes.has(cur);
    $(id).classList.toggle('on', !!on); $(id + ' use').setAttribute('href', on ? '#i-heart-f' : '#i-heart');
    $(id).setAttribute('aria-label', on ? 'Remove from Liked songs' : 'Add to Liked songs');
  }
  document.querySelectorAll('[data-act="like"]').forEach(b => {
    const on = S.likes.has(b.dataset.id);
    b.classList.toggle('on', on); b.querySelector('use').setAttribute('href', on ? '#i-heart-f' : '#i-heart');
  });
  renderSide();
}
function markPlaying() {
  const cur = S.queue[S.qi];
  document.querySelectorAll('.row[data-id]').forEach(r => {
    const on = r.dataset.id === cur; r.classList.toggle('is-cur', on);
    const n = r.querySelector('.row-n'); if (n) n.innerHTML = on ? '<span class="eq"><i></i><i></i><i></i></span>' : n.dataset.n;
  });
  document.querySelectorAll('.q-row').forEach(r => r.classList.toggle('cur', r.dataset.qi == S.qi));
}
function mediaSession(s) {
  if (!('mediaSession' in navigator)) return;
  const art = coverOf(s);
  navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist || '', album: s.album || '', artwork: art ? [{ src: art, sizes: '512x512' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] });
  const h = { play: () => audio.play(), pause: () => audio.pause(), previoustrack: prev, nexttrack: () => next(false), seekto: e => { audio.currentTime = e.seekTime; } };
  for (const [k, f] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, f); } catch { } }
}

/* ---------------- queue panel ---------------- */
function renderQueue() {
  const q = $('#queue'); if (q.hidden) return;
  const cur = getSong(S.queue[S.qi]);
  const rest = S.queue.slice(S.qi + 1);
  const row = (s, i) => `<div class="q-row ${i === S.qi ? 'cur' : ''}" data-act="jump" data-qi="${i}">${artHTML(s, 'art-xs')}<span class="row-main"><span class="row-t">${esc(s.title)}</span><span class="row-a">${esc(s.artist || 'Unknown artist')}</span></span>${i !== S.qi ? `<button class="icon-btn" data-act="q-remove" data-qi="${i}" aria-label="Remove from queue">${icon('close')}</button>` : '<span></span>'}</div>`;
  $('#queueBody').innerHTML = cur
    ? `<div><div class="eyebrow" style="padding:4px 8px">Now playing</div>${row(cur, S.qi)}</div>
       <div><div class="sec-h" style="padding:4px 8px"><span class="eyebrow">Next up</span>${rest.length ? '<button class="link-btn" data-act="q-clear">Clear</button>' : ''}</div>
       ${rest.length ? rest.map((id, k) => { const s = getSong(id); return s ? row(s, S.qi + 1 + k) : ''; }).join('') : '<p class="sub" style="padding:8px">Nothing queued. Use “Add to queue” on any song.</p>'}</div>`
    : '<p class="sub" style="padding:8px">Your queue is empty. Play a song to get started.</p>';
}

/* ---------------- lists ---------------- */
function sortedLibrary(filter = 'all') {
  let arr = [...S.songs.values()];
  if (filter === 'local') arr = arr.filter(s => s.source === 'local');
  else if (filter === 'saved') arr = arr.filter(s => s.source === 'ia' || s.source === 'jamendo');
  else if (filter === 'server') arr = arr.filter(s => s.source === 'server');
  const by = S.libSort;
  const col = new Intl.Collator(undefined, { sensitivity: 'base' });
  arr.sort(by === 'title' ? (a, b) => col.compare(a.title, b.title)
    : by === 'artist' ? (a, b) => col.compare(a.artist || '~', b.artist || '~') || col.compare(a.title, b.title)
      : (a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return arr.map(s => s.id);
}
const srcPill = s => s.source === 'ia' ? '<span class="pill src">Archive</span>' : s.source === 'jamendo' ? '<span class="pill src">Jamendo</span>' : s.source === 'server' ? '<span class="pill src">Server</span>' : '';
function listHTML(key, ids, { header = true, limit } = {}) {
  S.lists[key] = ids;
  const cur = S.queue[S.qi];
  const shown = limit ? ids.slice(0, limit) : ids;
  return `<div class="list" data-list="${key}">
    ${header ? `<div class="list-h"><span class="row-n">#</span><span></span><span>Title</span><span class="h-al">Album</span><span></span><span class="row-d">Time</span><span></span></div>` : ''}
    ${shown.map((id, i) => {
    const s = getSong(id); if (!s) return '';
    const liked = S.likes.has(id), isCur = id === cur;
    return `<div class="row ${isCur ? 'is-cur' : ''}" data-act="play-row" data-i="${i}" data-id="${esc(id)}">
        <span class="row-n" data-n="${i + 1}">${isCur ? '<span class="eq"><i></i><i></i><i></i></span>' : i + 1}</span>
        ${artHTML(s, 'art-sm')}
        <span class="row-main"><span class="row-t">${esc(s.title)}</span><span class="row-a">${esc(s.artist || 'Unknown artist')}${srcPill(s)}</span></span>
        <span class="row-al">${esc(s.album || '')}</span>
        <button class="icon-btn like ${liked ? 'on' : ''}" data-act="like" data-id="${esc(id)}" aria-label="${liked ? 'Remove from' : 'Add to'} Liked songs">${icon(liked ? 'heart-f' : 'heart')}</button>
        <span class="row-d">${fmt(s.duration)}</span>
        <button class="icon-btn" data-act="menu" data-id="${esc(id)}" aria-label="More options for ${esc(s.title)}">${icon('more')}</button>
      </div>`;
  }).join('')}
  </div>`;
}

/* ---------------- views ---------------- */
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Late night listening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function likedArt(cls) { return `<div class="art ${cls} liked-art">${icon('heart-f')}</div>`; }
function playlistArt(p, cls) {
  const first = p.songIds.map(getSong).find(s => s && coverOf(s));
  return first ? artHTML(first, cls) : `<div class="art ${cls}" style="--g:${gradFor({ title: p.name })}">${icon('note')}</div>`;
}
const V = {};
V.home = () => {
  const lib = sortedLibrary();
  const recent = S.recent.filter(id => S.songs.has(id)).slice(0, 12);
  if (!lib.length) return `<div class="page">
    <h1 class="display">${greeting()}, ${esc(OWNER)}</h1>
    <div class="empty">
      <span class="display">Your library is empty</span>
      <p class="sub">Add songs you own (MP3, M4A, FLAC) from this device, or explore free, legal music in Discover. Everything plays without ads.</p>
      <div class="actions"><button class="btn primary" data-act="upload">${icon('upload')}Add songs</button><button class="btn ghost" data-act="go" data-view="discover">${icon('compass')}Explore Discover</button></div>
      <p class="sub" style="font-size:13px">Tip: you can also drag files anywhere onto this window.</p>
    </div></div>`;
  return `<div class="page">
    <h1 class="display">${greeting()}, ${esc(OWNER)}</h1>
    <div class="tiles">
      <button class="tile" data-act="go" data-view="liked">${likedArt('')}<span>Liked songs</span></button>
      ${S.playlists.slice(0, 5).map(p => `<button class="tile" data-act="go" data-view="playlist" data-id="${p.id}">${playlistArt(p, '')}<span>${esc(p.name)}</span></button>`).join('')}
      <button class="tile" data-act="go" data-view="discover"><div class="art" style="--g:linear-gradient(135deg,#B8680E,#7A2E8E)">${icon('compass')}</div><span>Discover free music</span></button>
    </div>
    ${recent.length ? `<section class="sec"><div class="sec-h"><h2 class="h2">Recently played</h2></div>
      <div class="cards scroll" data-list="recent">${recent.map((id, i) => { const s = getSong(id); return `<div class="card" data-act="play-row" data-i="${i}" data-id="${esc(id)}" role="button" tabindex="0"><div class="art-wrap">${artHTML(s, 'art-md')}<span class="c-play">${icon('play')}</span></div><span class="c-t">${esc(s.title)}</span><span class="c-a">${esc(s.artist || 'Unknown artist')}</span></div>`; }).join('')}</div></section>` : ''}
    ${(S.lists.recent = recent, '')}
    <section class="sec"><div class="sec-h"><h2 class="h2">Recently added</h2><button class="link-btn" data-act="go" data-view="library">Show all</button></div>
      ${listHTML('home-added', lib, { header: false, limit: 8 })}</section>
  </div>`;
};
V.library = () => {
  const ids = sortedLibrary(S.libFilter);
  const counts = { all: S.songs.size, local: 0, saved: 0, server: 0 };
  for (const s of S.songs.values()) { if (s.source === 'local') counts.local++; else if (s.source === 'server') counts.server++; else counts.saved++; }
  const chip = (k, l) => counts[k] || k === 'all' ? `<button class="chip ${S.libFilter === k ? 'on' : ''}" data-act="lib-filter" data-f="${k}">${l}</button>` : '';
  return `<div class="page">
    <div class="hero"><div class="hero-txt"><span class="eyebrow">Library</span><h1 class="display">Your library</h1>
      <span class="hero-meta">${plural(S.songs.size, 'song')} · <span id="storageMeta">checking storage…</span></span></div></div>
    <div class="actions">
      ${ids.length ? `<button class="play-fab" data-act="play-list" data-list="lib" aria-label="Play all">${icon('play')}</button>
      <button class="icon-btn ${S.shuffle ? 'on' : ''}" data-act="shuffle-list" data-list="lib" aria-label="Shuffle play">${icon('shuffle')}</button>` : ''}
      <button class="btn primary" data-act="upload">${icon('upload')}Add songs</button>
    </div>
    <div class="toolbar">
      <div class="chips">${chip('all', 'All')}${chip('local', 'Uploaded')}${chip('saved', 'From Discover')}${chip('server', 'Server')}</div>
      <label class="muted" style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px">Sort
        <select class="sel" id="libSort"><option value="added">Recently added</option><option value="title">Title</option><option value="artist">Artist</option></select></label>
    </div>
    ${ids.length ? listHTML('lib', ids) : `<div class="empty"><span class="display">Nothing here yet</span><p class="sub">Add MP3s you own, or drag them onto this window.</p><button class="btn primary" data-act="upload">${icon('upload')}Add songs</button></div>`}
  </div>`;
};
V.liked = () => {
  const ids = [...S.likes].filter(id => getSong(id)).reverse();
  return `<div class="page">
    <div class="hero">${likedArt('art-lg')}<div class="hero-txt"><span class="eyebrow">Playlist</span><h1 class="display">Liked songs</h1><span class="hero-meta">${plural(ids.length, 'song')}</span></div></div>
    ${ids.length ? `<div class="actions"><button class="play-fab" data-act="play-list" data-list="liked" aria-label="Play">${icon('play')}</button><button class="icon-btn ${S.shuffle ? 'on' : ''}" data-act="shuffle-list" data-list="liked" aria-label="Shuffle play">${icon('shuffle')}</button></div>
    ${listHTML('liked', ids)}` : '<p class="sub">Tap the heart on any song to save it here.</p>'}
  </div>`;
};
V.playlist = () => {
  const p = S.playlists.find(x => x.id === S.view.id);
  if (!p) return '<div class="page"><p class="sub">This playlist no longer exists.</p></div>';
  const ids = p.songIds.filter(id => getSong(id));
  const dur = ids.reduce((t, id) => t + (getSong(id).duration || 0), 0);
  return `<div class="page">
    <div class="hero">${playlistArt(p, 'art-lg')}<div class="hero-txt"><span class="eyebrow">Playlist</span><h1 class="display">${esc(p.name)}</h1>
      <span class="hero-meta">${plural(ids.length, 'song')}${dur ? ' · about ' + Math.max(1, Math.round(dur / 60)) + ' min' : ''}</span></div></div>
    <div class="actions">
      ${ids.length ? `<button class="play-fab" data-act="play-list" data-list="pl" aria-label="Play">${icon('play')}</button><button class="icon-btn ${S.shuffle ? 'on' : ''}" data-act="shuffle-list" data-list="pl" aria-label="Shuffle play">${icon('shuffle')}</button>` : ''}
      <button class="btn ghost" data-act="rename-playlist" data-id="${p.id}">Rename</button>
      <button class="btn ghost danger" data-act="delete-playlist" data-id="${p.id}">${icon('trash')}Delete</button>
    </div>
    ${ids.length ? listHTML('pl', ids) : '<p class="sub">Add songs with the ••• menu on any song.</p>'}
  </div>`;
};
V.search = () => {
  const q = S.search.trim().toLowerCase();
  const ids = q ? [...S.songs.values()].filter(s => [s.title, s.artist, s.album].some(x => (x || '').toLowerCase().includes(q))).map(s => s.id) : [];
  const pls = q ? S.playlists.filter(p => p.name.toLowerCase().includes(q)) : [];
  return `<div class="page">
    <label class="field">${icon('search')}<input id="searchIn" type="search" placeholder="Songs, artists or albums" value="${esc(S.search)}" autocomplete="off" aria-label="Search your library"></label>
    <div id="searchRes">${searchResults(q, ids, pls)}</div>
  </div>`;
};
function searchResults(q, ids, pls) {
  if (!q) return `<section class="sec"><h2 class="h2">Browse</h2><div class="tiles">
      <button class="tile" data-act="go" data-view="liked">${likedArt('')}<span>Liked songs</span></button>
      <button class="tile" data-act="go" data-view="library"><div class="art" style="--g:${gradFor({ title: 'lib' })}">${icon('library')}</div><span>All songs</span></button>
      ${S.playlists.map(p => `<button class="tile" data-act="go" data-view="playlist" data-id="${p.id}">${playlistArt(p, '')}<span>${esc(p.name)}</span></button>`).join('')}
    </div></section>`;
  return `${pls.length ? `<section class="sec"><h2 class="h2">Playlists</h2><div class="tiles">${pls.map(p => `<button class="tile" data-act="go" data-view="playlist" data-id="${p.id}">${playlistArt(p, '')}<span>${esc(p.name)}</span></button>`).join('')}</div></section>` : ''}
    <section class="sec"><h2 class="h2">In your library</h2>${ids.length ? listHTML('search', ids, { header: false }) : `<p class="sub">No songs match “${esc(q)}”.</p>`}</section>
    <div class="actions"><button class="btn ghost" data-act="search-discover">${icon('compass')}Search free music for “${esc(S.search.trim())}”</button></div>`;
}

/* ---------------- Discover ---------------- */
const IA_PRESETS = [
  { id: 'hindi78', label: 'Vintage Hindi', q: 'collection:78rpm AND (language:hindi OR language:hin OR subject:hindi OR subject:"hindi film" OR subject:bollywood)' },
  { id: 'classical', label: 'Indian classical', q: 'collection:78rpm AND (subject:raga OR subject:sitar OR subject:hindustani OR subject:"indian classical" OR title:raga OR title:raag)' },
  { id: 'devotional', label: 'Ghazal & bhajan', q: 'collection:78rpm AND (subject:ghazal OR subject:bhajan OR title:ghazal OR title:bhajan OR subject:qawwali)' },
  { id: 'jazz', label: 'Old jazz & blues', q: 'collection:78rpm AND (subject:jazz OR subject:blues)' },
  { id: 'indie', label: 'Open-license indie', q: 'collection:netlabels AND mediatype:audio' },
];
const JM_PRESETS = [
  { id: 'indian', label: 'Indian' }, { id: 'world', label: 'World' }, { id: 'acoustic', label: 'Acoustic' },
  { id: 'pop', label: 'Pop' }, { id: 'lounge', label: 'Chill' }, { id: 'rock', label: 'Rock' },
];
let discToken = 0;
async function runDiscover() {
  const D = S.disc, tok = ++discToken;
  D.loading = true; D.error = ''; D.items = []; render();
  try {
    if (D.source === 'ia') {
      const clean = D.q.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
      const preset = IA_PRESETS.find(p => p.id === D.preset) || IA_PRESETS[0];
      const q = clean ? `(collection:78rpm OR collection:netlabels) AND mediatype:audio AND (${clean})` : preset.q;
      const url = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(q) +
        '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=date&sort[]=downloads+desc&rows=48&output=json';
      const r = await fetch(url); if (!r.ok) throw new Error('Archive ' + r.status);
      const j = await r.json();
      if (tok !== discToken) return;
      D.items = j.response.docs.map(d => ({ kind: 'ia', id: d.identifier, title: iaTitle(d.title, d.creator), creator: [].concat(d.creator || []).slice(0, 3).join(', '), year: d.year || (d.date || '').slice(0, 4) }));
    } else {
      if (!D.key) { D.loading = false; render(); return; }
      const base = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(D.key)}&format=json&limit=48&audioformat=mp32&include=musicinfo`;
      const url = base + (D.q.trim() ? '&search=' + encodeURIComponent(D.q.trim()) + '&order=relevance' : '&tags=' + encodeURIComponent(D.preset) + '&order=popularity_total');
      const r = await fetch(url); const j = await r.json();
      if (tok !== discToken) return;
      if (j.headers && j.headers.status !== 'success') throw new Error(j.headers.error_message || 'Jamendo error');
      D.items = j.results.map(t => {
        const s = { id: 'jm:' + t.id, title: t.name, artist: t.artist_name, album: t.album_name, duration: +t.duration || 0, url: t.audio, coverUrl: t.image || t.album_image, source: 'jamendo', page: t.shareurl, license: t.license_ccurl };
        if (!S.songs.has(s.id)) S.temp.set(s.id, s);
        return { kind: 'jm', id: s.id };
      });
    }
  } catch (e) {
    if (tok !== discToken) return;
    D.error = D.source === 'jm' ? 'Jamendo didn\'t respond. Check your client ID in Discover and try again.' : 'Couldn\'t reach the Internet Archive. Check your connection and try again.';
    console.error(e);
  }
  D.loading = false; render();
}
const dashes = s => s.replace(/--/g, ', ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
function cleanIaFile(name) {
  const n = name.replace(/\.mp3$/i, '').replace(/^.*\//, '');
  const m = n.match(/VintageSense\.com_(\d{4})_(.+?)--\d{4}-_(.+?)_\d{4}-.+?--\d{4}--(.+?)_VintageSense/i);
  if (m) return { title: dashes(m[4]), artist: dashes(m[3]), album: `${dashes(m[2])} (${m[1]})`, year: m[1] };
  if (!/\s/.test(n) && /[_-]/.test(n)) return { title: dashes(n.replace(/^\d+[_-]+/, '')) };
  return { title: n };
}
function iaTitle(t, creator) {
  t = String(t || '').trim().replace(/^www\./i, '').replace(/\.com-/i, ' ');
  if (!/\s/.test(t) && /[_-]/.test(t)) t = dashes(t);
  if (!t || /^none legible$/i.test(t)) { const c = [].concat(creator || [])[0]; return c ? `Untitled record · ${c}` : 'Untitled record'; }
  return t;
}
function iaSongs(ident, meta) {
  const files = (meta.files || []).filter(f => /mp3/i.test(f.format || '') || /\.mp3$/i.test(f.name));
  const byOrig = new Map();
  for (const f of files) { const k = f.original || f.name; const prevF = byOrig.get(k); if (!prevF || /vbr/i.test(f.format || '')) byOrig.set(k, f); }
  const md = meta.metadata || {};
  const creator = [].concat(md.creator || []).slice(0, 3).join(', ');
  const album = iaTitle(md.title, md.creator);
  const parseLen = l => { if (!l) return 0; if (String(l).includes(':')) return String(l).split(':').reduce((a, b) => a * 60 + (+b || 0), 0); return +l || 0; };
  return [...byOrig.values()].sort((a, b) => (+a.track || 0) - (+b.track || 0) || a.name.localeCompare(b.name)).map(f => {
    const id = 'ia:' + ident + '/' + f.name;
    const c = cleanIaFile(f.name);
    const rawT = f.title && !/^none legible$/i.test(f.title) ? f.title : '';
    const title = rawT && /\s/.test(rawT) ? rawT : (c.album || byOrig.size > 1 || !rawT ? c.title : album);
    const s = { id, title, artist: c.artist || f.artist || f.creator || creator, album: c.album || album, duration: parseLen(f.length), source: 'ia',
      url: `https://archive.org/download/${encodeURIComponent(ident)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      coverUrl: `https://archive.org/services/img/${encodeURIComponent(ident)}`, page: `https://archive.org/details/${encodeURIComponent(ident)}`,
      license: md.licenseurl || '', year: md.year || (md.date || '').slice(0, 4) };
    if (!S.songs.has(id)) S.temp.set(id, s);
    return id;
  });
}
async function loadIaItem(ident) {
  if (S.iaItems.has(ident)) return S.iaItems.get(ident);
  const r = await fetch('https://archive.org/metadata/' + encodeURIComponent(ident));
  const meta = await r.json();
  const item = { meta, ids: iaSongs(ident, meta) };
  S.iaItems.set(ident, item);
  return item;
}
V.discover = () => {
  const D = S.disc;
  const presets = D.source === 'ia' ? IA_PRESETS : JM_PRESETS;
  const needKey = D.source === 'jm' && !D.key;
  let body;
  if (needKey) body = `<div class="empty"><span class="display">Connect Jamendo</span>
      <p class="sub">Jamendo has 600,000+ free, Creative Commons songs. It needs a free client ID: sign up at <a href="https://devportal.jamendo.com/" target="_blank" rel="noopener">devportal.jamendo.com</a>, create an app, and paste its Client ID here.</p>
      <form class="key-form" id="keyForm"><label class="field"><input id="keyIn" placeholder="Client ID" autocomplete="off" aria-label="Jamendo client ID"></label><button class="btn primary">Connect</button></form></div>`;
  else if (D.loading) body = `<div class="actions"><div class="spinner"></div><span class="muted">Searching…</span></div>`;
  else if (D.error) body = `<div class="note">${icon('info')}<span>${esc(D.error)} <button class="link-btn" data-act="disc-retry">Try again</button></span></div>`;
  else if (!D.items.length) body = `<p class="sub">No results. Try another search.</p>`;
  else if (D.source === 'ia') body = `<div class="cards">${D.items.map(it => `<div class="card" data-act="ia-open" data-id="${esc(it.id)}" role="button" tabindex="0">
        <div class="art-wrap"><div class="art art-md" style="--g:${gradFor({ title: it.title })}"><img src="https://archive.org/services/img/${encodeURIComponent(it.id)}" alt="" loading="lazy" onerror="this.remove()"></div>
        <button class="c-play" data-act="ia-play" data-id="${esc(it.id)}" aria-label="Play ${esc(it.title)}">${icon('play')}</button></div>
        <span class="c-t">${esc(it.title)}</span><span class="c-a">${esc([it.creator, it.year].filter(Boolean).join(' · ') || 'Unknown artist')}</span></div>`).join('')}</div>`;
  else body = listHTML('disc', D.items.map(i => i.id));

  return `<div class="page">
    <div class="hero"><div class="hero-txt"><span class="eyebrow">Discover</span><h1 class="display">Free music, no ads</h1>
      <p class="sub">Public-domain and Creative Commons recordings. Tap the heart to keep a song in your library, or save it for offline listening.</p></div></div>
    <div class="toolbar">
      <div class="seg" role="tablist"><button class="${D.source === 'ia' ? 'on' : ''}" data-act="disc-source" data-s="ia" role="tab" aria-selected="${D.source === 'ia'}">Internet Archive</button><button class="${D.source === 'jm' ? 'on' : ''}" data-act="disc-source" data-s="jm" role="tab" aria-selected="${D.source === 'jm'}">Jamendo</button></div>
    </div>
    ${needKey ? '' : `<form id="discForm" class="toolbar"><label class="field">${icon('search')}<input id="discIn" type="search" value="${esc(D.q)}" placeholder="${D.source === 'ia' ? 'e.g. Saigal, Noor Jehan, raga, qawwali' : 'Artist, song or mood'}" aria-label="Search free music"></label></form>
    <div class="chips">${presets.map(p => `<button class="chip ${!D.q && D.preset === p.id ? 'on' : ''}" data-act="disc-preset" data-p="${p.id}">${esc(p.label)}</button>`).join('')}</div>`}
    ${body}
    ${D.source === 'ia' ? `<div class="note">${icon('info')}<span>Anyone can upload to the Archive, so rights vary. In India, a sound recording's copyright ends 60 years after release, but the song's lyrics and music can stay protected for longer. Streaming for personal listening is the safe use. Don't re-share these files.</span></div>` : ''}
    ${D.source === 'jm' && D.key ? `<p class="sub" style="font-size:13px">Connected to Jamendo. <button class="link-btn" data-act="disc-forget-key">Change client ID</button></p>` : ''}
  </div>`;
};
V.iaitem = () => {
  const it = S.iaItems.get(S.view.id);
  if (!it) return `<div class="page"><div class="actions"><div class="spinner"></div><span class="muted">Loading record…</span></div></div>`;
  const md = it.meta.metadata || {};
  const title = iaTitle(md.title, md.creator);
  const creator = [].concat(md.creator || []).slice(0, 4).join(', ');
  const lic = md.licenseurl;
  return `<div class="page">
    <button class="link-btn" data-act="go" data-view="discover" style="align-self:flex-start">← Back to Discover</button>
    <div class="hero"><div class="art art-lg" style="--g:${gradFor({ title })}"><img src="https://archive.org/services/img/${encodeURIComponent(S.view.id)}" alt="" onerror="this.remove()"></div>
      <div class="hero-txt"><span class="eyebrow">Internet Archive${md.year || md.date ? ' · ' + esc(md.year || String(md.date).slice(0, 4)) : ''}</span><h1 class="display">${esc(title)}</h1>
      <span class="hero-meta">${esc(creator || 'Unknown artist')} · ${plural(it.ids.length, 'track')}</span>
      <span class="hero-meta">${lic ? `License: <a href="${esc(lic)}" target="_blank" rel="noopener">${esc(lic.replace(/^https?:\/\//, ''))}</a> · ` : ''}<a href="https://archive.org/details/${encodeURIComponent(S.view.id)}" target="_blank" rel="noopener">View on archive.org</a></span></div></div>
    ${it.ids.length ? `<div class="actions"><button class="play-fab" data-act="play-list" data-list="ia" aria-label="Play">${icon('play')}</button></div>${listHTML('ia', it.ids)}` : '<p class="sub">This record has no playable MP3.</p>'}
  </div>`;
};

/* ---------------- render ---------------- */
const main = $('#main');
function render() {
  const name = S.view.name;
  const fn = V[name] || V.home;
  S.lists = {};
  main.innerHTML = fn();
  for (const b of document.querySelectorAll('#nav button, #tabbar button')) {
    const v = b.dataset.view;
    b.classList.toggle('on', v === name || (v === 'library' && ['liked', 'playlist'].includes(name)) || (v === 'discover' && name === 'iaitem'));
  }
  if (name === 'library') {
    const sel = $('#libSort'); if (sel) sel.value = S.libSort;
    navigator.storage?.estimate?.().then(e => { const el = $('#storageMeta'); if (el) el.textContent = `${(e.usage / 1048576).toFixed(0)} MB used on this device`; }).catch(() => { const el = $('#storageMeta'); if (el) el.textContent = 'stored on this device'; });
  }
}
function renderSide() {
  $('#plList').innerHTML = `<li><button data-act="go" data-view="liked" class="${S.view.name === 'liked' ? 'on' : ''}">${likedArt('art-xs')}<span class="row-main"><span class="pl-name">Liked songs</span><span class="pl-meta">${plural(S.likes.size, 'song')}</span></span></button></li>` +
    S.playlists.map(p => `<li><button data-act="go" data-view="playlist" data-id="${p.id}" class="${S.view.name === 'playlist' && S.view.id === p.id ? 'on' : ''}">${playlistArt(p, 'art-xs')}<span class="row-main"><span class="pl-name">${esc(p.name)}</span><span class="pl-meta">${plural(p.songIds.length, 'song')}</span></span></button></li>`).join('');
}
function go(view) {
  S.view = view; closeMenu();
  if (view.name === 'discover' && !S.disc.items.length && !S.disc.loading && !S.disc.error) runDiscover();
  render(); renderSide(); main.scrollTop = 0;
  if (view.name === 'search') { const i = $('#searchIn'); if (i && !isMobile()) i.focus(); }
  if (view.name === 'iaitem' && !S.iaItems.has(view.id)) loadIaItem(view.id).then(() => { if (S.view.name === 'iaitem') render(); }).catch(() => toast('Couldn\'t load that record'));
}

/* ---------------- song menu ---------------- */
function songMenu(btn, id) {
  const s = getSong(id); if (!s) return;
  const inPl = S.view.name === 'playlist' ? S.view.id : null;
  openMenu(btn, `
    <button data-act="m-next" data-id="${esc(id)}">${icon('next-up')}Play next</button>
    <button data-act="m-queue" data-id="${esc(id)}">${icon('queue')}Add to queue</button>
    <hr><div class="menu-h">Add to playlist</div>
    ${S.playlists.map(p => `<button data-act="m-pl" data-pl="${p.id}" data-id="${esc(id)}">${icon('note')}${esc(p.name)}</button>`).join('')}
    <button data-act="m-newpl" data-id="${esc(id)}">${icon('plus')}New playlist</button>
    ${inPl ? `<button data-act="m-unpl" data-pl="${inPl}" data-id="${esc(id)}">${icon('close')}Remove from this playlist</button>` : ''}
    <hr>
    ${s.url && !s.hasBlob ? `<button data-act="m-save" data-id="${esc(id)}">${icon('download')}Save for offline</button>` : ''}
    ${s.page ? `<a href="${esc(s.page)}" target="_blank" rel="noopener">${icon('link')}Open source page</a>` : ''}
    ${S.songs.has(id) && s.source !== 'server' ? `<button data-act="m-remove" data-id="${esc(id)}">${icon('trash')}Remove from library</button>` : ''}
    ${!S.songs.has(id) ? `<button data-act="m-add" data-id="${esc(id)}">${icon('plus')}Add to library</button>` : ''}`);
}

/* ---------------- events ---------------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!e.target.closest('.menu') && !(el && el.dataset.act === 'menu')) closeMenu();
  if (!el) return;
  const a = el.dataset.act, id = el.dataset.id;
  if (el.tagName === 'A') { closeMenu(); return; }
  switch (a) {
    case 'go': {
      const v = { name: el.dataset.view }; if (id) v.id = id;
      if (isMobile()) { $('#sheet').hidden = true; $('#queue').hidden = true; }
      go(v); break;
    }
    case 'play-row': {
      const listEl = el.closest('[data-list]'); const key = listEl?.dataset.list;
      const ids = S.lists[key] || [id];
      if (S.queue[S.qi] === id && audio.src) { toggle(); break; }
      playList(ids, +el.dataset.i || 0); break;
    }
    case 'play-list': case 'shuffle-list': {
      const ids = S.lists[el.dataset.list] || [];
      if (a === 'shuffle-list') playList(ids, 0, true); else playList(ids, 0);
      break;
    }
    case 'like': e.stopPropagation(); await toggleLike(id); break;
    case 'like-current': e.stopPropagation(); if (S.queue[S.qi]) await toggleLike(S.queue[S.qi]); break;
    case 'menu': e.stopPropagation(); if ($('#menuHost').firstChild && $('#menuHost').dataset.for === id) { closeMenu(); $('#menuHost').dataset.for = ''; } else { songMenu(el, id); $('#menuHost').dataset.for = id; } break;
    case 'm-next': { closeMenu(); if (!S.queue.length) { playList([id]); break; } const curId = S.queue[S.qi]; if (curId === id) break; S.queue = S.queue.filter(x => x !== id); S.qi = S.queue.indexOf(curId); S.queue.splice(S.qi + 1, 0, id); renderQueue(); toast('Playing next'); break; }
    case 'm-queue': closeMenu(); if (!S.queue.length) { playList([id]); break; } S.queue.push(id); renderQueue(); toast('Added to queue'); break;
    case 'm-pl': closeMenu(); await addToPlaylist(el.dataset.pl, id); break;
    case 'm-newpl': closeMenu(); await newPlaylist(id); break;
    case 'm-unpl': { closeMenu(); const p = S.playlists.find(x => x.id === el.dataset.pl); if (p) { p.songIds = p.songIds.filter(x => x !== id); await DB.put('playlists', p); render(); renderSide(); toast(`Removed from ${p.name}`); } break; }
    case 'm-save': closeMenu(); saveOffline(id); break;
    case 'm-remove': closeMenu(); removeSong(id); break;
    case 'm-add': closeMenu(); await addToLibrary(getSong(id)); toast('Added to your library'); break;
    case 'new-playlist': newPlaylist(); break;
    case 'rename-playlist': { const p = S.playlists.find(x => x.id === id); const n = await modal({ title: 'Rename playlist', input: p.name }); if (n) { p.name = n; await DB.put('playlists', p); render(); renderSide(); } break; }
    case 'delete-playlist': { const p = S.playlists.find(x => x.id === id); if (await modal({ title: 'Delete playlist?', body: `“${esc(p.name)}” will be deleted. The songs stay in your library.`, okText: 'Delete', danger: true })) { S.playlists = S.playlists.filter(x => x.id !== id); await DB.del('playlists', id); go({ name: 'library' }); toast('Playlist deleted'); } break; }
    case 'upload': $('#fileIn').click(); break;
    case 'lib-filter': S.libFilter = el.dataset.f; render(); break;
    case 'toggle': toggle(); break;
    case 'next': next(false); break;
    case 'prev': prev(); break;
    case 'shuffle': S.shuffle = !S.shuffle; store.set('shuffle', S.shuffle);
      if (S.shuffle && S.queue.length > S.qi + 1) S.queue = [...S.queue.slice(0, S.qi + 1), ...shuffleArr(S.queue.slice(S.qi + 1))];
      syncModes(); renderQueue(); toast(S.shuffle ? 'Shuffle on' : 'Shuffle off'); break;
    case 'repeat': S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat]; store.set('repeat', S.repeat); syncModes();
      toast({ off: 'Repeat off', all: 'Repeating the queue', one: 'Repeating this song' }[S.repeat]); break;
    case 'mute': audio.muted = !audio.muted; syncMute(); break;
    case 'toggle-queue': { const q = $('#queue'); q.hidden = !q.hidden; $('#pQueueBtn').classList.toggle('on', !q.hidden); renderQueue(); break; }
    case 'jump': if (e.target.closest('[data-act="q-remove"]')) break; S.qi = +el.dataset.qi; loadCurrent(true); break;
    case 'q-remove': { e.stopPropagation(); const i = +el.dataset.qi; S.queue.splice(i, 1); if (i < S.qi) S.qi--; renderQueue(); break; }
    case 'q-clear': S.queue = S.queue.slice(0, S.qi + 1); renderQueue(); break;
    case 'open-sheet': if (isMobile() && S.queue.length) { $('#sheet').hidden = false; } break;
    case 'close-sheet': $('#sheet').hidden = true; break;
    case 'search-discover': S.disc.source = 'ia'; S.disc.q = S.search.trim(); store.set('discSource', 'ia'); go({ name: 'discover' }); runDiscover(); break;
    case 'disc-source': S.disc.source = el.dataset.s; S.disc.preset = el.dataset.s === 'ia' ? 'hindi78' : 'indian'; S.disc.q = ''; S.disc.items = []; S.disc.error = ''; store.set('discSource', S.disc.source); runDiscover(); break;
    case 'disc-preset': S.disc.preset = el.dataset.p; S.disc.q = ''; runDiscover(); break;
    case 'disc-retry': runDiscover(); break;
    case 'disc-forget-key': S.disc.key = ''; store.set('jamendoKey', ''); render(); break;
    case 'ia-open': go({ name: 'iaitem', id }); break;
    case 'ia-play': {
      e.stopPropagation();
      try { const it = await loadIaItem(id); if (it.ids.length) playList(it.ids, 0); else toast('This record has no playable MP3'); }
      catch { toast('Couldn\'t load that record'); }
      break;
    }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeMenu(); $('#sheet').hidden = true; }
  const t = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && t.matches('.card[role=button]')) { e.preventDefault(); t.click(); return; }
  if (t.matches('input, textarea, select, button, [contenteditable]')) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) next(false);
  else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
});
document.addEventListener('input', e => {
  if (e.target.id === 'searchIn') {
    S.search = e.target.value;
    const q = S.search.trim().toLowerCase();
    const ids = q ? [...S.songs.values()].filter(s => [s.title, s.artist, s.album].some(x => (x || '').toLowerCase().includes(q))).map(s => s.id) : [];
    const pls = q ? S.playlists.filter(p => p.name.toLowerCase().includes(q)) : [];
    $('#searchRes').innerHTML = searchResults(q, ids, pls);
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'libSort') { S.libSort = e.target.value; store.set('libSort', S.libSort); render(); }
  if (e.target.id === 'fileIn') { addFiles(e.target.files); e.target.value = ''; }
});
document.addEventListener('submit', e => {
  if (e.target.id === 'discForm') { e.preventDefault(); S.disc.q = $('#discIn').value; runDiscover(); }
  if (e.target.id === 'keyForm') { e.preventDefault(); const k = $('#keyIn').value.trim(); if (k) { S.disc.key = k; store.set('jamendoKey', k); runDiscover(); } }
});
// drag & drop anywhere
let dragDepth = 0;
addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

/* ---------------- boot ---------------- */
async function loadServerLibrary() {
  try {
    const r = await fetch('library/songs.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const j = await r.json();
    for (const it of (j.songs || [])) {
      if (!it.file) continue;
      const id = 'srv:' + it.file;
      S.songs.set(id, { id, title: it.title || it.file.replace(/\.[^.]+$/, ''), artist: it.artist || '', album: it.album || '', duration: +it.duration || 0,
        source: 'server', url: 'library/' + it.file.split('/').map(encodeURIComponent).join('/'), coverUrl: it.cover ? 'library/' + it.cover : '', addedAt: +it.addedAt || 0 });
    }
  } catch { /* no server library */ }
}
async function boot() {
  try { await DB.open(); } catch { toast('This browser blocked local storage. Songs can\'t be saved.'); }
  if (DB.db) {
    const [songs, pls, likes, recent] = await Promise.all([DB.all('songs'), DB.all('playlists'), DB.get('meta', 'likes'), DB.get('meta', 'recent')]);
    for (const s of songs) S.songs.set(s.id, s);
    S.playlists = pls.sort((a, b) => a.createdAt - b.createdAt);
    S.likes = new Set(likes || []); S.recent = recent || [];
    // cover art for uploaded songs
    await Promise.all(songs.filter(s => s.hasCover).map(async s => { const b = await DB.get('blobs', 'cover:' + s.id); if (b) s._cover = URL.createObjectURL(b); }));
  }
  await loadServerLibrary();
  render(); renderSide(); syncModes(); syncMute(); syncPlayState();
  const sess = store.get('session', null);
  if (sess && sess.queue?.length) {
    S.queue = sess.queue.filter(id => S.songs.has(id));
    S.qi = Math.max(0, S.queue.indexOf(sess.id));
    if (S.queue.length) await loadCurrent(false);
  }
  updateNow();
}
boot();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
