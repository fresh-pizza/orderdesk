'use strict';
/* =====================================================================
   Order Desk — offline-first, synced with Supabase.
   Every screen reads and writes the copy stored on this device (IndexedDB).
   A background sync pushes local changes and pulls changes from other devices.
   ===================================================================== */
const CFG = {
  url: 'https://qgoyengzjgsxpqkhhyjm.supabase.co',
  key: 'sb_publishable_guwA3lmtAw61a5ks898qoQ_i07f7y3q',
  bucket: 'photos',
};
const VERSION = '1.0.2';
const COLLS = ['menu', 'customers', 'orders', 'settings'];
const DEFAULT_SETTINGS = { id: 'main', name: 'My kitchen', currency: '¥', deliveryFee: 0 };

/* ---------- tiny helpers ---------- */
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('aria-') && v != null) { e.setAttribute(k, String(v)); continue; }
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const $ = (s, r = document) => r.querySelector(s);
const clone = o => JSON.parse(JSON.stringify(o));
const DAY = 86400000;
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const pad = n => String(n).padStart(2, '0');
const timeStr = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dateShort = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const isoDay = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
function ago(ms) {
  const d = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
}
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const initial = s => (String(s || '?').trim()[0] || '?').toUpperCase();
function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const toIso = ms => new Date(Number(ms) || Date.now()).toISOString();
const toMs = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : Date.now(); };

/* ---------- local database (IndexedDB) ---------- */
const IDB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('orderdesk', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of [...COLLS, 'outbox', 'blobs', 'meta']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Close other Order Desk tabs and reload.'));
    });
    return dbp;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function all(store) {
    const d = await open(), t = d.transaction(store), s = t.objectStore(store);
    const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
    return keys.map((k, i) => [k, vals[i]]);
  }
  async function get(store, key) { const d = await open(); return req(d.transaction(store).objectStore(store).get(key)); }
  /* ops: [{store, key, val}] (val undefined = delete). One transaction, all or nothing. */
  async function batch(ops) {
    if (!ops.length) return;
    const d = await open(), stores = [...new Set(ops.map(o => o.store))];
    await new Promise((res, rej) => {
      const t = d.transaction(stores, 'readwrite');
      for (const o of ops) { const s = t.objectStore(o.store); if (o.val === undefined) s.delete(o.key); else s.put(o.val, o.key); }
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Save aborted'));
    });
  }
  async function clearAll() {
    const d = await open(), stores = [...d.objectStoreNames];
    await new Promise((res, rej) => {
      const t = d.transaction(stores, 'readwrite');
      for (const s of stores) t.objectStore(s).clear();
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }
  return { all, get, batch, clearAll };
})();

/* ---------- app state ---------- */
const OPEN = ['new', 'cooking', 'ready'];
const ST = { new: 'New', cooking: 'Cooking', ready: 'Ready', done: 'Done', cancelled: 'Cancelled' };
const NEXT = { new: 'cooking', cooking: 'ready', ready: 'done' };
const M = { menu: new Map(), customers: new Map(), orders: new Map(), settings: new Map() };
const S = {
  ready: false, uid: null, email: '', signedIn: false,
  menu: [], customers: [], orders: [], settings: clone(DEFAULT_SETTINGS),
  loaded: { menu: true, customers: true, orders: true, config: true },
  view: 'orders', ordFilter: 'open', ordLimit: 60, menuQ: '', menuCat: 'All', custQ: '', pickQ: '', pickCat: 'All',
  draft: null, blobUrls: new Map(), outbox: new Map(),
};
function refreshArrays(colls) {
  for (const c of colls || COLLS) {
    if (c === 'settings') { S.settings = Object.assign(clone(DEFAULT_SETTINGS), M.settings.get('main') || {}); continue; }
    S[c] = [...M[c].values()].filter(r => !r.deleted);
  }
}
const money = n => {
  n = Number(n) || 0;
  return (S.settings.currency || '') + (Number.isInteger(n) ? n : n.toFixed(2));
};
const newDraft = () => ({ customerId: null, name: '', phone: '', address: '', type: 'delivery', note: '', fee: Number(S.settings.deliveryFee) || 0, lines: [] });
S.draft = newDraft();

/* ---------- local writes (instant), queued for upload ---------- */
let stamp = 0;
const nextStamp = () => { stamp = Math.max(stamp + 1, Date.now()); return stamp; };
async function putRec(coll, rec, extraOps) {
  const v = nextStamp();
  const r = Object.assign({}, rec, { _v: v });
  const key = coll + ':' + r.id;
  const entry = { kind: 'row', coll, id: r.id, v };
  await IDB.batch([{ store: coll, key: r.id, val: r }, { store: 'outbox', key, val: entry }, ...(extraOps || [])]);
  M[coll].set(r.id, r); S.outbox.set(key, entry);
  refreshArrays([coll]); scheduleRender(); Sync.soon();
  return r;
}
const Store = {
  put: (coll, rec, extra) => putRec(coll, rec, extra),
  patch: (coll, id, part) => { const cur = M[coll].get(id); if (!cur) return Promise.reject(new Error('Record not found')); return putRec(coll, Object.assign({}, cur, part)); },
  remove: (coll, id, extra) => { const cur = M[coll].get(id) || { id }; return putRec(coll, Object.assign({}, cur, { deleted: true }), extra); },
};
/* photo: keep the file on this device, queue the upload */
async function queuePhoto(path, blob) {
  const buf = await blob.arrayBuffer();
  const key = 'photo:' + path, entry = { kind: 'photo-up', path, v: nextStamp() };
  await IDB.batch([{ store: 'blobs', key: path, val: { type: blob.type, data: buf } }, { store: 'outbox', key, val: entry }]);
  S.outbox.set(key, entry);
  S.blobUrls.set(path, URL.createObjectURL(new Blob([buf], { type: blob.type })));
  Sync.soon();
}
function photoDelOp(path) {
  if (!path) return [];
  const key = 'photodel:' + path, entry = { kind: 'photo-del', path, v: nextStamp() };
  S.outbox.set(key, entry);
  return [{ store: 'outbox', key, val: entry }];
}
const publicUrl = path => CFG.url + '/storage/v1/object/public/' + CFG.bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
const photoUrl = path => S.blobUrls.get(path) || publicUrl(path);

/* ---------- server row <-> app record ---------- */
const num = v => Number(v) || 0;
const MAP = {
  menu: {
    to: r => ({ id: r.id, name: r.name || '', category: r.category || 'Other', description: r.description || '', variants: r.variants || [], photo: r.photo || '', available: r.available !== false, example: !!r.example, deleted: !!r.deleted }),
    from: x => ({ id: x.id, name: x.name, category: x.category, description: x.description, variants: x.variants || [], photo: x.photo || '', available: x.available !== false, example: !!x.example, deleted: !!x.deleted }),
  },
  customers: {
    to: r => ({ id: r.id, name: r.name || '', phone: r.phone || '', address: r.address || '', notes: r.notes || '', created_at: toIso(r.createdAt), deleted: !!r.deleted }),
    from: x => ({ id: x.id, name: x.name, phone: x.phone, address: x.address, notes: x.notes, createdAt: toMs(x.created_at), deleted: !!x.deleted }),
  },
  orders: {
    to: r => ({ id: r.id, no: r.no || 0, customer_id: r.customerId || null, customer_name: r.customerName || '', phone: r.phone || '', address: r.address || '', type: r.type || 'delivery', items: r.items || [], subtotal: num(r.subtotal), fee: num(r.fee), total: num(r.total), note: r.note || '', status: r.status || 'new', created_at: toIso(r.createdAt), deleted: !!r.deleted }),
    from: x => ({ id: x.id, no: x.no, customerId: x.customer_id || null, customerName: x.customer_name, phone: x.phone, address: x.address, type: x.type, items: x.items || [], subtotal: num(x.subtotal), fee: num(x.fee), total: num(x.total), note: x.note, status: x.status, createdAt: toMs(x.created_at), deleted: !!x.deleted }),
  },
  settings: {
    to: r => ({ id: S.uid, name: r.name || 'My kitchen', currency: r.currency ?? '¥', delivery_fee: num(r.deliveryFee), deleted: false }),
    from: x => ({ id: 'main', name: x.name, currency: x.currency, deliveryFee: num(x.delivery_fee), deleted: false }),
  },
};

