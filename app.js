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
const VERSION = '2.15.1';
const COLLS = ['menu', 'customers', 'orders', 'settings', 'purchases'];
const DEFAULT_SETTINGS = { id: 'main', name: 'My kitchen', currency: '¥', deliveryFee: 0, addresses: [], wechatQr: '', alipayQr: '', wechatId: '', alipayId: '', pickup: true, inventory: {}, logo: '' };

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
const tsMs = s => (s ? toMs(s) : 0);

/* ---------- local database (IndexedDB) ---------- */
const IDB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('orderdesk', 2);
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

/* ---------- modern pickers: every <select> becomes a button that opens a bottom sheet ---------- */
const Picker = (() => {
  function labelOf(sel) {
    if (sel.getAttribute('aria-label')) return sel.getAttribute('aria-label');
    const l = sel.id && document.querySelector(`label[for="${sel.id}"]`);
    if (l) return l.textContent;
    const f = sel.closest('.field'); const fl = f && f.querySelector('label');
    return fl ? fl.textContent : 'Choose';
  }
  function sync(sel, btn) {
    const o = sel.options[sel.selectedIndex];
    const empty = !o || o.value === '';
    btn.querySelector('.pk-val').textContent = o ? o.textContent : '';
    btn.classList.toggle('empty', empty);
    btn.disabled = sel.disabled;
  }
  function open(sel, btn) {
    const ov = document.createElement('div'); ov.className = 'pk-ov'; ov.id = 'picker';
    const close = () => { ov.remove(); btn.focus(); };
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    const sheet = document.createElement('div'); sheet.className = 'pk-sheet'; sheet.setAttribute('role', 'listbox');
    const h = document.createElement('div'); h.className = 'pk-h'; h.textContent = labelOf(sel); sheet.append(h);
    const list = document.createElement('div'); list.className = 'pk-list';
    [...sel.options].forEach(o => {
      if (o.value === '') return; // placeholder rows like "Choose…" stay as the button text only
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pk-opt' + (o.selected && o.value !== '' ? ' on' : '');
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(o.selected)); b.dataset.value = o.value; b.disabled = o.disabled;
      const t = document.createElement('span'); t.textContent = o.textContent; b.append(t);
      const ck = document.createElement('i'); ck.textContent = '✓'; b.append(ck);
      b.addEventListener('click', () => { sel.value = o.value; sync(sel, btn); close(); sel.dispatchEvent(new Event('change', { bubbles: true })); });
      list.append(b);
    });
    sheet.append(list);
    const c = document.createElement('button'); c.type = 'button'; c.className = 'pk-cancel'; c.textContent = 'Cancel'; c.addEventListener('click', close); sheet.append(c);
    ov.append(sheet); document.body.append(ov);
    const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'center' });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); document.removeEventListener('keydown', esc, true); } }, true);
  }
  function enhance(sel) {
    if (sel.dataset.pk) return; sel.dataset.pk = '1';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'pk-btn';
    if (sel.id) btn.id = sel.id + '-pk';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-label', labelOf(sel));
    const v = document.createElement('span'); v.className = 'pk-val'; btn.append(v);
    const ch = document.createElement('i'); ch.className = 'pk-ch'; ch.setAttribute('aria-hidden', 'true'); btn.append(ch);
    sel.classList.add('pk-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    sel.after(btn); sync(sel, btn);
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); open(sel, btn); });
    sel.addEventListener('change', () => sync(sel, btn));
  }
  const scan = root => { if (root.tagName === 'SELECT') enhance(root); else if (root.querySelectorAll) root.querySelectorAll('select').forEach(enhance); };
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => scan(document.body));
  if (document.body) scan(document.body);
  return { scan, enhance };
})();

/* ---------- sounds (made in the browser, no files) ---------- */
const Sound = (() => {
  let ctx = null;
  const KEY = 'od-sound';
  const on = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch (_) { return true; } };
  const set = v => { try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch (_) { /* fine */ } };
  function unlock() { // phones only allow sound after the first tap
    try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch (_) { ctx = null; }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlock, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (_) { /* needs a tap */ } } });
  function tone(freq, start, dur, type = 'sine', vol = 0.6) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.05);
  }
  const TUNES = {
    order: [[659, 0, .18], [880, .16, .18], [1047, .32, .35]],          // new order: rising three notes
    paid: [[1319, 0, .12, 'triangle'], [1760, .1, .4, 'triangle']],     // payment: bright "ding-ding"
    placed: [[784, 0, .15], [1047, .14, .3]],
    accepted: [[523, 0, .15], [659, .14, .15], [784, .28, .3]],
    otw: [[880, 0, .12], [880, .18, .12], [1175, .36, .3]],
    done: [[784, 0, .15], [988, .14, .15], [1175, .28, .15], [1568, .42, .4]],
    msg: [[1047, 0, .12, 'triangle'], [1319, .1, .2, 'triangle']],
  };
  function play(name) {
    if (!on()) return;
    try { if (navigator.vibrate) navigator.vibrate(name === 'order' || name === 'paid' ? [120, 60, 120] : 80); } catch (_) { /* fine */ }
    try { unlock(); if (!ctx) return; for (const [f, s, d, t] of TUNES[name] || TUNES.msg) tone(f, s, d, t); } catch (_) { /* no sound */ }
  }
  return { play, on, set };
})();

/* ---------- app state ---------- */
const ST = { new: 'Received', cooking: 'Received', accepted: 'Accepted', ready: 'On the way / Ready', done: 'Delivered', cancelled: 'Cancelled' };
const PAY = { wechat: 'WeChat Pay', alipay: 'Alipay', wechat_chat: 'WeChat chat', alipay_chat: 'Alipay chat' };
const payBase = m => String(m || '').replace('_chat', '');
/* the WeChat Pay / Alipay logo; a coloured dot if the picture can't load */
function payLogo(m) {
  const b = payBase(m);
  if (b !== 'wechat' && b !== 'alipay') return null;
  return el('img', { class: 'paylogo', src: `pay-${b}.png`, alt: b === 'wechat' ? 'WeChat Pay' : 'Alipay', onerror: e => e.target.replaceWith(el('span', { class: 'paylogo fb ' + b })) });
}
const isCancelled = o => o.status === 'cancelled';
const isRefunded = o => !!o.refunded;
const isUnpaid = o => !isCancelled(o) && !isRefunded(o) && !o.paid;
const isOpenOrder = o => !isCancelled(o) && !isRefunded(o) && !(o.paid && o.status === 'done'); // not yet both paid and delivered
const M = { menu: new Map(), customers: new Map(), orders: new Map(), settings: new Map(), purchases: new Map() };
const S = {
  ready: false, uid: null, email: '', signedIn: false,
  menu: [], customers: [], orders: [], purchases: [], settings: clone(DEFAULT_SETTINGS),
  loaded: { menu: true, customers: true, orders: true, config: true },
  view: 'orders', statMode: 'days', statPick: null, ordFilter: 'open', ordLimit: 60, ordFrom: '', ordTo: '', ordAll: false, calOpen: false, calMonth: '', calAnchor: '', svcSet: false, menuQ: '', menuCat: 'All', custQ: '', pickQ: '', pickCat: 'All',
  draft: null, blobUrls: new Map(), outbox: new Map(), svc: 'all', msgs: [], msgsOff: false, reviews: [], reviewsOff: false,
};
function refreshArrays(colls) {
  for (const c of colls || COLLS) {
    if (c === 'settings') { S.settings = Object.assign(clone(DEFAULT_SETTINGS), M.settings.get('main') || {}); continue; }
    S[c] = [...M[c].values()].filter(r => !r.deleted);
  }
}
const money = n => {
  n = Number(n) || 0;
  const a = Math.abs(n);
  return (n < 0 ? '−' : '') + (S.settings.currency || '') + (Number.isInteger(a) ? a : a.toFixed(2));
};
const newDraft = () => ({ customerId: null, name: '', phone: '', address: '', type: 'delivery', note: '', lines: [], editId: null });
const addrList = () => (Array.isArray(S.settings.addresses) ? S.settings.addresses : []);
const addrFee = (name, pizza) => { const a = addrList().find(x => x.name === name); if (!a) return null; return pizza && a.feePizza !== '' && a.feePizza != null ? num(a.feePizza) : num(a.fee); };
const draftPizza = () => S.draft.lines.some(l => (M.menu.get(l.menuId) || {}).kitchen === 'pizza');
const feeText = f => (f ? money(f) : 'Free');
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
const bucketFor = path => (/\/(receipt|delivered|refund)-/.test(path) ? 'receipts' : CFG.bucket); // private: payment screenshots, delivery photos
async function receiptSrc(path) { // private: fetched with your login, kept in memory
  if (!path) return '';
  if (S.blobUrls.has(path)) return S.blobUrls.get(path);
  try {
    const { data, error } = await sb.storage.from('receipts').download(path);
    if (error || !data) return '';
    const u = URL.createObjectURL(data); S.blobUrls.set(path, u); return u;
  } catch (_) { return ''; }
}
const publicUrl = path => CFG.url + '/storage/v1/object/public/' + CFG.bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
const photoUrl = path => S.blobUrls.get(path) || publicUrl(path);

/* ---------- server row <-> app record ---------- */
const num = v => Number(v) || 0;
const MAP = {
  menu: {
    to: r => Object.assign({ id: r.id, name: r.name || '', category: r.category || 'Other', description: r.description || '', variants: r.variants || [], photo: r.photo || '', available: r.available !== false, example: !!r.example, deleted: !!r.deleted },
      r.winTouched ? { windows: r.windows || [] } : {},
      r.svcTouched ? { service: r.service === 'night' ? 'night' : 'day' } : {},
      r.ingTouched ? { ingredients: r.ingredients || [] } : {},
      r.kitTouched ? { kitchen: r.kitchen === 'pizza' ? 'pizza' : 'other' } : {},
      r.sortTouched ? { sort: r.sort == null ? null : r.sort } : {}),
    from: x => ({ id: x.id, name: x.name, category: x.category, description: x.description, variants: x.variants || [], photo: x.photo || '', available: x.available !== false, example: !!x.example, deleted: !!x.deleted,
      windows: Array.isArray(x.windows) ? x.windows : [], winTouched: x.windows !== undefined, service: x.service === 'night' ? 'night' : 'day', svcTouched: x.service !== undefined,
      ingredients: Array.isArray(x.ingredients) ? x.ingredients : [], ingTouched: x.ingredients !== undefined,
      kitchen: x.kitchen === 'pizza' ? 'pizza' : 'other', kitTouched: x.kitchen !== undefined,
      sort: x.sort == null ? null : Number(x.sort), sortTouched: x.sort !== undefined }),
  },
  customers: {
    // photo is only sent when there is one, so this works even before the photo column exists
    to: r => Object.assign({ id: r.id, name: r.name || '', phone: r.phone || '', address: r.address || '', notes: r.notes || '', created_at: toIso(r.createdAt), deleted: !!r.deleted }, r.photo || r.photoTouched ? { photo: r.photo || '' } : {}),
    from: x => ({ id: x.id, name: x.name, phone: x.phone, address: x.address, notes: x.notes, photo: x.photo || '', photoTouched: x.photo !== undefined, userId: x.user_id || '', createdAt: toMs(x.created_at), deleted: !!x.deleted }),
  },
  orders: {
    to: r => Object.assign({ id: r.id, no: r.no || 0, customer_id: r.customerId || null, customer_name: r.customerName || '', phone: r.phone || '', address: r.address || '', type: r.type || 'delivery', items: r.items || [], subtotal: num(r.subtotal), fee: num(r.fee), total: num(r.total), note: r.note || '', status: r.status || 'new', created_at: toIso(r.createdAt), deleted: !!r.deleted },
      r.payTouched ? { paid: !!r.paid, pay_method: r.payMethod || '', pay_proof: r.payProof || '', paid_at: r.paidAt ? toIso(r.paidAt) : null } : {},
      r.slotTouched ? { slot_date: r.slotDate || '', slot: r.slot || '' } : {},
      r.delTouched ? { delivery_proof: r.deliveryProof || '' } : {},
      r.refundTouched ? { refunded: !!r.refunded, refunded_at: r.refundedAt ? toIso(r.refundedAt) : null, refund_amount: num(r.refundAmount), refund_method: r.refundMethod || '', refund_proof: r.refundProof || '' } : {},
      r.editTouched ? { edited_at: r.editedAt ? toIso(r.editedAt) : null } : {}),
    from: x => ({ id: x.id, no: x.no, customerId: x.customer_id || null, customerName: x.customer_name, phone: x.phone, address: x.address, type: x.type, items: x.items || [], subtotal: num(x.subtotal), fee: num(x.fee), total: num(x.total), note: x.note, status: x.status, createdAt: toMs(x.created_at), deleted: !!x.deleted,
      paid: !!x.paid, payMethod: x.pay_method || '', payProof: x.pay_proof || '', paidAt: x.paid_at ? toMs(x.paid_at) : 0, payTouched: x.paid !== undefined,
      slotDate: x.slot_date || '', slot: x.slot || '', slotTouched: x.slot !== undefined,
      refunded: !!x.refunded, refundedAt: x.refunded_at ? toMs(x.refunded_at) : 0, refundAmount: num(x.refund_amount), refundMethod: x.refund_method || '', refundProof: x.refund_proof || '', refundTouched: x.refunded !== undefined,
      source: x.source || 'admin', paySubmittedAt: tsMs(x.pay_submitted_at), clientId: x.client_id || '',
      acceptedAt: tsMs(x.accepted_at), readyAt: tsMs(x.ready_at), doneAt: tsMs(x.done_at), deliveryProof: x.delivery_proof || '', delTouched: x.delivery_proof !== undefined,
      clientLogin: x.client_login || '', editedAt: tsMs(x.edited_at), editTouched: x.edited_at !== undefined }),
  },
  purchases: {
    to: r => Object.assign({ id: r.id, day: r.day || isoDay(Date.now()), item: r.item || '', qty: num(r.qty), unit: r.unit || '', cost: num(r.cost), note: r.note || '', photos: r.photos || [], created_at: toIso(r.createdAt), deleted: !!r.deleted },
      r.kindTouched ? { kind: ['pizza', 'expense'].includes(r.kind) ? r.kind : 'other' } : {}),
    from: x => ({ id: x.id, day: x.day, item: x.item, qty: num(x.qty), unit: x.unit || '', cost: num(x.cost), note: x.note || '', photos: Array.isArray(x.photos) ? x.photos : [], createdAt: toMs(x.created_at), deleted: !!x.deleted,
      kind: ['pizza', 'expense'].includes(x.kind) ? x.kind : 'other', kindTouched: x.kind !== undefined }),
  },
  settings: {
    to: r => Object.assign({ id: 'business', name: r.name || 'My kitchen', currency: r.currency ?? '¥', delivery_fee: num(r.deliveryFee), deleted: false },
      r.addrTouched ? { addresses: r.addresses || [] } : {},
      r.payCfgTouched ? { pay_wechat_qr: r.wechatQr || '', pay_alipay_qr: r.alipayQr || '', pay_wechat_id: r.wechatId || '', pay_alipay_id: r.alipayId || '' } : {},
      r.pkTouched ? { pickup: r.pickup !== false } : {},
      r.invTouched ? { inventory: r.inventory || {} } : {},
      r.logoTouched ? { logo: r.logo || '' } : {}),
    // one shared settings row for the whole team; older per-login rows are ignored
    from: x => ({ id: x.id === 'business' ? 'main' : '__other', name: x.name, currency: x.currency, deliveryFee: num(x.delivery_fee), addresses: Array.isArray(x.addresses) ? x.addresses : [], addrTouched: x.addresses !== undefined,
      wechatQr: x.pay_wechat_qr || '', alipayQr: x.pay_alipay_qr || '', wechatId: x.pay_wechat_id || '', alipayId: x.pay_alipay_id || '', payCfgTouched: x.pay_wechat_qr !== undefined,
      pickup: x.pickup !== false, pkTouched: x.pickup !== undefined, inventory: x.inventory && typeof x.inventory === 'object' ? x.inventory : {}, invTouched: x.inventory !== undefined,
      logo: x.logo || '', logoTouched: x.logo !== undefined, deleted: false }),
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
    if (!sb || !S.signedIn || S.notAdmin) { paintSync(); return; }
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
      loadMsgsSoon(0); loadReviewsSoon(0);
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
        const bucket = bucketFor(e.path);
        const { error } = await sb.storage.from(bucket).upload(e.path, blob, { contentType: b.type, cacheControl: '31536000', upsert: true });
        if (error) throw error;
        if (bucket === CFG.bucket) { try { const c = await caches.open('od-photos'); await c.put(publicUrl(e.path), new Response(blob, { headers: { 'Content-Type': b.type } })); } catch (_) { /* cache is optional */ } }
      }
      // payment screenshots stay on this device too (they are private, not cached by link)
      await IDB.batch(bucketFor(e.path) === 'receipts' ? [{ store: 'outbox', key }] : [{ store: 'outbox', key }, { store: 'blobs', key: e.path }]);
      S.outbox.delete(key);
    } else if (e.kind === 'photo-del') {
      const { error } = await sb.storage.from(bucketFor(e.path)).remove([e.path]);
      if (bucketFor(e.path) === 'receipts') await IDB.batch([{ store: 'blobs', key: e.path }]);
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
      // one row per upsert: a batched upsert unions the columns of all rows and
      // NULL-fills the ones a row omits, which breaks NOT NULL columns we only send
      // "when touched" (service, windows, photo, …). One row at a time, an omitted
      // column keeps its default on insert and its stored value on update.
      for (const r of recs) {
        const { error } = await sb.from(coll).upsert(MAP[coll].to(r));
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
  const changed = [], alerts = [];
  for (const coll of COLLS) {
    const sinceKey = 'since:' + coll;
    let since = (await IDB.get('meta', sinceKey)) || '';
    let from = since ? new Date(Date.parse(since) - 120000).toISOString() : '1970-01-01T00:00:00Z';
    for (;;) {
      const { data, error } = await sb.from(coll).select('*').gt('updated_at', from).order('updated_at', { ascending: true }).limit(1000);
      if (error && /^(42P01|PGRST205|PGRST204)$/.test(String(error.code || '')) && coll === 'purchases') break; // table not created yet
      if (error) throw error;
      if (!data || !data.length) break;
      const ops = [];
      for (const row of data) {
        const r = MAP[coll].from(row);
        if (r.id === '__other') continue;
        const pending = S.outbox.get(coll + ':' + r.id);
        if (pending) continue; // a local change is waiting; it wins and will be uploaded
        const cur = M[coll].get(r.id);
        if (r.deleted) {
          if (cur) { M[coll].delete(r.id); ops.push({ store: coll, key: r.id }); changed.push(coll); }
        } else if (!cur || JSON.stringify(stripV(cur)) !== JSON.stringify(r)) {
          if (coll === 'orders' && S.pulledOnce) {
            if (!cur && r.source === 'shop' && Date.now() - r.createdAt < 30 * 60000) alerts.push(['order', `New shop order ${orderNo(r.no)} · ${r.customerName || ''}`]);
            else if (cur && !cur.paySubmittedAt && r.paySubmittedAt && !r.paid) alerts.push(['paid', `${orderNo(r.no)}: customer says paid`]);
          }
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
  S.pulledOnce = true;
  if (alerts.length) { Sound.play(alerts.some(a => a[0] === 'order') ? 'order' : 'paid'); toast(alerts.map(a => a[1]).join(' · ')); }
}
function stripV(r) { const o = Object.assign({}, r); delete o._v; return o; }
function startRealtime() {
  stopRealtime();
  try {
    channel = sb.channel('od-' + S.uid);
    for (const t of COLLS) channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => Sync.soon(250)); // whole team's changes
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => loadMsgsSoon(150));
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'reviews' }, () => loadReviewsSoon(500));
    channel.subscribe();
  } catch (_) { channel = null; }
}
function stopRealtime() { if (channel && sb) { try { sb.removeChannel(channel); } catch (_) { /* ignore */ } } channel = null; }

/* ---------- sync indicator ---------- */
function syncInfo() {
  const n = Sync.waiting(), w = `${n} change${n === 1 ? '' : 's'} waiting to upload`;
  if (!S.signedIn) return [false, 'Signed out: changes stay on this device.'];
  if (Sync.state === 'syncing') return [false, 'Syncing…'];
  if (Sync.state === 'offline') return [false, n ? 'Offline: ' + w : 'Offline: everything is saved on this device.'];
  if (Sync.state === 'error') return [false, 'Sync problem: ' + Sync.err];
  if (n) return [false, w];
  return [true, Sync.lastOk ? 'Synced at ' + timeStr(Sync.lastOk) : 'Synced'];
}
function syncChip() {
  const [ok, msg] = syncInfo();
  return el('button', { class: 'sync dot ' + (ok ? 'ok' : 'wait'), type: 'button', title: msg, 'aria-label': msg, onclick: () => {
    toast(syncInfo()[1]); if (S.signedIn) Sync.soon(0);
  } }, el('i'));
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
  m.replaceChildren(node); m.hidden = false; chatOpen = null;
  const f = node.querySelector('input:not([type=file]),select,textarea,button'); if (f && window.matchMedia('(min-width:821px)').matches) f.focus();
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.replaceChildren(); chatOpen = null; }
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
    if (!o.customerId || o.status === 'cancelled' || isRefunded(o)) continue;
    const s = m.get(o.customerId) || { n: 0, spent: 0, last: 0, items: new Map() };
    s.n++; s.spent += o.total || 0; s.last = Math.max(s.last, o.createdAt || 0);
    for (const it of o.items || []) s.items.set(it.name, (s.items.get(it.name) || 0) + (it.qty || 0));
    m.set(o.customerId, s);
  }
  return m;
}
const nextNo = () => [...M.orders.values()].reduce((a, o) => Math.max(a, o.no || 0), 0) + 1;
/* the order you arranged (Menu > Arrange); anything not arranged yet goes after, A to Z. Categories follow their first dish. */
const sortOf = m => (m.sort == null ? Infinity : m.sort);
function catRanks(list) { const r = new Map(); for (const m of list) { const c = m.category || 'Other'; r.set(c, Math.min(r.has(c) ? r.get(c) : Infinity, sortOf(m))); } return r; }
function orderedMenu(list) {
  const rk = catRanks(list);
  return list.slice().sort((a, b) => { const ca = a.category || 'Other', cb = b.category || 'Other';
    return (rk.get(ca) - rk.get(cb) || 0) || ca.localeCompare(cb) || (sortOf(a) - sortOf(b) || 0) || (a.name || '').localeCompare(b.name || ''); });
}
const sortedMenu = () => orderedMenu(S.menu);
const priceText = it => {
  const v = (it.variants || []).map(x => Number(x.price) || 0);
  if (!v.length) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  return lo === hi ? money(lo) : money(lo) + ' – ' + money(hi);
};
function avatar(c, cls) {
  const ph = () => el('div', { class: 'avatar' + (cls ? ' ' + cls : ''), style: '--h:' + hue(c.name), text: initial(c.name) });
  if (!c.photo) return ph();
  const im = el('img', { class: 'avatar' + (cls ? ' ' + cls : ''), src: photoUrl(c.photo), alt: '', loading: 'lazy', decoding: 'async' });
  im.addEventListener('error', () => im.replaceWith(ph()));
  return im;
}
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
  inventory: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  messages: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
};
const NAV = [['new', 'New order'], ['orders', 'Orders'], ['messages', 'Messages'], ['menu', 'Menu'], ['customers', 'Customers'], ['inventory', 'Inventory'], ['stats', 'Statistics']];
function renderNav() {
  const open = S.orders.filter(isUnpaid).length;
  $('#brand').replaceChildren(S.settings.name || 'My kitchen', el('small', { text: 'Order desk' }));
  $('#nav').replaceChildren(...NAV.map(([k, label]) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.innerHTML = ICONS[k];
    return el('button', { type: 'button', 'aria-current': S.view === k ? 'page' : false, 'aria-label': label, title: label, onclick: () => go(k) },
      svg, el('span', { class: 'nav-lbl', text: label }), k === 'orders' && open ? el('span', { class: 'badge', text: open }) : null,
      k === 'messages' && unreadAll() ? el('span', { class: 'badge', text: unreadAll() }) : null);
  }));
  $('#side-sync').replaceChildren(syncChip());
  renderMobileNav(open);
  const un = unreadAll();
  document.title = (open + un ? `(${open + un}) ` : '') + 'Order Desk';
}
/* phones: three main buttons + More (opens upward with the rest) */
const MAIN_M = ['orders', 'new', 'messages'];
ICONS.more = '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>';
ICONS.settings = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>';
const SHORT = { orders: 'Orders', new: 'New', messages: 'Messages', more: 'More' };
let moreOpen = false;
function navIcon(k) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = ICONS[k]; return svg; }
function renderMobileNav(open) {
  let bar = $('#mnav');
  if (!bar) { bar = el('nav', { id: 'mnav', 'aria-label': 'Sections' }); document.body.append(bar); }
  const badgeOf = k => (k === 'orders' ? open : k === 'messages' ? unreadAll() : 0);
  const rest = NAV.filter(([k]) => !MAIN_M.includes(k));
  const inRest = rest.some(([k]) => k === S.view);
  const btn = (k, label, onclick, current) => el('button', { type: 'button', class: 'mn-btn', id: 'mn-' + k, 'aria-current': current ? 'page' : false, 'aria-label': label, onclick },
    navIcon(k), el('span', { class: 'mn-lbl', text: SHORT[k] || label }), badgeOf(k) ? el('span', { class: 'badge', text: badgeOf(k) }) : null);
  const menu = moreOpen ? el('div', { class: 'more-menu', id: 'more-menu', role: 'menu' },
    rest.map(([k, label]) => el('button', { type: 'button', role: 'menuitem', class: 'mm-item', 'aria-current': S.view === k ? 'page' : false, onclick: () => { moreOpen = false; go(k); } }, navIcon(k), el('span', { text: label }))),
    el('button', { type: 'button', role: 'menuitem', class: 'mm-item', onclick: () => { moreOpen = false; renderNav(); settingsModal(); } }, navIcon('settings'), el('span', { text: 'Settings' }))) : null;
  bar.replaceChildren(...[
    ...MAIN_M.map(k => btn(k, NAV.find(n => n[0] === k)[1], () => { moreOpen = false; go(k); }, S.view === k)),
    btn('more', 'More', e => { e.stopPropagation(); moreOpen = !moreOpen; renderNav(); }, inRest || moreOpen), menu].filter(Boolean));
  bar.classList.toggle('open', moreOpen);
}
document.addEventListener('click', e => { if (moreOpen && !e.target.closest('#mnav')) { moreOpen = false; renderNav(); } });
function go(v) { S.view = v; S.ordLimit = 60; render(true); window.scrollTo(0, 0); }
$('#gear-desk').addEventListener('click', () => settingsModal());

