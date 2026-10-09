'use strict';
/* =====================================================================
   Shop — the client side of Order Desk.
   Clients browse the menu (no account needed), then sign in as a guest,
   with a phone number or with an email to place an order. The database
   works out prices, fees and the order number (place_order), and clients
   only ever see their own orders.
   ===================================================================== */
const CFG = {
  url: 'https://qgoyengzjgsxpqkhhyjm.supabase.co',
  key: 'sb_publishable_guwA3lmtAw61a5ks898qoQ_i07f7y3q',
  phoneDomain: 'phone.orderdesk.app', // phone logins are stored as <digits>@this, no SMS involved
};
const SHOP_VERSION = '2.0.0';
/* phones (WeChat especially) keep old copies of web pages; if a newer shop is online, reload it */
(async function freshness() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const v = (await r.json()).shop;
    if (v && v !== SHOP_VERSION) {
      const k = 'shop-reloaded-' + v;
      if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, '1'); const u = new URL(location.href); u.searchParams.set('v', v); location.replace(u.toString()); }
    }
  } catch (_) { /* offline or blocked: keep going */ }
})();

/* ---------- helpers ---------- */
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('aria-') && v != null) { e.setAttribute(k, String(v)); continue; }
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const $ = (s, r = document) => r.querySelector(s);
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const isoDay = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const timeStr = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const num = v => Number(v) || 0;
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const initial = s => (String(s || '?').trim()[0] || '?').toUpperCase();
function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('shop-' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('shop-' + k, JSON.stringify(v)); } catch (_) { /* no storage */ } },
};
function dayLabel(day) {
  if (!day) return '';
  const today = chinaNow().day;
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

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

/* ---------- state ---------- */
const S = {
  biz: { name: '', currency: '¥', addresses: [], pay: {} }, menu: [], cat: 'All', view: 'menu',
  basket: store.get('basket', []), // [{menuId, variant, qty}]
  draft: Object.assign({ type: 'delivery', address: '', slotDate: '', slot: '', note: '', name: '', phone: '' }, store.get('draft', {})),
  session: null, orders: [], lastOrder: null, loaded: false, loadErr: '',
  msgs: [], msgsOff: false, chatAbout: null, reviews: [], reviewsOff: false, sales: new Map(),
};
const money = n => { n = Number(n) || 0; const a = Math.abs(n); return (n < 0 ? '−' : '') + (S.biz.currency || '') + (Number.isInteger(a) ? a : a.toFixed(2)); };
const feeText = f => (f ? money(f) : 'Free');
const saveBasket = () => { store.set('basket', S.basket); store.set('draft', Object.assign({}, S.draft, { slot: '', slotDate: '' })); };
const publicUrl = path => CFG.url + '/storage/v1/object/public/photos/' + path.split('/').map(encodeURIComponent).join('/');
const dish = id => S.menu.find(m => m.id === id);
const priceOf = (m, variant) => { const v = (m.variants || []).find(x => (x.label || '') === (variant || '')); return v ? num(v.price) : 0; };
/* delivery fee: orders with pizza use the address's pizza fee (when set) */
const feeOf = (a, pizza) => (pizza && a.feePizza !== '' && a.feePizza != null ? num(a.feePizza) : num(a.fee));
const basketPizza = () => S.basket.some(l => (dish(l.menuId) || {}).kitchen === 'pizza');
const addrFee = (name, pizza = basketPizza()) => { const a = (S.biz.addresses || []).find(x => x.name === name); return a ? feeOf(a, pizza) : null; };
const winLabel = w => `${w.from}–${w.to}`;

let sb = null;
try { sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'od-shop-auth' } }); } catch (_) { sb = null; }

/* ---------- toast / modal ---------- */
let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = isErr ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2600);
}
function openModal(node) { const m = $('#modal'); m.replaceChildren(node); m.hidden = false; }
function closeModal() { const m = $('#modal'); m.hidden = true; m.replaceChildren(); }
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
const niceErr = e => {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (/fetch|network|load failed/i.test(m)) return 'No connection. Check your internet and try again.';
  if (/signups not allowed|signup.*disabled/i.test(m)) return 'The shop is not taking new accounts yet.';
    if (/invalid login/i.test(m)) return 'Wrong phone/email or password.';
  if (/already registered|already been registered/i.test(m)) return 'That account already exists. Sign in instead.';
  if (/password.*(at least|short)/i.test(m)) return 'Choose a longer password (at least 6 characters).';
  return m;
};