/* ---------- cloud sync ---------- */
let sb = null, channel = null;
const Sync = {
  busy: false, again: false, timer: 0, state: 'idle', lastOk: 0, err: '', fails: 0,
  soon(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms == null ? 400 : ms); },
  waiting() { return S.outbox.size; },
  set(state, err) { this.state = state; this.err = err || ''; paintSync(); },
  async run() {
    if (!sb || !S.signedIn) { paintSync(); return; }
    if (this.busy) { this.again = true; return; }
    if (navigator.onLine === false) { this.set('offline'); return; }
    this.busy = true; this.set('syncing');
    try {
      let photoErr = null;
      try { await pushPhotos(); } catch (e) { photoErr = e; } // a stuck photo must not hold back orders
      await pushRows();
      await pull();
      if (photoErr) throw photoErr;
      this.lastOk = Date.now(); this.fails = 0; this.set('ok');
      if (!channel) startRealtime();
    } catch (e) {
      this.fails++;
      const msg = (e && (e.message || e.error_description)) || String(e);
      const offline = /fetch|network|load failed|timed? ?out/i.test(msg) || navigator.onLine === false;
      this.set(offline ? 'offline' : 'error', msg);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), Math.min(120000, 5000 * 2 ** Math.min(this.fails, 5)));
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.soon(50); }
    }
  },
};
async function pushPhotos() {
  for (const [key, e] of [...S.outbox]) {
    if (e.kind === 'photo-up') {
      const b = await IDB.get('blobs', e.path);
      if (b) {
        const blob = new Blob([b.data], { type: b.type });
        const { error } = await sb.storage.from(CFG.bucket).upload(e.path, blob, { contentType: b.type, cacheControl: '31536000', upsert: true });
        if (error) throw error;
        try { const c = await caches.open('od-photos'); await c.put(publicUrl(e.path), new Response(blob, { headers: { 'Content-Type': b.type } })); } catch (_) { /* cache is optional */ }
      }
      await IDB.batch([{ store: 'outbox', key }, { store: 'blobs', key: e.path }]);
      S.outbox.delete(key);
    } else if (e.kind === 'photo-del') {
      const { error } = await sb.storage.from(CFG.bucket).remove([e.path]);
      if (error && !/not.?found/i.test(error.message || '')) throw error;
      await IDB.batch([{ store: 'outbox', key }]);
      S.outbox.delete(key);
    }
  }
}
async function pushRows() {
  const rows = [...S.outbox].filter(([, e]) => e.kind === 'row');
  for (const coll of COLLS) {
    const mine = rows.filter(([, e]) => e.coll === coll);
    for (let i = 0; i < mine.length; i += 300) {
      const chunk = mine.slice(i, i + 300);
      const recs = chunk.map(([, e]) => M[coll].get(e.id)).filter(Boolean);
      if (recs.length) {
        const { error } = await sb.from(coll).upsert(recs.map(MAP[coll].to));
        if (error) throw error;
      }
      const ops = [];
      for (const [key, e] of chunk) {
        const now = S.outbox.get(key);
        if (now && now.v === e.v) {
          ops.push({ store: 'outbox', key });
          S.outbox.delete(key);
          const r = M[coll].get(e.id);
          if (r && r.deleted) { ops.push({ store: coll, key: e.id }); M[coll].delete(e.id); }
        }
      }
      await IDB.batch(ops);
    }
  }
}
async function pull() {
  const changed = [];
  for (const coll of COLLS) {
    const sinceKey = 'since:' + coll;
    let since = (await IDB.get('meta', sinceKey)) || '';
    let from = since ? new Date(Date.parse(since) - 120000).toISOString() : '1970-01-01T00:00:00Z';
    for (;;) {
      const { data, error } = await sb.from(coll).select('*').gt('updated_at', from).order('updated_at', { ascending: true }).limit(1000);
      if (error) throw error;
      if (!data || !data.length) break;
      const ops = [];
      for (const row of data) {
        const r = MAP[coll].from(row);
        const pending = S.outbox.get(coll + ':' + r.id);
        if (pending) continue; // a local change is waiting; it wins and will be uploaded
        const cur = M[coll].get(r.id);
        if (r.deleted) {
          if (cur) { M[coll].delete(r.id); ops.push({ store: coll, key: r.id }); changed.push(coll); }
        } else if (!cur || JSON.stringify(stripV(cur)) !== JSON.stringify(r)) {
          M[coll].set(r.id, r); ops.push({ store: coll, key: r.id, val: r }); changed.push(coll);
        }
      }
      const last = data[data.length - 1].updated_at;
      if (!since || Date.parse(last) > Date.parse(since)) since = last;
      ops.push({ store: 'meta', key: sinceKey, val: since });
      await IDB.batch(ops);
      if (data.length < 1000) break;
      from = last;
    }
  }
  if (changed.length) { refreshArrays([...new Set(changed)]); scheduleRender(); }
}
function stripV(r) { const o = Object.assign({}, r); delete o._v; return o; }
function startRealtime() {
  stopRealtime();
  try {
    channel = sb.channel('od-' + S.uid);
    for (const t of COLLS) channel.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'owner=eq.' + S.uid }, () => Sync.soon(250));
    channel.subscribe();
  } catch (_) { channel = null; }
}
function stopRealtime() { if (channel && sb) { try { sb.removeChannel(channel); } catch (_) { /* ignore */ } } channel = null; }

/* ---------- sync indicator ---------- */
function syncChip() {
  const n = Sync.waiting();
  let cls = 'sync', txt;
  if (!S.signedIn) { cls += ' off'; txt = 'Not signed in'; }
  else if (Sync.state === 'syncing') { cls += ' busy'; txt = 'Syncing…'; }
  else if (Sync.state === 'offline') { cls += ' off'; txt = n ? `Offline · ${n} to upload` : 'Offline · all saved here'; }
  else if (Sync.state === 'error') { cls += ' err'; txt = 'Sync problem' + (n ? ` · ${n} waiting` : ''); }
  else if (n) { cls += ' busy'; txt = `${n} to upload`; }
  else txt = Sync.lastOk ? 'Synced ' + timeStr(Sync.lastOk) : 'Synced';
  return el('button', { class: cls, type: 'button', title: Sync.err || 'Tap to sync now', onclick: () => {
    if (Sync.state === 'error' && Sync.err) toast('Sync: ' + Sync.err, true);
    Sync.soon(0);
  } }, el('i'), txt);
}
function paintSync() {
  for (const n of document.querySelectorAll('.sync')) n.replaceWith(syncChip());
}

/* ---------- toast / modal ---------- */
let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = isErr ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2600);
}
function openModal(node) {
  const m = $('#modal');
  m.replaceChildren(node); m.hidden = false;
  const f = node.querySelector('input:not([type=file]),select,textarea,button'); if (f && window.matchMedia('(min-width:821px)').matches) f.focus();
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.replaceChildren(); }
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

async function write(promise, okMsg) {
  try { await promise; if (okMsg) toast(okMsg); return true; }
  catch (e) { toast((e && e.message) || 'Could not save on this device.', true); return false; }
}

/* ---------- derived data ---------- */
function custStats() {
  const m = new Map();
  for (const o of S.orders) {
    if (!o.customerId || o.status === 'cancelled') continue;
    const s = m.get(o.customerId) || { n: 0, spent: 0, last: 0, items: new Map() };
    s.n++; s.spent += o.total || 0; s.last = Math.max(s.last, o.createdAt || 0);
    for (const it of o.items || []) s.items.set(it.name, (s.items.get(it.name) || 0) + (it.qty || 0));
    m.set(o.customerId, s);
  }
  return m;
}
const nextNo = () => [...M.orders.values()].reduce((a, o) => Math.max(a, o.no || 0), 0) + 1;
const sortedMenu = () => S.menu.slice().sort((a, b) =>
  (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || ''));
const priceText = it => {
  const v = (it.variants || []).map(x => Number(x.price) || 0);
  if (!v.length) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  return lo === hi ? money(lo) : money(lo) + ' – ' + money(hi);
};
function placeholder(name) { return el('div', { class: 'ph', style: '--h:' + hue(name), 'aria-hidden': 'true', text: initial(name) }); }
function thumb(item, cls) {
  if (item.photo) {
    const im = el('img', { class: cls || 'img', src: photoUrl(item.photo), alt: '', loading: 'lazy', decoding: 'async' });
    im.addEventListener('error', () => im.replaceWith(placeholder(item.name)));
    return im;
  }
  return placeholder(item.name);
}