/* ---------- rendering ---------- */
let raf = 0;
function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(false); }); }
/* the app's own icon: the logo from Settings, centred on a plain white square (light and dark both work). It is offered to the
   phone / Edge when the app is added to the home screen; an icon already on a home screen does not change by itself. */
let iconFor = null;
async function applyAppIcon() {
  const path = (S.settings && S.settings.logo) || '';
  if (!path || path === iconFor) return;
  iconFor = path;
  try {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = photoUrl(path); await img.decode();
    const mk = (size, pad) => {
      const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
      g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, size, size);
      const k = (size * (1 - 2 * pad)) / Math.max(img.naturalWidth, img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
      g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h); return c.toDataURL('image/png');
    };
    const set = (rel, href) => { let l = document.querySelector(`link[rel="${rel}"]`); if (!l) { l = document.createElement('link'); l.rel = rel; document.head.append(l); } l.href = href; return l; };
    set('apple-touch-icon', mk(180, .12));
    const base = new URL('./', location.href).href;
    const man = { name: 'Order Desk', short_name: 'Order Desk', description: 'Orders, menu and customers for the kitchen. Works offline.', start_url: base, scope: base, display: 'standalone', background_color: '#FFFFFF', theme_color: '#F2F4F1',
      icons: [{ src: mk(192, .12), sizes: '192x192', type: 'image/png' }, { src: mk(512, .12), sizes: '512x512', type: 'image/png' }, { src: mk(512, .22), sizes: '512x512', type: 'image/png', purpose: 'maskable' }] };
    set('manifest', URL.createObjectURL(new Blob([JSON.stringify(man)], { type: 'application/manifest+json' })));
  } catch (_) { iconFor = null; }
}
function render(viewChanged) {
  if (!S.ready) return;
  if (!S.uid) { showLogin(); return; }
  if (S.notAdmin) { showStaffOnly(); return; }
  if (S.loginOpen) return; // the sign-in screen is up; don't cover it
  $('#app').hidden = false; $('#login').hidden = true;
  applyAppIcon();
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
  ({ orders: viewOrders, messages: viewMessages, menu: viewMenu, customers: viewCustomers, inventory: viewInventory, stats: viewStats })[S.view](main);
}
const P = { fn: null };
function banners(root) {
  if (!S.signedIn) root.append(el('div', { class: 'banner err' }, el('span', { text: 'You are signed out, so changes stay on this device and are not uploaded.' }),
    el('button', { class: 'btn small', type: 'button', onclick: () => showLogin(true) }, 'Sign in')));
  if (S.updateReady) root.append(el('div', { class: 'banner' }, el('span', { text: 'A new version of Order Desk is ready.' }),
    el('button', { class: 'btn small primary', type: 'button', onclick: applyUpdate }, 'Update now')));
  if (showInstallHint()) root.append(el('div', { class: 'banner slim' }, el('span', { text: 'Install: tap Share, then "Add to Home Screen".' }),
    el('button', { class: 'x', type: 'button', 'aria-label': 'Hide', onclick: () => { try { localStorage.setItem('od-hint', '1'); } catch (_) { /* ignore */ } render(true); } }, '✕')));
}
function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = paths; return svg;
}
function pageHead(title, sub, ...actions) {
  return el('div', { class: 'page-head' },
    el('div', { class: 'head-title' }, el('h1', {}, ...(Array.isArray(title) ? title : [title])), sub ? el('div', { class: 'sub', text: sub }) : null),
    el('div', { class: 'head-acts' }, syncChip(), ...actions));
}
function tile(label, value, hot) { return el('div', { class: 'tile' + (hot ? ' hot' : '') }, el('b', { text: value }), el('span', { text: label })); }

/* ---------- ORDERS ---------- */
/* business day: an order belongs to the day it is FOR (its slot date), not the day it was typed in; one with no slot date
   falls back to when it was placed, and anything placed before 03:00 still counts as the evening before */