/* ---------- top bar + bottom tabs ---------- */
const TAB_ICONS = {
  menu: '<path d="M4 5h16M4 12h16M4 19h10"/>',
  orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  me: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6"/>',
};
const activeOrders = () => S.orders.filter(o => o.status !== 'done' && o.status !== 'cancelled');
const unreadMsgs = () => S.msgs.filter(m => m.from_admin && !m.read_at).length;
function renderTop() {
  $('#top').replaceChildren(el('button', { class: 'biz', type: 'button', onclick: () => go('menu') }, S.biz.name || 'Order food'));
  document.title = S.biz.name ? `${S.biz.name} · Order` : 'Order food';
  const tabOf = { menu: 'menu', checkout: 'menu', done: 'orders', orders: 'orders', me: 'me', chat: 'me' }[S.view] || 'menu';
  const badge = { orders: activeOrders().length, me: unreadMsgs() };
  $('#tabs').replaceChildren(...[['menu', 'Menu'], ['orders', 'Orders'], ['me', 'Me']].map(([k, l]) => {
    const b = el('button', { type: 'button', id: 'tab-' + k, 'aria-current': tabOf === k ? 'page' : false, onclick: () => go(k) });
    b.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICONS[k]}</svg>`;
    b.append(el('span', { text: l }), badge[k] ? el('span', { class: 'tbadge', text: badge[k] }) : '');
    return b;
  }));
  document.body.classList.toggle('no-tabs', S.view === 'checkout' || S.view === 'chat');
}
/* account: who is signed in */
function whoAmI() {
  const u = S.session && S.session.user;
  if (!u) return null;
  if (u.is_anonymous) return { kind: 'Guest', id: S.profile && S.profile.name ? `${S.profile.name} (Guest)` : 'Guest' };
  const e = u.email || '';
  return e.endsWith('@' + CFG.phoneDomain) ? { kind: 'Phone', id: e.replace('@' + CFG.phoneDomain, '') } : { kind: 'Email', id: e };
}
/* signing out forgets everything about that person on this phone, so the next customer starts clean */
function forgetPerson() {
  S.session = null; S.orders = []; S.msgs = []; S.profile = null; S.acct = undefined; S.lastOrder = null; lastStatus.clear();
  Object.assign(S.draft, { name: '', phone: '', address: '', note: '' }); store.set('draft', S.draft);
}
async function signOutShop() { await sb.auth.signOut({ scope: 'local' }); forgetPerson(); render(); toast('Signed out'); }
function viewMe(root) {
  const me = whoAmI();
  root.append(el('h1', { class: 'page-h', text: 'Me' }));
  if (!me) {
    root.append(el('div', { class: 'box' }, el('b', { text: 'Not signed in' }),
      el('p', { class: 'fineprint', text: 'Sign in to see your orders and message us. You can also just order: we ask for your phone number or email at checkout.' }),
      el('button', { class: 'btn primary big-btn', type: 'button', id: 'me-signin', onclick: () => authSheet(() => render()) }, 'Sign in')));
    return;
  }
  const un = unreadMsgs();
  root.append(
    el('div', { class: 'box' }, el('div', { class: 'acct-card' + (S.profile && S.profile.photo ? ' has-pic' : '') },
        S.profile && S.profile.photo ? el('img', { class: 'me-pic', src: publicUrl(S.profile.photo), alt: '' }) : null,
        el('div', { class: 'acct-txt' }, el('b', { id: 'me-id', text: me.kind === 'Guest' ? me.id : ((S.profile && S.profile.name) || me.id) }),
          me.kind !== 'Guest' ? el('small', { id: 'me-login' }, S.profile && S.profile.name ? (me.kind === 'Phone' ? '📱 ' : '✉ ') + me.id : '',
            S.acct !== undefined ? el('span', { class: 'vtag' + (S.acct && S.acct.verified ? ' ok' : ''), id: 'me-verified', text: S.acct && S.acct.verified ? '✓ Verified' : 'Unverified' }) : null) : null)),
      me.kind === 'Guest' ? el('p', { class: 'fineprint', text: 'Guest orders are saved on this phone only. Save your account with your phone number or email to keep your orders and messages on any phone.' }) : null,
      el('div', { class: 'btnrow' },
        me.kind === 'Guest' ? el('button', { class: 'btn primary', type: 'button', id: 'me-save', onclick: () => authSheet(() => render(), true) }, 'Save my account') : null,
        el('button', { class: 'btn danger', type: 'button', id: 'acct-out', onclick: signOutShop }, 'Sign out'))),
    S.msgsOff ? null : el('button', { class: 'me-row', type: 'button', id: 'me-chat', onclick: () => openChat(null) },
      el('span', { class: 'me-ic', text: '💬' }), el('span', { class: 'me-mid' }, el('b', { text: 'Messages' }), el('small', { text: un ? `${un} new from ${S.biz.name || 'us'}` : `Chat with ${S.biz.name || 'us'}` })),
      un ? el('span', { class: 'tbadge static', text: un }) : el('span', { class: 'chev', text: '›' })),
    el('button', { class: 'me-row', type: 'button', onclick: () => go('orders') },
      el('span', { class: 'me-ic', text: '🧾' }), el('span', { class: 'me-mid' }, el('b', { text: 'My orders' }), el('small', { text: `${S.orders.length} order${S.orders.length === 1 ? '' : 's'}` })), el('span', { class: 'chev', text: '›' })));
}
function go(v) { S.view = v; render(); window.scrollTo(0, 0); if (v === 'orders') loadOrders(); if (v === 'me') loadMsgs(); }
function render() {
  document.body.dataset.view = S.view;
  renderTop();
  const main = $('#main');
  main.replaceChildren();
  if (!S.loaded) { main.append(el('div', { class: 'splash', text: S.loadErr || 'Loading the menu…' })); renderBar(); return; }
  ({ menu: viewMenu, checkout: viewCheckout, orders: viewOrders, done: viewDone, me: viewMe, chat: viewChat })[S.view](main);
  renderBar();
}

/* ---------- menu ---------- */
function basketCount() { return S.basket.reduce((a, l) => a + l.qty, 0); }
function basketTotal() { return S.basket.reduce((a, l) => { const m = dish(l.menuId); return a + (m ? priceOf(m, l.variant) * l.qty : 0); }, 0); }
const svcOf = m => (m && m.service === 'night' ? 'night' : 'day');
const hasNight = () => S.menu.some(m => !m.deleted && svcOf(m) === 'night');
/* ---------- reviews ---------- */
const reviewsOf = id => S.reviews.filter(r => !r.hidden && (r.dish_ids || []).includes(id));
function ratingOf(id) { const rs = reviewsOf(id); return rs.length ? { avg: (rs.reduce((a, r) => a + r.stars, 0) / rs.length).toFixed(1), n: rs.length } : null; }
const starStr = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
async function loadReviews() {
  try {
    const { data, error } = await sb.from('reviews').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) { S.reviewsOff = true; return; }
    S.reviewsOff = false; S.reviews = data || [];
  } catch (_) { /* offline */ }
}
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
function reviewEl(r) {
  const src = r.photo ? publicUrl(r.photo) : '';
  return el('div', { class: 'rev' },
    el('div', { class: 'rev-main' },
      el('div', { class: 'rev-h' }, el('span', { class: 'stars', text: starStr(r.stars) }), el('b', { text: r.customer_name || 'Customer' }), el('small', { text: dayLabel(isoDay(Date.parse(r.created_at))) })),
      r.body ? el('div', { class: 'rev-t', text: r.body }) : null),
    src ? el('button', { class: 'rev-thumb', type: 'button', 'aria-label': 'Open photo', onclick: () => openPhoto(src, 'Photo from a customer') }, el('img', { src, alt: '', loading: 'lazy' })) : null);
}
async function loadSales() {
  try { const { data, error } = await sb.rpc('dish_sales'); if (!error && data) S.sales = new Map(data.map(r => [r.menu_id, Number(r.sold) || 0])); } catch (_) { /* fine */ }
}
const soldText = n => (n >= 100 ? `${Math.floor(n / 100) * 100}+` : n >= 10 ? `${Math.floor(n / 10) * 10}+` : String(n));
/* the dish page: like a delivery app — photo, price card, tags, info, ingredients, reviews, bottom bar */
function dishSheet(m) {
  const vs = (m.variants || []).map(v => num(v.price)), lo = Math.min(...vs), hi = Math.max(...vs);
  const rs = reviewsOf(m.id), r = ratingOf(m.id), good = rs.length ? Math.round(100 * rs.filter(x => x.stars >= 4).length / rs.length) : 0;
  const sold = S.sales.get(m.id) || 0, night = svcOf(m) === 'night';
  const fees = (S.biz.addresses || []).map(a => feeOf(a, m.kitchen === 'pizza')), minFee = fees.length ? Math.min(...fees) : 0;
  const pic = m.photo ? el('img', { class: 'dd-img', src: publicUrl(m.photo), alt: m.name }) : el('div', { class: 'dd-img ph', style: '--h:' + hue(m.name), text: initial(m.name) });
  const ingCard = el('div', { class: 'dd-card', id: 'dd-ing' }, el('h3', { text: 'Ingredients' }),
    (m.ingredients || []).length ? el('div', { class: 'dd-grid' }, m.ingredients.map(g => el('div', { class: 'dd-cell' }, el('b', { text: g.item }), el('small', { text: 'Ingredient' }))))
      : el('div', { class: 'fineprint', text: 'Ask us in Messages if you want to know what is inside.' }));
  const scroller = el('div', { class: 'dd-scroll' });
  const tabs = el('div', { class: 'dd-tabs' });
  const drawTabs = k => tabs.replaceChildren(el('button', { type: 'button', 'aria-pressed': k === 'photo', onclick: () => { scroller.scrollTo({ top: 0, behavior: 'smooth' }); drawTabs('photo'); } }, 'Photo'),
    el('button', { type: 'button', id: 'dd-tab-ing', 'aria-pressed': k === 'ing', onclick: () => { ingCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); drawTabs('ing'); } }, 'Ingredients'));
  drawTabs('photo');
  const add = then => { closeModal(); addDish(m); if (then) then(); };
  const n = basketCount();
  scroller.append(
    el('div', { class: 'dd-hero' }, pic, tabs),
    el('div', { class: 'dd-price-card' },
      el('div', {}, el('div', { class: 'dd-price' }, el('small', { text: S.biz.currency || '' }), vs.length ? String(lo) : '', lo !== hi ? el('span', { class: 'dd-from', text: ` – ${hi}` }) : null),
        el('div', { class: 'dd-sold', text: sold ? `Sold ${soldText(sold)} this month` : 'Freshly made to order' })),
      el('div', { class: 'dd-badge ' + (night ? 'night' : 'day') }, el('b', { text: night ? '🌙 Night' : '☀ Day' }), el('small', { text: night ? 'Evening dish' : 'Daytime dish' }))),
    el('div', { class: 'dd-card' }, el('h2', { class: 'dd-name', text: m.name }),
      el('div', { class: 'dd-tags' }, el('span', { class: 'dd-tag', text: m.category || 'Dish' }), r ? el('span', { class: 'dd-tag', text: `★ ${r.avg}` }) : null,
        ...(m.variants || []).filter(v => v.label).map(v => el('span', { class: 'dd-tag', text: `${v.label} ${money(v.price)}` }))),
      m.description ? el('p', { class: 'dd-desc', text: m.description }) : null),
    el('div', { class: 'dd-card' },
      el('div', { class: 'dd-info' }, el('span', { text: '🛵' }), el('b', { text: minFee ? `Delivery from ${money(minFee)}` : 'Free delivery' }), el('span', { class: 'dot' }), el('span', { class: 'fineprint', text: (S.biz.addresses || []).length + ' delivery points' })),
      (m.windows || []).length ? el('div', { class: 'dd-info' }, el('span', { text: '🕒' }), el('b', { text: 'Served' }), el('span', { text: m.windows.map(winLabel).join(', ') })) : null,
      el('div', { class: 'dd-info' }, el('span', { text: '✅' }), el('b', { text: 'Pay after we accept' }), el('span', { class: 'fineprint', text: 'WeChat Pay · Alipay' }))),
    ingCard,
    el('div', { class: 'dd-card' }, el('div', { class: 'dd-rev-h' }, el('h3', { text: `Reviews (${rs.length})` }), rs.length ? el('span', { class: 'dd-good', text: `${good}% positive 👍` }) : null),
      rs.length ? showSome(rs.map(reviewEl), 3, 'reviews') : el('div', { class: 'fineprint', text: 'No reviews yet. Be the first after your order arrives.' })));
  const iconBtn = (ic, label, fn, badge) => el('button', { class: 'dd-ic', type: 'button', 'aria-label': label, onclick: fn }, el('span', { class: 'dd-ic-i', text: ic }), el('small', { text: label }), badge ? el('span', { class: 'tbadge', text: badge }) : null);
  openModal(el('div', { class: 'sheet dd shop-dd', id: 'dsheet' },
    el('div', { class: 'dd-top' }, el('button', { class: 'dd-round ds-x', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '⌄')),
    scroller,
    el('div', { class: 'dd-bar shop' },
      iconBtn('🛍', 'Basket', () => { closeModal(); if (basketCount()) go('checkout'); }, n || null),
      S.msgsOff ? null : iconBtn('💬', 'Ask us', () => { closeModal(); openChat(null); }),
      m.available === false ? el('div', { class: 'dd-soldout', text: 'Sold out today' }) : el('div', { class: 'dd-buy' },
        el('button', { class: 'dd-add', type: 'button', id: 'ds-add', onclick: () => add() }, 'Add to basket'),
        el('button', { class: 'dd-now', type: 'button', id: 'ds-now', onclick: () => add(() => { if (basketCount()) go('checkout'); }) }, 'Buy now')))));
}
/* after delivery: the customer reviews the order */
function reviewSheet(o) {
  const mine = S.reviews.find(r => r.order_id === o.id);
  let stars = mine ? mine.stars : 0, blob = null, prev = '', keepPhoto = mine ? mine.photo : '';
  const err = el('div', { class: 'err', role: 'alert' });
  const starBox = el('div', { class: 'star-pick', role: 'radiogroup', 'aria-label': 'Stars' });
  const drawStars = () => starBox.replaceChildren(...[1, 2, 3, 4, 5].map(n => el('button', { type: 'button', role: 'radio', 'aria-checked': n === stars, 'aria-label': n + ' stars', id: 'star-' + n, class: n <= stars ? 'on' : '', onclick: () => { stars = n; drawStars(); } }, '★')));
  const text = el('textarea', { id: 'rv-text', maxlength: 1000, placeholder: 'How was the food? (optional)', value: mine ? mine.body : '' });
  const shot = el('div', { class: 'shotbox' });
  const drawShot = () => shot.replaceChildren(...[(prev || keepPhoto) ? el('img', { class: 'shot-prev', src: prev || publicUrl(keepPhoto), alt: '' }) : null,
    el('label', { class: 'btn small', style: 'text-align:center' }, (prev || keepPhoto) ? 'Change photo' : 'Add a photo (optional)',
      el('input', { type: 'file', accept: 'image/*', id: 'rv-file', style: 'display:none', onchange: async e => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        try { blob = await shrink(f); if (prev) URL.revokeObjectURL(prev); prev = URL.createObjectURL(blob); drawShot(); } catch (x) { err.textContent = niceErr(x); }
      } }))].filter(Boolean));
  drawStars(); drawShot();
  openModal(el('div', { class: 'sheet' }, el('h2', { text: mine ? 'Your review' : 'How was your order?' }),
    el('div', { class: 'sub', text: `Order #${pad3(o.no)} · ${(o.items || []).map(i => i.name).join(', ')}` }),
    starBox, text, shot, err,
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', id: 'rv-send', onclick: async e => {
        if (!stars) { err.textContent = 'Tap the stars first.'; return; }
        const btn = e.currentTarget; btn.disabled = true; err.textContent = '';
        try {
          let photo = keepPhoto || '';
          if (blob) {
            photo = `reviews/${S.session.user.id}/${newId()}.jpg`;
            const up = await sb.storage.from('photos').upload(photo, blob, { contentType: 'image/jpeg', upsert: false });
            if (up.error) throw up.error;
          }
          const { error } = await sb.rpc('submit_review', { p_order_id: o.id, p_stars: stars, p_body: text.value.trim(), p_photo: photo });
          if (error) throw error;
          closeModal(); toast('Thank you for your review!'); await loadReviews(); render();
        } catch (x) { err.textContent = niceErr(x); btn.disabled = false; }
      } }, mine ? 'Update review' : 'Send review'))));
}
const SVC = { day: '☀ Day menu', night: '🌙 Night menu' };
/* the order that needs the customer's attention, shown above the menu */
function actionBanner() {
  const o = activeOrders().filter(x => !x.paid).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || activeOrders()[0];
  if (!o) return null;
  const st = o.status === 'accepted' ? 'Accepted' : o.status === 'ready' ? (o.type === 'delivery' ? 'On the way' : 'Ready') : 'Sent · waiting for the kitchen';
  const canPay = !o.paid && !o.pay_submitted_at;
  return el('div', { class: 'act-banner' + (canPay && o.status !== 'new' ? ' hot' : ''), id: 'act-banner' },
    el('button', { class: 'ab-main', type: 'button', onclick: () => go('orders') }, el('b', { text: `Order #${pad3(o.no)}` }), el('span', { text: st + (o.paid ? ' · paid' : o.pay_submitted_at ? ' · payment sent' : '') })),
    canPay ? el('button', { class: 'ab-pay', type: 'button', id: 'ab-pay', onclick: () => payModal(o) }, `Pay ${money(o.total)}`) : null);
}
function viewMenu(root) {
  const all = S.menu.filter(m => !m.deleted);
  if (!all.length) { root.append(el('div', { class: 'empty' }, el('b', { text: 'The menu is empty right now' }), 'Please check back later.')); return; }
  const ban = actionBanner(); if (ban) root.append(ban);
  const menu = all;
  const cats = ['All', ...new Set(menu.map(m => m.category || 'Other'))];
  if (!cats.includes(S.cat)) S.cat = 'All';
  root.append(el('div', { class: 'chips' }, cats.map(c => el('button', { class: 'chip', type: 'button', 'aria-pressed': S.cat === c, onclick: () => { S.cat = c; render(); } }, c))));
  const show = menu.filter(m => S.cat === 'All' || (m.category || 'Other') === S.cat).sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || ''));
  const by = new Map();
  for (const m of show) { const c = m.category || 'Other'; if (!by.has(c)) by.set(c, []); by.get(c).push(m); }
  // one grid for everything, category names span the full width, so small categories don't leave holes
  root.append(el('div', { class: 'dishes' }, [...by].map(([c, arr]) => [S.cat === 'All' ? el('h2', { class: 'cat-h', text: c }) : null, arr.map(dishCard)])));
}
function dishCard(m) {
  const vs = (m.variants || []).map(v => num(v.price));
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const inB = S.basket.filter(l => l.menuId === m.id).reduce((a, l) => a + l.qty, 0);
  const pic = m.photo ? el('img', { class: 'img', src: publicUrl(m.photo), alt: m.name, loading: 'lazy' }) : el('div', { class: 'ph', style: '--h:' + hue(m.name), 'aria-hidden': 'true', text: initial(m.name) });
  if (m.photo) pic.addEventListener('error', () => pic.replaceWith(el('div', { class: 'ph', style: '--h:' + hue(m.name), text: initial(m.name) })));
  const r = ratingOf(m.id);
  return el('article', { class: 'dish' + (m.available === false ? ' off' : ''), 'data-id': m.id, tabindex: '0', onclick: e => { if (!e.target.closest('.add')) dishSheet(m); } }, pic,
    el('div', { class: 'body' },
      el('h3', {}, m.name, hasNight() ? el('span', { class: 'svc-ic ' + svcOf(m), title: svcOf(m) === 'night' ? 'Night dish' : 'Day dish', text: svcOf(m) === 'night' ? '🌙' : '☀' }) : null),
      r ? el('div', { class: 'rating', text: `★ ${r.avg} (${r.n})` }) : null,
      m.description ? el('div', { class: 'desc', text: m.description }) : null,
      (m.windows || []).length ? el('div', { class: 'win', text: '🕒 ' + m.windows.map(winLabel).join(', ') }) : null,
      el('div', { class: 'foot' }, el('span', { class: 'price', text: vs.length ? (lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`) : '' }),
        m.available === false ? el('span', { class: 'fineprint', text: 'Sold out' })
          : el('button', { class: 'add' + (inB ? ' in' : ''), type: 'button', 'aria-label': `Add ${m.name}`, onclick: () => addDish(m) }, inB ? `${inB} ✓` : '+'))));
}
function addDish(m) {
  // day and night dishes are separate orders
  const inBasket = S.basket.map(l => dish(l.menuId)).find(Boolean);
  if (inBasket && svcOf(inBasket) !== svcOf(m)) {
    openModal(el('div', { class: 'sheet' }, el('h2', { text: 'Separate order' }),
      el('p', { class: 'sub', text: `Your basket has ${svcOf(inBasket)} dishes. Day and night dishes are ordered separately.` }),
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Keep my basket'),
        el('button', { class: 'btn primary', type: 'button', id: 'svc-clear', onclick: () => { S.basket = []; saveBasket(); closeModal(); addDish(m); } }, 'Empty basket, add this'))));
    return;
  }
  const vs = m.variants && m.variants.length ? m.variants : [{ label: '', price: 0 }];
  const put = v => {
    const l = S.basket.find(x => x.menuId === m.id && x.variant === (v.label || ''));
    if (l) l.qty++; else S.basket.push({ menuId: m.id, variant: v.label || '', qty: 1 });
    saveBasket(); render(); toast(`${m.name}${v.label ? ' (' + v.label + ')' : ''} added`);
  };
  if (vs.length === 1) return put(vs[0]);
  openModal(el('div', { class: 'sheet' }, el('h2', { text: m.name }), el('div', { class: 'sub', text: 'Choose a size' }),
    el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, vs.map(v =>
      el('button', { class: 'btn', type: 'button', style: 'display:flex;justify-content:space-between;padding:12px', onclick: () => { closeModal(); put(v); } },
        el('span', { text: v.label || 'Regular' }), el('span', { text: money(v.price) })))),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'))));
}
function renderBar() {
  const n = basketCount();
  const bar = $('#bar');
  if (!n || S.view !== 'menu') { bar.replaceChildren(); return; }
  const d = S.draft, fee = d.type === 'pickup' ? null : addrFee(d.address);
  const feeLine = d.type === 'pickup' ? 'Pickup · no delivery fee'
    : fee !== null ? (fee ? `+ delivery ${money(fee)} · ${d.address}` : `Free delivery · ${d.address}`) : '+ delivery fee by address';
  const t = money(basketTotal()), cur = S.biz.currency || '';
  const icon = el('span', { class: 'cart-svg', 'aria-hidden': 'true' });
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1.3 11.2a2 2 0 0 1-2 1.8H8.3a2 2 0 0 1-2-1.8z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/></svg>';
  const toCheckout = () => go('checkout');
  bar.replaceChildren(el('div', { class: 'cartbar' },
    el('button', { class: 'cart-ic', type: 'button', 'aria-label': `Basket, ${n} item${n === 1 ? '' : 's'}`, onclick: toCheckout }, icon, el('span', { class: 'cart-badge', text: n > 99 ? '99+' : n })),
    el('button', { class: 'cart-sum', type: 'button', onclick: toCheckout },
      el('b', { class: 'cart-total' }, t.startsWith(cur) && cur ? [el('small', { text: cur }), t.slice(cur.length)] : t),
      el('small', { class: 'cart-fee', text: feeLine })),
    el('button', { class: 'cart-go', type: 'button', id: 'go-checkout', onclick: toCheckout }, 'Checkout')));
}

/* ---------- checkout ---------- */
/* China time (Asia/Shanghai), whatever the phone's own time zone is */
function chinaNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const addDays = (day, n) => { const [y, m, d] = day.split('-').map(Number); return isoDay(new Date(y, m - 1, d + n).getTime()); };
/* a window like 12:00–14:00 is closed for today once 14:00 has passed in China */
const winOpenToday = (label, now) => { const end = label.split('–')[1] || ''; return !end || end > now.time; };
function orderWindows() {
  const withWin = S.basket.map(l => dish(l.menuId)).filter(m => m && (m.windows || []).length);
  const all = new Set();
  const first = S.basket.map(l => dish(l.menuId)).find(Boolean);
  const same = S.menu.filter(m => !first || svcOf(m) === svcOf(first));
  for (const m of (withWin.length ? withWin : same)) for (const w of (m.windows || [])) all.add(winLabel(w));
  let list = [...all];
  if (withWin.length) list = list.filter(x => withWin.every(m => m.windows.some(w => winLabel(w) === x)));
  return { list: list.sort(), clash: withWin.length > 0 && !list.length };
}
function viewCheckout(root) {
  const d = S.draft;
  if (!basketCount()) { root.append(el('div', { class: 'empty' }, el('b', { text: 'Your basket is empty' }), el('button', { class: 'btn primary', type: 'button', onclick: () => go('menu') }, 'Back to the menu'))); return; }
  if (!S.biz.pickup) d.type = 'delivery';
  if (d.address && addrFee(d.address) === null) d.address = '';
  const now = chinaNow();
  const { list: all, clash } = orderWindows();
  const todayOpen = all.filter(x => winOpenToday(x, now));
  // if every window has passed today, only tomorrow onwards can be chosen
  const dates = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(now.day, i)).filter(x => !(x === now.day && all.length && !todayOpen.length));
  if (!d.slotDate || !dates.includes(d.slotDate)) d.slotDate = dates[0];
  const list = d.slotDate === now.day ? todayOpen : all;
  if (d.slot && !list.includes(d.slot)) d.slot = '';
  const sub = basketTotal(), fee = d.type === 'delivery' ? (addrFee(d.address) || 0) : 0;
  const lines = S.basket.map((l, i) => {
    const m = dish(l.menuId); if (!m) return null;
    return el('div', { class: 'line' },
      el('div', { class: 'nm' }, m.name, l.variant ? el('small', { text: ' · ' + l.variant }) : null),
      el('div', { class: 'qty' },
        el('button', { type: 'button', 'aria-label': 'One less', onclick: () => { l.qty--; if (l.qty <= 0) S.basket.splice(i, 1); saveBasket(); render(); } }, '−'),
        el('span', { text: l.qty }),
        el('button', { type: 'button', 'aria-label': 'One more', onclick: () => { l.qty++; saveBasket(); render(); } }, '+')),
      el('div', { class: 'pr', text: money(priceOf(m, l.variant) * l.qty) }));
  });
  const fld = (id, label, key, attrs) => el('div', { class: 'field' }, el('label', { for: id, text: label }),
    el('input', Object.assign({ id, value: d[key] || '', oninput: e => { d[key] = e.target.value; store.set('draft', d); } }, attrs)));
  const err = el('div', { class: 'err', role: 'alert' });
  root.append(
    el('div', { class: 'box' }, el('h2', {}, el('span', { class: 'stepn', text: '1' }), 'Your order'), lines,
      el('button', { class: 'link', type: 'button', style: 'align-self:flex-start', onclick: () => go('menu') }, '+ Add more')),
    el('div', { class: 'box' }, el('h2', {}, el('span', { class: 'stepn', text: '2' }), S.biz.pickup ? 'Delivery or pickup' : 'Delivery'),
      S.biz.pickup ? el('div', { class: 'seg', role: 'group', 'aria-label': 'Delivery or pickup' }, [['delivery', 'Delivery'], ['pickup', 'Pickup']].map(([k, lbl]) =>
        el('button', { type: 'button', 'aria-pressed': d.type === k, onclick: () => { d.type = k; render(); } }, lbl))) : null,
      d.type === 'delivery' ? el('div', { class: 'field' }, el('label', { for: 'c-addr', text: 'Delivery address' }),
        el('select', { id: 'c-addr', onchange: e => { d.address = e.target.value; render(); } },
          el('option', { value: '', text: 'Choose your address…' }),
          (S.biz.addresses || []).map(a => el('option', { value: a.name, selected: a.name === d.address, text: `${a.name}${feeOf(a, basketPizza()) ? ' · delivery fee' : ' · free delivery'}` })))) : null,
      el('div', { class: 'field' }, el('label', { text: d.type === 'delivery' ? 'Delivery time' : 'Pickup time' }),
        el('div', { class: list.length ? 'two' : '' },
          el('select', { id: 'c-day', 'aria-label': 'Day', onchange: e => { d.slotDate = e.target.value; render(); } }, dates.map(x => el('option', { value: x, selected: x === d.slotDate, text: dayLabel(x) }))),
          list.length ? el('select', { id: 'c-slot', 'aria-label': 'Time', onchange: e => { d.slot = e.target.value; } },
            el('option', { value: '', text: 'Choose time', disabled: true, selected: !d.slot }), list.map(x => el('option', { value: x, selected: x === d.slot, text: x }))) : null),
        all.length && !todayOpen.length ? el('div', { class: 'fineprint', id: 'c-tomorrow', text: 'Today\'s times have passed, so the earliest is tomorrow.' }) : null,
        clash ? el('div', { class: 'err', text: 'These dishes are served at different times. Please order them separately.' }) : null)),
    el('div', { class: 'box' }, el('h2', {}, el('span', { class: 'stepn', text: '3' }), 'Your details'),
      fld('c-name', 'Name', 'name', Object.assign({ autocomplete: 'nickname', placeholder: 'Your WeChat name', maxlength: 80 }, isLinked() ? { readonly: true } : {})),
      isLinked() ? el('div', { class: 'fineprint', style: 'margin-top:-6px', text: `${S.biz.name || 'The kitchen'} knows you by this name.` }) : null,
      isLinked() ? null : el('div', { class: 'fineprint', style: 'margin-top:-6px', text: 'Preferably your WeChat name: it makes it easy to track and deliver your parcel correctly.' }),
      fld('c-phone', 'Phone (optional)', 'phone', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: 'Optional' }),
      el('div', { class: 'field' }, el('label', { for: 'c-note', text: 'Note for the kitchen (optional)' }),
        el('textarea', { id: 'c-note', value: d.note || '', placeholder: 'Less spicy, extra raita…', oninput: e => { d.note = e.target.value; store.set('draft', d); } }))),
    el('div', { class: 'box sumbox' },
      el('div', { class: 'sumrow' }, el('span', { text: 'Items' }), el('span', { text: money(sub) })),
      d.type === 'delivery' ? el('div', { class: 'sumrow' }, el('span', { text: 'Delivery' + (d.address ? ' · ' + d.address : '') }), el('span', { text: d.address ? feeText(fee) : '–' })) : null,
      el('div', { class: 'sumrow total' }, el('span', { text: 'Total' }), el('span', { id: 'c-total', text: money(sub + fee) })),
      el('div', { class: 'fineprint', text: 'Pay by WeChat Pay or Alipay, now or later. We start cooking once payment is confirmed. To change or cancel an order, message us.' }),
      err,
      el('button', { class: 'btn primary big-btn', type: 'button', id: 'c-place', disabled: clash, onclick: () => placeOrder(err) }, S.session ? 'Place order' : 'Continue')));
}
async function placeOrder(err) {
  const d = S.draft;
  err.textContent = '';
  if (d.type === 'delivery' && addrFee(d.address) === null) { err.textContent = 'Choose your delivery address.'; return; }
  if (orderWindows().list.length && !d.slot) { err.textContent = `Choose a ${d.type === 'delivery' ? 'delivery' : 'pickup'} time.`; return; }
  if (!(d.name || '').trim()) { err.textContent = 'Please add your name (your WeChat name is best).'; $('#c-name').focus(); return; }
  if (!S.session) { authSheet(() => placeOrder(err)); return; }
  const btn = $('#c-place'); btn.disabled = true; btn.textContent = 'Placing your order…';
  try {
    const { data, error } = await sb.rpc('place_order', { p: {
      items: S.basket.map(l => ({ menu_id: l.menuId, variant: l.variant, qty: l.qty })),
      type: d.type, address: d.type === 'delivery' ? d.address : '', slot_date: d.slotDate, slot: d.slot,
      note: d.note || '', name: d.name.trim(), phone: d.phone.trim() } });
    if (error) throw error;
    S.lastOrder = data; S.basket = []; d.note = ''; saveBasket();
    S.orders = [data, ...S.orders.filter(o => o.id !== data.id)];
    if (!S.profile) S.profile = { name: data.customer_name, notes: 'Signed up in the shop' }; else S.profile.name = data.customer_name;
    lastStatus.set(data.id, data.status);
    Sound.play('placed');
    go('done');
    payModal(data); // offer to pay now (Pay later is the first choice)
  } catch (e) { err.textContent = niceErr(e); btn.disabled = false; btn.textContent = 'Place order'; }
}

/* ---------- sign in: one field (mobile number or email) → password, or create a password ----------
   save: a guest turns their guest login into a phone/email account, keeping the same account. */
function authSheet(after, save) {
  let step = 'id';
  const title0 = save ? 'Save my account' : 'Sign in';
  const isEmail = v => v.includes('@');
  const digitsOf = v => { let d = v.replace(/\D/g, ''); if (d.length === 13 && d.startsWith('86')) d = d.slice(2); return d; };
  const login = v => isEmail(v) ? v.trim().toLowerCase() : `${digitsOf(v)}@${CFG.phoneDomain}`;
  const title = el('h2', { class: 'auth-title', id: 'a-title', text: title0 });
  const id = el('input', { id: 'a-id', type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: false, 'aria-label': 'Mobile number or email',
    placeholder: 'Mobile number or email', value: S.draft.phone || '' });
  const change = el('button', { class: 'link auth-change', type: 'button', id: 'a-change', tabindex: -1, onclick: () => setStep('id') }, 'Change');
  const pw = el('input', { id: 'a-pw', type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password' });
  const pw2 = el('input', { id: 'a-pw2', type: 'password', autocomplete: 'new-password', placeholder: 'Confirm password', 'aria-label': 'Confirm password' });
  const nm = el('input', { id: 'a-name', type: 'text', autocomplete: 'name', placeholder: 'Your name (preferably your WeChat name)', 'aria-label': 'Your name' });
  const forgot = el('p', { class: 'fineprint auth-forgot', text: 'Forgot your password? Message us and we will reset it.' });
  const more = el('div', { class: 'auth-more', inert: '' }, el('div', { class: 'auth-more-in' }, nm, pw, pw2, forgot));
  const err = el('div', { class: 'err', role: 'alert' });
  const btn = el('button', { class: 'btn primary big-btn', type: 'button', id: 'a-next', onclick: () => (step === 'id' ? next() : go()) }, 'Continue');
  const sheet = el('div', { class: 'sheet auth' }, title, el('div', { class: 'auth-id' }, id, change), more, err, btn);
  const enter = e => { if (e.key === 'Enter') btn.click(); };
  for (const x of [id, pw, pw2, nm]) x.onkeydown = enter;

  function setTitle(t) {
    if (title.textContent === t) return;
    title.classList.add('fade'); setTimeout(() => { title.textContent = t; title.classList.remove('fade'); }, 160);
  }
  function setStep(st) {
    step = st; err.textContent = '';
    const done = st !== 'id';
    sheet.classList.toggle('submitted', done);
    id.readOnly = done; change.tabIndex = done ? 0 : -1;
    nm.hidden = !(st === 'create' && !S.draft.name);
    pw2.hidden = st !== 'create';
    forgot.hidden = st !== 'login';
    pw.autocomplete = st === 'create' ? 'new-password' : 'current-password';
    pw.placeholder = st === 'create' ? 'Password (6+ characters)' : 'Password';
    pw.value = ''; pw2.value = '';
    more.classList.toggle('open', done);
    if (done) more.removeAttribute('inert'); else more.setAttribute('inert', '');
    setTitle(st === 'create' && !save ? 'New here? Create a password' : st === 'login' && save ? 'This already has an account' : title0);
    btn.id = done ? 'a-go' : 'a-next';
    btn.textContent = st === 'id' ? 'Continue' : st === 'login' ? 'Sign in' : save ? 'Save my account' : 'Create account';
    btn.disabled = false;
    setTimeout(() => (done ? (nm.hidden ? pw : nm) : id).focus(), done ? 320 : 50);
  }
  async function next() {
    err.textContent = '';
    const v = id.value.trim();
    if (!v) { err.textContent = 'Enter your mobile number or email.'; return; }
    if (isEmail(v) ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) : digitsOf(v).length < 5) { err.textContent = isEmail(v) ? 'That email does not look right.' : 'That mobile number does not look right.'; return; }
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      if (!sb) throw new Error('No connection. Check your internet and try again.');
      const { data, error } = await sb.rpc('account_exists', { p_login: login(v) });
      if (error) throw error;
      if (!isEmail(v)) { id.value = digitsOf(v); if (!S.draft.phone) { S.draft.phone = id.value; store.set('draft', S.draft); } }
      setStep(data ? 'login' : 'create');
    } catch (e) { err.textContent = niceErr(e); btn.disabled = false; btn.textContent = 'Continue'; }
  }
  function go() {
    err.textContent = '';
    if (!pw.value) { err.textContent = 'Enter your password.'; return; }
    if (step === 'create') {
      if (pw.value.length < 6) { err.textContent = 'Choose a password with at least 6 characters.'; return; }
      if (pw.value !== pw2.value) { err.textContent = 'The two passwords do not match.'; return; }
      if (!nm.hidden && nm.value.trim()) { S.draft.name = nm.value.trim(); store.set('draft', S.draft); }
    }
    const em = login(id.value);
    run(async () => {
      if (step === 'login') return sb.auth.signInWithPassword({ email: em, password: pw.value });
      if (save) {
        const { error } = await sb.rpc('claim_account', { p_login: em, p_password: pw.value });
        if (error) return { error };
        return sb.auth.signInWithPassword({ email: em, password: pw.value });
      }
      return sb.auth.signUp({ email: em, password: pw.value });
    });
  }
  async function run(fn) {
    btn.disabled = true;
    try {
      if (!sb) throw new Error('No connection. Check your internet and try again.');
      const { data, error } = await fn();
      if (error) throw error;
      if (!data.session) throw new Error('Check your email to confirm your account, then sign in.');
      await onSession(data.session);
      closeModal();
      if (save) toast('Account saved');
      if (after) after();
    } catch (e) {
      err.textContent = /invalid login/i.test((e && e.message) || '') ? 'Wrong password. Forgot it? Message us and we will reset it.' : niceErr(e);
      btn.disabled = false;
    }
  }
  openModal(sheet); setStep('id');
}
async function refreshProfile() {
  try {
    const { data } = await sb.from('customers').select('name,phone,address,photo,notes').limit(1);
    if (data && data[0]) { S.profile = data[0]; if (isLinked()) { S.draft.name = data[0].name || S.draft.name; store.set('draft', S.draft); } }
  } catch (_) { /* fine */ }
}
const isLinked = () => !!(S.session && S.profile && S.profile.notes !== undefined && S.profile.notes !== 'Signed up in the shop');
async function onSession(session) {
  const prevUser = S.session && S.session.user && S.session.user.id;
  S.session = session || null;
  if (session && prevUser && prevUser !== session.user.id) { S.profile = null; Object.assign(S.draft, { name: '', phone: '' }); }
  if (!session) { S.orders = []; return; }
  // fill in name / phone / address from the profile the shop keeps for this account
  try {
    const { data } = await sb.from('customers').select('name,phone,address,photo,notes').limit(1);
    const p = data && data[0];
    S.profile = p || null;
    if (p) {
      // the account's name fills the order; a name set by the kitchen (Link) always wins
      if (isLinked() || !S.draft.name) S.draft.name = p.name || '';
      if (!S.draft.phone) S.draft.phone = p.phone || '';
      if (!S.draft.address && addrFee(p.address) !== null) S.draft.address = p.address;
      store.set('draft', S.draft);
    }
  } catch (_) { /* fine */ }
  loadAcct();
  listen(); loadOrders(); loadMsgs();
}
/* Verified / Unverified (undefined = unknown, e.g. offline) */
async function loadAcct() {
  S.acct = undefined;
  const u = S.session && S.session.user;
  if (!u || u.is_anonymous) return;
  try {
    const { data, error } = await sb.from('accounts').select('verified').eq('user_id', u.id).limit(1);
    if (error) return;
    S.acct = (data && data[0]) || { verified: false };
    if (S.view === 'me') render();
  } catch (_) { /* fine */ }
}

/* ---------- payment ---------- */
async function shrink(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('That file is not a picture this phone can read.')); im.src = URL.createObjectURL(file); }); }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, k = Math.min(1, 1600 / Math.max(w, h));
  const cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.8));
}
const PAYWAYS = {
  wechat: { base: 'wechat', title: 'WeChat Pay QR', hint: 'Scan our QR code' },
  alipay: { base: 'alipay', title: 'Alipay QR', hint: 'Scan our QR code' },
  wechat_chat: { base: 'wechat', title: 'Pay in WeChat chat', hint: 'Send the money to us in WeChat' },
  alipay_chat: { base: 'alipay', title: 'Pay in Alipay chat', hint: 'Transfer to us in Alipay' },
};
const APP = { wechat: 'WeChat', alipay: 'Alipay' };
function payLogo(m) {
  const b = (PAYWAYS[m] || {}).base || m;
  if (b !== 'wechat' && b !== 'alipay') return null;
  return el('img', { class: 'paylogo', src: `../pay-${b}.png`, alt: '', onerror: e => e.target.replaceWith(el('span', { class: 'paylogo fb ' + b })) });
}
function payBox(o) {
  if (o.status === 'cancelled') return null;
  if (o.paid) return el('div', { class: 'paybox ok' }, el('b', { text: '✓ Payment confirmed' }));
  const w = PAYWAYS[o.pay_method];
  if (o.pay_submitted_at) return el('div', { class: 'paybox' },
    el('b', {}, payLogo(o.pay_method), o.pay_proof ? 'Screenshot sent' : `You paid in ${APP[w ? w.base : 'wechat']} chat`),
    el('span', { class: 'fineprint', text: 'We are checking your payment and start cooking once it is confirmed.' }),
    el('button', { class: 'btn small', type: 'button', onclick: () => payModal(o) }, 'Change or send a screenshot'));
  return el('div', { class: 'paybox' }, el('b', { text: `Not paid yet · ${money(o.total)}` }),
    el('span', { class: 'fineprint', text: 'Pay whenever you are ready. We start cooking once payment is confirmed.' }),
    el('button', { class: 'btn primary', type: 'button', id: 'pay-' + o.no, onclick: () => payModal(o) }, 'Pay now'));
}
async function saveQr(path, name) {
  try {
    const r = await fetch(publicUrl(path)); if (!r.ok) throw new Error();
    const u = URL.createObjectURL(await r.blob());
    const a = el('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  } catch (_) { toast('Could not save it. Long-press the code or take a screenshot instead.', true); }
}
function copyText(t) {
  const done = () => toast('Copied');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => toast('Long-press to copy it.', true));
  else toast('Long-press to copy it.', true);
}
/* paying: pick one of four ways, then a QR + screenshot, or "I've paid" for chat */
function payModal(o) {
  const P = S.biz.pay || {};
  const ways = Object.keys(PAYWAYS).filter(k => (k === 'wechat' ? P.wechatQr : k === 'alipay' ? P.alipayQr : true));
  let way = PAYWAYS[o.pay_method] && ways.includes(o.pay_method) && o.pay_submitted_at ? o.pay_method : '', blob = null, prev = '';
  const sheet = el('div', { class: 'sheet paysheet' });
  const pickShot = (err, onPick) => el('label', { class: 'btn', style: 'text-align:center' }, prev ? 'Choose another screenshot' : 'Choose screenshot',
    el('input', { type: 'file', accept: 'image/*', id: 'pay-file', style: 'display:none', onchange: async e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      try { blob = await shrink(f); if (prev) URL.revokeObjectURL(prev); prev = URL.createObjectURL(blob); onPick(); } catch (x) { err.textContent = niceErr(x); }
    } }));
  function drawChoose() {
    sheet.replaceChildren(el('h2', { text: `Order #${pad3(o.no)} · ${money(o.total)}` }), el('div', { class: 'sub', text: 'Pay now or later, whatever suits you.' }),
      el('div', { class: 'payways' },
        el('button', { class: 'payway later', type: 'button', id: 'way-later', onclick: closeModal },
          el('span', { class: 'later-ic', text: '🕒' }), el('span', {}, el('b', { text: 'Pay later' }), el('small', { text: 'Pay any time from My orders' })), el('span', { class: 'chev', text: '›' })),
        ways.map(k => el('button', { class: 'payway', type: 'button', id: 'way-' + k, onclick: () => { way = k; drawWay(); } },
          payLogo(k), el('span', {}, el('b', { text: PAYWAYS[k].title }), el('small', { text: PAYWAYS[k].hint })), el('span', { class: 'chev', text: '›' })))));
  }
  function drawWay() {
    const w = PAYWAYS[way], isQr = !way.endsWith('_chat'), app = APP[w.base];
    const err = el('div', { class: 'err', role: 'alert' });
    const shot = el('div', { class: 'shotbox' });
    const drawShot = () => shot.replaceChildren(...[prev ? el('img', { class: 'shot-prev', src: prev, alt: 'Your screenshot' }) : null, pickShot(err, drawShot)].filter(Boolean));
    drawShot();
    const qrPath = w.base === 'wechat' ? P.wechatQr : P.alipayQr, acct = w.base === 'wechat' ? P.wechatId : P.alipayId;
    const how = isQr
      ? [el('div', { class: 'qrwrap' }, el('img', { class: 'qr', src: publicUrl(qrPath), alt: `${w.title} code` })),
        el('button', { class: 'btn small', type: 'button', style: 'align-self:center', onclick: () => saveQr(qrPath, `${w.base}-pay.jpg`) }, 'Save QR to photos'),
        el('ol', { class: 'howto' },
          el('li', { text: 'Long-press the code, or save it to your photos.' }),
          el('li', { text: `In ${app}: Scan → pick the picture from your album → pay ${money(o.total)}.` }),
          el('li', { text: 'Send us the payment screenshot below.' }))]
      : [el('ol', { class: 'howto' },
          el('li', {}, `Send ${money(o.total)} to us in ${app} chat`, acct ? '' : '.'),
          acct ? el('li', { class: 'acct' }, el('span', { text: `${w.base === 'wechat' ? 'WeChat ID' : 'Alipay account'}: ` }), el('b', { text: acct }),
            el('button', { class: 'link', type: 'button', onclick: () => copyText(acct) }, 'Copy')) : null,
          el('li', { text: 'Tap "I have paid". A screenshot helps us confirm faster (optional).' }))];
    sheet.replaceChildren(
      el('div', { class: 'payhead' }, payLogo(way), el('h2', { text: w.title })),
      el('div', { class: 'amount', text: money(o.total) }),
      ...how,
      el('div', { class: 'field' }, el('label', { text: isQr ? 'Payment screenshot' : 'Screenshot (optional)' }), shot), err,
      el('div', { class: 'actions' },
        el('button', { class: 'btn left', type: 'button', onclick: () => { blob = null; drawChoose(); } }, '‹ Other ways'),
        el('button', { class: 'btn primary', type: 'button', id: 'pay-send', onclick: async e => {
          if (isQr && !blob) { err.textContent = 'Choose the payment screenshot first.'; return; }
          e.currentTarget.disabled = true; const btn = e.currentTarget; err.textContent = '';
          try {
            let path = '';
            if (blob) {
              path = `${S.session.user.id}/receipt-${newId()}.jpg`;
              const up = await sb.storage.from('receipts').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
              if (up.error) throw up.error;
            }
            const { error } = await sb.rpc('submit_payment', { order_id: o.id, proof: path, method: way });
            if (error) throw error;
            closeModal(); toast(path ? 'Screenshot sent. Thank you!' : 'Thank you! We will confirm your payment.'); await loadOrders();
            if (S.lastOrder && S.lastOrder.id === o.id) S.lastOrder = S.orders.find(x => x.id === o.id) || S.lastOrder;
            render();
          } catch (x) { err.textContent = niceErr(x); btn.disabled = false; }
        } }, isQr ? 'Send screenshot' : 'I have paid')));
  }
  if (way) drawWay(); else drawChoose();
  openModal(sheet);
}
const pad3 = n => String(n || 0).padStart(3, '0');

/* ---------- after ordering, and my orders ---------- */
function viewDone(root) {
  const o = S.lastOrder;
  if (!o) { go('menu'); return; }
  root.append(el('div', { class: 'done-hero' }, el('h1', { text: 'Order sent' }), el('div', { class: 'no', text: '#' + pad3(o.no) }),
    el('p', { class: 'sub', text: `${o.type === 'delivery' ? 'Delivery to ' + o.address : 'Pickup'} · ${[dayLabel(o.slot_date) || 'Today', o.slot].filter(Boolean).join(' · ')}` }),
    el('p', { class: 'sub', text: 'We will accept it shortly. You can follow it in Orders.' })),
  orderCard(o), el('button', { class: 'btn big-btn', type: 'button', onclick: () => go('orders') }, 'See all my orders'));
}
const STEPS = ['new', 'accepted', 'ready', 'done'];
function stepLabel(o, s) { return { new: 'Sent', accepted: 'Accepted', ready: o.type === 'delivery' ? 'On the way' : 'Ready', done: o.type === 'delivery' ? 'Delivered' : 'Picked up' }[s]; }
function statusLine(o) {
  return { new: 'Waiting for the kitchen to accept', accepted: o.paid ? 'Accepted · being cooked' : 'Accepted', ready: o.type === 'delivery' ? 'On the way to you' : 'Ready for pickup',
    done: o.type === 'delivery' ? 'Delivered · enjoy!' : 'Picked up · enjoy!' }[STEPS.includes(o.status) ? o.status : 'new'];
}
const picCache = new Map();
function privatePic(path, alt) { // delivery photo (only you and the kitchen can see it)
  const box = el('div', { class: 'proof' });
  const show = u => box.replaceChildren(el('a', { href: u, target: '_blank', rel: 'noopener' }, el('img', { src: u, alt })));
  if (picCache.has(path)) { show(picCache.get(path)); return box; }
  box.append(el('span', { class: 'fineprint', text: 'Loading photo…' }));
  sb.storage.from('receipts').download(path).then(({ data }) => {
    if (!data) { box.replaceChildren(el('span', { class: 'fineprint', text: 'Photo not available right now.' })); return; }
    const u = URL.createObjectURL(data); picCache.set(path, u); show(u);
  }).catch(() => box.replaceChildren());
  return box;
}
function orderCard(o) {
  const st = STEPS.includes(o.status) ? o.status : 'new';
  const idx = STEPS.indexOf(st), when = [dayLabel(o.slot_date), o.slot].filter(Boolean).join(' · ');
  return el('article', { class: 'ocard', 'data-no': o.no },
    el('div', { class: 'oh' }, el('span', { class: 't-no', text: '#' + pad3(o.no) }),
      el('span', { class: 'sub', text: new Date(o.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + timeStr(Date.parse(o.created_at)) }),
      S.biz.pickup || o.type === 'pickup' ? el('span', { class: 'tag', style: 'margin-left:auto', text: o.type === 'delivery' ? 'Delivery' : 'Pickup' }) : null),
    o.status === 'cancelled' ? el('div', { class: 'err', text: 'Cancelled' })
      : el('div', {}, el('div', { class: 'ostatus', text: statusLine(o) }),
        el('div', { class: 'steps' }, STEPS.map((s, i) => el('span', { class: i <= idx ? 'on' : '' }))),
        el('div', { class: 'steplbl' }, STEPS.map((s, i) => i === idx ? el('b', { text: stepLabel(o, s) }) : el('span', { text: stepLabel(o, s) })))),
    when ? el('div', { class: 'when', text: '🕒 ' + when }) : null,
    el('ul', { class: 'lines' }, (o.items || []).map(it => el('li', {}, el('span', { text: `${it.qty}× ${it.name}${it.variant ? ' (' + it.variant + ')' : ''}` }), el('span', { text: money(num(it.price) * it.qty) }))),
      o.type === 'delivery' ? el('li', {}, el('span', { text: 'Delivery · ' + o.address }), el('span', { text: feeText(num(o.fee)) })) : null),
    el('div', { class: 'sumrow total' }, el('span', { text: 'Total' }), el('span', { text: money(o.total) })),
    payBox(o),
    o.delivery_proof ? el('div', { class: 'proofbox' }, el('b', { text: o.type === 'delivery' ? 'Delivery photo' : 'Photo' }), privatePic(o.delivery_proof, 'Delivery photo')) : null,
    o.status === 'done' && !S.reviewsOff ? (() => { const mine = S.reviews.find(r => r.order_id === o.id);
      return el('button', { class: mine ? 'my-rev' : 'btn small primary', type: 'button', id: 'rv-' + o.no, style: 'align-self:flex-start', onclick: () => reviewSheet(o) },
        mine ? [el('span', { class: 'stars', text: starStr(mine.stars) }), ' Your review · edit'] : '★ Write a review'); })() : null,
    S.msgsOff ? null : el('button', { class: 'link', type: 'button', style: 'align-self:flex-start', onclick: () => openChat(o.no) }, '💬 Message us about this order'));
}
function viewOrders(root) {
  root.append(el('h1', { class: 'page-h', text: 'Orders' }));
  if (!S.session) {
    root.append(el('div', { class: 'empty' }, el('b', { text: 'No orders on this phone yet' }), 'Sign in to see orders you placed with your phone number or email.',
      el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn primary', type: 'button', onclick: () => authSheet(() => render()) }, 'Sign in'))));
    return;
  }
  if (!S.orders.length) { root.append(el('div', { class: 'empty' }, el('b', { text: 'No orders yet' }), el('button', { class: 'btn primary', type: 'button', onclick: () => go('menu') }, 'See the menu'))); return; }
  const act = activeOrders(), past = S.orders.filter(o => !act.includes(o));
  if (act.length) root.append(el('h2', { class: 'sect-h', text: 'Now' }), ...act.map(orderCard));
  if (past.length) root.append(el('h2', { class: 'sect-h', text: 'Earlier' }), ...past.map(orderCard));
}
let ordersSig = '';
const lastStatus = new Map();
async function loadOrders() {
  if (!sb || !S.session) return;
  try {
    const { data, error } = await sb.from('orders').select('*').eq('deleted', false).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    S.orders = data || [];
    // sounds when the kitchen moves an order along
    let tune = '', msg = '';
    for (const o of S.orders) {
      const was = lastStatus.get(o.id);
      if (was && was !== o.status) {
        if (o.status === 'accepted') { tune = 'accepted'; msg = `Order #${pad3(o.no)} accepted`; }
        else if (o.status === 'ready') { tune = 'otw'; msg = o.type === 'delivery' ? `Order #${pad3(o.no)} is on the way` : `Order #${pad3(o.no)} is ready`; }
        else if (o.status === 'done') { tune = 'done'; msg = `Order #${pad3(o.no)} delivered. Enjoy!`; }
      }
      lastStatus.set(o.id, o.status);
    }
    if (tune) { Sound.play(tune); toast(msg); }
    if (S.lastOrder) S.lastOrder = S.orders.find(o => o.id === S.lastOrder.id) || S.lastOrder;
    const sig = JSON.stringify(S.orders.map(o => [o.id, o.status, o.paid, o.pay_submitted_at, o.delivery_proof, o.customer_name]));
    if (S.orders[0] && S.profile && S.orders[0].customer_name && S.orders[0].customer_name !== S.profile.name) refreshProfile();
    const changed = sig !== ordersSig; ordersSig = sig;
    if (S.view === 'orders' || S.view === 'done' || (changed && (S.view === 'menu' || S.view === 'me')) ) render(); else renderTop();
  } catch (_) { /* try again later */ }
}
/* ---------- messages: one conversation with the kitchen ---------- */
async function loadMsgs() {
  if (!sb || !S.session) { S.msgs = []; return; }
  try {
    const { data, error } = await sb.from('messages').select('*').order('created_at', { ascending: true }).limit(300);
    if (error) { if (/messages|relation|schema cache/i.test(error.message || '')) S.msgsOff = true; return; }
    S.msgsOff = false;
    const before = S.msgs.length + ':' + unreadMsgs();
    S.msgs = data || [];
    if (S.view === 'chat') { drawChat(); if (unreadMsgs()) markRead(); }
    else if (before !== S.msgs.length + ':' + unreadMsgs()) { if (S.view === 'me') render(); else renderTop(); }
  } catch (_) { /* offline */ }
}
async function markRead() {
  for (const m of S.msgs) if (m.from_admin && !m.read_at) m.read_at = new Date().toISOString();
  renderTop();
  try { await sb.rpc('mark_messages_read'); } catch (_) { /* next time */ }
}
function openChat(orderNo) {
  if (!S.session) { authSheet(() => openChat(orderNo)); return; }
  S.chatAbout = orderNo || null; go('chat'); loadMsgs();
}
const CH = { list: null };
function drawChat() {
  if (!CH.list) return;
  let lastDay = '';
  CH.list.replaceChildren(...S.msgs.flatMap(m => {
    const t = Date.parse(m.created_at), d = dayLabel(isoDay(t)), out = [];
    if (d !== lastDay) { lastDay = d; out.push(el('div', { class: 'chat-day', text: d })); }
    out.push(el('div', { class: 'bubble ' + (m.from_admin ? 'them' : 'me') },
      m.order_no ? el('span', { class: 'b-order', text: '#' + pad3(m.order_no) }) : null,
      el('span', { class: 'b-text', text: m.body }), el('small', { text: timeStr(t) })));
    return out;
  }));
  if (!S.msgs.length) CH.list.append(el('div', { class: 'fineprint', style: 'text-align:center;padding:24px 8px', text: `Ask ${S.biz.name || 'us'} anything: your order, delivery, spice level…` }));
  requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
}
function viewChat(root) {
  const input = el('textarea', { id: 'chat-in', rows: 1, placeholder: 'Write a message…', maxlength: 1000 });
  const about = el('div', { class: 'chat-about' });
  const drawAbout = () => about.replaceChildren(...(S.chatAbout ? [el('span', { text: 'About order #' + pad3(S.chatAbout) }), el('button', { class: 'link', type: 'button', onclick: () => { S.chatAbout = null; drawAbout(); } }, 'remove')] : []));
  async function send(e) {
    const body = input.value.trim(); if (!body) return;
    const btn = e && e.currentTarget && e.currentTarget.tagName === 'BUTTON' ? e.currentTarget : $('#chat-send'); btn.disabled = true;
    try {
      const { data, error } = await sb.from('messages').insert({ client_id: S.session.user.id, body, order_no: S.chatAbout }).select().single();
      if (error) throw error;
      S.msgs.push(data); input.value = ''; S.chatAbout = null; drawAbout(); drawChat();
    } catch (x) { toast(niceErr(x), true); }
    btn.disabled = false;
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  CH.list = el('div', { class: 'chat-list' });
  root.append(el('div', { class: 'chat-top' }, el('button', { class: 'link', type: 'button', onclick: () => go('me') }, '‹ Back'), el('b', { text: S.biz.name || 'Messages' })),
    CH.list,
    el('div', { class: 'chat-bar' }, about, el('div', { class: 'chat-row' }, input, el('button', { class: 'btn primary', type: 'button', id: 'chat-send', onclick: send }, 'Send'))));
  drawAbout(); drawChat(); if (unreadMsgs()) markRead();
}
let channel = null;
function listen() {
  try {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('shop-orders').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => loadOrders())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => loadMsgs()).subscribe();
  } catch (_) { channel = null; }
}

/* ---------- start ---------- */
async function loadShop() {
  try {
    const [st, mn] = await Promise.all([
      sb.from('settings').select('*').eq('id', 'business'),
      sb.from('menu').select('*').eq('deleted', false)]);
    if (st.error) throw st.error; if (mn.error) throw mn.error;
    const b = (st.data || [])[0] || {};
    S.biz = { name: b.name || '', currency: b.currency ?? '¥', addresses: Array.isArray(b.addresses) ? b.addresses : [],
      pay: { wechatQr: b.pay_wechat_qr || '', alipayQr: b.pay_alipay_qr || '', wechatId: b.pay_wechat_id || '', alipayId: b.pay_alipay_id || '' }, pickup: b.pickup !== false };
    S.menu = mn.data || [];
    await Promise.all([loadReviews(), loadSales()]);
    S.basket = S.basket.filter(l => dish(l.menuId));
    S.loaded = true; S.loadErr = '';
  } catch (e) { S.loadErr = niceErr(e) + ' Pull down to reload.'; }
  render();
}
async function boot() {
  render();
  if (!sb) { S.loadErr = 'Could not start. Check your internet and reload.'; render(); return; }
  await loadShop();
  try { const r = await sb.auth.getSession(); if (r && r.data && r.data.session) { await onSession(r.data.session); render(); } } catch (_) { /* signed out */ }
  sb.auth.onAuthStateChange((ev, session) => { if (ev === 'SIGNED_OUT') { forgetPerson(); setTimeout(render); } else if (session) S.session = session; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadShop(); loadOrders(); } });
  setInterval(() => { if (document.visibilityState === 'visible') { loadOrders(); loadMsgs(); } }, 20000);
}
boot();