/* ---------- shell: nav, brand ---------- */
const ICONS = {
  orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  new: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  menu: '<path d="M4 5h16M4 12h16M4 19h10"/>',
  customers: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
};
const NAV = [['orders', 'Orders'], ['new', 'New order'], ['menu', 'Menu'], ['customers', 'Customers']];
function renderNav() {
  const open = S.orders.filter(o => OPEN.includes(o.status)).length;
  $('#brand').replaceChildren(S.settings.name || 'My kitchen', el('small', { text: 'Order desk' }));
  $('#nav').replaceChildren(...NAV.map(([k, label]) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.innerHTML = ICONS[k];
    return el('button', { type: 'button', 'aria-current': S.view === k ? 'page' : false, onclick: () => go(k) },
      svg, label, k === 'orders' && open ? el('span', { class: 'badge', text: open }) : null);
  }));
  $('#side-sync').replaceChildren(syncChip());
  document.title = (open ? `(${open}) ` : '') + 'Order Desk';
}
function go(v) { S.view = v; S.ordLimit = 60; render(true); window.scrollTo(0, 0); }
$('#gear-desk').addEventListener('click', () => settingsModal());

/* ---------- rendering ---------- */
let raf = 0;
function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(false); }); }
function render(viewChanged) {
  if (!S.ready) return;
  if (!S.uid) { showLogin(); return; }
  $('#app').hidden = false; $('#login').hidden = true;
  renderNav();
  const main = $('#main');
  if (S.view === 'new') {
    if (viewChanged || !N.root || !main.contains(N.root)) { main.replaceChildren(); banners(main); viewNew(main); }
    else refreshNew();
    return;
  }
  // while typing in a search box, refresh only the results so the keyboard stays open
  const act = document.activeElement;
  if (!viewChanged && P.fn && act && act.type === 'search' && main.contains(act)) { P.fn(); return; }
  P.fn = null;
  main.replaceChildren();
  banners(main);
  ({ orders: viewOrders, menu: viewMenu, customers: viewCustomers })[S.view](main);
}
const P = { fn: null };
function banners(root) {
  if (!S.signedIn) root.append(el('div', { class: 'banner err' }, el('span', { text: 'You are signed out, so changes stay on this device and are not uploaded.' }),
    el('button', { class: 'btn small', type: 'button', onclick: () => showLogin(true) }, 'Sign in')));
  if (S.updateReady) root.append(el('div', { class: 'banner' }, el('span', { text: 'A new version of Order Desk is ready.' }),
    el('button', { class: 'btn small primary', type: 'button', onclick: applyUpdate }, 'Update now')));
  if (showInstallHint()) root.append(el('div', { class: 'banner' }, el('span', { text: 'Install this app: tap the Share button, then "Add to Home Screen". It then opens full-screen and keeps your data safer.' }),
    el('button', { class: 'btn small', type: 'button', onclick: () => { try { localStorage.setItem('od-hint', '1'); } catch (_) { /* ignore */ } render(true); } }, 'Got it')));
  const days = backupAgeDays();
  if (S.orders.length >= 10 && days >= 7) root.append(el('div', { class: 'banner' }, el('span', { text: days === Infinity ? 'You have not saved a backup file yet.' : `Last backup file was ${days} days ago.` }),
    el('button', { class: 'btn small', type: 'button', onclick: saveBackup }, 'Back up now')));
}
function pageHead(title, sub, ...actions) {
  return el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: title }), sub ? el('div', { class: 'sub', text: sub }) : null),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, syncChip(), ...actions, el('button', { class: 'btn gear-m', type: 'button', onclick: () => settingsModal() }, 'Settings')));
}
function tile(label, value, hot) { return el('div', { class: 'tile' + (hot ? ' hot' : '') }, el('b', { text: value }), el('span', { text: label })); }

/* ---------- ORDERS ---------- */
function viewOrders(root) {
  root.append(pageHead('Orders', new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    el('button', { class: 'btn primary', type: 'button', onclick: () => go('new') }, '+ New order')));
  const t0 = startOfDay(Date.now());
  const today = S.orders.filter(o => o.createdAt >= t0 && o.status !== 'cancelled');
  const openN = S.orders.filter(o => OPEN.includes(o.status)).length;
  root.append(el('div', { class: 'tiles' }, tile('Open now', openN, openN > 0), tile("Today's orders", today.length),
    tile("Today's sales", money(today.reduce((a, o) => a + (o.total || 0), 0)))));
  const filters = [['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All']];
  root.append(el('div', { class: 'chips' }, filters.map(([k, label]) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': S.ordFilter === k, onclick: () => { S.ordFilter = k; S.ordLimit = 60; render(true); } },
      label + (k === 'open' ? ` (${openN})` : '')))));
  const list = S.orders.filter(o => S.ordFilter === 'all' || (S.ordFilter === 'open' ? OPEN.includes(o.status) : o.status === S.ordFilter));
  list.sort(S.ordFilter === 'open' ? (a, b) => a.createdAt - b.createdAt : (a, b) => b.createdAt - a.createdAt);
  if (!list.length) {
    root.append(el('div', { class: 'empty' }, el('b', { text: S.ordFilter === 'open' ? 'No open orders' : 'Nothing here yet' }),
      S.orders.length ? 'Orders you take will show up here as tickets.' : 'Tap "New order" to take your first one.'));
    return;
  }
  const shown = list.slice(0, S.ordLimit);
  root.append(el('div', { class: 'tickets' }, shown.map(ticket)));
  if (list.length > shown.length) root.append(el('p', {}, el('button', { class: 'btn', type: 'button', onclick: () => { S.ordLimit += 60; render(true); } }, `Show more (${list.length - shown.length})`)));
}
function confirmBtn(label, sure, fn, cls) {
  const b = el('button', { class: 'btn small ' + (cls || ''), type: 'button' }, label);
  let t;
  b.addEventListener('click', () => {
    if (b.dataset.armed) { clearTimeout(t); fn(); return; }
    b.dataset.armed = '1'; b.textContent = sure;
    t = setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 3500);
  });
  return b;
}
const setStatus = (o, status) => write(Store.patch('orders', o.id, { status }));
const orderNo = n => '#' + String(n || 0).padStart(3, '0');
function ticket(o) {
  const sameDay = startOfDay(o.createdAt) === startOfDay(Date.now());
  const items = (o.items || []).map(it => el('li', {},
    el('span', { text: `${it.qty}× ${it.name}${it.variant ? ' (' + it.variant + ')' : ''}` }),
    el('span', { text: money((it.price || 0) * (it.qty || 0)) })));
  if (o.fee) items.push(el('li', {}, el('span', { text: 'Delivery fee' }), el('span', { text: money(o.fee) })));
  const acts = [];
  if (NEXT[o.status]) {
    const label = o.status === 'new' ? 'Start cooking' : o.status === 'cooking' ? 'Mark ready' : (o.type === 'delivery' ? 'Mark delivered' : 'Mark picked up');
    acts.push(el('button', { class: 'btn small primary', type: 'button', onclick: () => setStatus(o, NEXT[o.status]) }, label));
    acts.push(confirmBtn('Cancel', 'Sure?', () => setStatus(o, 'cancelled'), 'danger'));
  } else {
    acts.push(el('button', { class: 'btn small', type: 'button', onclick: () => setStatus(o, 'new') }, 'Reopen'));
    if (o.status === 'cancelled') acts.push(confirmBtn('Delete', 'Delete for good?', () => write(Store.remove('orders', o.id), 'Order deleted'), 'danger'));
  }
  return el('article', { class: 'ticket t-' + o.status, 'data-id': o.id },
    el('div', { class: 't-head' },
      el('span', { class: 't-no', text: orderNo(o.no) }),
      el('span', { class: 't-time', text: timeStr(o.createdAt) + (sameDay ? '' : ' · ' + dateShort(o.createdAt)) }),
      el('span', { class: 'tag', text: o.type === 'delivery' ? 'Delivery' : 'Pickup' }),
      el('span', { class: 'pill ' + o.status, text: ST[o.status] || o.status })),
    el('div', { class: 't-body' },
      el('div', { class: 'who' }, o.customerName || 'Walk-in', o.phone ? el('small', { text: o.phone }) : null),
      o.address ? el('div', { class: 'addr', text: o.address }) : null,
      el('ul', { class: 'lines' }, items),
      o.note ? el('div', { class: 'note', text: o.note }) : null),
    el('div', { class: 't-foot' }, el('span', { class: 't-total', text: money(o.total) }), acts));
}

