/* Player: join a room by code, get a card, find people, call bingo. */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  let code = normCode(location.pathname.split('/')[2]);
  let token = code ? LS.get('hb2:p:' + code) : null;
  let R = null; // room view
  let ME = null; // {id, name, card, marks}
  let photos = {}; // cell -> dataURL (kept only on this phone)
  const pending = {}; // cell -> mark waiting to reach the server
  let prevLines = 0;
  let cur = -1;
  let pp = '';
  let origPhoto = '';
  let photoFirst = false; // the picker was opened straight from tapping an empty square
  const pendingUpload = {}; // cell -> true while a photo still has to reach the server
  let connectedOnce = false;

  // ── Photos live on this phone only (IndexedDB) ──
  const idb = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('hb2', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => { const t = db.transaction('photos', mode); const out = fn(t.objectStore('photos')); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)).catch(() => null),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => null),
      del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => null),
    };
  })();
  async function loadPhotos() {
    photos = {};
    if (!ME || !ME.card) return;
    await Promise.all(ME.card.map(async (c, i) => {
      const v = await idb.get(`${ME.id}:${i}`);
      if (v) photos[i] = v;
      else if (ME.marks[i] && ME.marks[i].p && token) photos[i] = serverPhoto(i); // e.g. opened on another phone
    }));
  }
  const serverPhoto = (i) => `/photo/${code}/${ME.id}/${i}.jpg?t=${encodeURIComponent(token)}&v=${(ME.marks[i] && ME.marks[i].u) || 0}`;

  // ── Toasts ──
  function toast(msg, bad) {
    let box = document.querySelector('.toast-box');
    if (!box) { box = document.createElement('div'); box.className = 'toast-box'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function show(v) {
    ['join', 'wait', 'msg', 'play'].forEach((id) => ($('#' + id).hidden = id !== v));
    $('#title').textContent = R ? R.title : 'Find Someone Who…';
  }
  function message(h, p) { $('#msgH').textContent = h; $('#msgP').textContent = p; show('msg'); }

  // ── Socket ──
  const socket = io();
  const emit = (ev, data) => new Promise((res) => socket.timeout(10000).emit(ev, data, (err, r) => res(err ? { ok: false, error: 'offline' } : r)));
  socket.on('connect', async () => {
    $('#net').textContent = '';
    if (!token) { if (!ME) showJoin(); return; }
    const r = await emit('player:resume', { code, token });
    if (!r.ok) {
      if (r.error === 'offline') return;
      forget();
      if (r.error === 'kicked') return message('You were removed', 'The host removed you from this room.');
      return showJoin();
    }
    if (connectedOnce) toast('Back online ✓');
    connectedOnce = true;
    await setMe(r.me);
    R = r.room;
    flushPending();
    render();
  });
  socket.on('disconnect', () => { if (ME) $('#net').textContent = 'Offline — your squares are saved and will sync when you reconnect.'; });
  socket.on('room', (room) => { const was = R && R.status; R = room; render(was); });
  socket.on('me', async (m) => { await setMe(m); render(); });
  socket.on('kicked', () => { forget(); message('You were removed', 'The host removed you from this room.'); });
  socket.on('fx', (fx) => {
    if (!ME) return;
    if (fx.type === 'start') toast('Game on! Go find people 🏃');
    if (fx.type === 'end') {
      toast('The host ended the game');
      for (const i in photos) if (String(photos[i]).startsWith('/photo/')) delete photos[i]; // server copies are deleted at the end
    }
    if (fx.type === 'resume') toast('The game is back on!');
    if (fx.type === 'bingo' || fx.type === 'blackout') {
      const word = fx.type === 'bingo' ? 'BINGO' : 'BLACKOUT';
      if (fx.playerId === ME.id) showBanner(`${word}! You’re #${fx.order} 🎉 Show the host your card.`);
      else toast(`${fx.type === 'bingo' ? '🎉' : '⭐'} ${fx.name} called ${word}! (#${fx.order})`);
    }
  });
  async function setMe(m) {
    const firstCard = m.card && (!ME || !ME.card);
    ME = m;
    ME.marks = ME.marks || {};
    for (const c in pending) ME.marks[c] = pending[c].n || pending[c].p ? { n: pending[c].n, p: pending[c].p } : undefined;
    await loadPhotos();
    if (firstCard) prevLines = lines().length;
  }
  function forget() { token = null; LS.del('hb2:p:' + code); }

  // ── Join ──
  function showJoin() {
    $('#code').value = code;
    show('join');
    (code ? $('#name') : $('#code')).focus();
  }
  $('#code').addEventListener('input', (e) => { e.target.value = normCode(e.target.value); });
  $('#jf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = normCode($('#code').value);
    const name = $('#name').value.trim();
    if (!c) return ($('#err').textContent = 'Enter the room code.');
    if (!name) return ($('#err').textContent = 'Enter your name.');
    $('#go').disabled = true;
    const r = await emit('player:join', { code: c, name });
    $('#go').disabled = false;
    if (!r.ok) return ($('#err').textContent = r.error === 'offline' ? 'Can’t reach the game — check your connection.' : r.error);
    $('#err').textContent = '';
    code = c;
    token = r.token;
    LS.set('hb2:p:' + code, token);
    if (location.pathname !== '/join/' + code) history.replaceState(null, '', '/join/' + code);
    connectedOnce = true;
    R = r.room;
    await setMe(r.me);
    render();
  });

  // ── Card ──
  const on = (i) => ME.card[i].f || !!ME.marks[i];
  function lines() {
    if (!ME || !ME.card) return [];
    const z = Math.round(Math.sqrt(ME.card.length));
    const Rg = [...Array(z).keys()];
    const L = [];
    Rg.forEach((i) => { L.push(Rg.map((j) => i * z + j)); L.push(Rg.map((j) => j * z + i)); });
    L.push(Rg.map((i) => i * z + i));
    L.push(Rg.map((i) => i * z + z - 1 - i));
    return L.filter((l) => l.every(on));
  }
  function render(prevStatus) {
    if (!ME || !R) return;
    if (R.status === 'lobby' || !ME.card) {
      $('#waitH').textContent = `You’re in, ${ME.name}!`;
      $('#waitP').textContent = R.status === 'lobby' ? 'Waiting for the host to start the game…' : 'Dealing your card…';
      $('#waitCount').textContent = `${R.playerCount} player${R.playerCount === 1 ? '' : 's'} here`;
      $('#waitMode').textContent = R.winMode === 'blackout' ? 'To win: fill EVERY square (blackout).' : 'To win: complete one row, column or diagonal.';
      return show('wait');
    }
    show('play');
    const ended = R.status === 'ended';
    const z = Math.round(Math.sqrt(ME.card.length));
    const g = $('#grid');
    const done = lines();
    const win = new Set(done.flat());
    g.style.gridTemplateColumns = `repeat(${z},1fr)`;
    g.className = 's' + z;
    g.innerHTML = ME.card.map((c, i) => {
      const m = ME.marks[i];
      const ph = photos[i];
      return `<button class="cell${c.f ? ' free' : ''}${m && m.n ? ' got' : ''}${ph ? ' has' : ''}${win.has(i) ? ' win' : ''}${pending[i] ? ' pend' : ''}" data-i="${i}"${c.f ? ' disabled' : ''}>${ph ? `<img class="ph" src="${ph}" alt="">` : ''}<span class="q">${esc(c.t)}</span>${m && m.n ? `<span class="nm">${esc(m.n)}</span>` : ''}</button>`;
    }).join('');
    const f = ME.card.filter((c, i) => on(i)).length;
    const t = ME.card.length;
    const b = $('#status');
    const blackoutMode = R.winMode === 'blackout';
    if (blackoutMode) b.textContent = f === t ? 'Blackout! Every square is filled.' : `${f} of ${t} squares filled. Fill every square to win.`;
    else b.textContent = done.length ? `Bingo! ${done.length} line${done.length > 1 ? 's' : ''} complete.` : `${f} of ${t} squares filled. Complete a row, column or diagonal.`;
    b.classList.toggle('bingo', blackoutMode ? f === t : done.length > 0);
    if (done.length > prevLines || (blackoutMode && f === t && !b.dataset.full)) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
    b.dataset.full = f === t ? '1' : '';
    prevLines = done.length;
    $('#clear').hidden = ended;
    if (ended) {
      const top = R.winners.slice(0, 5).map((w, i) => `#${i + 1} ${w.name}`).join(' · ');
      showBanner(`Game over${top ? ' — Winners: ' + top : ''}`, true);
    } else if (prevStatus === 'ended') $('#banner').hidden = true;
  }
  function showBanner(text, ended) {
    const el = $('#banner');
    el.textContent = text;
    el.className = 'banner' + (ended ? ' ended' : ' pop');
    el.hidden = false;
  }

  // ── Square dialog ──
  function setPv(d) { pp = d; $('#pv').hidden = !d; if (d) $('#pv').src = d; $('#pr').hidden = !d; $('#ps').hidden = !d; }
  // Tapping an EMPTY square goes straight to the photo picker (camera or gallery); the name step follows.
  // Tapping a filled square opens it for checking or editing.
  $('#grid').addEventListener('click', (e) => {
    const c = e.target.closest('.cell');
    if (!c || c.disabled) return;
    const i = +c.dataset.i;
    if (R.status === 'live' && !ME.marks[i] && !photos[i]) {
      cur = i;
      photoFirst = true;
      $('#f2').click(); // must run inside the tap, or phones block the picker
    } else openDialog(i);
  });
  function openDialog(i, keepPicked) {
    cur = i;
    const ended = R.status !== 'live';
    $('#dq').textContent = ME.card[cur].t;
    $('#dn').value = (ME.marks[cur] && ME.marks[cur].n) || '';
    $('#dn').readOnly = ended;
    $('#dsub').textContent = ended ? 'The game has ended — this square is read-only.'
      : keepPicked ? 'Nice shot! Now type their name.' : 'Who fits this square? Add a photo and their name.';
    ['#pt', '#pc', '#dx', '#ds'].forEach((s) => ($(s).hidden = ended));
    origPhoto = photos[cur] || '';
    if (!keepPicked) setPv(photos[cur] || '');
    $('#pt').textContent = pp ? 'Retake' : 'Take photo';
    $('#pc').textContent = pp ? 'Choose another' : 'Choose photo';
    $('#pr').hidden = ended || !pp;
    $('#dn').placeholder = 'Their name';
    if (!$('#dlg').open) $('#dlg').showModal();
    if (!ended) $('#dn').focus();
  }
  async function put(v, p) {
    const cell = cur;
    const name = v.trim().slice(0, 24);
    $('#dlg').close();
    const changed = !!p && p !== origPhoto;
    if (p) { photos[cell] = p; if (changed) idb.set(`${ME.id}:${cell}`, p); } else { delete photos[cell]; idb.del(`${ME.id}:${cell}`); }
    ME.marks[cell] = name || p ? { n: name, p: !!p, u: (ME.marks[cell] && ME.marks[cell].u) || 0 } : undefined;
    pending[cell] = { n: name, p: !!p };
    if (changed) pendingUpload[cell] = true;
    else delete pendingUpload[cell];
    render();
    await send(cell); // name first, so the host's photo wall can caption the photo
    if (changed) upload(cell);
  }
  // Upload a smaller copy so the host can see it during the game (deleted from the server when the game ends).
  async function upload(cell) {
    if (!pendingUpload[cell]) return true;
    const src = photos[cell];
    if (!src) { delete pendingUpload[cell]; return true; }
    try {
      const blob = await shrink(src, 960, 0.78);
      const r = await fetch('/api/photo', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-player-token': token, 'x-cell': String(cell) }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status >= 400 && r.status < 500) { delete pendingUpload[cell]; toast(j.error || 'Photo not shared with the host', true); }
        return false;
      }
      delete pendingUpload[cell];
      if (ME.marks[cell]) ME.marks[cell].u = j.v;
      return true;
    } catch (e) {
      return false; // offline: retried when the connection comes back
    }
  }
  function shrink(src, max, q) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, max / Math.max(im.width, im.height));
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * k);
        c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', q);
      };
      im.onerror = rej;
      im.src = src;
    });
  }
  async function send(cell) {
    const m = pending[cell];
    if (!m) return;
    const r = await emit('player:mark', { cell, name: m.n, photo: m.p });
    if (r.ok) {
      if (pending[cell] === m) delete pending[cell];
      render();
    } else if (r.error !== 'offline') {
      delete pending[cell];
      toast(r.error, true);
    }
  }
  async function flushPending() {
    for (const c of Object.keys(pendingUpload)) await upload(+c);
    Object.keys(pending).forEach((c) => send(+c));
  }
  function pick(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) { if (photoFirst) { photoFirst = false; openDialog(cur); } return; }
    const url = URL.createObjectURL(f);
    const i = new Image();
    i.onload = () => {
      const k = Math.min(1, 1080 / Math.max(i.width, i.height));
      const c = document.createElement('canvas');
      c.width = Math.round(i.width * k);
      c.height = Math.round(i.height * k);
      c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      setPv(c.toDataURL('image/jpeg', 0.85));
      if (photoFirst || !$('#dlg').open) { photoFirst = false; openDialog(cur, true); } // step 2: the name
      else { $('#pt').textContent = 'Retake'; $('#pc').textContent = 'Choose another'; }
    };
    i.onerror = () => { URL.revokeObjectURL(url); toast('That photo could not be opened', true); if (photoFirst) { photoFirst = false; openDialog(cur); } };
    i.src = url;
  }
  $('#ds').onclick = () => put($('#dn').value, pp);
  $('#dx').onclick = () => put('', '');
  $('#dc').onclick = () => $('#dlg').close();
  $('#f1').onchange = pick;
  $('#f2').onchange = pick;
  // Picker closed without a photo: still let them type a name for that square.
  ['#f1', '#f2'].forEach((s) => $(s).addEventListener('cancel', () => { if (photoFirst) { photoFirst = false; openDialog(cur); } }));
  $('#pt').onclick = () => $('#f1').click();
  $('#pc').onclick = () => $('#f2').click();
  $('#pr').onclick = () => setPv('');
  $('#dn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#dn').readOnly) put($('#dn').value, pp); });

  // ── Bar actions ──
  function guard(id, label, fn) {
    const b = $(id);
    let t = 0;
    b.onclick = () => {
      if (!t) { b.textContent = 'Tap again to confirm'; t = setTimeout(() => { t = 0; b.textContent = label; }, 3000); return; }
      clearTimeout(t); t = 0; b.textContent = label; fn();
    };
  }
  guard('#clear', 'Clear all', async () => {
    const r = await emit('player:clearAll');
    if (!r.ok) return toast(r.error === 'offline' ? 'You’re offline — try again in a moment' : r.error, true);
    ME.card.forEach((c, i) => idb.del(`${ME.id}:${i}`));
    ME.marks = {};
    photos = {};
    render();
  });
  const leave = () => { forget(); location.href = '/'; };
  guard('#leave', 'Leave room', leave);
  guard('#leave1', 'Leave room', leave);

  // ── Save card & photos ──
  // Phones (Android especially) block multi-file downloads, so we show finished pictures that can be
  // pressed-and-held to save, plus Share / Download buttons that run straight from the tap.
  const fname = (i) => 'bingo-' + (i + 1) + '-' + ((ME.marks[i] && ME.marks[i].n) || ME.card[i].t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '.jpg';
  const FS = "'Bricolage Grotesque',system-ui,sans-serif";
  const FH = "'Caveat',cursive,system-ui";
  const loadImg = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  function wrap(x, text, maxW) {
    const L = [];
    let l = '';
    for (const a of String(text).split(' ')) { const u = l ? l + ' ' + a : a; if (x.measureText(u).width > maxW && l) { L.push(l); l = a; } else l = u; }
    L.push(l);
    return L;
  }
  function cover(x, im, X, Y, W, H) {
    const k = Math.max(W / im.width, H / im.height), w = im.width * k, h = im.height * k;
    x.save(); x.beginPath(); x.rect(X, Y, W, H); x.clip();
    x.drawImage(im, X + (W - w) / 2, Y + (H - h) / 2, w, h);
    x.restore();
  }
  function rr(x, X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }
  // One picture of the whole card with photos and names — easy to save or screenshot.
  async function cardPicture() {
    const z = Math.round(Math.sqrt(ME.card.length));
    const W = 1080, pad = 40, gap = 12, head = 190, foot = 110;
    const cs = (W - 2 * pad - gap * (z - 1)) / z;
    const H = head + z * cs + (z - 1) * gap + foot;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.fillStyle = '#2f4bff'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff'; rr(x, pad, 30, W - 2 * pad, 130, 22); x.fill();
    x.fillStyle = '#d62839'; rr(x, pad, 30, W - 2 * pad, 40, 22); x.fill(); x.fillRect(pad, 50, W - 2 * pad, 20);
    x.fillStyle = '#fff'; x.font = '800 24px ' + FS; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('Hello, we’re playing', W / 2, 52);
    x.fillStyle = '#14163a'; x.font = '700 64px ' + FH; x.fillText(R.title, W / 2, 118, W - 2 * pad - 40);
    const ims = await Promise.all(ME.card.map((c, i) => (photos[i] ? loadImg(photos[i]) : null)));
    const win = new Set(lines().flat());
    const fs = z === 3 ? 34 : z === 4 ? 26 : 21;
    ME.card.forEach((c, i) => {
      const X = pad + (i % z) * (cs + gap), Y = head + Math.floor(i / z) * (cs + gap);
      const m = ME.marks[i];
      x.save(); rr(x, X, Y, cs, cs, 14); x.clip();
      x.fillStyle = c.f ? '#ffd93d' : '#fff'; x.fillRect(X, Y, cs, cs);
      if (ims[i]) cover(x, ims[i], X, Y, cs, cs);
      x.textAlign = c.f ? 'center' : 'left'; x.textBaseline = 'top';
      x.font = (c.f ? '800 ' : '600 ') + fs + 'px ' + FS;
      const L = wrap(x, c.t, cs - 20).slice(0, ims[i] ? 2 : 5);
      if (ims[i]) { x.fillStyle = 'rgba(20,22,58,.78)'; x.fillRect(X, Y, cs, L.length * fs * 1.2 + 16); }
      x.fillStyle = ims[i] ? '#fff' : m && m.n ? 'rgba(20,22,58,.6)' : '#14163a';
      L.forEach((t, j) => x.fillText(t, c.f ? X + cs / 2 : X + 10, (c.f ? Y + cs / 2 - fs / 2 : Y + 8) + j * fs * 1.2));
      if (m && m.n) {
        const nh = fs * 1.5;
        x.fillStyle = '#ffd93d'; x.fillRect(X + 6, Y + cs - nh - 6, cs - 12, nh);
        x.fillStyle = '#14163a'; x.font = '700 ' + Math.round(fs * 1.3) + 'px ' + FH; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(m.n, X + cs / 2, Y + cs - nh / 2 - 6, cs - 20);
      }
      x.restore();
      x.lineWidth = win.has(i) ? 7 : 3; x.strokeStyle = win.has(i) ? '#d62839' : '#c9cffc'; rr(x, X, Y, cs, cs, 14); x.stroke();
    });
    const f = ME.card.filter((c, i) => on(i)).length;
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '700 30px ' + FS; x.fillText(`${ME.name} · ${f} of ${ME.card.length} squares · ${lines().length} line${lines().length === 1 ? '' : 's'}`, W / 2, H - foot / 2 - 10, W - 2 * pad);
    x.font = '600 22px ' + FS; x.fillStyle = 'rgba(255,255,255,.8)'; x.fillText(new Date().toLocaleDateString(), W / 2, H - foot / 2 + 26);
    return cv.toDataURL('image/jpeg', 0.9);
  }
  // A captioned picture for one photo (prompt on top, name tag at the bottom).
  async function tilePicture(i, nameOverride, srcOverride) {
    const im = await loadImg(srcOverride || photos[i]);
    if (!im) return null;
    const Z = 1080, cv = document.createElement('canvas');
    cv.width = cv.height = Z;
    const x = cv.getContext('2d');
    cover(x, im, 0, 0, Z, Z);
    const fs = 78, lh = fs * 1.2, pad = 36;
    x.font = '700 ' + fs + 'px ' + FS; x.textBaseline = 'top';
    const L = wrap(x, ME.card[i].t, Z - 2 * pad);
    x.fillStyle = 'rgba(20,22,58,.78)'; x.fillRect(0, 0, Z, pad * 2 + L.length * lh);
    x.fillStyle = '#fff'; L.forEach((t, j) => x.fillText(t, pad, pad + j * lh));
    const nm = nameOverride != null ? nameOverride : ME.marks[i] && ME.marks[i].n;
    if (nm) {
      x.font = '700 ' + fs + 'px ' + FH;
      let t = nm;
      while (x.measureText(t).width > Z - 4 * pad && t.length > 1) t = t.slice(0, -1);
      const w2 = x.measureText(t).width + 48, h2 = fs * 1.25;
      x.save(); x.translate(Z / 2, Z - pad - h2 / 2); x.rotate(-0.03);
      x.fillStyle = '#ffd93d'; x.fillRect(-w2 / 2, -h2 / 2, w2, h2);
      x.fillStyle = '#14163a'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(t, 0, 4);
      x.restore();
    }
    return cv.toDataURL('image/jpeg', 0.9);
  }
  let saveItems = []; // [{url, name}]
  async function toFile(it) { const b = await (await fetch(it.url)).blob(); return new File([b], it.name, { type: 'image/jpeg' }); }
  async function openSave(items) {
    const list = $('#saveList');
    list.innerHTML = '<p class="muted">Making your pictures…</p>';
    $('#shareAll').hidden = true;
    $('#saveDlg').showModal();
    try { await document.fonts.ready; } catch (e) {}
    saveItems = (await Promise.all(items.map(async (it) => ({ name: it.name, caption: it.caption, url: await it.make() })))).filter((it) => it.url);
    list.innerHTML = '';
    saveItems.forEach((it) => {
      const f = document.createElement('figure');
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = it.caption;
      const cap = document.createElement('figcaption');
      cap.textContent = it.caption;
      f.append(img, cap);
      list.appendChild(f);
    });
    if (navigator.canShare) {
      try { $('#shareAll').hidden = !navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' })] }); } catch (e) {}
    }
    $('#shareAll').textContent = saveItems.length > 1 ? 'Share all' : 'Share';
    $('#dlAll').textContent = saveItems.length > 1 ? 'Download all' : 'Download';
  }
  $('#shareAll').onclick = async () => {
    try {
      const files = await Promise.all(saveItems.map(toFile));
      await navigator.share({ files });
    } catch (e) {
      if (e.name !== 'AbortError') toast('Sharing didn’t work here — press and hold a picture to save it instead', true);
    }
  };
  $('#dlAll').onclick = () => {
    saveItems.forEach((it, i) => setTimeout(() => { const a = document.createElement('a'); a.href = it.url; a.download = it.name; document.body.appendChild(a); a.click(); a.remove(); }, i * 400));
  };
  $('#saveClose').onclick = () => $('#saveDlg').close();
  $('#save').onclick = () => {
    const items = [{ name: `bingo-card-${(R.title || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}.jpg`, caption: 'Your whole card', make: cardPicture }];
    ME.card.forEach((c, i) => { if (photos[i]) items.push({ name: fname(i), caption: `#${i + 1} · ${c.t}`, make: () => tilePicture(i) }); });
    openSave(items);
  };
  $('#ps').onclick = () => {
    if (!pp) return;
    const i = cur;
    const nm = $('#dn').value.trim();
    const src = pp;
    $('#dlg').close();
    openSave([{ name: fname(i), caption: ME.card[i].t, make: () => tilePicture(i, nm, src) }]);
  };

  if (!token) showJoin();
})();