const BIZ_CUTOFF_H = 3;
const bizDay = ms => isoDay(ms - BIZ_CUTOFF_H * 3600000);
const orderDay = o => o.slotDate || bizDay(o.createdAt);
/* which half of the day to open on: Day before 20:00 and from 03:00; Night from 20:00 until 03:00 */
function autoSvc() { const h = new Date().getHours(); return h >= 20 || h < BIZ_CUTOFF_H ? 'night' : 'day'; }
const isoToDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function rangeText(from, to) {
  const f = isoToDate(from || to), t = isoToDate(to || from);
  const fs = f.getDate() + ' ' + MON[f.getMonth()];
  if (+f === +t) return fs;
  return f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear() ? f.getDate() + ' – ' + t.getDate() + ' ' + MON[t.getMonth()] : fs + ' – ' + t.getDate() + ' ' + MON[t.getMonth()];
}
const CAL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
function calIcon(pathD, size) { const s = el('span', { class: 'cal-ic' }); s.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + pathD + '"/></svg>'; return s; }
function calendarPop() {
  const [cy, cm] = S.calMonth.split('-').map(Number);
  const first = new Date(cy, cm - 1, 1), lead = (first.getDay() + 6) % 7, days = new Date(cy, cm, 0).getDate();
  const rows = Math.ceil((lead + days) / 7), today = bizDay(Date.now());
  const lo = S.ordFrom && S.ordTo ? (S.ordFrom <= S.ordTo ? S.ordFrom : S.ordTo) : (S.ordFrom || S.ordTo);
  const hi = S.ordFrom && S.ordTo ? (S.ordFrom <= S.ordTo ? S.ordTo : S.ordFrom) : lo;
  const shift = n => { const d = new Date(cy, cm - 1 + n, 1); S.calMonth = d.getFullYear() + '-' + pad(d.getMonth() + 1); render(true); };
  const pick = iso => {
    S.ordAll = false;
    if (S.calAnchor) { const a = S.calAnchor; S.calAnchor = ''; S.calOpen = false; S.ordFrom = a < iso ? a : iso; S.ordTo = a < iso ? iso : a; }
    else { S.calAnchor = iso; S.ordFrom = iso; S.ordTo = iso; }
    S.ordLimit = 60; render(true);
  };
  const cells = [];
  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(cy, cm - 1, i - lead + 1), iso = isoDay(+d), other = d.getMonth() !== cm - 1;
    const inR = lo && iso >= lo && iso <= hi, edge = lo && (iso === lo || iso === hi);
    cells.push(el('div', { class: 'cal-cell' + (inR ? ' in' : '') + (inR && iso === lo ? ' s' : '') + (inR && iso === hi ? ' e' : '') },
      el('button', { type: 'button', class: 'cal-day' + (other ? ' other' : '') + (edge ? ' edge' : '') + (iso === today ? ' today' : ''), 'aria-label': d.getDate() + ' ' + MONTH_FULL[d.getMonth()], 'aria-pressed': !!inR, onclick: () => pick(iso), text: String(d.getDate()) })));
  }
  const nav = (label, path, n) => { const b = el('button', { type: 'button', class: 'cal-nav', 'aria-label': label, onclick: () => shift(n) }); b.append(calIcon(path, 18)); return b; };
  return el('div', { class: 'cal-wrap' },
    el('div', { class: 'cal-back', onclick: () => { S.calOpen = false; S.calAnchor = ''; render(true); } }),
    el('div', { class: 'cal-pop', role: 'dialog', 'aria-label': 'Pick a date' },
      el('div', { class: 'cal-head' }, nav('Previous month', 'M15 6l-6 6 6 6', -1), el('b', { text: MONTH_FULL[cm - 1] + ' ' + cy }), nav('Next month', 'M9 6l6 6-6 6', 1)),
      el('div', { class: 'cal-dow' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(t => el('span', { text: t }))),
      el('div', { class: 'cal-grid' }, cells),
      el('div', { class: 'cal-foot' },
        el('span', { text: S.calAnchor ? 'Now tap the last day.' : 'Tap a day, or tap two days for a range.' }),
        el('span', { class: 'cal-links' },
          (S.ordFrom || S.ordTo || S.ordAll) ? el('button', { type: 'button', class: 'link', onclick: () => { S.calAnchor = ''; S.calOpen = false; S.ordFrom = ''; S.ordTo = ''; S.ordAll = false; S.ordLimit = 60; render(true); } }, 'Today') : null,
          S.ordAll ? null : el('button', { type: 'button', class: 'link', onclick: () => { S.calAnchor = ''; S.calOpen = false; S.ordFrom = ''; S.ordTo = ''; S.ordAll = true; S.ordLimit = 60; render(true); } }, 'All dates')))));
}
function dateButton() {
  const has = S.ordFrom || S.ordTo || S.ordAll;
  const reset = () => { S.calOpen = false; S.calAnchor = ''; S.ordFrom = ''; S.ordTo = ''; S.ordAll = false; S.ordLimit = 60; render(true); };
  const open = () => { const base = (S.ordFrom || S.ordTo || bizDay(Date.now())); S.calMonth = base.slice(0, 7); S.calAnchor = ''; S.calOpen = !S.calOpen; render(true); };
  const main = el('button', { type: 'button', class: 'h-date-btn' + (has ? ' set' : ''), 'aria-expanded': !!S.calOpen, 'aria-label': has ? 'Change date: ' + (S.ordAll ? 'all dates' : rangeText(S.ordFrom, S.ordTo)) : 'Pick a date', onclick: open });
  main.innerHTML = CAL_ICON;
  main.append(document.createTextNode(S.ordAll ? 'All dates' : has ? rangeText(S.ordFrom, S.ordTo) : isoToDate(bizDay(Date.now())).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })));
  if (!has) return main;
  const x = el('button', { type: 'button', class: 'h-date-x', 'aria-label': 'Back to today', onclick: reset });
  x.append(calIcon('M6 6l12 12M18 6L6 18', 14));
  return el('span', { class: 'h-date-grp set' }, main, x);
}
function viewOrders(root) {
  const head = pageHead(['Orders', dateButton()], '',
    el('button', { class: 'btn primary hide-m', type: 'button', onclick: () => go('new') }, '+ New order'));
  if (!S.svcSet && hasNight()) { S.svc = autoSvc(); S.svcSet = true; }
  let seg = null;
  if (hasNight()) {
    const active = o => !isCancelled(o) && !isComplete(o);
    const cnt = k => S.orders.filter(o => active(o) && (k === 'all' || orderSvc(o) === k)).length;
    seg = el('div', { class: 'svc-seg', role: 'group', 'aria-label': 'Day or night orders' }, [['all', 'All'], ['day', SVC.day], ['night', SVC.night]].map(([k, l]) =>
      el('button', { type: 'button', class: 'svc-btn ' + k, id: 'svc-' + k, 'aria-pressed': S.svc === k, title: 'Open orders', onclick: () => { S.svc = k; S.svcSet = true; S.ordLimit = 60; render(true); } },
        el('span', { text: l }), el('b', { text: cnt(k) }))));
  } else S.svc = 'all';
  /* every chip below is scoped to whichever Day/Night segment is active above it; 'all' sees everything, as before */
  const inSvc = o => S.svc === 'all' || orderSvc(o) === S.svc;
  const isDone = isComplete;
/* no date chosen = today's business day (what the header shows); Open still lists every open order, so an unaccepted one from yesterday is never hidden.
     asOpen = true when counting/listing the Open chip */
  const todayBiz = bizDay(Date.now());
  const inRange = (o, asOpen) => { if (S.ordAll) return true; if (!S.ordFrom && !S.ordTo) return asOpen || orderDay(o) === todayBiz; const d = orderDay(o); return (!S.ordFrom || d >= S.ordFrom) && (!S.ordTo || d <= S.ordTo); };
  const paidN = S.orders.filter(o => inSvc(o) && inRange(o, false) && !isCancelled(o) && !isRefunded(o) && o.paid).length;
  const unpaidN = S.orders.filter(o => inSvc(o) && inRange(o, false) && isUnpaid(o)).length;
  const cancN = S.orders.filter(o => inSvc(o) && inRange(o, false) && isCancelled(o)).length;
  const doneN = S.orders.filter(o => inSvc(o) && inRange(o, false) && isDone(o)).length;
  const openN = S.orders.filter(o => inSvc(o) && inRange(o, true) && isOpenOrder(o)).length;
  const refN = S.orders.filter(o => inSvc(o) && inRange(o, false) && isRefunded(o)).length;
  const filters = [['all', 'All'], ['open', `Open (${openN})`], ['paid', `Paid (${paidN})`], ['unpaid', `Unpaid (${unpaidN})`], ['done', `Completed (${doneN})`], ['cancelled', `Cancelled (${cancN})`], ['refunded', `Refunded (${refN})`]];
  if (!filters.some(([k]) => k === S.ordFilter)) S.ordFilter = 'open';
  const chips = el('div', { class: 'chips' }, filters.map(([k, label]) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': S.ordFilter === k, onclick: () => { S.ordFilter = k; S.ordLimit = 60; render(true); } }, label)));
  root.append(el('div', { class: 'ord-sticky' }, head, seg, chips, S.calOpen ? calendarPop() : null));
  const keep0 = { all: () => true, open: isOpenOrder, paid: o => !isCancelled(o) && !isRefunded(o) && o.paid, unpaid: isUnpaid, done: isDone, cancelled: isCancelled, refunded: isRefunded }[S.ordFilter];
    const keep = o => keep0(o) && inSvc(o) && inRange(o, S.ordFilter === 'open');
  const list = S.orders.filter(keep).sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) {
    root.append(el('div', { class: 'empty' }, el('b', { text: S.orders.length ? 'Nothing here' : 'No orders yet' }),
      S.orders.length ? 'Try another filter.' : 'Tap "New order" to take your first one.'));
    return;
  }
  const shown = list.slice(0, S.ordLimit);
  root.append(el('div', { class: 'tickets' }, shown.map(ticket)));
  if (list.length > shown.length) root.append(el('p', {}, el('button', { class: 'btn', type: 'button', onclick: () => { S.ordLimit += 60; render(true); } }, `Show more (${list.length - shown.length})`)));
}
function confirmBtn(label, sure, fn, cls) {
  const b = el('button', { class: 'btn small ' + (cls || ''), type: 'button' }, label);
  let t;
  b.addEventListener('click', e => {
    e.stopPropagation();
    if (b.dataset.armed) { clearTimeout(t); fn(); return; }
    b.dataset.armed = '1'; b.textContent = sure;
    t = setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 3500);
  });
  return b;
}
const setStatus = (o, status) => write(Store.patch('orders', o.id, { status }));
const orderNo = n => '#' + String(n || 0).padStart(3, '0');
function dayLabel(day) { // 'YYYY-MM-DD' -> Today / Tomorrow / Sat 10 Oct
  if (!day) return '';
  const t = isoDay(Date.now()), tm = isoDay(Date.now() + DAY);
  if (day === t) return 'Today'; if (day === tm) return 'Tomorrow';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function slotText(o) {
  if (!o.slot && (!o.slotDate || o.slotDate === isoDay(o.createdAt))) return o.slot ? o.slot : '';
  return [dayLabel(o.slotDate), o.slot || 'any time'].filter(Boolean).join(' · ');
}
const custOf = o => (o.customerId && M.customers.get(o.customerId)) || null;
/* the shop keeps its own automatic profile per account; those live in Shop accounts, never in your Customers list */
const AUTO_PROFILE = 'Signed up in the shop';
const realCusts = () => S.customers.filter(c => c.notes !== AUTO_PROFILE);
function whoAvatar(o, cls) { const c = custOf(o); return avatar({ name: whoName(o), photo: c && !c.deleted ? c.photo : '' }, cls); }
/* a linked customer's current name and phone win over what was typed at checkout, so a change shows everywhere */
function whoName(o) { const c = custOf(o); return (c && !c.deleted && (c.name || '').trim()) || o.customerName || 'Walk-in'; }
function whoPhone(o) { const c = custOf(o); return (c && !c.deleted && (c.phone || '').trim()) || o.phone || ''; }
/* progress the client sees: Received -> Accepted -> Ready / On the way -> Done */
/* order flow: Received -> Accept -> Mark paid -> On the way / Ready -> Delivered / Picked up */
const doneLabel = o => (o.type === 'delivery' ? 'Delivered' : 'Picked up');
const readyLabel = o => (o.type === 'delivery' ? 'On the way' : 'Ready');
const isNew = o => !['accepted', 'ready', 'done', 'cancelled'].includes(o.status);
function stepText(o) {
  return { accepted: o.paid ? 'Accepted · paid · cooking' : 'Accepted · not paid yet', ready: (o.type === 'delivery' ? 'On the way' : 'Ready for pickup') + (o.paid ? '' : ' · not paid yet'),
    done: o.paid ? 'Completed' : doneLabel(o) + ' · not paid yet' }[o.status] || '';
}
/* Day / Night: from the dishes in the order */
function orderSvc(o) {
  for (const it of o.items || []) { const m = M.menu.get(it.menuId); if (m) return m.service === 'night' ? 'night' : 'day'; }
  return 'day';
}
const SVC = { day: '☀ Day', night: '🌙 Night' };
const hasNight = () => S.menu.some(m => m.service === 'night');
function payPill(o) {
  if (isCancelled(o)) return el('span', { class: 'pill cancelled', text: 'Cancelled' });
  if (isRefunded(o)) return el('span', { class: 'pill refunded' }, 'Refunded');
  if (!o.paid && o.paySubmittedAt) return el('span', { class: 'pill check' }, payLogo(o.payMethod), o.payProof ? 'Check payment' : 'Check chat');
  return o.paid ? el('span', { class: 'pill paid' }, payLogo(o.payMethod), 'Paid')
    : el('span', { class: 'pill unpaid', text: 'Unpaid' });
}
function itemLines(o) {
  const items = (o.items || []).map(it => el('li', {},
    el('span', { text: `${it.qty}× ${it.name}${it.variant ? ' (' + it.variant + ')' : ''}` }),
    el('span', { text: money((it.price || 0) * (it.qty || 0)) })));
  if (o.type === 'delivery') items.push(el('li', {}, el('span', { text: 'Delivery' }), el('span', { text: feeText(o.fee) })));
  return items;
}
/* the buttons for where the order is now (tickets and order details share them)
   New: Accept / Cancel.  Accepted: Mark paid · On the way · Cancel.  On the way: Mark paid · Delivered.
   Paid and Delivered are separate; the order is Completed once it is both. */
const isComplete = o => !isCancelled(o) && !isRefunded(o) && o.status === 'done' && o.paid;
function orderActions(o, after, details) {
  const done = () => { if (after) after(); };
  const stop = fn => e => { if (e) e.stopPropagation(); fn(); };
  const acts = [];
  if (isCancelled(o)) {
    acts.push(el('button', { class: 'btn small', type: 'button', onclick: stop(async () => { await setStatus(o, 'new'); done(); }) }, 'Reopen'));
    acts.push(confirmBtn('Delete', 'Delete for good?', async () => { if (await write(Store.remove('orders', o.id, [...photoDelOp(o.payProof), ...photoDelOp(o.deliveryProof)]), 'Order deleted')) closeModal(); }, 'danger'));
    return acts;
  }
  if (isRefunded(o)) return acts; // refunds are shown and undone in the Refund section at the bottom
  const cancel = () => confirmBtn('Cancel', 'Sure?', async () => { await setStatus(o, 'cancelled'); done(); }, 'danger');
  const payBtn = () => el('button', { class: 'btn small pay', type: 'button', onclick: stop(() => payModal(o)) }, o.paySubmittedAt ? 'Check & mark paid' : 'Mark paid');
  if (isNew(o) && o.source === 'shop') {
    acts.push(el('button', { class: 'btn small primary', type: 'button', id: 'act-accept', onclick: stop(() => acceptSheet(o, after)) }, 'Accept'), cancel());
  } else if (o.status === 'accepted' || isNew(o)) { // orders you take yourself start here
    if (!o.paid) acts.push(payBtn());
    acts.push(el('button', { class: 'btn small primary', type: 'button', id: 'act-otw', onclick: stop(async () => { await setStatus(o, 'ready'); done(); }) }, readyLabel(o)));
    acts.push(cancel());
  } else if (o.status === 'ready') {
    if (!o.paid) acts.push(payBtn());
    acts.push(el('button', { class: 'btn small done', type: 'button', id: 'act-delivered', onclick: stop(() => deliveredModal(o)) }, doneLabel(o)));
  } else if (o.status === 'done') {
    if (!o.paid) { acts.push(el('span', { class: 'paid-note warn', text: '✓ ' + doneLabel(o) + ' · not paid' })); acts.push(payBtn()); }
    else acts.push(el('span', { class: 'paid-note', text: '✓ Completed' }));
  }
  return acts;
}
/* Refund a paid order: records the amount + method, takes it out of sales. */
function refundSheet(o0, after) {
  const o = M.orders.get(o0.id) || o0;
  const amount = num(o.total);
  let method = (o.payMethod && String(o.payMethod).replace('_chat', '')) || 'wechat';
  const methods = [['wechat', 'WeChat Pay'], ['alipay', 'Alipay'], ['cash', 'Cash']];
  const seg = el('div', { class: 'seg3', role: 'group', 'aria-label': 'Refund method' });
  const drawSeg = () => seg.replaceChildren(...methods.map(([k, l]) => el('button', { type: 'button', id: 'rf-' + k, 'aria-pressed': method === k, onclick: () => { method = k; drawSeg(); } }, l)));
  drawSeg();
  // optional screenshot of the refund transfer (private: only you and the customer-side kitchen see it)
  let blob = null, prev = '', keep = !!o.refundProof;
  const box = el('div', { class: 'photo-edit' });
  const status = el('div', { class: 'sub' });
  async function drawShot() {
    const src = blob ? prev : (keep && o.refundProof ? await receiptSrc(o.refundProof) : '');
    box.replaceChildren(src ? el('img', { class: 'receipt-thumb', src, alt: '' }) : el('div', { class: 'ph', style: '--h:10', text: '↩' }),
      el('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        el('label', { class: 'btn small', style: 'text-align:center' }, src ? 'Change screenshot' : 'Add screenshot',
          el('input', { type: 'file', accept: 'image/*', id: 'rf-file', style: 'display:none', onchange: async e => {
            const f = e.target.files && e.target.files[0]; if (!f) return;
            status.textContent = 'Preparing picture…';
            try { blob = await shrinkPhoto(f, 1600, false); if (prev) URL.revokeObjectURL(prev); prev = URL.createObjectURL(blob); keep = false; status.textContent = ''; drawShot(); }
            catch (err) { status.textContent = ''; toast((err && err.message) || 'Could not read that picture.', true); }
          } })),
        src ? el('button', { class: 'link', type: 'button', onclick: () => { blob = null; keep = false; drawShot(); } }, 'Remove') : el('span', { class: 'sub', text: 'Optional' })));
  }
  drawShot();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: `Refund ${orderNo(o.no)}` }),
    el('div', { class: 'sub', text: `Give ${money(amount)} back to ${whoName(o)}. This marks the order refunded and takes it out of your sales. Do the transfer in WeChat / Alipay yourself.` }),
    el('div', { class: 'field' }, el('label', { text: 'Refunded by' }), seg),
    el('div', { class: 'field' }, el('label', { text: 'Screenshot (optional)' }), box, status),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Back'),
      el('button', { class: 'btn danger', type: 'button', id: 'rf-yes', onclick: async () => {
        let proof = keep ? o.refundProof : '';
        if (blob) { proof = `${o.clientId || S.uid}/refund-${newId()}.jpg`; try { await queuePhoto(proof, blob); } catch (_) { return toast('Could not store the picture on this device.', true); } }
        const extra = o.refundProof && o.refundProof !== proof ? photoDelOp(o.refundProof) : [];
        const ok = await write(Store.put('orders', Object.assign({}, o, { refunded: true, refundedAt: Date.now(), refundAmount: amount, refundMethod: method, refundProof: proof, refundTouched: true }), extra), 'Refunded');
        if (ok) { closeModal(); if (after) setTimeout(after, 0); }
      } }, `Refund ${money(amount)}`))));
}
/* Accept asks first */
function acceptSheet(o0, after) {
  const o = M.orders.get(o0.id) || o0;
  openModal(el('div', { class: 'sheet accept' }, el('h2', { text: `Accept order ${orderNo(o.no)}?` }),
    el('div', { class: 'acc-card' },
      el('div', { class: 'who' }, whoAvatar(o, 'sm'), el('span', { class: 'who-nm' }, whoName(o), whoPhone(o) ? el('small', { text: whoPhone(o) }) : null)),
      o.address ? el('div', { class: 'addr', text: '📍 ' + o.address }) : null,
      slotText(o) || o.slot ? el('div', { class: 'when', text: '🕒 ' + (slotText(o) || o.slot) }) : null,
      el('ul', { class: 'lines' }, itemLines(o)),
      el('div', { class: 'sum total' }, el('span', { text: 'Total' }), el('span', { text: money(o.total) })),
      o.note ? el('div', { class: 'note', text: o.note }) : null),
    el('div', { class: 'sub', text: 'The customer will see "Accepted" and can pay.' }),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Back'),
      el('button', { class: 'btn primary', type: 'button', id: 'acc-yes', onclick: async () => { if (await setStatus(o, 'accepted')) { closeModal(); toast(`${orderNo(o.no)} accepted`); if (after) setTimeout(after, 0); } } }, 'Accept order'))));
}
const PHONE_DOMAIN = 'phone.orderdesk.app';
function loginText(o) {
  const l = o.clientLogin || '';
  if (!l) return '';
  if (l === 'guest') return '👤 Guest (this phone only)';
  if (l.endsWith('@' + PHONE_DOMAIN)) return '📱 Phone account · ' + l.replace('@' + PHONE_DOMAIN, '');
  return '✉ Email account · ' + l;
}
const pickupOn = () => S.settings.pickup !== false;
function unreadFrom(clientId) { return clientId ? S.msgs.filter(m => m.client_id === clientId && !m.from_admin && !m.read_at).length : 0; }
function ticket(o) {
  const sameDay = startOfDay(o.createdAt) === startOfDay(Date.now());
  const unread = unreadFrom(o.clientId);
  return el('article', { class: 'ticket ' + (isCancelled(o) ? 't-cancelled' : isRefunded(o) ? 't-refunded' : o.paid ? 't-paid' : 't-unpaid') + (isNew(o) && !isCancelled(o) && !isRefunded(o) ? ' t-new' : ''), 'data-id': o.id, tabindex: '0',
    onclick: () => orderSheet(o), onkeydown: e => { if (e.key === 'Enter') orderSheet(o); } },
    el('div', { class: 't-head' },
      el('span', { class: 't-no', text: orderNo(o.no) }),
      el('span', { class: 't-time', text: timeStr(o.createdAt) + (sameDay ? '' : ' · ' + dateShort(o.createdAt)) }),
      hasNight() ? el('span', { class: 'tag svc ' + orderSvc(o), text: orderSvc(o) === 'night' ? '🌙' : '☀', title: SVC[orderSvc(o)] }) : null,
      o.source === 'shop' ? el('span', { class: 'tag shop', text: 'Shop' }) : null,
      o.editedAt ? el('span', { class: 'tag', title: 'Edited', text: '✎' }) : null,
      pickupOn() || o.type === 'pickup' ? el('span', { class: 'tag', text: o.type === 'delivery' ? 'Delivery' : 'Pickup' }) : null,
      unread ? el('span', { class: 'tag msg', text: '💬 ' + unread }) : null,
      payPill(o)),
    el('div', { class: 't-body' },
      stepText(o) ? el('div', { class: 'stepnow', text: stepText(o) }) : isNew(o) && !isCancelled(o) && o.source === 'shop' ? el('div', { class: 'stepnow new', text: 'New · accept or cancel' }) : null,
      el('div', { class: 'who' }, whoAvatar(o, 'md'), el('span', { class: 'who-nm' }, whoName(o), whoPhone(o) ? el('small', { text: whoPhone(o) }) : null)),
      o.address ? el('div', { class: 'addr', text: o.address }) : null,
      slotText(o) ? el('div', { class: 'when', text: '🕒 ' + slotText(o) }) : null,
      el('ul', { class: 'lines' }, itemLines(o)),
      o.note ? el('div', { class: 'note', text: o.note }) : null),
    el('div', { class: 't-foot' }, el('span', { class: 't-total', text: money(o.total) }), orderActions(o)));
}
/* private pictures (payment screenshot, delivery photo) shown inside the order */
function privatePic(path, alt) {
  const box = el('div', { class: 'receipt-box' });
  if (!path) return box;
  box.append(el('div', { class: 'sub', text: 'Loading picture…' }));
  receiptSrc(path).then(src => box.replaceChildren(src
    ? el('a', { href: src, target: '_blank', rel: 'noopener' }, el('img', { class: 'receipt', src, alt }))
    : el('div', { class: 'sub', text: 'Picture not available right now (offline?).' })));
  return box;
}
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast(t));
  else toast(t);
}
/* the whole order, tapped from its ticket */
function orderSheet(o0) {
  const o = M.orders.get(o0.id) || o0;
  const again = () => { const cur = M.orders.get(o.id); if (cur && !$('#modal').hidden) orderSheet(cur); };
  const steps = [['new', 'Received'], ['accepted', 'Accepted'], ['ready', readyLabel(o)], ['done', doneLabel(o)]];
  const at = steps.findIndex(([k]) => k === o.status), cur = at < 0 ? 0 : at;
  const events = [['Placed', o.createdAt], ['Payment sent by client', o.paySubmittedAt], ['Accepted', o.acceptedAt], ['Paid', o.paid ? o.paidAt : 0],
    [readyLabel(o), o.readyAt], [doneLabel(o), o.doneAt], ['Edited', o.editedAt]].filter(([, t]) => t).sort((a, b) => a[1] - b[1]);
  const unread = unreadFrom(o.clientId);
  const pay = isCancelled(o) ? null : el('section', { class: 'od-sect' }, el('h3', { text: 'Payment' }),
    o.paid ? el('div', { class: 'od-row' }, el('span', {}, 'Paid with ', payLogo(o.payMethod), PAY[o.payMethod] || 'unknown'), o.paidAt ? el('span', { class: 'sub', text: dateShort(o.paidAt) + ' ' + timeStr(o.paidAt) }) : null)
      : o.paySubmittedAt ? el('div', { class: 'od-row' }, el('span', {}, 'Client says paid · ', payLogo(o.payMethod), (String(o.payMethod).endsWith('_chat') ? 'in ' : '') + (PAY[o.payMethod] || 'unknown')),
        el('span', { class: 'sub', text: dateShort(o.paySubmittedAt) + ' ' + timeStr(o.paySubmittedAt) }))
        : el('div', { class: 'sub', text: 'Not paid yet.' }),
    o.payProof ? privatePic(o.payProof, 'Payment screenshot') : null,
    el('div', { class: 'btns' },
      el('button', { class: 'btn small' + (o.paid ? '' : ' pay'), type: 'button', onclick: () => payModal(o) }, o.paid ? 'Change payment' : o.paySubmittedAt ? 'Check & mark paid' : 'Mark paid'),
      o.paid ? confirmBtn('Mark unpaid', o.payProof ? 'Unpaid + remove screenshot?' : 'Mark unpaid?', async () => {
        if (await write(Store.put('orders', Object.assign({}, o, { paid: false, payMethod: '', payProof: '', paidAt: 0, payTouched: true }), photoDelOp(o.payProof)), 'Marked unpaid')) again();
      }) : null));
  const delivery = o.status === 'done' || o.deliveryProof ? el('section', { class: 'od-sect' }, el('h3', { text: doneLabel(o) }),
    o.doneAt ? el('div', { class: 'sub', text: dateShort(o.doneAt) + ' ' + timeStr(o.doneAt) }) : null,
    o.deliveryProof ? privatePic(o.deliveryProof, 'Delivery photo') : el('div', { class: 'sub', text: 'No photo.' }),
    el('div', { class: 'btns' }, el('button', { class: 'btn small', type: 'button', onclick: () => deliveredModal(o) }, o.deliveryProof ? 'Change photo' : 'Add photo'))) : null;
  openModal(el('div', { class: 'sheet od' },
    el('div', { class: 'od-head' }, el('h2', { text: `Order ${orderNo(o.no)}` }),
      hasNight() ? el('span', { class: 'tag svc ' + orderSvc(o), text: SVC[orderSvc(o)] }) : null,
      o.editedAt ? el('span', { class: 'tag', title: 'Edited ' + dateShort(o.editedAt) + ' ' + timeStr(o.editedAt), text: '✎ Edited' }) : null, payPill(o)),
    el('div', { class: 'sub', text: `${o.source === 'shop' ? 'Ordered in the shop' : 'Taken by you'} · ${dateShort(o.createdAt)} ${timeStr(o.createdAt)}${pickupOn() || o.type === 'pickup' ? ' · ' + (o.type === 'delivery' ? 'Delivery' : 'Pickup') : ''}` }),
    !isCancelled(o) ? el('div', { class: 'stepper', role: 'group', 'aria-label': 'Progress (the client sees this)' }, steps.map(([k, l], i) =>
      el('button', { type: 'button', class: i < cur ? 'past' : i === cur ? 'now' : '', 'aria-pressed': i === cur, onclick: async () => { if (k === 'done') return deliveredModal(o); await setStatus(o, k); again(); } },
        el('span', { class: 'dot', text: i < cur ? '✓' : i + 1 }), el('span', { text: l })))) : el('div', { class: 'err', text: 'Cancelled' }),
    el('div', { class: 'od-acts' }, orderActions(o, again, true)),
    el('section', { class: 'od-sect od-who' },
      el('div', { class: 'who-head' }, whoAvatar(o, 'big'), el('div', { style: 'min-width:0' }, el('b', { text: whoName(o) }), whoPhone(o) ? el('div', { class: 'sub', text: whoPhone(o) }) : null,
        el('div', { class: 'login-tag', text: loginText(o) || (o.source === 'shop' ? 'Shop customer' : 'Order taken by you') }), acctBits(o, again))),
      el('div', { class: 'btns' },
        o.phone ? el('a', { class: 'btn small', href: 'tel:' + o.phone.replace(/[^\d+]/g, '') }, '📞 Call') : null,
        o.phone ? el('button', { class: 'btn small', type: 'button', onclick: () => copyText(o.phone) }, 'Copy number') : null,
        o.clientId ? el('button', { class: 'btn small', type: 'button', id: 'od-msg', onclick: () => chatSheet(o.clientId, o.no) }, '💬 Message' + (unread ? ` (${unread})` : '')) : null,
        o.clientId && o.source === 'shop' ? el('button', { class: 'btn small link-btn', type: 'button', id: 'od-link', onclick: () => linkSheet(o) }, isLinked(o) ? '🔗 Linked · change' : '🔗 Link to customer') : null,
        hasPassword(o) ? el('button', { class: 'btn small', type: 'button', id: 'od-reset', onclick: () => resetPwSheet(o) }, '🔑 Reset password') : null),
      o.type === 'delivery' ? el('div', { class: 'od-row' }, el('span', { class: 'sub', text: 'Deliver to' }), el('b', { text: o.address || '—' })) : el('div', { class: 'od-row' }, el('span', { class: 'sub', text: 'Pickup' }), el('b', { text: 'At the kitchen' })),
      el('div', { class: 'od-row' }, el('span', { class: 'sub', text: 'Time' }), el('b', { text: slotText(o) || [dayLabel(o.slotDate || isoDay(o.createdAt)), o.slot].filter(Boolean).join(' · ') || 'Not set' }))),
    el('section', { class: 'od-sect' }, el('h3', { text: 'Items' }), el('ul', { class: 'lines' }, itemLines(o)),
      el('div', { class: 'sum total' }, el('span', { text: 'Total' }), el('span', { text: money(o.total) })),
      o.note ? el('div', { class: 'note', text: o.note }) : null),
    pay, delivery,
    isRefunded(o) ? el('section', { class: 'od-sect' }, el('h3', { text: 'Refund' }),
      el('div', { class: 'od-row' }, el('span', {}, 'Refunded ' + money(o.refundAmount || o.total) + (o.refundMethod ? ' · ' + (PAY[o.refundMethod] || o.refundMethod) : '')), o.refundedAt ? el('span', { class: 'sub', text: dateShort(o.refundedAt) + ' ' + timeStr(o.refundedAt) }) : null),
      o.refundProof ? privatePic(o.refundProof, 'Refund screenshot') : null,
      el('div', { class: 'btns' }, confirmBtn('Undo refund', 'Undo the refund?', async () => { if (await write(Store.put('orders', Object.assign({}, o, { refunded: false, refundedAt: 0, refundAmount: 0, refundMethod: '', refundProof: '', refundTouched: true }), photoDelOp(o.refundProof)), 'Refund undone')) again(); }))) : null,
    el('section', { class: 'od-sect' }, el('h3', { text: 'Timeline' }),
      el('ol', { class: 'timeline' }, events.map(([l, t]) => el('li', {}, el('span', { text: l }), el('span', { class: 'sub', text: dateShort(t) + ' ' + timeStr(t) }))))),
    el('div', { class: 'actions' },
      !isCancelled(o) ? el('button', { class: 'btn small', type: 'button', onclick: () => editOrder(o) }, '✎ Edit order') : null,
      !isCancelled(o) && !isRefunded(o) && !isNew(o) && o.status !== 'accepted' && !isComplete(o) ? confirmBtn('Cancel order', 'Cancel it?', async () => { await setStatus(o, 'cancelled'); again(); }, 'danger left') : null,
      o.paid && !isRefunded(o) && !isCancelled(o) ? el('button', { class: 'btn danger', type: 'button', id: 'act-refund', onclick: () => refundSheet(o, again) }, 'Refund') : null,
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'))));
}
/* phone / email accounts: Verified status and password reset (needs internet) */
const hasPassword = o => !!(o.clientId && o.clientLogin && o.clientLogin !== 'guest');
function acctBits(o, again) {
  const box = el('div', { class: 'acct-bits' });
  if (!hasPassword(o) || !sb || navigator.onLine === false) return box;
  sb.from('accounts').select('verified').eq('user_id', o.clientId).limit(1).then(({ data, error }) => {
    if (error) return;
    const v = !!(data && data[0] && data[0].verified);
    box.replaceChildren(el('span', { class: 'vtag' + (v ? ' ok' : ''), id: 'od-vtag', text: v ? '✓ Verified' : 'Unverified' }),
      el('button', { class: 'link', type: 'button', id: 'od-verify', onclick: async () => {
        const { error: e } = await sb.rpc('set_account_verified', { p_user: o.clientId, p_verified: !v });
        if (e) return toast('Could not change: ' + e.message, true);
        toast(v ? 'Marked unverified' : 'Marked verified'); again();
      } }, v ? 'Mark unverified' : 'Mark verified'));
  }, () => {});
  return box;
}
function resetPwSheet(o) {
  const pw = el('input', { id: 'rp-pw', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: String(Math.floor(100000 + Math.random() * 900000)) });
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:10px' },
    el('div', { class: 'sub', text: `New password for ${o.customerName || 'this customer'} (${loginText(o).replace(/^\S+ \w+ account · /, '')}). Send it to them on WeChat; they can sign in with it right away.` }),
    el('div', { class: 'field' }, el('label', { for: 'rp-pw', text: 'New password (6+ characters)' }), pw));
  const save = el('button', { class: 'btn primary', type: 'button', id: 'rp-save', onclick: async () => {
    if (pw.value.length < 6) return toast('At least 6 characters.', true);
    if (!sb || navigator.onLine === false) return toast('Needs internet.', true);
    save.disabled = true;
    const { error } = await sb.rpc('reset_account_password', { p_user: o.clientId, p_password: pw.value });
    if (error) { save.disabled = false; return toast('Could not reset: ' + error.message, true); }
    const p = pw.value;
    body.replaceChildren(el('div', { class: 'sub', text: 'Password changed. Send it to the customer:' }), el('div', { class: 'rp-new', id: 'rp-new', text: p }));
    save.replaceWith(el('button', { class: 'btn primary', type: 'button', onclick: () => copyText(p) }, 'Copy password'));
  } }, 'Set password');
  openModal(el('div', { class: 'sheet' }, el('h2', { text: '🔑 Reset password' }), body,
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'), save)));
}
/* Link: connect a shop account to one of your customers */
const isLinked = o => { const c = custOf(o); return !!(c && c.notes !== AUTO_PROFILE); };
function linkSheet(o) {
  const words = s => String(s || '').toLowerCase().replace(/[_\-.]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
  let q = o.customerName || '';
  const list = el('div', { class: 'link-list' });
  const input = el('input', { id: 'link-q', type: 'search', value: q, placeholder: 'Search your customers', 'aria-label': 'Search customers', oninput: e => { q = e.target.value; draw(); } });
  function draw() {
    const ws = words(q), qq = q.trim().toLowerCase();
    const pool = realCusts();
    const score = c => { const n = (c.name || '').toLowerCase(); if (!qq) return 1; if (n === qq) return 100; let sc = n.includes(qq) ? 50 : 0; for (const w of ws) if (n.includes(w)) sc += 10; if ((c.phone || '').includes(qq)) sc += 40; return sc; };
    const hits = pool.map(c => [score(c), c]).filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0] || (a[1].name || '').localeCompare(b[1].name || '')).slice(0, 40);
    list.replaceChildren(...(hits.length ? hits.map(([, c]) => el('button', { class: 'link-row', type: 'button', 'data-id': c.id, onclick: () => doLink(c) },
      avatar(c, 'sm'), el('span', { class: 'lr-mid' }, el('b', { text: c.name || 'Customer' }), el('small', { text: [c.phone, c.address].filter(Boolean).join(' · ') || ' ' })), el('span', { class: 'chev', text: '›' })))
      : [el('div', { class: 'sub', style: 'padding:12px', text: 'No match. Try part of the name, or the phone number.' })]));
  }
  async function doLink(c) {
    if (!sb || navigator.onLine === false) return toast('Linking needs internet.', true);
    try {
      const { error } = await sb.rpc('link_account', { p_user: o.clientId, p_customer_id: c.id });
      if (error) throw error;
      toast(`Linked to ${c.name}`); closeModal(); Sync.soon(0);
      if (S.view === 'customers' && S.custTab === 'accounts') { try { await loadAccts(); } catch (_) { /* shown next time */ } render(true); }
    } catch (e) { toast('Could not link: ' + ((e && e.message) || e), true); }
  }
  draw();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: '🔗 Link to a customer' }),
    el('div', { class: 'sub', text: `This customer typed "${o.customerName || ''}". Pick who it is: their name and photo will show on this order, their earlier and future orders, and on their phone.` }),
    input, list,
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'))));
  setTimeout(() => input.focus(), 50);
}
/* Delivered / Picked up, with an optional photo the client can see */
function deliveredModal(o0) {
  const o = M.orders.get(o0.id) || o0;
  let blob = null, prev = '', keep = !!o.deliveryProof;
  const box = el('div', { class: 'photo-edit' });
  const status = el('div', { class: 'sub' });
  async function draw() {
    const src = blob ? prev : (keep && o.deliveryProof ? await receiptSrc(o.deliveryProof) : '');
    box.replaceChildren(src ? el('img', { class: 'receipt-thumb', src, alt: '' }) : el('div', { class: 'ph', style: '--h:140', text: '📦' }),
      el('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        el('label', { class: 'btn small', style: 'text-align:center' }, src ? 'Change photo' : 'Take / add photo',
          el('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'dl-file', style: 'display:none', onchange: async e => {
            const f = e.target.files && e.target.files[0]; if (!f) return;
            status.textContent = 'Preparing photo…';
            try { blob = await shrinkPhoto(f, 1600, false); if (prev) URL.revokeObjectURL(prev); prev = URL.createObjectURL(blob); status.textContent = ''; draw(); }
            catch (err) { status.textContent = ''; toast((err && err.message) || 'Could not read that picture.', true); }
          } })),
        src ? el('button', { class: 'link', type: 'button', onclick: () => { blob = null; keep = false; draw(); } }, 'Remove photo') : el('span', { class: 'sub', text: 'Optional · the client sees it' })));
  }
  async function save() {
    let path = keep ? o.deliveryProof : '';
    if (blob) { path = `${o.clientId || S.uid}/delivered-${newId()}.jpg`; try { await queuePhoto(path, blob); } catch (_) { return toast('Could not store the photo on this device.', true); } }
    const extra = o.deliveryProof && o.deliveryProof !== path ? photoDelOp(o.deliveryProof) : [];
    const rec = Object.assign({}, o, { status: 'done', deliveryProof: path, delTouched: true });
    if (await write(Store.put('orders', rec, extra), `${orderNo(o.no)} ${doneLabel(o).toLowerCase()}`)) closeModal();
  }
  draw();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: `${doneLabel(o)} · ${orderNo(o.no)}` }),
    el('div', { class: 'sub', text: `${o.customerName || 'Walk-in'}${o.address ? ' · ' + o.address : ''}` }),
    o.paid ? null : el('div', { class: 'banner' }, el('span', { text: 'This order is not marked paid yet.' })),
    el('div', { class: 'field' }, el('label', { text: o.type === 'delivery' ? 'Delivery photo' : 'Photo' }), box, status),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn done', type: 'button', id: 'dl-save', onclick: save }, `Mark ${doneLabel(o).toLowerCase()}`))));
}
/* record a payment: WeChat Pay or Alipay, optional screenshot */
function payModal(o0) {
  const o = M.orders.get(o0.id) || o0;
  let method = o.payMethod || 'wechat', blob = null, preview = '', keepOld = !!o.payProof;
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Paid with' });
  const shot = el('div', { class: 'photo-edit' });
  const status = el('div', { class: 'sub' });
  const drawSeg = () => seg.replaceChildren(...[['wechat', 'WeChat Pay'], ['alipay', 'Alipay']].map(([k, label]) =>
    el('button', { type: 'button', 'aria-pressed': payBase(method) === k, onclick: () => { if (payBase(method) !== k) method = k; drawSeg(); } }, payLogo(k), label)));
  async function drawShot() {
    const src = blob ? preview : (keepOld && o.payProof ? await receiptSrc(o.payProof) : '');
    shot.replaceChildren(src ? el('img', { class: 'receipt-thumb', src, alt: '' }) : el('div', { class: 'ph', style: '--h:40', text: '🧾' }),
      el('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        el('label', { class: 'btn small', style: 'text-align:center' }, src ? 'Change screenshot' : 'Add screenshot',
          el('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: onFile })),
        src ? el('button', { class: 'link', type: 'button', onclick: () => { blob = null; keepOld = false; drawShot(); } }, 'Remove screenshot') : el('span', { class: 'sub', text: 'Optional' })));
  }
  async function onFile(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    status.textContent = 'Preparing screenshot…';
    try { blob = await shrinkPhoto(f, 1600, false); if (preview) URL.revokeObjectURL(preview); preview = URL.createObjectURL(blob); status.textContent = ''; drawShot(); }
    catch (err) { status.textContent = ''; toast((err && err.message) || 'Could not read that picture.', true); }
  }
  async function save() {
    let proof = keepOld ? o.payProof : '';
    if (blob) { proof = `${S.uid}/receipt-${newId()}.jpg`; try { await queuePhoto(proof, blob); } catch (_) { return toast('Could not store the screenshot on this device.', true); } }
    const extra = o.payProof && o.payProof !== proof ? photoDelOp(o.payProof) : [];
    const rec = Object.assign({}, o, { paid: true, payMethod: method, payProof: proof, paidAt: o.paid && o.paidAt ? o.paidAt : Date.now(), payTouched: true });
    if (await write(Store.put('orders', rec, extra), `${orderNo(o.no)} marked paid`)) closeModal();
  }
  drawSeg(); drawShot();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: `Payment for ${orderNo(o.no)} · ${money(o.total)}` }),
    el('div', { class: 'field' }, el('label', { text: 'Paid with' }), seg),
    el('div', { class: 'field' }, el('label', { text: 'Payment screenshot' }), shot, status),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn pay', type: 'button', id: 'pay-save', onclick: save }, 'Save as paid'))));
}