/* ---------- NEW ORDER ---------- */
const N = { root: null };
function viewNew(root) {
  const d = S.draft;
  const field = (id, label, key, attrs) => el('div', { class: 'field' }, el('label', { for: id, text: label }),
    el('input', Object.assign({ id, value: d[key], autocomplete: 'off', oninput: e => { d[key] = e.target.value; if (key !== 'address') { d.customerId = null; refreshCustomerBits(); } } }, attrs)));
  N.suggest = el('div'); N.known = el('div'); N.addrField = field('o-addr', 'Address', 'address');
  N.typeSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Order type' });
  N.grid = el('div', { class: 'grid' }); N.chips = el('div', { class: 'chips' });
  N.basket = el('div', { class: 'card basket' });
  N.search = el('input', { id: 'o-q', type: 'search', 'aria-label': 'Search the menu', placeholder: 'Search the menu', value: S.pickQ, oninput: e => { S.pickQ = e.target.value; refreshGrid(); } });
  N.root = el('div', {},
    pageHead('New order', 'Pick a customer, add items, save.'),
    el('div', { class: 'neworder' },
      el('div', { class: 'stack' },
        el('div', { class: 'card' }, el('h2', { text: 'Customer' }),
          el('div', { class: 'row' }, field('o-name', 'Name', 'name', { placeholder: 'Type a name to find a regular' }), field('o-phone', 'Phone', 'phone', { type: 'tel', inputmode: 'tel' })),
          N.suggest, N.known,
          el('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:10px' }, N.typeSeg, N.addrField)),
        el('div', { class: 'card' }, el('h2', { text: 'Menu' }),
          el('div', { class: 'field', style: 'margin-bottom:10px' }, N.search), N.chips, N.grid)),
      N.basket));
  root.append(N.root);
  refreshNew();
}
function refreshNew() { refreshCustomerBits(); refreshGrid(); refreshBasket(); renderNav(); }
function refreshCustomerBits() {
  const d = S.draft;
  N.typeSeg.replaceChildren(...[['delivery', 'Delivery'], ['pickup', 'Pickup']].map(([k, label]) =>
    el('button', { type: 'button', 'aria-pressed': d.type === k, onclick: () => { d.type = k; refreshCustomerBits(); refreshBasket(); } }, label)));
  N.addrField.hidden = d.type !== 'delivery';
  const known = d.customerId && S.customers.find(c => c.id === d.customerId);
  const st = known && custStats().get(known.id);
  N.known.replaceChildren(...(known ? [el('div', { class: 'known' },
    el('span', { text: 'Returning customer' + (st ? ` · ${st.n} order${st.n === 1 ? '' : 's'} · last ${ago(st.last)}` : '') }),
    el('button', { class: 'link', type: 'button', onclick: () => { d.customerId = null; refreshCustomerBits(); } }, 'Not them'))] : []));
  const nameQ = d.name.trim().toLowerCase(), phoneQ = d.phone.replace(/\s/g, '');
  let hits = [];
  if (!d.customerId && (nameQ.length >= 2 || phoneQ.length >= 3)) {
    hits = S.customers.filter(c => (nameQ.length >= 2 && (c.name || '').toLowerCase().includes(nameQ)) ||
      (phoneQ.length >= 3 && (c.phone || '').replace(/\s/g, '').includes(phoneQ))).slice(0, 5);
  }
  N.suggest.replaceChildren(...(hits.length ? [el('div', { class: 'suggest' }, hits.map(c =>
    el('button', { type: 'button', onclick: () => pickCustomer(c) }, el('span', { text: c.name }), el('span', { class: 'sub', text: c.phone || '' }))))] : []));
}
function pickCustomer(c) {
  Object.assign(S.draft, { customerId: c.id, name: c.name || '', phone: c.phone || '', address: c.address || '' });
  $('#o-name').value = S.draft.name; $('#o-phone').value = S.draft.phone; $('#o-addr').value = S.draft.address;
  refreshCustomerBits();
}
function menuCats(list) {
  return ['All', ...new Set(list.map(m => m.category || 'Other'))].sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));
}
function refreshGrid() {
  const cats = menuCats(S.menu);
  if (!cats.includes(S.pickCat)) S.pickCat = 'All';
  N.chips.replaceChildren(...cats.map(c => el('button', { class: 'chip', type: 'button', 'aria-pressed': S.pickCat === c, onclick: () => { S.pickCat = c; refreshGrid(); } }, c)));
  const q = S.pickQ.trim().toLowerCase();
  const items = sortedMenu().filter(m => (S.pickCat === 'All' || (m.category || 'Other') === S.pickCat) && (!q || (m.name || '').toLowerCase().includes(q)));
  if (!items.length) { N.grid.replaceChildren(el('div', { class: 'empty' }, el('b', { text: S.menu.length ? 'No match' : 'The menu is empty' }), S.menu.length ? 'Try another word or category.' : 'Add dishes in the Menu section first.')); return; }
  N.grid.replaceChildren(...items.map(m => el('button', { class: 'mi', type: 'button', disabled: m.available === false, onclick: () => addItem(m) },
    thumb(m), el('div', { class: 'info' }, el('b', { text: m.name }), el('span', { text: m.available === false ? 'Not available' : priceText(m) })))));
}
function addItem(m) {
  const vs = m.variants && m.variants.length ? m.variants : [{ label: '', price: 0 }];
  if (vs.length === 1) return addLine(m, vs[0]);
  openModal(el('div', { class: 'sheet' }, el('h2', { text: m.name }), el('div', { class: 'sub', text: 'Choose a size' }),
    el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, vs.map(v =>
      el('button', { class: 'btn', type: 'button', style: 'display:flex;justify-content:space-between', onclick: () => { addLine(m, v); closeModal(); } },
        el('span', { text: v.label || 'Regular' }), el('span', { text: money(v.price) })))),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'))));
}
function addLine(m, v) {
  const lines = S.draft.lines, label = v.label || '';
  const ex = lines.find(l => l.menuId === m.id && l.variant === label);
  if (ex) ex.qty++; else lines.push({ menuId: m.id, name: m.name, variant: label, price: Number(v.price) || 0, qty: 1 });
  refreshBasket();
}
function totals() {
  const d = S.draft, sub = d.lines.reduce((a, l) => a + l.price * l.qty, 0);
  const fee = d.type === 'delivery' && d.lines.length ? (Number(d.fee) || 0) : 0;
  return { sub, fee, total: sub + fee };
}
function refreshBasket() {
  const d = S.draft, t = totals();
  const lines = d.lines.map((l, i) => el('div', { class: 'bl' },
    el('div', { class: 'nm' }, l.name, l.variant ? el('small', { text: ' · ' + l.variant }) : null),
    el('div', { class: 'pr', text: money(l.price * l.qty) }),
    el('div', { class: 'qty' },
      el('button', { type: 'button', 'aria-label': 'One less', onclick: () => { l.qty--; if (l.qty <= 0) d.lines.splice(i, 1); refreshBasket(); } }, '−'),
      el('span', { text: l.qty }),
      el('button', { type: 'button', 'aria-label': 'One more', onclick: () => { l.qty++; refreshBasket(); } }, '+')),
    el('button', { class: 'link', type: 'button', style: 'justify-self:end', onclick: () => { d.lines.splice(i, 1); refreshBasket(); } }, 'Remove')));
  const feeInput = d.type === 'delivery' ? el('div', { class: 'field', style: 'margin-top:8px' }, el('label', { for: 'o-fee', text: 'Delivery fee' }),
    el('input', { id: 'o-fee', type: 'number', inputmode: 'decimal', min: '0', step: '0.5', value: d.fee, oninput: e => { d.fee = e.target.value; $('#b-total').textContent = money(totals().total); } })) : null;
  N.basket.replaceChildren(
    el('h2', { text: 'Order' }),
    ...(d.lines.length ? lines : [el('div', { class: 'empty', style: 'padding:18px 10px' }, 'Tap dishes in the menu to add them.')]),
    el('div', { class: 'sum' }, el('span', { text: 'Items' }), el('span', { text: money(t.sub) })),
    feeInput,
    el('div', { class: 'sum total' }, el('span', { text: 'Total' }), el('span', { id: 'b-total', text: money(t.total) })),
    el('div', { class: 'field', style: 'margin:10px 0' }, el('label', { for: 'o-note', text: 'Note for the kitchen' }),
      el('textarea', { id: 'o-note', value: d.note, placeholder: 'Less spicy, extra raita…', oninput: e => { d.note = e.target.value; } })),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
      el('button', { class: 'btn primary', id: 'b-save', type: 'button', disabled: !d.lines.length, onclick: saveOrder }, 'Save order'),
      el('button', { class: 'btn', type: 'button', onclick: () => { S.draft = newDraft(); $('#main').replaceChildren(); viewNew($('#main')); } }, 'Clear')));
}
async function saveOrder() {
  const d = S.draft;
  if (!d.lines.length) return;
  const btn = $('#b-save'); btn.disabled = true;
  const now = Date.now(), name = d.name.trim(), phone = d.phone.trim(), addr = d.type === 'delivery' ? d.address.trim() : '';
  let cid = d.customerId;
  if (!cid && (name || phone)) {
    const ph = phone.replace(/\s/g, '');
    const found = ph && S.customers.find(c => (c.phone || '').replace(/\s/g, '') === ph);
    if (found) cid = found.id;
    else {
      cid = newId();
      if (!await write(Store.put('customers', { id: cid, name: name || 'Customer', phone, address: d.address.trim(), notes: '', createdAt: now }))) { btn.disabled = false; return; }
    }
  } else if (cid) {
    const c = S.customers.find(x => x.id === cid);
    if (c && addr && c.address !== addr) await write(Store.patch('customers', cid, { address: addr }));
  }
  const t = totals(), no = nextNo();
  const order = {
    id: newId(), no, customerId: cid || null, customerName: name || 'Walk-in', phone, address: addr, type: d.type,
    items: d.lines.map(l => ({ menuId: l.menuId, name: l.name, variant: l.variant, price: l.price, qty: l.qty })),
    subtotal: t.sub, fee: t.fee, total: t.total, note: d.note.trim(), status: 'new', createdAt: now,
  };
  if (await write(Store.put('orders', order), `Order ${orderNo(no)} saved`)) {
    S.draft = newDraft(); S.ordFilter = 'open'; go('orders');
  } else btn.disabled = false;
}

/* ---------- MENU ---------- */
const SAMPLE_MENU = [
  ['Chicken Tikka Pizza', 'Pizza', 'Tikka chicken, onion, green chilli, mozzarella', [['Small', 45], ['Large', 75]]],
  ['Paneer Pizza', 'Pizza', 'Spiced paneer, peppers, mozzarella', [['Small', 42], ['Large', 70]]],
  ['Margherita', 'Pizza', 'Tomato, mozzarella, basil', [['Small', 35], ['Large', 60]]],
  ['Butter Chicken', 'Curries', 'With rice', [['', 48]]],
  ['Chicken Biryani', 'Rice', 'With raita', [['', 45]]],
  ['Seekh Kebab', 'Grill', '4 pieces', [['', 38]]],
  ['Garlic Naan', 'Breads', '', [['', 8]]],
  ['Mango Lassi', 'Drinks', '', [['', 15]]],
];
async function loadSamples() {
  for (const [name, category, description, vs] of SAMPLE_MENU) {
    await Store.put('menu', { id: newId(), name, category, description, variants: vs.map(([label, price]) => ({ label, price })), photo: '', available: true, example: true });
  }
  toast('Sample menu added');
}
function viewMenu(root) {
  root.append(pageHead('Menu', 'Dishes, sizes and prices. Tap Edit to change a photo.',
    el('button', { class: 'btn primary', type: 'button', onclick: () => menuModal(null) }, '+ Add dish')));
  const samples = S.menu.filter(m => m.example);
  if (samples.length) root.append(el('div', { class: 'banner' }, el('span', { text: `${samples.length} sample dishes are on the menu so you can try things out. Prices are made up. Edit them or remove them all.` }),
    confirmBtn('Remove all samples', 'Remove them?', async () => { for (const m of samples) await write(Store.remove('menu', m.id)); toast('Samples removed'); }, 'danger')));
  if (!S.menu.length) {
    root.append(el('div', { class: 'empty' }, el('b', { text: 'Your menu is empty' }), 'Add your first dish with "+ Add dish".',
      el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn', type: 'button', onclick: loadSamples }, 'Or load 8 sample dishes to try things out'))));
    return;
  }
  const cats = menuCats(S.menu);
  if (!cats.includes(S.menuCat)) S.menuCat = 'All';
  root.append(el('div', { class: 'field', style: 'margin-bottom:10px' }, el('input', { id: 'm-q', type: 'search', 'aria-label': 'Search dishes', placeholder: 'Search dishes', value: S.menuQ,
    oninput: e => { S.menuQ = e.target.value; P.fn(); } })));
  root.append(el('div', { class: 'chips' }, cats.map(c => el('button', { class: 'chip', type: 'button', 'aria-pressed': S.menuCat === c, onclick: () => { S.menuCat = c; render(true); } }, c))));
  const res = el('div');
  P.fn = () => { res.replaceChildren(); menuResults(res); renderNav(); };
  P.fn(); root.append(res);
}
function menuResults(root) {
  const q = S.menuQ.trim().toLowerCase();
  const items = sortedMenu().filter(m => (S.menuCat === 'All' || (m.category || 'Other') === S.menuCat) && (!q || (m.name || '').toLowerCase().includes(q)));
  const by = new Map();
  for (const m of items) { const c = m.category || 'Other'; if (!by.has(c)) by.set(c, []); by.get(c).push(m); }
  if (!items.length) root.append(el('div', { class: 'empty' }, el('b', { text: 'No dishes match' }), 'Try another word.'));
  for (const [c, arr] of by) {
    root.append(el('h2', { class: 'cat-title' }, c, el('span', { text: arr.length + (arr.length === 1 ? ' dish' : ' dishes') })));
    root.append(el('div', { class: 'mlist' }, arr.map(m => el('div', { class: 'mrow' + (m.available === false ? ' off' : '') },
      thumb(m, ''),
      el('div', {}, el('div', { class: 'nm', text: m.name }),
        el('div', { class: 'pr', text: (m.variants || []).map(v => (v.label ? v.label + ' ' : '') + money(v.price)).join(' · ') })),
      el('div', { class: 'ctl' },
        el('button', { class: 'btn small', type: 'button', onclick: () => menuModal(m) }, 'Edit'),
        el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: m.available !== false, 'aria-label': 'Available', onchange: e => write(Store.patch('menu', m.id, { available: e.target.checked })) }), 'Available'))))));
  }
}
async function shrinkPhoto(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) {
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('That file is not a picture this phone can read.')); im.src = URL.createObjectURL(file); });
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const k = Math.min(1, 800 / Math.max(w, h));
  const cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  const blob = (b => b)(await new Promise(r => cv.toBlob(r, 'image/webp', 0.8)));
  if (blob && blob.type === 'image/webp') return blob;
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.8)); // Safari cannot make WebP; JPEG instead
}
function menuModal(item) {
  const m = item ? clone(item) : { name: '', category: '', description: '', variants: [{ label: '', price: '' }], photo: '', available: true };
  if (!m.variants || !m.variants.length) m.variants = [{ label: '', price: '' }];
  const oldPhoto = m.photo || '';
  let newBlob = null, previewUrl = '';
  const vbox = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const photoBox = el('div', { class: 'photo-edit' });
  const status = el('div', { class: 'sub' });
  function drawVariants() {
    vbox.replaceChildren(...m.variants.map((v, i) => el('div', { class: 'vrow' },
      el('div', { class: 'field' }, i === 0 ? el('label', { text: 'Size (optional)' }) : null, el('input', { value: v.label, placeholder: 'e.g. Large', 'aria-label': 'Size name', oninput: e => { v.label = e.target.value; } })),
      el('div', { class: 'field' }, i === 0 ? el('label', { text: 'Price' }) : null, el('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.5', value: v.price, 'aria-label': 'Price', oninput: e => { v.price = e.target.value; } })),
      m.variants.length > 1 ? el('button', { class: 'btn small', type: 'button', onclick: () => { m.variants.splice(i, 1); drawVariants(); } }, 'Remove') : el('span'))));
  }
  function drawPhoto() {
    const src = newBlob ? previewUrl : (m.photo ? photoUrl(m.photo) : '');
    photoBox.replaceChildren(src ? el('img', { src, alt: '' }) : el('div', { class: 'ph', style: '--h:' + hue(m.name || 'x'), text: initial(m.name || '+') }),
      el('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        el('label', { class: 'btn small', style: 'text-align:center' }, src ? 'Change photo' : 'Add photo',
          el('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: onFile })),
        src ? el('button', { class: 'link', type: 'button', onclick: () => { newBlob = null; m.photo = ''; drawPhoto(); } }, 'Remove photo') : null));
  }
  async function onFile(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    status.textContent = 'Preparing photo…';
    try {
      newBlob = await shrinkPhoto(f);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(newBlob);
      status.textContent = `Photo ready (${Math.round(newBlob.size / 1024)} KB).`; drawPhoto();
    } catch (err) { status.textContent = ''; toast((err && err.message) || 'Could not read that photo.', true); }
  }
  const cats = [...new Set(S.menu.map(x => x.category).filter(Boolean))];
  const dl = el('datalist', { id: 'cats' }, cats.map(c => el('option', { value: c })));
  async function save() {
    const name = m.name.trim();
    const variants = m.variants.map(v => ({ label: (v.label || '').trim(), price: v.price === '' || v.price == null ? NaN : Number(v.price) })).filter(v => Number.isFinite(v.price));
    if (!name) return toast('Give the dish a name.', true);
    if (!variants.length) return toast('Add at least one price.', true);
    let photo = m.photo || '';
    if (newBlob) {
      photo = `${S.uid}/${newId()}.${newBlob.type === 'image/webp' ? 'webp' : 'jpg'}`;
      try { await queuePhoto(photo, newBlob); } catch (err) { return toast('Could not store the photo on this device.', true); }
    }
    const extra = oldPhoto && oldPhoto !== photo ? photoDelOp(oldPhoto) : [];
    const rec = { id: item ? item.id : newId(), name, category: (m.category || '').trim() || 'Other', description: (m.description || '').trim(), variants, photo, available: m.available !== false, example: false };
    if (await write(Store.put('menu', rec, extra), 'Saved')) closeModal();
  }
  drawVariants(); drawPhoto();
  const sheet = el('div', { class: 'sheet' }, el('h2', { text: item ? 'Edit dish' : 'Add dish' }),
    photoBox, status,
    el('div', { class: 'field' }, el('label', { for: 'f-name', text: 'Name' }), el('input', { id: 'f-name', value: m.name, oninput: e => { m.name = e.target.value; } })),
    el('div', { class: 'field' }, el('label', { for: 'f-cat', text: 'Category' }), el('input', { id: 'f-cat', list: 'cats', value: m.category, placeholder: 'Pizza, Curries, Breads, Drinks…', oninput: e => { m.category = e.target.value; } }), dl),
    el('div', { class: 'field' }, el('label', { for: 'f-desc', text: 'Description (optional)' }), el('textarea', { id: 'f-desc', value: m.description || '', oninput: e => { m.description = e.target.value; } })),
    el('div', {}, el('div', { class: 'sub', style: 'margin-bottom:6px', text: 'Prices. Add a row for each size (small, medium, large).' }), vbox,
      el('button', { class: 'link', type: 'button', style: 'margin-top:8px', onclick: () => { m.variants.push({ label: '', price: '' }); drawVariants(); } }, '+ Add another size')),
    el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: m.available !== false, onchange: e => { m.available = e.target.checked; } }), 'Available today'),
    el('div', { class: 'actions' },
      item ? confirmBtn('Delete dish', 'Delete for good?', async () => { if (await write(Store.remove('menu', item.id, photoDelOp(oldPhoto)), 'Dish deleted')) closeModal(); }, 'danger left') : null,
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', id: 'f-save', onclick: save }, 'Save dish')));
  openModal(sheet);
}