/* ---------- NEW ORDER ---------- */
const N = { root: null };
function viewNew(root) {
  const d = S.draft;
  const field = (id, label, key, attrs) => el('div', { class: 'field' }, el('label', { for: id, text: label }),
    el('input', Object.assign({ id, value: d[key], autocomplete: 'off', oninput: e => { d[key] = e.target.value; if (key !== 'address') { d.customerId = null; refreshCustomerBits(); } } }, attrs)));
  N.suggest = el('div'); N.known = el('div'); N.addrField = el('div', { class: 'field' });
  N.typeSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Order type' });
  N.grid = el('div', { class: 'grid' }); N.chips = el('div', { class: 'chips' });
  N.basket = el('div', { class: 'card basket', id: 'basket' });
  N.when = el('div', { class: 'when-pick' });
  const editing = !!d.editId, editOrig = editing ? S.orders.find(x => x.id === d.editId) : null;
  N.root = el('div', {},
    pageHead(editing ? `Edit order ${orderNo(editOrig ? editOrig.no : 0)}` : 'New order',
      editing ? 'Change what you need — everything else stays the same.' : 'Pick a customer, add items, save.'),
    el('div', { class: 'neworder' },
      el('div', { class: 'stack' },
        el('div', { class: 'card' }, el('h2', { text: 'Customer' }),
          el('div', { class: 'row' }, field('o-name', 'Name', 'name', { placeholder: 'Type a name to find a regular' }), field('o-phone', 'Phone', 'phone', { type: 'tel', inputmode: 'tel' })),
          N.suggest, N.known,
          el('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:10px' }, N.typeSeg, N.addrField, N.when)),
        el('div', { class: 'card' }, el('h2', { text: 'Menu' }), N.chips, N.grid)),
      N.basket));
  root.append(N.root);
  refreshNew();
}
function refreshNew() { refreshCustomerBits(); refreshGrid(); refreshBasket(); renderNav(); }
function refreshCustomerBits() {
  const d = S.draft;
  if (!pickupOn()) d.type = 'delivery';
  N.typeSeg.hidden = !pickupOn();
  N.typeSeg.replaceChildren(...[['delivery', 'Delivery'], ['pickup', 'Pickup']].map(([k, label]) =>
    el('button', { type: 'button', 'aria-pressed': d.type === k, onclick: () => { d.type = k; refreshCustomerBits(); refreshBasket(); } }, label)));
  N.addrField.hidden = d.type !== 'delivery';
  drawAddrPicker();
  const known = d.customerId && S.customers.find(c => c.id === d.customerId);
  const st = known && custStats().get(known.id);
  N.known.replaceChildren(...(known ? [el('div', { class: 'known' },
    el('span', { text: 'Returning customer' + (st ? ` · ${st.n} order${st.n === 1 ? '' : 's'} · last ${ago(st.last)}` : '') }),
    el('button', { class: 'link', type: 'button', onclick: () => { d.customerId = null; refreshCustomerBits(); } }, 'Not them'))] : []));
  const nameQ = d.name.trim().toLowerCase(), phoneQ = d.phone.replace(/\s/g, '');
  let hits = [];
  if (!d.customerId && (nameQ.length >= 2 || phoneQ.length >= 3)) {
    hits = realCusts().filter(c => (nameQ.length >= 2 && (c.name || '').toLowerCase().includes(nameQ)) ||
      (phoneQ.length >= 3 && (c.phone || '').replace(/\s/g, '').includes(phoneQ))).slice(0, 5);
  }
  N.suggest.replaceChildren(...(hits.length ? [el('div', { class: 'suggest' }, hits.map(c =>
    el('button', { type: 'button', onclick: () => pickCustomer(c) }, el('span', { class: 'sg-name' }, avatar(c, 'sm'), el('span', { text: c.name })), el('span', { class: 'sub', text: c.phone || '' }))))] : []));
}
function addrSelect(id, value, onchange, withLegacy) {
  const list = addrList();
  const opts = [el('option', { value: '', text: list.length ? 'Choose address…' : 'No addresses yet' }),
    ...list.map(a => el('option', { value: a.name, text: `${a.name} — ${feeText(num(a.fee))}${a.feePizza !== '' && a.feePizza != null ? ' · 🍕 ' + feeText(num(a.feePizza)) : ''}` }))];
  if (withLegacy && value && !list.some(a => a.name === value)) opts.push(el('option', { value, text: value + ' (not in your list)' }));
  const sel = el('select', { id, onchange: e => onchange(e.target.value) }, opts);
  sel.value = value || '';
  return sel;
}
function drawAddrPicker() {
  const d = S.draft;
  if (d.address && addrFee(d.address) === null) d.address = '';
  N.addrField.replaceChildren(...[el('label', { for: 'o-addr', text: 'Delivery address' }),
    addrSelect('o-addr', d.address, v => { d.address = v; refreshBasket(); }),
    addrList().length ? null : el('div', { class: 'sub' }, 'Add your delivery addresses in ', el('button', { class: 'link', type: 'button', onclick: () => settingsModal() }, 'Settings'), '.')].filter(Boolean));
}
function pickCustomer(c) {
  Object.assign(S.draft, { customerId: c.id, name: c.name || '', phone: c.phone || '', address: addrFee(c.address) !== null ? c.address : '' });
  $('#o-name').value = S.draft.name; $('#o-phone').value = S.draft.phone;
  refreshCustomerBits(); refreshBasket();
}
function menuCats(list) {
  return ['All', ...new Set(orderedMenu(list).map(m => m.category || 'Other'))];
}
function refreshGrid() {
  const cats = menuCats(S.menu);
  if (!cats.includes(S.pickCat)) S.pickCat = 'All';
  N.chips.replaceChildren(...cats.map(c => el('button', { class: 'chip', type: 'button', 'aria-pressed': S.pickCat === c, onclick: () => { S.pickCat = c; refreshGrid(); } }, c)));
  const items = sortedMenu().filter(m => S.pickCat === 'All' || (m.category || 'Other') === S.pickCat);
  if (!items.length) { N.grid.replaceChildren(el('div', { class: 'empty' }, el('b', { text: 'The menu is empty' }), 'Add dishes in the Menu section first.')); return; }
  const inBasket = new Map();
  for (const l of S.draft.lines) inBasket.set(l.menuId, (inBasket.get(l.menuId) || 0) + l.qty);
  N.grid.replaceChildren(...items.map(m => el('button', { class: 'mi' + (inBasket.has(m.id) ? ' picked' : ''), type: 'button', disabled: m.available === false, onclick: () => addItem(m) },
    thumb(m), el('div', { class: 'info' }, el('b', { text: m.name }), el('span', { text: m.available === false ? 'Not available' : priceText(m) })),
    inBasket.has(m.id) ? el('span', { class: 'cnt', text: '×' + inBasket.get(m.id) }) : el('span', { class: 'plus', 'aria-hidden': 'true', text: '+' }))));
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
  refreshBasket(); refreshGrid();
}
function totals() {
  const d = S.draft, sub = d.lines.reduce((a, l) => a + l.price * l.qty, 0);
  const fee = d.type === 'delivery' && d.lines.length ? (addrFee(d.address, draftPizza()) || 0) : 0;
  return { sub, fee, total: sub + fee };
}
function refreshBasket() {
  const d = S.draft, t = totals();
  const lines = d.lines.map((l, i) => el('div', { class: 'bl' },
    el('div', { class: 'nm' }, l.name, l.variant ? el('small', { text: ' · ' + l.variant }) : null),
    el('div', { class: 'pr', text: money(l.price * l.qty) }),
    el('div', { class: 'qty' },
      el('button', { type: 'button', 'aria-label': 'One less', onclick: () => { l.qty--; if (l.qty <= 0) d.lines.splice(i, 1); refreshBasket(); refreshGrid(); } }, '−'),
      el('span', { text: l.qty }),
      el('button', { type: 'button', 'aria-label': 'One more', onclick: () => { l.qty++; refreshBasket(); refreshGrid(); } }, '+')),
    el('button', { class: 'link', type: 'button', style: 'justify-self:end', onclick: () => { d.lines.splice(i, 1); refreshBasket(); refreshGrid(); } }, 'Remove')));
  const feeInput = d.type === 'delivery' ? el('div', { class: 'sum', id: 'b-fee' }, el('span', { text: 'Delivery' + (d.address ? ' · ' + d.address : '') }),
    el('span', { text: d.address ? feeText(addrFee(d.address, draftPizza()) || 0) : 'choose address' })) : null;
  N.basket.replaceChildren(
    el('h2', { text: 'Order' }),
    ...(d.lines.length ? lines : [el('div', { class: 'basket-empty' })]),
    el('div', { class: 'sum' }, el('span', { text: 'Items' }), el('span', { text: money(t.sub) })),
    feeInput,
    el('div', { class: 'sum total' }, el('span', { text: 'Total' }), el('span', { id: 'b-total', text: money(t.total) })),
    el('div', { class: 'field', style: 'margin:10px 0' }, el('label', { for: 'o-note', text: 'Note for the kitchen' }),
      el('textarea', { id: 'o-note', value: d.note, placeholder: 'Less spicy, extra raita…', oninput: e => { d.note = e.target.value; } })),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
      el('button', { class: 'btn primary', id: 'b-save', type: 'button', disabled: !d.lines.length, onclick: saveOrder }, d.editId ? 'Save changes' : 'Save order'),
      d.editId
        ? el('button', { class: 'btn', type: 'button', onclick: () => { S.draft = newDraft(); go('orders'); } }, 'Cancel')
        : el('button', { class: 'btn', type: 'button', onclick: () => { S.draft = newDraft(); $('#main').replaceChildren(); viewNew($('#main')); } }, 'Clear')));
  drawWhen();
}
/* time windows: a dish may list the windows it is served in; the order offers the windows all its dishes share */
const winLabel = w => `${w.from}–${w.to}`;
function orderWindows() {
  const withWin = S.draft.lines.map(l => M.menu.get(l.menuId)).filter(m => m && Array.isArray(m.windows) && m.windows.length);
  const all = new Map();
  for (const m of (withWin.length ? withWin : S.menu)) for (const w of (m.windows || [])) all.set(winLabel(w), w);
  let list = [...all.keys()];
  if (withWin.length) list = list.filter(lbl => withWin.every(m => m.windows.some(w => winLabel(w) === lbl)));
  return { list: list.sort(), clash: withWin.length > 0 && !list.length };
}
function drawWhen() {
  const d = S.draft;
  if (!d.slotDate) d.slotDate = isoDay(Date.now());
  const { list, clash } = orderWindows();
  if (d.slot && !list.includes(d.slot)) d.slot = '';
  const dates = [0, 1, 2, 3, 4, 5, 6].map(i => isoDay(Date.now() + i * DAY));
  N.when.replaceChildren(el('label', { class: 'lbl', text: d.type === 'delivery' ? 'Delivery time' : 'Pickup time' }),
    el('div', { class: 'when-row' },
      el('select', { id: 'o-day', 'aria-label': 'Day', onchange: e => { d.slotDate = e.target.value; } }, dates.map(x => el('option', { value: x, text: dayLabel(x), selected: x === d.slotDate }))),
      el('select', { id: 'o-slot', 'aria-label': 'Time', onchange: e => { d.slot = e.target.value; } },
        el('option', { value: '', text: list.length ? 'Any time / ASAP' : 'ASAP (no time windows set)' }),
        list.map(x => el('option', { value: x, text: x, selected: x === d.slot })))),
    clash ? el('div', { class: 'sub warn', text: 'These dishes have no time window in common.' }) : null);
  const day = $('#o-day', N.when); if (day) day.value = d.slotDate;
}
async function saveOrder() {
  const d = S.draft;
  if (!d.lines.length) return;
  const btn = $('#b-save'); btn.disabled = true;
  const now = Date.now(), name = d.name.trim(), phone = d.phone.trim(), addr = d.type === 'delivery' ? d.address : '';
  if (d.type === 'delivery' && addrFee(addr) === null) { btn.disabled = false; toast('Choose a delivery address (or switch to Pickup).', true); $('#o-addr') && $('#o-addr').focus(); return; }
  let cid = d.customerId;
  if (!cid && (name || phone)) {
    const ph = phone.replace(/\s/g, '');
    const found = ph && realCusts().find(c => (c.phone || '').replace(/\s/g, '') === ph);
    if (found) cid = found.id;
    else {
      cid = newId();
      if (!await write(Store.put('customers', { id: cid, name: name || 'Customer', phone, address: addr, notes: '', createdAt: now }))) { btn.disabled = false; return; }
    }
  } else if (cid) {
    const c = S.customers.find(x => x.id === cid);
    if (c && addr && c.address !== addr) await write(Store.patch('customers', cid, { address: addr }));
  }
  const t = totals();
  const items = d.lines.map(l => { const m = M.menu.get(l.menuId) || {}; return { menuId: l.menuId, name: l.name, variant: l.variant, price: l.price, qty: l.qty, kitchen: m.kitchen === 'pizza' ? 'pizza' : 'other', ing: clone(m.ingredients || []) }; });

  if (d.editId) {
    // editing: start from the order exactly as it is, and only change what the form controls —
    // status, payment, delivery proof, refund, timestamps and everything else carry over untouched
    const orig = S.orders.find(x => x.id === d.editId);
    if (!orig) { btn.disabled = false; toast('That order no longer exists.', true); S.draft = newDraft(); go('orders'); return; }
    const patched = Object.assign({}, orig, {
      customerId: cid || null, customerName: name || 'Walk-in', phone, address: addr, type: d.type,
      items, subtotal: t.sub, fee: t.fee, total: t.total, note: d.note.trim(),
      slotDate: d.slotDate, slot: d.slot || '', slotTouched: true,
      editedAt: now, editTouched: true,
    });
    if (await write(Store.put('orders', patched), `Order ${orderNo(orig.no)} updated`)) {
      S.draft = newDraft(); go('orders');
    } else btn.disabled = false;
    return;
  }

  const no = nextNo();
  const order = {
    id: newId(), no, customerId: cid || null, customerName: name || 'Walk-in', phone, address: addr, type: d.type,
    items, subtotal: t.sub, fee: t.fee, total: t.total, note: d.note.trim(), status: 'accepted', createdAt: now,
  };
  if (d.slot || (d.slotDate && d.slotDate !== isoDay(now))) Object.assign(order, { slotDate: d.slotDate, slot: d.slot || '', slotTouched: true });
  if (await write(Store.put('orders', order), `Order ${orderNo(no)} saved`)) {
    S.draft = newDraft(); S.ordFilter = 'open'; go('orders');
  } else btn.disabled = false;
}
/* open an existing order in the New-order form, pre-filled, to change it. Only the fields the
   form controls change on save (customer, items, type, address, note, time) — status, payment,
   delivery proof and refund stay exactly as they were. */