/* ---------- CUSTOMERS ---------- */
function viewCustomers(root) {
  root.append(pageHead('Customers', 'Everyone who has ordered, with what they like.',
    el('button', { class: 'btn primary', type: 'button', onclick: () => customerModal(null) }, '+ Add customer')));
  const stats = custStats();
  const regulars = S.customers.filter(c => (stats.get(c.id) || { n: 0 }).n >= 3).length;
  root.append(el('div', { class: 'tiles' }, tile('Customers', S.customers.length), tile('Regulars (3+ orders)', regulars),
    tile('Repeat rate', S.customers.length ? Math.round(100 * S.customers.filter(c => (stats.get(c.id) || { n: 0 }).n >= 2).length / S.customers.length) + '%' : '–')));
  root.append(el('div', { class: 'field', style: 'margin-bottom:12px' }, el('input', { id: 'c-q', type: 'search', 'aria-label': 'Search customers', placeholder: 'Search by name, phone or address', value: S.custQ,
    oninput: e => { S.custQ = e.target.value; P.fn(); } })));
  const res = el('div');
  P.fn = () => { res.replaceChildren(); customerResults(res); renderNav(); };
  P.fn(); root.append(res);
}
function customerResults(root) {
  const stats = custStats();
  const q = S.custQ.trim().toLowerCase();
  const list = S.customers.filter(c => !q || [c.name, c.phone, c.address].some(x => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => ((stats.get(b.id) || {}).last || 0) - ((stats.get(a.id) || {}).last || 0) || (a.name || '').localeCompare(b.name || ''));
  if (!list.length) { root.append(el('div', { class: 'empty' }, el('b', { text: S.customers.length ? 'No one matches' : 'No customers yet' }), S.customers.length ? 'Try another word.' : 'Customers are added automatically when you save an order with a name or phone number.')); return; }
  root.append(el('div', { class: 'clist' }, list.slice(0, 300).map(c => {
    const s = stats.get(c.id);
    return el('button', { class: 'crow', type: 'button', onclick: () => customerModal(c) },
      el('div', { class: 'avatar', style: '--h:' + hue(c.name), text: initial(c.name) }),
      el('div', {}, el('div', { class: 'nm', text: c.name }), el('div', { class: 'meta', text: [c.phone, c.address].filter(Boolean).join(' · ') })),
      el('div', { class: 'meta', style: 'text-align:right' }, s ? `${s.n} order${s.n === 1 ? '' : 's'} · ${money(s.spent)}` : 'No orders', el('br'), s ? 'last ' + ago(s.last) : ''));
  })));
}
function customerModal(c) {
  const m = c ? clone(c) : { name: '', phone: '', address: '', notes: '' };
  const s = c && custStats().get(c.id);
  const favs = s ? [...s.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) : [];
  const hist = c ? S.orders.filter(o => o.customerId === c.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 8) : [];
  const field = (id, label, key, tag, attrs) => el('div', { class: 'field' }, el('label', { for: id, text: label }),
    el(tag || 'input', Object.assign({ id, value: m[key] || '', oninput: e => { m[key] = e.target.value; } }, attrs)));
  async function save() {
    if (!(m.name || '').trim() && !(m.phone || '').trim()) return toast('Add a name or phone number.', true);
    const rec = { id: c ? c.id : newId(), name: (m.name || '').trim() || 'Customer', phone: (m.phone || '').trim(), address: (m.address || '').trim(), notes: (m.notes || '').trim(), createdAt: c ? (c.createdAt || Date.now()) : Date.now() };
    if (await write(Store.put('customers', rec), 'Saved')) closeModal();
  }
  openModal(el('div', { class: 'sheet' }, el('h2', { text: c ? c.name : 'Add customer' }),
    s ? el('div', { class: 'tiles', style: 'margin:0' }, tile('Orders', s.n), tile('Spent', money(s.spent)), tile('Last order', ago(s.last))) : null,
    favs.length ? el('div', {}, el('div', { class: 'sub', style: 'margin-bottom:6px', text: 'Usually orders' }), el('div', { class: 'favs' }, favs.map(([n, q]) => el('span', { class: 'tag', text: `${n} ×${q}` })))) : null,
    el('div', { class: 'row' }, field('k-name', 'Name', 'name'), field('k-phone', 'Phone', 'phone', null, { type: 'tel', inputmode: 'tel' })),
    field('k-addr', 'Address', 'address'), field('k-notes', 'Notes (allergies, gate code…)', 'notes', 'textarea'),
    hist.length ? el('div', {}, el('div', { class: 'sub', style: 'margin-bottom:6px', text: 'Recent orders' }),
      el('div', { class: 'hist' }, hist.map(o => el('div', {}, el('span', { text: `${orderNo(o.no)} · ${dateShort(o.createdAt)} · ${(o.items || []).map(i => i.qty + '× ' + i.name).join(', ')}` }), el('span', { text: o.status === 'cancelled' ? 'cancelled' : money(o.total) }))))) : null,
    el('div', { class: 'actions' },
      c ? confirmBtn('Delete', 'Delete customer?', async () => { if (await write(Store.remove('customers', c.id), 'Customer deleted')) closeModal(); }, 'danger left') : null,
      c && hist.some(o => o.status !== 'cancelled') ? el('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); repeatLast(c); } }, 'Repeat last order') : null,
      c ? el('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); S.draft = newDraft(); Object.assign(S.draft, { customerId: c.id, name: c.name, phone: c.phone || '', address: c.address || '' }); go('new'); } }, 'New order') : null,
      el('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save'))));
}
function repeatLast(c) {
  const last = S.orders.filter(o => o.customerId === c.id && o.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!last) return toast('No earlier order to repeat.', true);
  S.draft = newDraft();
  Object.assign(S.draft, { customerId: c.id, name: c.name, phone: c.phone || '', address: c.address || '', type: last.type || 'delivery' });
  let skipped = 0;
  for (const it of last.items || []) {
    const m = S.menu.find(x => x.id === it.menuId);
    const v = m && (m.variants || []).find(x => (x.label || '') === (it.variant || ''));
    if (!m || !v || m.available === false) { skipped++; continue; }
    S.draft.lines.push({ menuId: m.id, name: m.name, variant: v.label || '', price: Number(v.price) || 0, qty: it.qty });
  }
  go('new');
  toast(skipped ? `Repeated with ${skipped} item${skipped === 1 ? '' : 's'} no longer on the menu left out.` : 'Last order copied. Check it and save.');
}

/* ---------- files: save / share ---------- */
async function deliverFile(name, blob) {
  const file = new File([blob], name, { type: blob.type });
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return false; /* fall through to download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
function pickFile(accept) {
  return new Promise(res => {
    const inp = el('input', { type: 'file', accept, style: 'display:none' });
    inp.addEventListener('change', () => { res(inp.files && inp.files[0]); inp.remove(); });
    document.body.append(inp); inp.click();
  });
}

/* ---------- Excel (.xlsx) writer, no library ---------- */
const XLSX = (() => {
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder();
  function zip(files) { // stored (no compression) zip
    const parts = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    const csize = central.reduce((a, p) => a + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const col = i => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  // cell kinds: number, string, {date: ms}, {time: ms}
  const serial = ms => { const d = new Date(ms); return (ms - d.getTimezoneOffset() * 60000) / 86400000 + 25569; };
  function sheetXml(rows, widths) {
    const out = rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => {
      const ref = col(ci) + (ri + 1);
      if (v == null || v === '') return '';
      if (ri === 0) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${esc(v)}</t></is></c>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      if (v && v.date != null) return `<c r="${ref}" s="2"><v>${serial(v.date)}</v></c>`;
      if (v && v.time != null) return `<c r="${ref}" s="3"><v>${serial(v.time) % 1}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const cols = widths ? '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      cols + '<sheetData>' + out + '</sheetData></worksheet>';
  }
  function build(sheets) { // [{name, rows, widths}]
    const files = [
      { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
      { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows, s.widths) })),
    ];
    return zip(files);
  }
  return { build };
})();
function excelBlob() {
  const orders = S.orders.slice().sort((a, b) => (a.no || 0) - (b.no || 0) || a.createdAt - b.createdAt);
  const st = custStats();
  return XLSX.build([
    { name: 'Orders', widths: [7, 11, 7, 11, 9, 20, 15, 28, 45, 11, 11, 10, 25],
      rows: [['No', 'Date', 'Time', 'Status', 'Type', 'Customer', 'Phone', 'Address', 'Items', 'Items total', 'Delivery fee', 'Total', 'Note'],
        ...orders.map(o => [o.no, { date: o.createdAt }, { time: o.createdAt }, ST[o.status] || o.status, o.type === 'delivery' ? 'Delivery' : 'Pickup', o.customerName, o.phone, o.address,
          (o.items || []).map(i => `${i.qty}x ${i.name}${i.variant ? ' (' + i.variant + ')' : ''}`).join('; '), num(o.subtotal), num(o.fee), num(o.total), o.note])] },
    { name: 'Order lines', widths: [7, 11, 11, 24, 10, 6, 9, 10],
      rows: [['Order no', 'Date', 'Status', 'Item', 'Size', 'Qty', 'Price', 'Line total'],
        ...orders.flatMap(o => (o.items || []).map(i => [o.no, { date: o.createdAt }, ST[o.status] || o.status, i.name, i.variant || '', num(i.qty), num(i.price), num(i.qty) * num(i.price)]))] },
    { name: 'Customers', widths: [20, 15, 30, 25, 8, 10, 11],
      rows: [['Name', 'Phone', 'Address', 'Notes', 'Orders', 'Spent', 'Last order'],
        ...S.customers.map(c => { const x = st.get(c.id); return [c.name, c.phone, c.address, c.notes, x ? x.n : 0, x ? x.spent : 0, x ? { date: x.last } : '']; })] },
    { name: 'Menu', widths: [14, 26, 10, 8, 10, 30],
      rows: [['Category', 'Dish', 'Size', 'Price', 'Available', 'Description'],
        ...sortedMenu().flatMap(m => (m.variants || []).map(v => [m.category, m.name, v.label || '', num(v.price), m.available === false ? 'No' : 'Yes', m.description || '']))] },
  ]);
}
async function exportExcel() {
  try { if (await deliverFile(`orderdesk-${isoDay(Date.now())}.xlsx`, excelBlob())) toast('Excel file ready'); }
  catch (e) { toast('Could not make the Excel file: ' + ((e && e.message) || e), true); }
}

/* ---------- backup / restore (one JSON file with everything) ---------- */
function backupAgeDays() {
  let t = 0; try { t = Number(localStorage.getItem('od-backup-at')) || 0; } catch (_) { /* ignore */ }
  return t ? Math.floor((Date.now() - t) / DAY) : Infinity;
}
const b64 = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(s), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; };
async function photoBytes(path) {
  const local = await IDB.get('blobs', path);
  if (local) return { type: local.type, data: local.data };
  try {
    const c = await caches.open('od-photos');
    let r = await c.match(publicUrl(path));
    if (!r) r = await fetch(publicUrl(path));
    if (r && r.ok) { const bl = await r.blob(); return { type: bl.type || 'image/jpeg', data: await bl.arrayBuffer() }; }
  } catch (_) { /* offline and not cached */ }
  return null;
}
async function saveBackup() {
  toast('Preparing backup…');
  try {
    const strip = arr => arr.map(stripV);
    const photos = {};
    let missing = 0;
    for (const m of S.menu) if (m.photo && !photos[m.photo]) {
      const p = await photoBytes(m.photo);
      if (p) photos[m.photo] = { type: p.type, data: b64(p.data) }; else missing++;
    }
    const data = { app: 'orderdesk', version: 1, exportedAt: new Date().toISOString(),
      settings: stripV(S.settings), menu: strip(S.menu), customers: strip(S.customers), orders: strip(S.orders), photos };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    if (await deliverFile(`orderdesk-backup-${isoDay(Date.now())}.json`, blob)) {
      try { localStorage.setItem('od-backup-at', String(Date.now())); } catch (_) { /* ignore */ }
      toast(missing ? `Backup saved. ${missing} photo${missing === 1 ? ' was' : 's were'} not on this device and were left out.` : 'Backup saved');
      render(true);
    }
  } catch (e) { toast('Backup failed: ' + ((e && e.message) || e), true); }
}
async function restoreBackup() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (_) { return toast('That file is not an Order Desk backup.', true); }
  if (!data || data.app !== 'orderdesk') return toast('That file is not an Order Desk backup.', true);
  const n = k => (Array.isArray(data[k]) ? data[k].length : 0);
  openModal(el('div', { class: 'sheet' }, el('h2', { text: 'Restore backup?' }),
    el('p', { text: `From ${new Date(data.exportedAt).toLocaleString()}: ${n('orders')} orders, ${n('customers')} customers, ${n('menu')} dishes.` }),
    el('p', { class: 'sub', text: 'Records in the file are added back, and replace the same records here. Nothing else is deleted. Restored records are then uploaded.' }),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', onclick: async () => { closeModal(); await doRestore(data); } }, 'Restore'))));
}
async function doRestore(data) {
  try {
    const remap = new Map();
    for (const [path, p] of Object.entries(data.photos || {})) {
      const base = path.split('/').pop();
      const np = `${S.uid}/${base}`;
      remap.set(path, np);
      const bytes = unb64(p.data);
      await queuePhoto(np, new Blob([bytes], { type: p.type }));
    }
    let count = 0;
    for (const coll of ['menu', 'customers', 'orders']) {
      for (const r of data[coll] || []) {
        if (!r || !r.id) continue;
        const rec = Object.assign({}, r); delete rec._v;
        if (coll === 'menu' && rec.photo) rec.photo = remap.get(rec.photo) || (rec.photo.startsWith(S.uid + '/') ? rec.photo : '');
        await Store.put(coll, rec); count++;
      }
    }
    if (data.settings) await Store.put('settings', Object.assign(clone(DEFAULT_SETTINGS), data.settings, { id: 'main' }));
    toast(`Restored ${count} records`); render(true);
  } catch (e) { toast('Restore failed: ' + ((e && e.message) || e), true); }
}

/* ---------- settings ---------- */
function settingsModal() {
  const s = clone(S.settings);
  const f = (id, label, key, attrs) => el('div', { class: 'field' }, el('label', { for: id, text: label }), el('input', Object.assign({ id, value: s[key], oninput: e => { s[key] = e.target.value; } }, attrs)));
  const n = Sync.waiting();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: 'Settings' }),
    f('s-name', 'Business name', 'name'),
    el('div', { class: 'row' }, f('s-cur', 'Currency symbol', 'currency', { maxlength: '4' }), f('s-fee', 'Default delivery fee', 'deliveryFee', { type: 'number', inputmode: 'decimal', min: '0', step: '0.5' })),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'),
      el('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const rec = { id: 'main', name: (s.name || '').trim() || 'My kitchen', currency: s.currency || '', deliveryFee: Number(s.deliveryFee) || 0 };
        if (await write(Store.put('settings', rec), 'Settings saved')) closeModal();
      } }, 'Save settings')),
    el('div', { class: 'sect' }, el('h3', { text: 'Your data' }),
      el('div', { class: 'sub', text: backupAgeDays() === Infinity ? 'No backup file saved from this device yet.' : `Last backup file: ${backupAgeDays() === 0 ? 'today' : backupAgeDays() + ' days ago'}.` }),
      el('div', { class: 'btns' },
        el('button', { class: 'btn', type: 'button', onclick: exportExcel }, 'Export to Excel'),
        el('button', { class: 'btn', type: 'button', onclick: saveBackup }, 'Back up (JSON)'),
        el('button', { class: 'btn', type: 'button', onclick: restoreBackup }, 'Restore backup'))),
    el('div', { class: 'sect' }, el('h3', { text: 'Sync' }),
      el('div', { class: 'sub', text: (S.signedIn ? 'Signed in as ' + (S.email || 'you') + '. ' : 'Signed out. ') + (n ? `${n} change${n === 1 ? '' : 's'} waiting to upload.` : 'Everything on this device is uploaded.') + (Sync.err ? ' Last problem: ' + Sync.err : '') }),
      el('div', { class: 'btns' },
        S.signedIn ? el('button', { class: 'btn', type: 'button', onclick: () => { Sync.soon(0); toast('Syncing…'); } }, 'Sync now') : el('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); showLogin(true); } }, 'Sign in'),
        S.signedIn ? confirmBtn(n ? `Sign out (${n} not uploaded!)` : 'Sign out', n ? 'Sign out and lose them?' : 'Sign out and clear this device?', signOut, 'danger') : null),
      el('div', { class: 'sub', text: `Order Desk ${VERSION}` }))));
}

/* ---------- sign in / out ---------- */
function showLogin(force) {
  if (S.uid && !force) return;
  const box = $('#login');
  if (!box.hidden && box.firstChild) return; // already showing; don't wipe what is being typed
  $('#app').hidden = !S.uid;
  const err = el('div', { class: 'err', role: 'alert' });
  const email = el('input', { id: 'l-email', type: 'email', autocomplete: 'username', inputmode: 'email', value: S.email || '' });
  const pass = el('input', { id: 'l-pass', type: 'password', autocomplete: 'current-password' });
  const btn = el('button', { class: 'btn primary', type: 'submit', id: 'l-go' }, 'Sign in');
  const form = el('form', { class: 'card', onsubmit: async e => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      if (!sb) throw new Error('Could not load the sign-in system. Check your connection and reload.');
      const { data, error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (error) throw error;
      await onSession(data.session);
      box.hidden = true; $('#app').hidden = false; render(true);
    } catch (ex) {
      const m = (ex && ex.message) || String(ex);
      err.textContent = /invalid login/i.test(m) ? 'Wrong email or password.' : /fetch|network|load failed/i.test(m) ? 'No connection to the server. Check the internet or VPN and try again.' : m;
    } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  } },
    el('h1', { text: 'Order Desk' }),
    el('div', { class: 'sub', text: 'Sign in with the account you created in Supabase.' }),
    el('div', { class: 'field' }, el('label', { for: 'l-email', text: 'Email' }), email),
    el('div', { class: 'field' }, el('label', { for: 'l-pass', text: 'Password' }), pass),
    err, btn,
    S.uid ? el('button', { class: 'link', type: 'button', onclick: () => { box.hidden = true; $('#app').hidden = false; render(true); } }, 'Back to the app') : null);
  box.replaceChildren(form); box.hidden = false;
  if (S.uid) $('#app').hidden = true;
}
async function onSession(session) {
  if (!session) { S.signedIn = false; stopRealtime(); paintSync(); return; }
  const uid = session.user.id;
  if (S.uid && S.uid !== uid) { // a different account: start clean
    await IDB.clearAll(); for (const c of COLLS) M[c].clear(); S.outbox.clear(); refreshArrays();
  }
  S.uid = uid; S.email = session.user.email || ''; S.signedIn = true;
  await IDB.batch([{ store: 'meta', key: 'uid', val: uid }, { store: 'meta', key: 'email', val: S.email }]);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* ignore */ }
  startRealtime(); Sync.soon(0);
}
async function signOut() {
  closeModal();
  stopRealtime();
  try { if (sb) await sb.auth.signOut({ scope: 'local' }); } catch (_) { /* ignore */ }
  await IDB.clearAll();
  try { await caches.delete('od-photos'); } catch (_) { /* ignore */ }
  for (const c of COLLS) M[c].clear();
  S.outbox.clear(); S.uid = null; S.signedIn = false; refreshArrays();
  showLogin(true);
}

/* ---------- install hint, updates ---------- */
function isStandalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
function showInstallHint() {
  if (isStandalone()) return false;
  if (!/iPhone|iPad|iPod/i.test(navigator.userAgent)) return false;
  try { return !localStorage.getItem('od-hint'); } catch (_) { return true; }
}
let waitingSW = null;
let updating = false;
function applyUpdate() { updating = true; if (waitingSW) waitingSW.postMessage('skip-waiting'); else location.reload(); }
function setupSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const watch = w => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) { waitingSW = w; S.updateReady = true; render(true); }
    });
    if (reg.waiting && navigator.serviceWorker.controller) { waitingSW = reg.waiting; S.updateReady = true; }
    reg.addEventListener('updatefound', () => watch(reg.installing));
    setInterval(() => reg.update().catch(() => {}), 3600000);
  }).catch(() => { /* offline install not possible here */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating && !reloading) { reloading = true; location.reload(); } });
}

/* ---------- boot ---------- */
async function loadLocal() {
  const [uid, email, ...rest] = await Promise.all([IDB.get('meta', 'uid'), IDB.get('meta', 'email'), ...COLLS.map(c => IDB.all(c)), IDB.all('outbox'), IDB.all('blobs')]);
  COLLS.forEach((c, i) => { M[c].clear(); for (const [k, v] of rest[i]) M[c].set(k, v); });
  S.outbox = new Map(rest[COLLS.length]);
  for (const [path, b] of rest[COLLS.length + 1]) S.blobUrls.set(path, URL.createObjectURL(new Blob([b.data], { type: b.type })));
  for (const e of S.outbox.values()) stamp = Math.max(stamp, e.v || 0);
  S.uid = uid || null; S.email = email || '';
  refreshArrays();
  S.draft = newDraft();
}
function hasStoredAuth() { try { return !!localStorage.getItem('od-auth'); } catch (_) { return false; } }
async function boot() {
  try { await loadLocal(); }
  catch (e) { $('#main').replaceChildren(el('div', { class: 'banner err' }, el('span', { text: 'This browser would not open the local database: ' + ((e && e.message) || e) }))); return; }
  S.ready = true;
  render(true);
  setupSW();
  try {
    sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'od-auth' } });
  } catch (e) { sb = null; }
  if (!sb) { if (!S.uid) showLogin(); return; }
  sb.auth.onAuthStateChange((event, session) => {
    // never await Supabase calls inside this callback; hand off with setTimeout
    if (event === 'SIGNED_OUT') { if (S.signedIn) { S.signedIn = false; stopRealtime(); setTimeout(() => render(false)); } }
    else if (session && S.uid === session.user.id && (!S.signedIn || !channel) && event !== 'INITIAL_SESSION') setTimeout(() => onSession(session).then(() => render(false)));
  });
  let session = null;
  try { const r = await sb.auth.getSession(); session = r && r.data && r.data.session; } catch (_) { session = null; }
  if (session) await onSession(session);
  else if (!S.uid) { showLogin(); }
  else if (hasStoredAuth()) { S.signedIn = true; Sync.set('offline'); } // could not refresh the login yet (no internet); keep working
  else S.signedIn = false;
  render(false);
  window.addEventListener('online', () => Sync.soon(0));
  window.addEventListener('offline', () => Sync.set('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.soon(100); });
  setInterval(() => { if (document.visibilityState === 'visible') Sync.soon(0); }, 60000);
}
boot();