function editOrder(o) {
  const lines = (o.items || []).map(it => ({ menuId: it.menuId, name: it.name || '', variant: it.variant || '', price: num(it.price), qty: Math.max(1, num(it.qty) || 1) }));
  S.draft = Object.assign(newDraft(), {
    editId: o.id, customerId: o.customerId || null,
    name: o.customerName && o.customerName !== 'Walk-in' ? o.customerName : '', phone: o.phone || '', address: o.address || '',
    type: o.type || 'delivery', note: o.note || '', slotDate: o.slotDate || isoDay(o.createdAt), slot: o.slot || '', lines,
  });
  closeModal(); go('new');
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
    S.menu.length > 1 ? el('button', { class: 'btn', type: 'button', id: 'm-arrange', onclick: arrangeSheet }, 'Arrange') : null,
    el('button', { class: 'btn primary', type: 'button', onclick: () => menuModal(null) }, '+ Add', el('span', { class: 'hide-m', text: ' dish' }))));
  const samples = S.menu.filter(m => m.example);
  if (samples.length) root.append(el('div', { class: 'banner slim' }, el('span', { text: `${samples.length} sample dishes with made-up prices.` }),
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
/* put the dishes in the order the shop shows them: categories and the dishes inside them */
function arrangeSheet() {
  const groups = [];
  for (const m of orderedMenu(S.menu)) { const c = m.category || 'Other'; let g = groups.find(x => x.cat === c); if (!g) groups.push(g = { cat: c, items: [] }); g.items.push(m); }
  const list = el('div', { class: 'arr-list' });
  const mv = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; draw(); };
  const btns = (arr, i, what) => el('span', { class: 'arr-mv' },
    el('button', { type: 'button', class: 'btn small', 'aria-label': `Move ${what} up`, disabled: i === 0, onclick: () => mv(arr, i, -1) }, '▲'),
    el('button', { type: 'button', class: 'btn small', 'aria-label': `Move ${what} down`, disabled: i === arr.length - 1, onclick: () => mv(arr, i, 1) }, '▼'));
  function draw() {
    list.replaceChildren(...groups.flatMap((g, gi) => [
      el('div', { class: 'arr-cat', 'data-cat': g.cat }, el('b', { text: g.cat }), btns(groups, gi, g.cat)),
      ...g.items.map((m, i) => el('div', { class: 'arr-row', 'data-id': m.id }, thumb(m, 'arr-th'), el('span', { class: 'arr-nm', text: m.name }), btns(g.items, i, m.name)))]));
  }
  draw();
  async function save(e) {
    e.currentTarget.disabled = true;
    let n = 0;
    try {
      for (const g of groups) for (const m of g.items) { n++; if (m.sort !== n || !m.sortTouched) await Store.patch('menu', m.id, { sort: n, sortTouched: true }); }
      closeModal(); toast('Menu order saved');
    } catch (x) { toast('Could not save: ' + ((x && x.message) || x), true); e.currentTarget.disabled = false; }
  }
  openModal(el('div', { class: 'sheet arrange' }, el('h2', { text: 'Arrange the menu' }),
    el('div', { class: 'sub', text: 'This is the order your customers see: categories first, then the dishes inside each one.' }), list,
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), el('button', { class: 'btn primary', type: 'button', id: 'arr-save', onclick: save }, 'Save order'))));
}
function menuResults(root) {
  const q = S.menuQ.trim().toLowerCase();
  const items = sortedMenu().filter(m => (S.menuCat === 'All' || (m.category || 'Other') === S.menuCat) && (!q || (m.name || '').toLowerCase().includes(q)));
  const by = new Map();
  for (const m of items) { const c = m.category || 'Other'; if (!by.has(c)) by.set(c, []); by.get(c).push(m); }
  if (!items.length) root.append(el('div', { class: 'empty' }, el('b', { text: 'No dishes match' }), 'Try another word.'));
  for (const [c, arr] of by) {
    root.append(el('h2', { class: 'cat-title' }, c, el('span', { text: arr.length + (arr.length === 1 ? ' dish' : ' dishes') })));
    root.append(el('div', { class: 'mlist' }, arr.map(m => el('div', { class: 'mrow' + (m.available === false ? ' off' : ''), tabindex: '0', onclick: e => { if (!e.target.closest('button, label, input')) dishView(m); } },
      thumb(m, ''),
      el('div', {}, el('div', { class: 'nm', text: m.name + (m.service === 'night' ? ' 🌙' : ' ☀') + (m.kitchen === 'pizza' ? ' 🍕' : '') }),
        dishRating(m.id) ? el('div', { class: 'pr', text: dishRating(m.id) }) : null,
        (m.ingredients || []).length ? el('div', { class: 'pr', text: '🧂 ' + m.ingredients.map(g => g.item).join(', ') }) : null,
        el('div', { class: 'pr', text: (m.variants || []).map(v => (v.label ? v.label + ' ' : '') + money(v.price)).join(' · ') }),
        (m.windows || []).length ? el('div', { class: 'pr', text: '🕒 ' + m.windows.map(winLabel).join(', ') }) : null),
      el('div', { class: 'ctl' },
        el('button', { class: 'btn small', type: 'button', onclick: () => menuModal(m) }, 'Edit'),
        el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: m.available !== false, 'aria-label': 'Available', onchange: e => write(Store.patch('menu', m.id, { available: e.target.checked })) }), 'Available'))))));
  }
}
async function shrinkPhoto(file, max = 800, webp = true) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) {
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('That file is not a picture this phone can read.')); im.src = URL.createObjectURL(file); });
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const k = Math.min(1, max / Math.max(w, h));
  const cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  const blob = webp ? await new Promise(r => cv.toBlob(r, 'image/webp', 0.8)) : null;
  if (blob && blob.type === 'image/webp') return blob;
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.8)); // Safari cannot make WebP; JPEG instead
}
function menuModal(item) {
  const m = item ? clone(item) : { name: '', category: '', description: '', variants: [{ label: '', price: '' }], photo: '', available: true };
  if (!m.variants || !m.variants.length) m.variants = [{ label: '', price: '' }];
  const oldPhoto = m.photo || '';
  m.windows = Array.isArray(m.windows) ? clone(m.windows) : [];
  m.service = m.service === 'night' ? 'night' : 'day';
  m.ingredients = Array.isArray(m.ingredients) ? clone(m.ingredients) : [];
  m.kitchen = m.kitchen === 'pizza' || (!item && /pizza/i.test(m.category || '')) ? 'pizza' : 'other';
  const allStock = stockList();
  const inv = () => allStock.filter(x => x.kitchen === m.kitchen);
  const invDl = el('datalist', { id: 'inv-items' });
  const drawDl = () => invDl.replaceChildren(...inv().map(x => el('option', { value: x.name })));
  const ibox = el('div', { class: 'ing-list' });
  const drawIng = () => ibox.replaceChildren(...m.ingredients.map((g, i) => {
    const unit = (allStock.find(x => x.key === stockKey(m.kitchen, g.item)) || {}).unit || '';
    return el('div', { class: 'ing-row' },
      el('input', { value: g.item, list: 'inv-items', placeholder: 'Ingredient', 'aria-label': 'Ingredient', oninput: e => { g.item = e.target.value; } }),
      el('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: g.qty, 'aria-label': 'Amount per dish', oninput: e => { g.qty = e.target.value; } }),
      el('span', { class: 'ing-unit', text: unit || '×' }),
      el('button', { class: 'x', type: 'button', 'aria-label': 'Remove ingredient', onclick: () => { m.ingredients.splice(i, 1); drawIng(); } }, '✕'));
  }), ...(m.ingredients.length ? [] : [el('div', { class: 'sub', text: 'No ingredients yet.' })]));
  drawIng(); drawDl();
  const kitSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Kitchen' });
  const drawKit = () => kitSeg.replaceChildren(...[['pizza', KITCH.pizza], ['other', KITCH.other]].map(([k, l]) =>
    el('button', { type: 'button', id: 'f-kit-' + k, 'aria-pressed': m.kitchen === k, onclick: () => { m.kitchen = k; drawKit(); drawDl(); drawIng(); } }, l)));
  drawKit();
  const svcSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Day or night' });
  const drawSvc = () => svcSeg.replaceChildren(...[['day', SVC.day], ['night', SVC.night]].map(([k, l]) =>
    el('button', { type: 'button', id: 'f-svc-' + k, 'aria-pressed': m.service === k, onclick: () => { m.service = k; drawSvc(); } }, l)));
  drawSvc();
  let newBlob = null, previewUrl = '';
  const wbox = el('div', { class: 'win-list' });
  const drawWins = () => wbox.replaceChildren(...m.windows.map((w, i) => el('div', { class: 'win-row' },
    el('input', { type: 'time', value: w.from, 'aria-label': 'From', oninput: e => { w.from = e.target.value; } }), el('span', { text: 'to' }),
    el('input', { type: 'time', value: w.to, 'aria-label': 'To', oninput: e => { w.to = e.target.value; } }),
    el('button', { class: 'x', type: 'button', 'aria-label': 'Remove time window', onclick: () => { m.windows.splice(i, 1); drawWins(); } }, '✕'))));
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
    const windows = m.windows.filter(w => w.from && w.to);
    if (windows.some(w => w.from >= w.to)) return toast('A time window ends before it starts.', true);
    const rec = { id: item ? item.id : newId(), name, category: (m.category || '').trim() || 'Other', description: (m.description || '').trim(), variants, photo, available: m.available !== false, example: false,
      windows, winTouched: !!(windows.length || (item && item.winTouched)),
      ingredients: m.ingredients.map(g => ({ item: (g.item || '').trim(), qty: g.qty === '' || g.qty == null ? 1 : Math.max(0, Number(g.qty) || 0) })).filter(g => g.item),
      ingTouched: !!(m.ingredients.length || (item && item.ingTouched)),
      service: m.service, svcTouched: !!(m.service === 'night' || (item && item.svcTouched)),
      kitchen: m.kitchen, kitTouched: !!(m.kitchen === 'pizza' || (item && item.kitTouched)),
      sort: item && item.sort != null ? item.sort : null, sortTouched: !!(item && item.sortTouched) };
    if (await write(Store.put('menu', rec, extra), 'Saved')) closeModal();
  }
  drawVariants(); drawPhoto(); drawWins();
  const sheet = el('div', { class: 'sheet' }, el('h2', { text: item ? 'Edit dish' : 'Add dish' }),
    photoBox, status,
    el('div', { class: 'field' }, el('label', { for: 'f-name', text: 'Name' }), el('input', { id: 'f-name', value: m.name, oninput: e => { m.name = e.target.value; } })),
    el('div', { class: 'field' }, el('label', { for: 'f-cat', text: 'Category' }), el('input', { id: 'f-cat', list: 'cats', value: m.category, placeholder: 'Pizza, Curries, Breads, Drinks…', oninput: e => { m.category = e.target.value; } }), dl),
    el('div', { class: 'field' }, el('label', { for: 'f-desc', text: 'Description (optional)' }), el('textarea', { id: 'f-desc', value: m.description || '', oninput: e => { m.description = e.target.value; } })),
    el('div', {}, el('div', { class: 'sub', style: 'margin-bottom:6px', text: 'Prices. Add a row for each size (small, medium, large).' }), vbox,
      el('button', { class: 'link', type: 'button', style: 'margin-top:8px', onclick: () => { m.variants.push({ label: '', price: '' }); drawVariants(); } }, '+ Add another size')),
    el('div', {}, el('div', { class: 'sub', style: 'margin-bottom:6px', text: 'Time windows (optional). When this dish can be delivered or picked up, e.g. 12:00 to 14:00. Leave empty for any time.' }), wbox,
      el('button', { class: 'link', type: 'button', style: 'margin-top:8px', onclick: () => { m.windows.push({ from: '12:00', to: '14:00' }); drawWins(); } }, '+ Add time window')),
    el('div', {}, el('div', { class: 'sub', style: 'margin-bottom:6px', text: 'Ingredients (from your inventory). Customers see them, and each delivered dish takes them out of stock. Amount = per one dish.' }),
      ibox, invDl, el('button', { class: 'link', type: 'button', style: 'margin-top:8px', id: 'f-ing-add', onclick: () => { m.ingredients.push({ item: '', qty: 1 }); drawIng(); const ins = ibox.querySelectorAll('.ing-row input:not([type=number])'); if (ins.length) ins[ins.length - 1].focus(); } }, '+ Add ingredient'),
      el('div', { class: 'sub', text: 'Suggestions come from this dish\'s kitchen stock in Inventory.' })),
    el('div', { class: 'field' }, el('label', { text: 'Kitchen (which stock it uses, which delivery fee)' }), kitSeg),
    el('div', { class: 'field' }, el('label', { text: 'Sold during' }), svcSeg,
      el('div', { class: 'sub', text: 'Day and night dishes are ordered separately, and orders are split into Day / Night.' })),
    el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: m.available !== false, onchange: e => { m.available = e.target.checked; } }), 'Available today'),
    item ? reviewsBox(item.id) : null,
    el('div', { class: 'actions' },
      item ? confirmBtn('Delete dish', 'Delete for good?', async () => { if (await write(Store.remove('menu', item.id, photoDelOp(oldPhoto)), 'Dish deleted')) closeModal(); }, 'danger left') : null,
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', id: 'f-save', onclick: save }, 'Save dish')));
  openModal(sheet);
}

/* ---------- STOCK: bought (Inventory) minus used (delivered orders x dish ingredients) ---------- */
const ingKey = n => String(n || '').trim().toLowerCase();
const KITCH = { pizza: '🍕 Pizza', other: '🍛 Others' };
const stockKey = (kitchen, name) => (kitchen === 'pizza' ? 'pizza' : 'other') + ':' + ingKey(name);
/* stock is kept per kitchen: Chicken (Pizza) and Chicken (Others) are separate. Expenses (gas…) are not stock. */
function stockList() {
  const by = new Map();
  const get = (kitchen, name) => { const k = stockKey(kitchen, name); if (!by.has(k)) by.set(k, { key: k, kitchen: kitchen === 'pizza' ? 'pizza' : 'other', name: String(name).trim(), unit: '', bought: 0, used: 0, last: 0 }); return by.get(k); };
  for (const p of S.purchases) { if (!p.item || p.kind === 'expense') continue; const r = get(p.kind, p.item); r.bought += num(p.qty); const t = p.createdAt || 0; if (t >= r.last) { r.last = t; r.unit = p.unit || r.unit; r.name = p.item.trim(); } }
  for (const o of S.orders) {
    if (isCancelled(o) || o.status !== 'done') continue;
    for (const it of o.items || []) {
      const m = M.menu.get(it.menuId);
      const ing = Array.isArray(it.ing) ? it.ing : (m && !m.deleted ? m.ingredients || [] : []); // the recipe locked into the order, else today's recipe
      const kit = it.kitchen || (m && m.kitchen) || 'other';
      for (const g of ing) if (g.item) get(kit, g.item).used += num(g.qty) * num(it.qty);
    }
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const qtyText = n => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
/* ---------- REVIEWS (needs internet) ---------- */
let revTimer = 0;
function loadReviewsSoon(ms) { clearTimeout(revTimer); revTimer = setTimeout(loadReviews, ms == null ? 300 : ms); }
async function loadReviews() {
  if (!sb || !S.signedIn || S.notAdmin) return;
  try {
    const { data, error } = await sb.from('reviews').select('*').order('created_at', { ascending: false }).limit(1000);
    if (error) { S.reviewsOff = true; return; }
    S.reviewsOff = false; S.reviews = data || []; scheduleRender();
  } catch (_) { /* offline */ }
}
const reviewsOf = id => (S.reviews || []).filter(r => (r.dish_ids || []).includes(id));
function dishRating(id) {
  const rs = reviewsOf(id).filter(r => !r.hidden); if (!rs.length) return '';
  return `★ ${(rs.reduce((a, r) => a + r.stars, 0) / rs.length).toFixed(1)} (${rs.length})`;
}
const starStr = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
/* full-size photo on tap */
function openPhoto(src, alt) {
  const ov = el('div', { class: 'lightbox', id: 'lightbox', role: 'dialog', 'aria-label': alt || 'Photo', onclick: () => ov.remove() },
    el('img', { src, alt: alt || '' }), el('button', { class: 'lb-x', type: 'button', 'aria-label': 'Close' }, '✕'));
  document.body.append(ov);
}
/* first few, then "See all" */
function showSome(items, n, label) {
  const box = el('div', { class: 'rev-list' });
  const draw = all => box.replaceChildren(...(all ? items : items.slice(0, n)),
    !all && items.length > n ? el('button', { class: 'see-all', type: 'button', id: 'see-all', onclick: () => draw(true) }, `See all ${items.length} ${label} ›`) : '');
  draw(false);
  return box;
}
function reviewsBox(dishId) {
  const box = el('div', { class: 'rev-box' });
  const draw = () => {
    const rs = reviewsOf(dishId);
    box.replaceChildren(el('div', { class: 'sub', style: 'margin-bottom:6px', text: rs.length ? `Reviews · ${dishRating(dishId) || 'all hidden'}` : 'No reviews yet.' }),
      showSome(rs.map(r => el('div', { class: 'rev' + (r.hidden ? ' hidden' : '') },
        el('div', { class: 'rev-h' }, el('span', { class: 'stars', text: starStr(r.stars) }), el('b', { text: r.customer_name || 'Customer' }), el('small', { text: dateShort(Date.parse(r.created_at)) }),
          el('button', { class: 'link', type: 'button', onclick: async () => {
            const hidden = !r.hidden;
            try { const { error } = await sb.from('reviews').update({ hidden }).eq('id', r.id); if (error) throw error; r.hidden = hidden; draw(); toast(hidden ? 'Review hidden' : 'Review shown'); }
            catch (e) { toast('Could not change it: ' + ((e && e.message) || 'no internet?'), true); }
          } }, r.hidden ? 'Show' : 'Hide')),
        el('div', { class: 'rev-body' }, el('div', { class: 'rev-t', text: r.body || '' }),
          r.photo ? el('button', { class: 'rev-thumb', type: 'button', 'aria-label': 'Open photo', onclick: () => openPhoto(photoUrl(r.photo), 'Review photo') }, el('img', { src: photoUrl(r.photo), alt: '', loading: 'lazy' })) : null))), 3, 'reviews'));
  };
  draw();
  return box;
}
/* ---------- MESSAGES (one conversation per customer; needs internet) ---------- */
let msgTimer = 0, chatOpen = null;
function loadMsgsSoon(ms) { clearTimeout(msgTimer); msgTimer = setTimeout(loadMsgs, ms == null ? 300 : ms); }
async function loadMsgs() {
  if (!sb || !S.signedIn || S.notAdmin) return;
  try {
    const { data, error } = await sb.from('messages').select('*').order('created_at', { ascending: false }).limit(1500);
    if (error) { if (/messages|relation|schema cache/i.test(error.message || '')) { S.msgsOff = true; scheduleRender(); } return; }
    S.msgsOff = false; S.msgs = (data || []).reverse();
    if (chatOpen) chatOpen.draw();
    scheduleRender();
  } catch (_) { /* offline: try on the next sync */ }
}
const unreadAll = () => S.msgs.filter(m => !m.from_admin && !m.read_at).length;
function threadPhoto(clientId) { const c = S.customers.find(x => x.userId === clientId && !x.deleted); return c ? c.photo || '' : ''; }
function threadName(clientId) {
  const c = S.customers.find(x => x.userId === clientId);
  if (c) return c.name;
  const o = S.orders.filter(x => x.clientId === clientId).sort((a, b) => b.createdAt - a.createdAt)[0];
  return o ? o.customerName : 'Customer (no order yet)';
}
function threads() {
  const by = new Map();
  for (const m of S.msgs) { const t = by.get(m.client_id) || { id: m.client_id, last: null, unread: 0 }; t.last = m; if (!m.from_admin && !m.read_at) t.unread++; by.set(m.client_id, t); }
  return [...by.values()].sort((a, b) => (a.last.created_at < b.last.created_at ? 1 : -1));
}
function viewMessages(root) {
  root.append(pageHead('Messages', 'Chats with your shop customers.'));
  if (S.msgsOff) { root.append(el('div', { class: 'banner err' }, el('span', { text: 'Messages are not set up yet: run update-2.3.sql in Supabase.' }))); return; }
  if (!S.signedIn || navigator.onLine === false) root.append(el('div', { class: 'banner' }, el('span', { text: 'Messages need internet.' })));
  const list = threads();
  if (!list.length) { root.append(el('div', { class: 'empty' }, el('b', { text: 'No messages yet' }), 'When a customer writes from the shop, it shows up here.')); return; }
  root.append(el('div', { class: 'threads' }, list.map(t => {
    const name = threadName(t.id);
    return el('button', { class: 'thread' + (t.unread ? ' unread' : ''), type: 'button', onclick: () => chatSheet(t.id) },
      avatar({ name, photo: threadPhoto(t.id) }, 'sm'),
      el('span', { class: 'th-mid' }, el('b', { text: name }), el('small', { text: (t.last.from_admin ? 'You: ' : '') + (t.last.order_no ? orderNo(t.last.order_no) + ' · ' : '') + t.last.body })),
      el('span', { class: 'th-end' }, el('small', { text: ago(Date.parse(t.last.created_at)) }), t.unread ? el('span', { class: 'badge', text: t.unread }) : null));
  })));
}
function chatSheet(clientId, orderNoHint) {
  const name = threadName(clientId);
  const list = el('div', { class: 'chat-list' });
  const input = el('textarea', { id: 'chat-in', rows: 1, placeholder: 'Write a message…', maxlength: 1000 });
  let about = orderNoHint || null;
  const tag = el('div', { class: 'chat-about' });
  const drawTag = () => tag.replaceChildren(...(about ? [el('span', { text: 'About order ' + orderNo(about) }), el('button', { class: 'link', type: 'button', onclick: () => { about = null; drawTag(); } }, 'remove')] : []));
  async function markRead() {
    const ids = S.msgs.filter(m => m.client_id === clientId && !m.from_admin && !m.read_at).map(m => m.id);
    if (!ids.length) return;
    const now = new Date().toISOString();
    for (const m of S.msgs) if (ids.includes(m.id)) m.read_at = now;
    scheduleRender();
    try { await sb.from('messages').update({ read_at: now }).in('id', ids); } catch (_) { /* next time */ }
  }
  function draw() {
    const mine = S.msgs.filter(m => m.client_id === clientId);
    let lastDay = '';
    list.replaceChildren(...mine.flatMap(m => {
      const t = Date.parse(m.created_at), d = dateShort(t), out = [];
      if (d !== lastDay) { lastDay = d; out.push(el('div', { class: 'chat-day', text: d })); }
      out.push(el('div', { class: 'bubble ' + (m.from_admin ? 'me' : 'them') },
        m.order_no ? el('span', { class: 'b-order', text: orderNo(m.order_no) }) : null,
        el('span', { class: 'b-text', text: m.body }), el('small', { text: timeStr(t) + (m.from_admin && m.read_at ? ' · read' : '') })));
      return out;
    }));
    if (!mine.length) list.append(el('div', { class: 'sub', style: 'text-align:center;padding:20px', text: 'No messages yet. Say hello.' }));
    list.scrollTop = list.scrollHeight;
    markRead();
  }
  async function send() {
    const body = input.value.trim(); if (!body) return;
    const btn = $('#chat-send'); btn.disabled = true;
    try {
      const { data, error } = await sb.from('messages').insert({ client_id: clientId, body, from_admin: true, order_no: about }).select().single();
      if (error) throw error;
      S.msgs.push(data); input.value = ''; draw();
    } catch (e) { toast('Could not send: ' + ((e && e.message) || 'no internet?'), true); }
    btn.disabled = false; input.focus();
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  drawTag();
  openModal(el('div', { class: 'sheet chat' },
    el('div', { class: 'chat-head' }, avatar({ name, photo: threadPhoto(clientId) }, 'sm'), el('h2', { text: name }), el('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '✕')),
    list, tag,
    el('div', { class: 'chat-bar' }, input, el('button', { class: 'btn primary', type: 'button', id: 'chat-send', onclick: send }, 'Send'))));
  chatOpen = { clientId, draw };
  draw();
}

/* ---------- CUSTOMERS ---------- */
/* ---------- people pictures: change / remove, shown everywhere the customer shows ---------- */
async function shrinkSquare(file, size = 480) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('That file is not a picture this phone can read.')); im.src = URL.createObjectURL(file); }); }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, side = Math.min(w, h), k = Math.min(1, size / side);
  const cv = document.createElement('canvas'); cv.width = cv.height = Math.round(side * k);
  cv.getContext('2d').drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, cv.width, cv.height);
  const webp = await new Promise(r => cv.toBlob(r, 'image/webp', 0.82));
  if (webp && webp.type === 'image/webp') return webp;
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
}
/* onChange({ blob }) for a new picture, onChange({ remove: true }) to clear it */
function picEditor(name, startPhoto, onChange) {
  let photo = startPhoto || '', prev = '';
  const box = el('div', { class: 'pic-edit' });
  const has = () => !!(prev || photo);
  function draw() {
    const av = prev ? el('img', { class: 'avatar big', src: prev, alt: '' }) : avatar({ name, photo }, 'big');
    box.replaceChildren(av, el('div', { class: 'pic-btns' },
      el('label', { class: 'btn small', style: 'text-align:center' }, has() ? 'Change photo' : 'Add photo',
        el('input', { type: 'file', accept: 'image/*', 'aria-label': 'Choose a photo', style: 'display:none', onchange: async e => {
          const f = e.target.files && e.target.files[0]; if (!f) return;
          try { const blob = await shrinkSquare(f); if (prev) URL.revokeObjectURL(prev); prev = URL.createObjectURL(blob); photo = ''; draw(); onChange({ blob }); }
          catch (x) { toast((x && x.message) || 'Could not read that photo.', true); }
        } })),
      has() ? el('button', { class: 'link', type: 'button', onclick: () => { if (prev) URL.revokeObjectURL(prev); prev = ''; photo = ''; draw(); onChange({ remove: true }); } }, 'Remove photo') : null));
  }
  draw();
  return box;
}
/* save a customer's picture (or clear it): the file is stored on this phone and uploaded with the next sync */
async function setCustPhoto(id, ch) {
  const cur = M.customers.get(id); if (!cur) return false;
  let photo = '';
  if (ch.blob) {
    photo = `${S.uid}/cust-${newId()}.${ch.blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
    try { await queuePhoto(photo, ch.blob); } catch (_) { toast('Could not store the photo on this device.', true); return false; }
  }
  const extra = cur.photo && cur.photo !== photo ? photoDelOp(cur.photo) : [];
  return write(Store.put('customers', Object.assign({}, cur, { photo, photoTouched: true }), extra), ch.remove ? 'Photo removed' : 'Photo saved');
}
/* the customer record behind a shop account: the customer you linked, or the profile the shop made for them */
const acctCust = a => [...M.customers.values()].find(c => !c.deleted && c.userId === a.user_id) || null;

function viewCustomers(root) {
  const accts = S.custTab === 'accounts';
  root.append(pageHead('Customers', accts ? 'Phone and email logins made in the shop.' : 'Everyone who has ordered, with what they like.',
    accts ? null : el('button', { class: 'btn primary', type: 'button', onclick: () => customerModal(null) }, '+ Add', el('span', { class: 'hide-m', text: ' customer' }))));
  root.append(el('div', { class: 'inv-tabs', role: 'group' }, [['list', 'Customers'], ['accounts', 'Shop accounts']].map(([k, l]) =>
    el('button', { type: 'button', id: 'ct-' + k, 'aria-pressed': (S.custTab || 'list') === k, onclick: () => { S.custTab = k; render(true); } }, l))));
  if (accts) return accountsView(root);
  const stats = custStats();
  const rc = realCusts();
  const regulars = rc.filter(c => (stats.get(c.id) || { n: 0 }).n >= 3).length;
  root.append(el('div', { class: 'tiles' }, tile('Customers', rc.length), tile('Regulars (3+)', regulars),
    tile('Repeat rate', rc.length ? Math.round(100 * rc.filter(c => (stats.get(c.id) || { n: 0 }).n >= 2).length / rc.length) + '%' : '–')));
  root.append(el('div', { class: 'field', style: 'margin-bottom:12px' }, el('input', { id: 'c-q', type: 'search', 'aria-label': 'Search customers', placeholder: 'Search by name, phone or address', value: S.custQ,
    oninput: e => { S.custQ = e.target.value; P.fn(); } })));
  const res = el('div');
  P.fn = () => { res.replaceChildren(); customerResults(res); renderNav(); };
  P.fn(); root.append(res);
}
/* Shop accounts: every phone / email login, with status, reset and delete (needs internet) */
const acctIdent = login => String(login || '').endsWith('@' + PHONE_DOMAIN) ? { icon: '📱', id: login.replace('@' + PHONE_DOMAIN, '') } : { icon: '✉', id: login || '' };
function accountsView(root) {
  const res = el('div', { id: 'acct-list' });
  root.append(el('div', { class: 'field', style: 'margin-bottom:12px' }, el('input', { id: 'acct-q', type: 'search', 'aria-label': 'Search accounts', placeholder: 'Search by number, email or name', value: S.acctQ || '',
    oninput: e => { S.acctQ = e.target.value; draw(); } })), res);
  function draw() {
    if (!S.accts) return;
    const q = (S.acctQ || '').trim().toLowerCase();
    const list = S.accts.filter(a => !q || [acctIdent(a.login).id, a.name].some(x => (x || '').toLowerCase().includes(q)));
    if (!list.length) { res.replaceChildren(el('div', { class: 'empty' }, el('b', { text: S.accts.length ? 'No one matches' : 'No shop accounts yet' }), S.accts.length ? 'Try another number or name.' : 'Accounts appear here when customers sign up in the shop.')); return; }
    res.replaceChildren(el('div', { class: 'sub', style: 'margin-bottom:8px', text: `${S.accts.length} account${S.accts.length === 1 ? '' : 's'}` }),
      el('div', { class: 'clist' + (list.length > 150 ? ' big' : '') }, ...list.map(a => {
        const d = acctIdent(a.login);
        return el('button', { class: 'crow acct-row', type: 'button', 'data-id': a.user_id, onclick: () => acctSheet(a) },
          avatar({ name: a.name || d.id, photo: (acctCust(a) || {}).photo || '' }),
          el('div', {}, el('div', { class: 'nm', text: (a.name || d.id) + (a.linked ? ' 🔗' : '') }), el('div', { class: 'meta' }, d.icon + ' ' + (a.name ? d.id + ' ' : ''), el('span', { class: 'vtag' + (a.verified ? ' ok' : ''), text: a.verified ? '✓ Verified' : 'Unverified' }))),
          el('div', { class: 'meta', style: 'text-align:right' }, a.orders ? `${a.orders} order${a.orders == 1 ? '' : 's'}` : 'No orders', el('br'), 'joined ' + dateShort(Date.parse(a.created_at))));
      })));
  }
  if (S.accts) draw(); else res.replaceChildren(el('div', { class: 'sub', text: 'Loading…' }));
  if (!sb || navigator.onLine === false) { if (!S.accts) res.replaceChildren(el('div', { class: 'empty' }, el('b', { text: 'Needs internet' }), 'Shop accounts load from the server.')); return; }
  loadAccts().then(draw, e => res.replaceChildren(el('div', { class: 'empty' }, el('b', { text: 'Could not load accounts' }),
    /shop_accounts/.test((e && e.message) || '') ? 'Run update-2.9.sql in Supabase first.' : ((e && e.message) || String(e)))));
}
async function loadAccts() {
  const { data, error } = await sb.rpc('shop_accounts');
  if (error) throw error;
  S.accts = data || [];
}
function acctSheet(a) {
  const d = acctIdent(a.login);
  const when = x => x ? dateShort(Date.parse(x)) + ' ' + timeStr(Date.parse(x)) : '—';
  const refresh = () => { if (S.view === 'customers') render(true); };
  const vbox = el('div', { class: 'acct-bits' });
  const drawV = () => vbox.replaceChildren(el('span', { class: 'vtag' + (a.verified ? ' ok' : ''), id: 'as-vtag', text: a.verified ? '✓ Verified' : 'Unverified' }),
    el('button', { class: 'link', type: 'button', id: 'as-verify', onclick: async () => {
      const { error } = await sb.rpc('set_account_verified', { p_user: a.user_id, p_verified: !a.verified });
      if (error) return toast('Could not change: ' + error.message, true);
      a.verified = !a.verified; drawV(); refresh(); toast(a.verified ? 'Marked verified' : 'Marked unverified');
    } }, a.verified ? 'Mark unverified' : 'Mark verified'));
  drawV();
  const row = (k, v) => el('div', { class: 'od-row' }, el('span', { class: 'sub', text: k }), el('b', { text: v }));
  const tgt = acctCust(a);
  const pic = tgt ? el('div', { id: 'as-pic' }, picEditor(tgt.name || d.id, tgt.photo, ch => { setCustPhoto(tgt.id, ch).then(ok => { if (ok) refresh(); }); }))
    : el('div', { class: 'sub', id: 'as-pic', text: 'A photo can be added after their first order.' });
  openModal(el('div', { class: 'sheet' },
    pic,
    el('h2', { text: d.icon + ' ' + d.id }),
    a.name ? el('div', { class: 'sub', text: a.linked ? 'Linked to ' + a.name : 'Typed at checkout: ' + a.name }) : null, vbox,
    el('section', { class: 'od-sect' }, row('Joined', when(a.created_at)), row('Last sign in', when(a.last_sign_in_at)),
      row('Orders', String(a.orders || 0)), a.last_order ? row('Last order', when(a.last_order)) : null),
    el('div', { class: 'btns' },
      el('button', { class: 'btn small', type: 'button', id: 'as-reset', onclick: () => resetPwSheet({ clientId: a.user_id, customerName: a.name, clientLogin: a.login }) }, '🔑 Reset password'),
      el('button', { class: 'btn small link-btn', type: 'button', id: 'as-link', onclick: () => linkSheet({ clientId: a.user_id, customerName: a.name }) }, a.linked ? '🔗 Linked · change' : '🔗 Link to customer'),
      a.linked && M.customers.get(a.customer_id) ? el('button', { class: 'btn small', type: 'button', onclick: () => customerModal(M.customers.get(a.customer_id)) }, 'Customer record') : null),
    el('div', { class: 'sub', style: 'margin-top:14px', text: 'Deleting removes this login, its chat and its reviews. Their orders stay, and so does the customer you linked. They are signed out within an hour.' }),
    el('div', { class: 'actions' },
      confirmBtn('Delete account', 'Tap again to delete', async () => {
        if (!sb || navigator.onLine === false) return toast('Needs internet.', true);
        const { error } = await sb.rpc('delete_shop_account', { p_user: a.user_id });
        if (error) return toast('Could not delete: ' + error.message, true);
        S.accts = (S.accts || []).filter(x => x.user_id !== a.user_id);
        closeModal(); toast('Account deleted'); Sync.soon(0); refresh();
      }, 'danger left'),
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'))));
}
function customerResults(root) {
  const stats = custStats();
  const q = S.custQ.trim().toLowerCase();
  const all = realCusts();
  const list = all.filter(c => !q || [c.name, c.phone, c.address].some(x => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => ((stats.get(b.id) || {}).last || 0) - ((stats.get(a.id) || {}).last || 0) || (a.name || '').localeCompare(b.name || ''));
  if (!list.length) { root.append(el('div', { class: 'empty' }, el('b', { text: all.length ? 'No one matches' : 'No customers yet' }), all.length ? 'Try another word.' : 'Customers are added automatically when you save an order with a name or phone number.')); return; }
  root.append(el('div', { class: 'clist' + (list.length > 150 ? ' big' : '') }, list.map(c => {
    const s = stats.get(c.id);
    return el('button', { class: 'crow', type: 'button', onclick: () => customerModal(c) },
      avatar(c),
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
  let newBlob = null, removed = false;
  const picBox = picEditor(m.name, c && c.photo, ch => { if (ch.blob) { newBlob = ch.blob; removed = false; } else { newBlob = null; removed = true; } });
  async function save() {
    if (!(m.name || '').trim() && !(m.phone || '').trim()) return toast('Add a name or phone number.', true);
    let photo = removed ? '' : (c ? (c.photo || '') : '');
    if (newBlob) {
      photo = `${S.uid}/cust-${newId()}.${newBlob.type === 'image/webp' ? 'webp' : 'jpg'}`;
      try { await queuePhoto(photo, newBlob); } catch (_) { return toast('Could not store the photo on this device.', true); }
    }
    const extra = c && c.photo && c.photo !== photo ? photoDelOp(c.photo) : [];
    const rec = { id: c ? c.id : newId(), name: (m.name || '').trim() || 'Customer', phone: (m.phone || '').trim(), address: (m.address || '').trim(), notes: (m.notes || '').trim(), photo, photoTouched: !!(photo || (c && c.photoTouched)), createdAt: c ? (c.createdAt || Date.now()) : Date.now() };
    if (await write(Store.put('customers', rec, extra), 'Saved')) closeModal();
  }
  openModal(el('div', { class: 'sheet' }, c ? el('div', { class: 'who-head' }, picBox, el('h2', { text: c.name })) : el('h2', { text: 'Add customer' }), c ? null : picBox,
    s ? el('div', { class: 'tiles', style: 'margin:0' }, tile('Orders', s.n), tile('Spent', money(s.spent)), tile('Last order', ago(s.last))) : null,
    favs.length ? el('div', {}, el('div', { class: 'sub', style: 'margin-bottom:6px', text: 'Usually orders' }), el('div', { class: 'favs' }, favs.map(([n, q]) => el('span', { class: 'tag', text: `${n} ×${q}` })))) : null,
    el('div', { class: 'row' }, field('k-name', 'Name', 'name'), field('k-phone', 'Phone', 'phone', null, { type: 'tel', inputmode: 'tel' })),
    el('div', { class: 'field' }, el('label', { for: 'k-addr', text: 'Delivery address' }), addrSelect('k-addr', m.address || '', v => { m.address = v; }, true)),
    field('k-notes', 'Notes (allergies, gate code…)', 'notes', 'textarea'),
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

/* ---------- INVENTORY: what was bought, when, how much ---------- */
const UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'pack', 'box', 'bag', 'dozen'];
const monthKey = day => day.slice(0, 7);
const monthLabel = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); };
/* ---------- DISH PAGE (same look as the shop; Edit opens the editor) ---------- */
function soldLast30(id) {
  const from = Date.now() - 30 * DAY;
  let n = 0;
  for (const o of S.orders) if (!isCancelled(o) && o.createdAt >= from) for (const it of o.items || []) if (it.menuId === id) n += num(it.qty);
  return n;
}
function dishView(m0) {
  const m = M.menu.get(m0.id) || m0;
  const vs = (m.variants || []).map(v => num(v.price)), lo = Math.min(...vs), hi = Math.max(...vs);
  const rs = reviewsOf(m.id).filter(r => !r.hidden), avg = rs.length ? rs.reduce((a, r) => a + r.stars, 0) / rs.length : 0;
  const good = rs.length ? Math.round(100 * rs.filter(r => r.stars >= 4).length / rs.length) : 0;
  const stock = new Map(stockList().map(r => [r.key, r]));
  const pic = m.photo ? el('img', { class: 'dd-img', src: photoUrl(m.photo), alt: m.name }) : el('div', { class: 'dd-img ph', style: '--h:' + hue(m.name), text: initial(m.name) });
  const sold = soldLast30(m.id);
  openModal(el('div', { class: 'sheet dd', id: 'dish-view' },
    el('div', { class: 'dd-top' }, el('button', { class: 'dd-round', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '⌄'),
      el('button', { class: 'btn small primary', type: 'button', id: 'dd-edit', onclick: () => menuModal(m) }, 'Edit')),
    el('div', { class: 'dd-scroll' }, el('div', { class: 'dd-hero' }, pic),
      el('div', { class: 'dd-price-card' },
        el('div', {}, el('div', { class: 'dd-price' }, el('small', { text: S.settings.currency || '' }), vs.length ? String(lo) : '', lo !== hi ? el('span', { class: 'dd-from', text: ` – ${hi}` }) : null),
          el('div', { class: 'dd-sold', text: `Sold ${sold} in the last 30 days` })),
        el('div', { class: 'dd-badge ' + (m.service === 'night' ? 'night' : 'day') }, el('b', { text: m.service === 'night' ? '🌙 Night' : '☀ Day' }), el('small', { text: m.available === false ? 'Sold out today' : 'Available' }))),
      el('div', { class: 'dd-card' }, el('h2', { class: 'dd-name', text: m.name }),
        el('div', { class: 'dd-tags' }, el('span', { class: 'dd-tag', text: KITCH[m.kitchen === 'pizza' ? 'pizza' : 'other'] + ' kitchen' }), el('span', { class: 'dd-tag', text: m.category || 'Other' }), ...(m.windows || []).map(w => el('span', { class: 'dd-tag blue', text: '🕒 ' + winLabel(w) })),
          ...(m.variants || []).filter(v => v.label).map(v => el('span', { class: 'dd-tag', text: `${v.label} ${money(v.price)}` }))),
        m.description ? el('p', { class: 'dd-desc', text: m.description }) : null),
      el('div', { class: 'dd-card' }, el('h3', { text: 'Ingredients' }),
        (m.ingredients || []).length ? el('div', { class: 'dd-grid' }, m.ingredients.map(g => { const st = stock.get(stockKey(m.kitchen, g.item)); const left = st ? st.bought - st.used : null;
          return el('div', { class: 'dd-cell' }, el('b', { text: g.item }), el('small', { text: `${qtyText(num(g.qty) || 1)} ${st ? st.unit : ''} per dish`.trim() }),
            left != null ? el('small', { class: left <= 0 ? 'bad' : '', text: `${qtyText(left)} ${st.unit} in stock`.trim() }) : null); }))
          : el('div', { class: 'sub', text: 'No ingredients yet. Tap Edit to add them.' })),
      el('div', { class: 'dd-card' }, el('div', { class: 'dd-rev-h' }, el('h3', { text: `Reviews (${rs.length})` }), rs.length ? el('span', { class: 'dd-good', text: `${good}% positive · ★ ${avg.toFixed(1)}` }) : null),
        reviewsBox(m.id))),
    el('div', { class: 'dd-bar' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'),
      el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: m.available !== false, onchange: e => write(Store.patch('menu', m.id, { available: e.target.checked })) }), 'Available'),
      el('button', { class: 'btn primary', type: 'button', onclick: () => menuModal(m) }, 'Edit dish'))));
}

/* ---------- INVENTORY: 🍕 Pizza and 🍛 Others, fuel gauges, days left, can-still-make, shopping list ---------- */
const INV_GROUPS = [['pizza', '🍕', 'Pizza'], ['other', '🍛', 'Others']];
const invCfg = key => ((S.settings.inventory || {})[key] || {});
function guessGroup(key) {
  const users = S.menu.filter(m => (m.ingredients || []).some(g => ingKey(g.item) === key));
  if (users.length && users.every(m => /pizza/i.test(m.category || '') || /pizza/i.test(m.name || ''))) return 'pizza';
  return 'other';
}
const groupOf = key => (key.startsWith('pizza:') ? 'pizza' : 'other');
function invStats() {
  const weekAgo = Date.now() - 7 * DAY;
  const used7 = new Map(), spent = new Map();
  for (const o of S.orders) {
    if (isCancelled(o) || o.status !== 'done' || (o.doneAt || o.createdAt) < weekAgo) continue;
    for (const it of o.items || []) { const m = M.menu.get(it.menuId); const ing = Array.isArray(it.ing) ? it.ing : (m ? m.ingredients || [] : []); const kit = it.kitchen || (m && m.kitchen) || 'other';
      for (const g of ing) { const k = stockKey(kit, g.item); used7.set(k, (used7.get(k) || 0) + num(g.qty) * num(it.qty)); } }
  }
  for (const p of S.purchases) { if (!p.item || p.kind === 'expense') continue; const k = stockKey(p.kind, p.item); spent.set(k, (spent.get(k) || 0) + num(p.cost)); }
  return stockList().map(r => {
    const left = r.bought - r.used, perDay = (used7.get(r.key) || 0) / 7, low = num(invCfg(r.key).low);
    const unitCost = r.bought ? (spent.get(r.key) || 0) / r.bought : 0;
    const lastBuy = S.purchases.filter(p => p.kind !== 'expense' && stockKey(p.kind, p.item) === r.key).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    const ref = Math.max(left, low * 3, lastBuy ? num(lastBuy.qty) : 0, 1);
    const state = left <= 0 ? 'out' : (low && left <= low) || (perDay && left / perDay < 2) ? 'low' : 'ok';
    return Object.assign({}, r, { left, perDay, low, days: perDay ? left / perDay : null, unitCost, value: Math.max(0, left) * unitCost, fill: Math.max(0, Math.min(1, left / ref)), state, group: groupOf(r.key) });
  });
}
function canMake(stats) {
  const by = new Map(stats.map(s => [s.key, s]));
  return S.menu.filter(m => (m.ingredients || []).length).map(m => {
    let n = Infinity, limit = '';
    for (const g of m.ingredients) { const st = by.get(stockKey(m.kitchen, g.item)); const q = num(g.qty) || 1; const k = st ? Math.floor(Math.max(0, st.left) / q) : 0; if (k < n) { n = k; limit = g.item; } }
    return { m, n: n === Infinity ? 0 : n, limit };
  }).sort((a, b) => a.n - b.n);
}
function viewInventory(root) {
  if (!S.invTab) S.invTab = 'stock';
  root.append(pageHead('Inventory', 'Stock, what runs out next, and what you bought.',
    el('button', { class: 'btn primary', type: 'button', onclick: () => purchaseModal(null) }, '+ Add', el('span', { class: 'hide-m', text: ' purchase' }))));
  root.append(el('div', { class: 'inv-tabs', role: 'group' }, [['stock', 'Stock'], ['buys', 'Purchases']].map(([k, l]) =>
    el('button', { type: 'button', id: 'inv-' + k, 'aria-pressed': S.invTab === k, onclick: () => { S.invTab = k; render(true); } }, l))));
  if (S.invTab === 'buys') return purchasesList(root);
  const stats = invStats();
  if (!stats.length) { root.append(el('div', { class: 'empty' }, el('b', { text: 'No stock yet' }), 'Add what you buy (pizza bases, chicken, flour…) with "+ Add purchase". Then add ingredients to your dishes, and every delivered order takes them out of stock.')); return; }
  const lowOnes = stats.filter(s => s.state !== 'ok');
  const value = stats.reduce((a, s) => a + s.value, 0);
  root.append(el('div', { class: 'inv-sum' },
    el('div', { class: 'inv-kpi' }, el('small', { text: 'Stock value' }), el('b', { text: money(Math.round(value)) })),
    el('div', { class: 'inv-kpi' + (lowOnes.length ? ' warn' : '') }, el('small', { text: 'Low or out' }), el('b', { text: String(lowOnes.length) })),
    el('button', { class: 'inv-shop', type: 'button', id: 'inv-shoplist', onclick: () => shoppingList(stats) }, '🛒', el('span', { text: 'Shopping list' }))));
  for (const [g, emoji, title] of INV_GROUPS) {
    const items = stats.filter(s => s.group === g);
    const lowN = items.filter(s => s.state !== 'ok').length;
    root.append(el('section', { class: 'inv-group ' + g, id: 'grp-' + g },
      el('div', { class: 'ig-head' }, el('span', { class: 'ig-emoji', text: emoji }), el('div', { class: 'ig-title' }, el('b', { text: title }), el('small', { text: `${items.length} ingredient${items.length === 1 ? '' : 's'} · ${money(Math.round(items.reduce((a, s) => a + s.value, 0)))}` })),
        lowN ? el('span', { class: 'ig-low', text: `${lowN} low` }) : el('span', { class: 'ig-ok', text: 'All good' })),
      items.length ? el('div', { class: 'ig-list' }, items.map(s => el('div', { class: 'ing ' + s.state, role: 'button', tabindex: '0', 'data-key': s.key, onclick: () => ingredientSheet(s.key) },
        el('div', { class: 'ing-top' }, el('b', { text: s.name }), el('span', { class: 'ing-left', text: `${qtyText(s.left)} ${s.unit}`.trim() })),
        el('div', { class: 'gauge' }, el('i', { style: `width:${Math.round(s.fill * 100)}%` })),
        el('div', { class: 'ing-meta' }, el('span', { text: s.state === 'out' ? 'Out of stock' : s.days != null ? `≈ ${s.days < 1 ? 'less than a day' : Math.floor(s.days) + ' day' + (Math.floor(s.days) === 1 ? '' : 's')} left` : 'Not used this week' }),
          el('button', { class: 'ing-plus', type: 'button', 'aria-label': 'Restock ' + s.name, onclick: e => { e.stopPropagation(); purchaseModal(null, { item: s.name, unit: s.unit, kind: s.kitchen }); } }, '+')))))
        : el('div', { class: 'sub', style: 'padding:6px 4px', text: g === 'pizza' ? 'Nothing yet. Add a purchase "For: 🍕 Pizza".' : 'Nothing yet. Add a purchase "For: 🍛 Others".' })));
  }
  const cm = canMake(stats);
  if (cm.length) root.append(el('section', { class: 'card can-make' }, el('h2', { text: 'Can still make' }),
    el('div', { class: 'sub', text: 'With what is in stock now. The ingredient in brackets runs out first.' }),
    el('div', { class: 'cm-list' }, cm.map(x => el('div', { class: 'cm-row' + (x.n === 0 ? ' zero' : x.n <= 5 ? ' few' : '') },
      el('span', { class: 'cm-n', text: String(x.n) }), el('span', { class: 'cm-nm' }, x.m.name, el('small', { text: ` (${x.limit})` })))))));
}
function shoppingList(stats) {
  const need = stats.filter(s => s.state !== 'ok');
  const lines = need.map(s => `• ${s.name} — ${qtyText(Math.max(0, s.left))} ${s.unit} left`.replace(/\s+left$/, ' left'));
  const text = need.length ? `🛒 Shopping list (${dateShort(Date.now())})\n` + lines.join('\n') : '';
  openModal(el('div', { class: 'sheet' }, el('h2', { text: '🛒 Shopping list' }),
    need.length ? el('pre', { class: 'shoplist', id: 'shoplist', text }) : el('div', { class: 'sub', text: 'Nothing is low. Set "Alert when below" on an ingredient to get it listed here.' }),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'),
      need.length ? el('button', { class: 'btn primary', type: 'button', onclick: () => copyText(text) }, 'Copy for WeChat') : null)));
}
function ingredientSheet(key) {
  const s = invStats().find(x => x.key === key); if (!s) return;
  const cfg = Object.assign({ low: s.low || '' }, invCfg(key));
  const buys = S.purchases.filter(p => p.kind !== 'expense' && stockKey(p.kind, p.item) === key).sort((a, b) => (b.day || '').localeCompare(a.day || ''));
  const usedBy = S.menu.filter(m => m.kitchen === s.kitchen && (m.ingredients || []).some(g => ingKey(g.item) === ingKey(s.name)));
  openModal(el('div', { class: 'sheet' }, el('h2', {}, s.name, el('span', { class: 'tag kit ' + s.kitchen, text: KITCH[s.kitchen] })),
    el('div', { class: 'ing-stats' },
      el('div', {}, el('small', { text: 'In stock' }), el('b', { class: s.state, text: `${qtyText(s.left)} ${s.unit}`.trim() })),
      el('div', {}, el('small', { text: 'Used / day' }), el('b', { text: s.perDay ? `${qtyText(Math.round(s.perDay * 100) / 100)} ${s.unit}`.trim() : '—' })),
      el('div', {}, el('small', { text: 'Avg price' }), el('b', { text: s.unitCost ? `${money(Math.round(s.unitCost * 100) / 100)}/${s.unit || 'unit'}` : '—' }))),
    el('div', { class: 'field' }, el('label', { for: 'ig-low', text: `Alert when below (${s.unit || 'units'})` }),
      el('input', { id: 'ig-low', type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: cfg.low, placeholder: 'e.g. 5', oninput: e => { cfg.low = e.target.value; } })),
    usedBy.length ? el('div', { class: 'sub', text: 'Used in: ' + usedBy.map(m => m.name).join(', ') }) : el('div', { class: 'sub', text: 'Not used in any dish yet.' }),
    buys.length ? el('div', { class: 'ing-buys' }, el('b', { text: 'Bought' }), buys.slice(0, 6).map(p => el('div', { class: 'od-row' }, el('span', { text: `${dayLabel(p.day)} · ${qtyText(num(p.qty))} ${p.unit || ''}` }), el('span', { text: money(p.cost) })))) : null,
    el('div', { class: 'actions' },
      el('button', { class: 'btn left', type: 'button', onclick: () => purchaseModal(null, { item: s.name, unit: s.unit, kind: s.kitchen }) }, '+ Restock'),
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'),
      el('button', { class: 'btn primary', type: 'button', id: 'ig-save', onclick: async () => {
        const inv = Object.assign({}, S.settings.inventory || {});
        inv[key] = { low: cfg.low === '' ? 0 : Math.max(0, Number(cfg.low) || 0) };
        if (await write(Store.put('settings', Object.assign({}, S.settings, { inventory: inv, invTouched: true })), 'Saved')) closeModal();
      } }, 'Save'))));
}
function purchasesList(root) {
  const list = S.purchases.slice().sort((a, b) => (b.day || '').localeCompare(a.day || '') || (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) { root.append(el('div', { class: 'empty' }, el('b', { text: 'No purchases yet' }), 'Add what you buy (meat, flour, gas…) with the cost and a photo of the receipt.')); return; }
  const thisMonth = monthKey(isoDay(Date.now()));
  const mSpent = list.filter(p => monthKey(p.day) === thisMonth).reduce((a, p) => a + num(p.cost), 0);
  root.append(el('div', { class: 'sumline' }, el('span', { text: monthLabel(thisMonth) }), el('b', { text: money(mSpent) + ' spent' })));
  const byDay = new Map();
  for (const p of list) { if (!byDay.has(p.day)) byDay.set(p.day, []); byDay.get(p.day).push(p); }
  for (const [day, arr] of byDay) {
    root.append(el('h2', { class: 'cat-title' }, dayLabel(day), el('span', { text: money(arr.reduce((a, p) => a + num(p.cost), 0)) })));
    root.append(el('div', { class: 'plist' }, arr.map(p => el('button', { class: 'prow', type: 'button', onclick: () => purchaseModal(p) },
      el('div', { class: 'p-main' }, el('div', { class: 'nm', text: p.item || 'Item' }),
        el('div', { class: 'meta', text: [p.qty ? `${p.qty} ${p.unit || ''}`.trim() : '', p.note].filter(Boolean).join(' · ') })),
      el('span', { class: 'tag kit ' + (p.kind || 'other'), text: p.kind === 'pizza' ? '🍕' : p.kind === 'expense' ? '🧾 Expense' : '🍛' }),
      (p.photos || []).length ? el('span', { class: 'tag', text: '📷 ' + p.photos.length }) : null,
      el('b', { class: 'p-cost', text: money(p.cost) })))));
  }
}
function purchaseModal(p0, pre) {
  const p = p0 ? clone(p0) : Object.assign({ day: isoDay(Date.now()), item: '', qty: '', unit: '', cost: '', note: '', photos: [], kind: '' }, pre || {});
  const lastKind = name => { const x = S.purchases.filter(q => ingKey(q.item) === ingKey(name)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]; return x ? x.kind : ''; };
  if (!p.kind) p.kind = 'other';
  const kindSeg = el('div', { class: 'seg kind-seg', role: 'group', 'aria-label': 'For' });
  const drawKind = () => kindSeg.replaceChildren(...[['pizza', '🍕 Pizza'], ['other', '🍛 Others'], ['expense', '🧾 Expense']].map(([k, l]) =>
    el('button', { type: 'button', id: 'p-kind-' + k, 'aria-pressed': p.kind === k, onclick: () => { p.kind = k; p.kindPicked = true; drawKind(); } }, l)));
  drawKind();
  const keep = (p.photos || []).slice(); const added = []; // {blob, url}
  const shots = el('div', { class: 'shots' });
  async function drawShots() {
    const items = [];
    for (const [i, path] of keep.entries()) {
      const src = await receiptSrc(path);
      items.push(el('div', { class: 'shot' }, src ? el('a', { href: src, target: '_blank', rel: 'noopener' }, el('img', { src, alt: 'Receipt' })) : el('div', { class: 'ph', text: '🧾' }),
        el('button', { class: 'x', type: 'button', 'aria-label': 'Remove picture', onclick: () => { keep.splice(i, 1); drawShots(); } }, '✕')));
    }
    added.forEach((a, i) => items.push(el('div', { class: 'shot' }, el('img', { src: a.url, alt: 'New receipt' }),
      el('button', { class: 'x', type: 'button', 'aria-label': 'Remove picture', onclick: () => { added.splice(i, 1); drawShots(); } }, '✕'))));
    items.push(el('label', { class: 'shot add' }, '+ Picture', el('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: async e => {
      for (const f of [...(e.target.files || [])]) { try { const b = await shrinkPhoto(f, 1600, false); added.push({ blob: b, url: URL.createObjectURL(b) }); } catch (_) { toast('Could not read one of the pictures.', true); } }
      drawShots();
    } })));
    shots.replaceChildren(...items);
  }
  const items = [...new Set(S.purchases.map(x => x.item).filter(Boolean))];
  const f = (id, label, key, attrs) => el('div', { class: 'field' }, el('label', { for: id, text: label }), el('input', Object.assign({ id, value: p[key] ?? '', oninput: e => { p[key] = e.target.value; } }, attrs)));
  async function save() {
    const item = (p.item || '').trim();
    if (!item) return toast('What did you buy?', true);
    if (p.cost === '' || !Number.isFinite(Number(p.cost))) return toast('Add how much it cost.', true);
    const photos = keep.slice();
    for (const a of added) { const path = `${S.uid}/receipt-${newId()}.jpg`; try { await queuePhoto(path, a.blob); photos.push(path); } catch (_) { return toast('Could not store a picture on this device.', true); } }
    const removed = (p0 && p0.photos || []).filter(x => !photos.includes(x));
    const rec = { id: p0 ? p0.id : newId(), day: p.day || isoDay(Date.now()), item, qty: num(p.qty), unit: (p.unit || '').trim(), cost: num(p.cost), note: (p.note || '').trim(), photos, createdAt: p0 ? p0.createdAt : Date.now(),
      kind: p.kind, kindTouched: !!(p.kind !== 'other' || (p0 && p0.kindTouched)) };
    if (await write(Store.put('purchases', rec, removed.flatMap(photoDelOp)), 'Saved')) closeModal();
  }
  drawShots();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: p0 ? 'Edit purchase' : 'Add purchase' }),
    f('p-day', 'Date', 'day', { type: 'date' }),
    el('div', { class: 'field' }, el('label', { for: 'p-item', text: 'Item' }), el('input', { id: 'p-item', list: 'p-items', value: p.item, placeholder: 'Chicken, flour, cooking gas…', oninput: e => { p.item = e.target.value; if (!p0 && !p.kindPicked && lastKind(p.item)) { p.kind = lastKind(p.item); drawKind(); } } }),
      el('datalist', { id: 'p-items' }, items.map(x => el('option', { value: x })))),
    el('div', { class: 'row' }, f('p-qty', 'Quantity', 'qty', { type: 'number', inputmode: 'decimal', min: '0', step: 'any' }),
      el('div', { class: 'field' }, el('label', { for: 'p-unit', text: 'Unit' }), el('input', { id: 'p-unit', list: 'p-units', value: p.unit, placeholder: 'kg, pcs…', oninput: e => { p.unit = e.target.value; } }),
        el('datalist', { id: 'p-units' }, UNITS.map(x => el('option', { value: x }))))),
    el('div', { class: 'field' }, el('label', { text: 'For' }), kindSeg,
      el('div', { class: 'sub', text: 'Pizza / Others = goes into that kitchen\'s stock. Expense = only counted as spending (gas, rent, transport…).' })),
    f('p-cost', `Total cost (${S.settings.currency || ''})`, 'cost', { type: 'number', inputmode: 'decimal', min: '0', step: 'any' }),
    f('p-note', 'Note (shop, who paid…)', 'note'),
    el('div', { class: 'field' }, el('label', { text: 'Receipt / screenshot pictures' }), shots),
    el('div', { class: 'actions' },
      p0 ? confirmBtn('Delete', 'Delete for good?', async () => { if (await write(Store.remove('purchases', p0.id, (p0.photos || []).flatMap(photoDelOp)), 'Deleted')) closeModal(); }, 'danger left') : null,
      el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', id: 'p-save', onclick: save }, 'Save'))));
}

/* ---------- STATISTICS: sales vs spending by day or month ---------- */
function statRows(mode) {
  const key = mode === 'months' ? (d => d.slice(0, 7)) : (d => d);
  const rows = new Map();
  const get = k => { if (!rows.has(k)) rows.set(k, { k, orders: 0, sales: 0, unpaid: 0, spent: 0 }); return rows.get(k); };
  for (const o of S.orders) { if (isCancelled(o) || isRefunded(o)) continue; const r = get(key(isoDay(o.createdAt))); r.orders++; r.sales += num(o.total); if (!o.paid) r.unpaid += num(o.total); }
  for (const p of S.purchases) { if (p.day) get(key(p.day)).spent += num(p.cost); }
  return rows;
}
function periods(mode) { // the last 14 days or 12 months, oldest first
  const out = [];
  if (mode === 'months') { const d = new Date(); d.setDate(1); for (let i = 11; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(x.getFullYear() + '-' + pad(x.getMonth() + 1)); } }
  else for (let i = 13; i >= 0; i--) out.push(isoDay(Date.now() - i * DAY));
  return out;
}
const periodLabel = (mode, k) => mode === 'months' ? new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1).toLocaleDateString(undefined, { month: 'short' }) : String(+k.slice(8, 10));
const periodLong = (mode, k) => mode === 'months' ? monthLabel(k) : dayLabel(k);
function viewStats(root) {
  const mode = S.statMode;
  root.append(pageHead('Statistics', 'Sales from orders against what you spent.'));
  root.append(el('div', { class: 'seg', role: 'group', 'aria-label': 'Group by', style: 'margin-bottom:12px' },
    [['days', 'Days'], ['months', 'Months']].map(([k, l]) => el('button', { type: 'button', 'aria-pressed': mode === k, onclick: () => { S.statMode = k; S.statPick = null; render(true); } }, l))));
  const rows = statRows(mode), ps = periods(mode);
  const data = ps.map(k => rows.get(k) || { k, orders: 0, sales: 0, unpaid: 0, spent: 0 });
  const cur = data[data.length - 1];
  // headline for the current day/month: plain numbers, no tiles
  root.append(el('div', { class: 'headline' },
    el('span', { class: 'sub', text: mode === 'months' ? 'This month' : 'Today' }),
    el('span', {}, el('b', { text: money(cur.sales) }), ' sales'), el('span', {}, el('b', { text: money(cur.spent) }), ' spent'),
    el('span', {}, el('b', { class: cur.sales - cur.spent < 0 ? 'neg' : '', text: money(cur.sales - cur.spent) }), ' net')));
  root.append(chart(mode, data));
  // table: every period that has something, newest first
  const all = [...rows.values()].sort((a, b) => b.k.localeCompare(a.k)).slice(0, mode === 'months' ? 24 : 60);
  if (!all.length) { root.append(el('div', { class: 'empty' }, el('b', { text: 'Nothing to show yet' }), 'Orders and purchases will appear here.')); return; }
  root.append(el('div', { class: 'table-wrap' }, el('table', { class: 'stat-table' },
    el('thead', {}, el('tr', {}, ['', 'Orders', 'Sales', 'Spent', 'Net'].map(h => el('th', { text: h })))),
    el('tbody', {}, all.map(r => el('tr', { class: S.statPick === r.k ? 'pick' : '' },
      el('td', {}, periodLong(mode, r.k)), el('td', { text: r.orders }),
      el('td', {}, money(r.sales), r.unpaid ? el('small', { text: ` (${money(r.unpaid)} unpaid)` }) : null),
      el('td', { text: money(r.spent) }), el('td', { class: r.sales - r.spent < 0 ? 'neg' : '', text: money(r.sales - r.spent) })))))));
}
function chart(mode, data) {
  // draw at the real on-screen width so the axis text stays readable on a phone
  const W = Math.round(Math.max(300, Math.min(760, (($('#main') || document.body).clientWidth || 640) - 54))), H = 200, padL = 44, padB = 22, padT = 10, padR = 6;
  const max = Math.max(1, ...data.map(d => Math.max(d.sales, d.spent)));
  const step = Math.pow(10, Math.floor(Math.log10(max))); const top = Math.ceil(max / step) * step;
  const y = v => padT + (H - padT - padB) * (1 - v / top);
  const gw = (W - padL - padR) / data.length, bw = Math.max(3, Math.min(14, gw / 2 - 3));
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Sales and spending, last ${data.length} ${mode}` });
  for (let i = 0; i <= 2; i++) { const v = top * i / 2, yy = y(v); svg.append(mk('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: 'grid' })); svg.append(mk('text', { x: padL - 6, y: yy + 4, class: 'ax', 'text-anchor': 'end' }, i ? money(v) : '0')); }
  const info = el('div', { class: 'chart-info', text: 'Tap a bar to see that ' + (mode === 'months' ? 'month' : 'day') + '.' });
  const bar = (x, v, cls) => { const h = Math.max(0, y(0) - y(v)); if (!h) return null; const r = Math.min(4, bw / 2, h);
    return mk('path', { d: `M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z`, class: cls }); };
  data.forEach((d, i) => {
    const gx = padL + i * gw, cx = gx + gw / 2;
    const g = mk('g', { class: 'grp' + (S.statPick === d.k ? ' pick' : ''), tabindex: '0' });
    g.append(mk('rect', { x: gx, y: padT, width: gw, height: H - padT - padB, class: 'hit' }));
    const a = bar(cx - bw - 1, d.sales, 'b-sales'), b = bar(cx + 1, d.spent, 'b-spent');
    if (a) g.append(a); if (b) g.append(b);
    const every = Math.ceil(data.length / Math.max(4, Math.floor((W - padL) / 34)));
    if ((data.length - 1 - i) % every === 0) g.append(mk('text', { x: cx, y: H - 6, class: 'ax', 'text-anchor': 'middle' }, periodLabel(mode, d.k)));
    const show = () => { S.statPick = d.k; info.replaceChildren(el('b', { text: periodLong(mode, d.k) + ': ' }), `${money(d.sales)} sales · ${money(d.spent)} spent · ${money(d.sales - d.spent)} net · ${d.orders} order${d.orders === 1 ? '' : 's'}`);
      svg.querySelectorAll('.grp.pick').forEach(n => n.classList.remove('pick')); g.classList.add('pick'); };
    g.addEventListener('click', show); g.addEventListener('mouseenter', show); g.addEventListener('keydown', e => { if (e.key === 'Enter') show(); });
    svg.append(g);
  });
  svg.append(mk('line', { x1: padL, x2: W - padR, y1: y(0), y2: y(0), class: 'base' }));
  return el('div', { class: 'card chart-card' },
    el('div', { class: 'legend' }, el('span', {}, el('i', { class: 'k-sales' }), 'Sales'), el('span', {}, el('i', { class: 'k-spent' }), 'Spent')),
    svg, info);
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
    { name: 'Orders', widths: [7, 11, 7, 10, 6, 11, 9, 20, 15, 24, 45, 11, 11, 10, 25],
      rows: [['No', 'Date', 'Time', 'Status', 'Paid', 'Paid with', 'Type', 'Customer', 'Phone', 'Address', 'Items', 'Items total', 'Delivery fee', 'Total', 'Note'],
        ...orders.map(o => [o.no, { date: o.createdAt }, { time: o.createdAt }, ST[o.status] || o.status, isCancelled(o) ? '' : o.paid ? 'Yes' : 'No', o.paid ? (PAY[o.payMethod] || '') : '', o.type === 'delivery' ? 'Delivery' : 'Pickup', o.customerName, o.phone, o.address,
          (o.items || []).map(i => `${i.qty}x ${i.name}${i.variant ? ' (' + i.variant + ')' : ''}`).join('; '), num(o.subtotal), num(o.fee), num(o.total), o.note])] },
    { name: 'Order lines', widths: [7, 11, 11, 24, 10, 6, 9, 10],
      rows: [['Order no', 'Date', 'Status', 'Item', 'Size', 'Qty', 'Price', 'Line total'],
        ...orders.flatMap(o => (o.items || []).map(i => [o.no, { date: o.createdAt }, ST[o.status] || o.status, i.name, i.variant || '', num(i.qty), num(i.price), num(i.qty) * num(i.price)]))] },
    { name: 'Customers', widths: [20, 15, 30, 25, 8, 10, 11],
      rows: [['Name', 'Phone', 'Address', 'Notes', 'Orders', 'Spent', 'Last order'],
        ...realCusts().map(c => { const x = st.get(c.id); return [c.name, c.phone, c.address, c.notes, x ? x.n : 0, x ? x.spent : 0, x ? { date: x.last } : '']; })] },
    { name: 'Purchases', widths: [11, 24, 8, 8, 10, 30, 8],
      rows: [['Date', 'Item', 'Qty', 'Unit', 'Cost', 'Note', 'Pictures'],
        ...S.purchases.slice().sort((a, b) => (a.day || '').localeCompare(b.day || '')).map(p => [p.day, p.item, num(p.qty), p.unit, num(p.cost), p.note, (p.photos || []).length])] },
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
  if (bucketFor(path) === 'receipts') {
    const local = await IDB.get('blobs', path);
    if (local) return { type: local.type, data: local.data };
    try { const { data } = await sb.storage.from('receipts').download(path); if (data) return { type: data.type || 'image/jpeg', data: await data.arrayBuffer() }; } catch (_) { /* offline */ }
    return null;
  }
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
    const paths = [...S.menu.map(m => m.photo), ...S.customers.map(c => c.photo), ...S.orders.map(o => o.payProof), ...S.purchases.flatMap(p => p.photos || [])].filter(Boolean);
    for (const path of new Set(paths)) {
      const p = await photoBytes(path);
      if (p) photos[path] = { type: p.type, data: b64(p.data) }; else missing++;
    }
    const data = { app: 'orderdesk', version: 1, exportedAt: new Date().toISOString(),
      settings: stripV(S.settings), menu: strip(S.menu), customers: strip(S.customers), orders: strip(S.orders), purchases: strip(S.purchases), photos };
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
    el('p', { text: `From ${new Date(data.exportedAt).toLocaleString()}: ${n('orders')} orders, ${n('customers')} customers, ${n('menu')} dishes, ${n('purchases')} purchases.` }),
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
    for (const coll of ['menu', 'customers', 'orders', 'purchases']) {
      for (const r of data[coll] || []) {
        if (!r || !r.id) continue;
        const rec = Object.assign({}, r); delete rec._v;
        if ((coll === 'menu' || coll === 'customers') && rec.photo) rec.photo = remap.get(rec.photo) || (rec.photo.startsWith(S.uid + '/') ? rec.photo : '');
        if (coll === 'purchases') rec.photos = (rec.photos || []).map(x => remap.get(x) || (String(x).startsWith(S.uid + '/') ? x : '')).filter(Boolean);
        if (coll === 'orders' && rec.payProof) { rec.payProof = remap.get(rec.payProof) || (rec.payProof.startsWith(S.uid + '/') ? rec.payProof : ''); rec.payTouched = true; }
        await Store.put(coll, rec); count++;
      }
    }
    if (data.settings) await Store.put('settings', Object.assign(clone(DEFAULT_SETTINGS), data.settings, { id: 'main' }));
    toast(`Restored ${count} records`); render(true);
  } catch (e) { toast('Restore failed: ' + ((e && e.message) || e), true); }
}

/* ---------- settings ---------- */
/* ---------- push notifications (Web Push; sent by the Supabase Edge Function) ---------- */
const VAPID_PUBLIC = 'BMz6K6GyZ0qnUmZQL7WsnaykvuaSAZ5eZ30qbJ-MtP6aOFryDU_I1adq9wyIfTpirPPihTnAR_rr9LqnsQx79QU';
function b64ToU8(s) { const pad = '='.repeat((4 - s.length % 4) % 4); const b = (s + pad).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(b); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); }
const Push = {
  supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && location.protocol !== 'file:'; },
  async current() { if (!this.supported()) return null; try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch (_) { return null; } },
  async enable() {
    if (!this.supported()) throw new Error('This phone cannot do notifications here. On iPhone, add the app to your Home Screen and open it from there first.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked. Turn them on for this app in your phone settings.' : 'Notifications were not allowed.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC) });
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({ endpoint: sub.endpoint, user_id: S.uid, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 200) });
    if (error) throw error;
    return sub;
  },
  async disable() {
    const sub = await this.current();
    if (sub) { try { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch (_) { /* ignore */ } try { await sub.unsubscribe(); } catch (_) { /* ignore */ } }
  },
};
function pushSection() {
  const box = el('div', { class: 'sect' }, el('h3', { text: 'Notifications' }));
  const body = el('div'); box.append(body);
  async function draw() {
    if (!Push.supported()) {
      body.replaceChildren(el('div', { class: 'sub', id: 'push-unsupported', text: 'Not available here. On iPhone: add Order Desk to your Home Screen (Share → Add to Home Screen), open it from there, then turn this on.' }));
      return;
    }
    const perm = (window.Notification && Notification.permission) || 'default';
    const sub = await Push.current();
    const on = perm === 'granted' && !!sub;
    body.replaceChildren(
      el('label', { class: 'switch' }, el('input', { type: 'checkbox', id: 's-push', checked: on, onchange: async e => {
        e.target.disabled = true;
        try { if (e.target.checked) { await Push.enable(); toast('Notifications on'); } else { await Push.disable(); toast('Notifications off'); } }
        catch (x) { toast((x && x.message) || 'Could not change notifications', true); }
        draw();
      } }), 'New orders, payments and messages'),
      el('div', { class: 'sub', text: on ? 'This device will buzz even when the app is closed.' : perm === 'denied' ? 'Blocked. Turn notifications on for this app in your phone settings, then try again.' : 'Get told about new orders even when the app is shut.' }));
  }
  draw();
  return box;
}
function settingsModal() {
  const s = clone(S.settings);
  const addrs = addrList().map(a => ({ id: a.id || newId(), name: a.name, fee: a.fee, feePizza: a.feePizza ?? '', was: a.name }));
  const abox = el('div', { class: 'addr-list' });
  const drawAddrs = () => abox.replaceChildren(...addrs.map((a, i) => el('div', { class: 'addr-row' },
    el('input', { value: a.name, placeholder: 'e.g. Chang\'an Uni West Gate', 'aria-label': 'Address name', oninput: e => { a.name = e.target.value; } }),
    el('div', { class: 'fee-in' }, el('span', { text: '🍛' }), el('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.5', value: a.fee, placeholder: '0', 'aria-label': 'Delivery fee (Others)', oninput: e => { a.fee = e.target.value; } })),
    el('div', { class: 'fee-in' }, el('span', { text: '🍕' }), el('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.5', value: a.feePizza, placeholder: 'same', 'aria-label': 'Delivery fee (Pizza)', oninput: e => { a.feePizza = e.target.value; } })),
    el('button', { class: 'x', type: 'button', 'aria-label': 'Remove address', onclick: () => { addrs.splice(i, 1); drawAddrs(); } }, '✕'))),
    ...(addrs.length ? [] : [el('div', { class: 'sub', text: 'No addresses yet.' })]));
  drawAddrs();
  // payment: QR codes + accounts the shop shows to clients
  const qr = { wechat: { path: s.wechatQr || '', blob: null, prev: '' }, alipay: { path: s.alipayQr || '', blob: null, prev: '' } };
  let payChanged = false;
  const payBlock = (k, title, idKey, idLabel, idHint) => {
    const box = el('div', { class: 'qr-edit' });
    const draw = () => {
      const q = qr[k], src = q.blob ? q.prev : (q.path ? photoUrl(q.path) : '');
      box.replaceChildren(src ? el('img', { class: 'qr-thumb', src, alt: title + ' QR code' }) : el('div', { class: 'qr-thumb empty', text: 'No QR' }),
        el('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:flex-start' },
          el('label', { class: 'btn small' }, src ? 'Change QR' : 'Upload QR',
            el('input', { type: 'file', accept: 'image/*', id: 's-qr-' + k, style: 'display:none', onchange: async e => {
              const file = e.target.files && e.target.files[0]; if (!file) return;
              try { q.blob = await shrinkPhoto(file, 1000, false); if (q.prev) URL.revokeObjectURL(q.prev); q.prev = URL.createObjectURL(q.blob); payChanged = true; draw(); }
              catch (err) { toast((err && err.message) || 'Could not read that picture.', true); }
            } })),
          src ? el('button', { class: 'link', type: 'button', onclick: () => { q.blob = null; q.path = ''; payChanged = true; draw(); } }, 'Remove') : null));
    };
    draw();
    return el('div', { class: 'pay-cfg' }, el('div', { class: 'pay-h' }, payLogo(k), el('b', { text: title })), box,
      el('div', { class: 'field' }, el('label', { for: 's-' + idKey, text: idLabel }),
        el('input', { id: 's-' + idKey, value: s[idKey] || '', placeholder: idHint, autocomplete: 'off', oninput: e => { s[idKey] = e.target.value; payChanged = true; } })));
  };
  const f = (id, label, key, attrs) => el('div', { class: 'field' }, el('label', { for: id, text: label }), el('input', Object.assign({ id, value: s[key], oninput: e => { s[key] = e.target.value; } }, attrs)));
  // logo: shown top-left in the shop app in place of the business name
  const logo = { path: s.logo || '', blob: null, prev: '' };
  let logoChanged = false;
  const logoBox = el('div', { class: 'qr-edit' });
  const drawLogo = () => {
    const src = logo.blob ? logo.prev : (logo.path ? photoUrl(logo.path) : '');
    logoBox.replaceChildren(src ? el('img', { class: 'qr-thumb', src, alt: 'Business logo' }) : el('div', { class: 'qr-thumb empty', text: 'No logo' }),
      el('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:flex-start' },
        el('label', { class: 'btn small' }, src ? 'Change logo' : 'Upload logo',
          el('input', { type: 'file', accept: 'image/*', id: 's-logo', style: 'display:none', onchange: async e => {
            const file = e.target.files && e.target.files[0]; if (!file) return;
            try { logo.blob = await shrinkPhoto(file, 400, true); if (logo.prev) URL.revokeObjectURL(logo.prev); logo.prev = URL.createObjectURL(logo.blob); logoChanged = true; drawLogo(); }
            catch (err) { toast((err && err.message) || 'Could not read that picture.', true); }
          } })),
        src ? el('button', { class: 'link', type: 'button', onclick: () => { logo.blob = null; logo.path = ''; logoChanged = true; drawLogo(); } }, 'Remove') : null));
  };
  drawLogo();
  const n = Sync.waiting();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: 'Settings' }),
    f('s-name', 'Business name', 'name'),
    f('s-cur', 'Currency symbol', 'currency', { maxlength: '4' }),
    el('div', { class: 'sect' }, el('h3', { text: 'Logo' }),
      el('div', { class: 'sub', text: 'Shown top-left in the shop app, in place of the business name.' }), logoBox),
    el('div', { class: 'sect' }, el('h3', { text: 'Delivery addresses' }),
      el('div', { class: 'sub', text: 'Only these can be picked for a delivery. 🍛 = fee for other dishes, 🍕 = fee when the order has pizza (empty = same). 0 = free.' }),
      abox, el('button', { class: 'link', type: 'button', style: 'align-self:flex-start', onclick: () => { addrs.push({ id: newId(), name: '', fee: '', was: '' }); drawAddrs(); const ins = abox.querySelectorAll('.addr-row input:not([type=number])'); if (ins.length) ins[ins.length - 1].focus(); } }, '+ Add address')),
    el('div', { class: 'sect' }, el('h3', { text: 'Sound alerts' }),
      el('label', { class: 'switch' }, el('input', { type: 'checkbox', id: 's-sound', checked: Sound.on(), onchange: e => { Sound.set(e.target.checked); if (e.target.checked) Sound.play('order'); } }), 'Play a sound for new shop orders and payments'),
      el('div', { class: 'sub', text: 'On this device, while the app is open.' })),
    pushSection(),
    el('div', { class: 'sect' }, el('h3', { text: 'Pickup' }),
      el('label', { class: 'switch' }, el('input', { type: 'checkbox', id: 's-pickup', checked: s.pickup !== false, onchange: e => { s.pickup = e.target.checked; } }), 'Pickup available'),
      el('div', { class: 'sub', text: 'Off: customers can only choose delivery, and Pickup disappears everywhere. Turn it on again any time.' })),
    el('div', { class: 'sect' }, el('h3', { text: 'Payment' }),
      el('div', { class: 'sub', text: 'Clients see these when they pay in the shop.' }),
      el('div', { class: 'pay-cfgs' },
        payBlock('wechat', 'WeChat Pay', 'wechatId', 'WeChat ID (for paying in chat)', 'your WeChat ID'),
        payBlock('alipay', 'Alipay', 'alipayId', 'Alipay account (for paying in chat)', 'phone or email'))),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'),
      el('button', { class: 'btn primary', type: 'button', id: 's-save', onclick: async () => {
        const clean = addrs.map(a => ({ id: a.id, name: (a.name || '').trim(), fee: Math.max(0, Number(a.fee) || 0), feePizza: a.feePizza === '' || a.feePizza == null ? '' : Math.max(0, Number(a.feePizza) || 0), was: a.was })).filter(a => a.name);
        const names = clean.map(a => a.name.toLowerCase());
        if (new Set(names).size !== names.length) return toast('Two addresses have the same name.', true);
        const rec = { id: 'main', name: (s.name || '').trim() || 'My kitchen', currency: s.currency || '', deliveryFee: num(S.settings.deliveryFee),
          addresses: clean.map(({ id, name, fee, feePizza }) => (feePizza === '' ? { id, name, fee } : { id, name, fee, feePizza })), addrTouched: true,
          wechatQr: qr.wechat.path, alipayQr: qr.alipay.path, wechatId: (s.wechatId || '').trim(), alipayId: (s.alipayId || '').trim(),
          payCfgTouched: !!(S.settings.payCfgTouched || payChanged),
          pickup: s.pickup !== false, pkTouched: !!(S.settings.pkTouched || (s.pickup === false) !== (S.settings.pickup === false)),
          inventory: S.settings.inventory || {}, invTouched: !!S.settings.invTouched,
          logo: logo.path, logoTouched: !!(S.settings.logoTouched || logoChanged) };
        const extra = [];
        for (const k of ['wechat', 'alipay']) {
          const q = qr[k], old = S.settings[k + 'Qr'] || '';
          if (q.blob) {
            const path = `${S.uid}/payqr-${k}-${newId()}.jpg`;
            try { await queuePhoto(path, q.blob); } catch (_) { return toast('Could not store the QR picture on this device.', true); }
            rec[k + 'Qr'] = path;
          }
          if (old && old !== rec[k + 'Qr']) extra.push(...photoDelOp(old));
        }
        if (logo.blob) {
          const path = `${S.uid}/logo-${newId()}.jpg`;
          try { await queuePhoto(path, logo.blob); } catch (_) { return toast('Could not store the logo picture on this device.', true); }
          rec.logo = path;
        }
        if ((S.settings.logo || '') && (S.settings.logo || '') !== rec.logo) extra.push(...photoDelOp(S.settings.logo));
        if (!await write(Store.put('settings', rec, extra), 'Settings saved')) return;
        // a renamed address follows the customers who use it
        for (const a of clean) if (a.was && a.was !== a.name) for (const c of S.customers.filter(x => x.address === a.was)) await Store.patch('customers', c.id, { address: a.name });
        closeModal();
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
  if (!box.hidden && box.firstChild && box.querySelector('form')) return; // already showing; don't wipe what is being typed
  S.loginOpen = true;
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
      S.loginOpen = false; box.hidden = true; $('#app').hidden = false; render(true);
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
    S.uid ? el('button', { class: 'link', type: 'button', onclick: () => { S.loginOpen = false; box.hidden = true; $('#app').hidden = false; render(true); } }, 'Back to the app') : null);
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
  await checkRole();
  if (S.notAdmin) { stopRealtime(); return; }
  S.loginOpen = false; $('#login').hidden = true; // signed in: the sign-in screen is no longer needed
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* ignore */ }
  startRealtime(); Sync.soon(0);
}
/* this app is for the team only; client accounts are turned away (the database refuses them anyway) */
async function checkRole() {
  try {
    const { data, error } = await sb.rpc('is_admin');
    if (error) {
      if (/^(PGRST202|42883)$/.test(String(error.code || ''))) S.notAdmin = false; // older database without roles
      return; // offline or other trouble: keep what we knew
    }
    S.notAdmin = data === false;
    await IDB.batch([{ store: 'meta', key: 'notAdmin', val: S.notAdmin }]);
  } catch (_) { /* offline: keep what we knew */ }
}
function showStaffOnly() {
  $('#app').hidden = true;
  const box = $('#login'); box.hidden = false; S.loginOpen = true;
  if (box.querySelector('#staff-out')) return;
  box.replaceChildren(el('div', { class: 'card' },
    el('h1', { text: 'Staff only' }),
    el('p', { text: `${S.email || 'This account'} is a customer account. This app is for the kitchen team. To order food, use the shop.` }),
    el('button', { class: 'btn primary', type: 'button', id: 'staff-out', onclick: async () => { S.notAdmin = false; await signOut(); } }, 'Sign out')));
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
  const [uid, email, notAdmin, ...rest] = await Promise.all([IDB.get('meta', 'uid'), IDB.get('meta', 'email'), IDB.get('meta', 'notAdmin'), ...COLLS.map(c => IDB.all(c)), IDB.all('outbox'), IDB.all('blobs')]);
  COLLS.forEach((c, i) => { M[c].clear(); for (const [k, v] of rest[i]) M[c].set(k, v); });
  S.outbox = new Map(rest[COLLS.length]);
  for (const [path, b] of rest[COLLS.length + 1]) S.blobUrls.set(path, URL.createObjectURL(new Blob([b.data], { type: b.type })));
  for (const e of S.outbox.values()) stamp = Math.max(stamp, e.v || 0);
  S.uid = uid || null; S.email = email || ''; S.notAdmin = notAdmin === true;
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
