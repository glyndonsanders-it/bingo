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
    await Promise.all(ME.card.map(async (c, i) => { const v = await idb.get(`${ME.id}:${i}`); if (v) photos[i] = v; }));
  }

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
    if (fx.type === 'end') toast('The host ended the game');
    if (fx.type === 'resume') toast('The game is back on!');
    if (fx.type === 'bingo' || fx.type === 'blackout') {
      const word = fx.type === 'bingo' ? 'BINGO' : 'BLACKOUT';
      if (fx.playerId === ME.id) showBanner(`${word}! You’re #${fx.order} 🎉`);
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
    b.textContent = f === t ? 'Blackout! Every square is filled.' : done.length ? `Bingo! ${done.length} line${done.length > 1 ? 's' : ''} complete.` : `${f} of ${t} squares filled. Complete a row, column or diagonal.`;
    b.classList.toggle('bingo', done.length > 0);
    if (done.length > prevLines) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
    prevLines = done.length;
    $('#clear').hidden = ended;
    if (ended) {
      const top = R.winners.filter((w) => w.kind === 'bingo').slice(0, 5).map((w, i) => `#${i + 1} ${w.name}`).join(' · ');
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
  $('#grid').addEventListener('click', (e) => {
    const c = e.target.closest('.cell');
    if (!c || c.disabled) return;
    cur = +c.dataset.i;
    const ended = R.status !== 'live';
    $('#dq').textContent = ME.card[cur].t;
    $('#dn').value = (ME.marks[cur] && ME.marks[cur].n) || '';
    $('#dn').readOnly = ended;
    $('#dsub').textContent = ended ? 'The game has ended — this square is read-only.' : 'Who fits this square? Add their name, a photo, or both.';
    ['#pt', '#pc', '#dx', '#ds'].forEach((s) => ($(s).hidden = ended));
    setPv(photos[cur] || '');
    $('#pr').hidden = ended || !pp;
    $('#dlg').showModal();
    if (!ended) $('#dn').focus();
  });
  async function put(v, p) {
    const cell = cur;
    const name = v.trim().slice(0, 24);
    $('#dlg').close();
    if (p) { photos[cell] = p; idb.set(`${ME.id}:${cell}`, p); } else { delete photos[cell]; idb.del(`${ME.id}:${cell}`); }
    ME.marks[cell] = name || p ? { n: name, p: !!p } : undefined;
    pending[cell] = { n: name, p: !!p };
    render();
    send(cell);
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
  function flushPending() { Object.keys(pending).forEach((c) => send(+c)); }
  function pick(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
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
    };
    i.onerror = () => { URL.revokeObjectURL(url); toast('That photo could not be opened', true); };
    i.src = url;
  }
  $('#ds').onclick = () => put($('#dn').value, pp);
  $('#dx').onclick = () => put('', '');
  $('#dc').onclick = () => $('#dlg').close();
  $('#f1').onchange = pick;
  $('#f2').onchange = pick;
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

  // Save photos as captioned tiles (share sheet on phones, downloads elsewhere)
  const fname = (i) => 'bingo-' + (i + 1) + '-' + ((ME.marks[i] && ME.marks[i].n) || ME.card[i].t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '.jpg';
  function tilePic(d, cat, nm, name) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const Z = 1080, cv = document.createElement('canvas');
        cv.width = cv.height = Z;
        const x = cv.getContext('2d'), k = Math.max(Z / im.width, Z / im.height), w = im.width * k, h = im.height * k;
        x.drawImage(im, (Z - w) / 2, (Z - h) / 2, w, h);
        const fs = 78, lh = fs * 1.2, pad = 36, FS = "'Bricolage Grotesque',system-ui,sans-serif", FH = "'Caveat',cursive,system-ui";
        x.font = '700 ' + fs + 'px ' + FS;
        x.textBaseline = 'top';
        const L = [];
        let l = '';
        for (const a of cat.split(' ')) { const u = l ? l + ' ' + a : a; if (x.measureText(u).width > Z - 2 * pad && l) { L.push(l); l = a; } else l = u; }
        L.push(l);
        x.fillStyle = 'rgba(20,22,58,.78)';
        x.fillRect(0, 0, Z, pad * 2 + L.length * lh);
        x.fillStyle = '#fff';
        L.forEach((t, j) => x.fillText(t, pad, pad + j * lh));
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
        cv.toBlob((b) => res(new File([b], name, { type: 'image/jpeg' })), 'image/jpeg', 0.92);
      };
      im.src = d;
    });
  }
  async function savePics(files) {
    if (navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    files.forEach((f, i) => setTimeout(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }, i * 350));
  }
  $('#save').onclick = async () => {
    const ix = ME.card.map((c, i) => (photos[i] ? i : -1)).filter((i) => i >= 0);
    if (!ix.length) { $('#status').textContent = 'No photos to save yet. Tap a square to add one.'; return; }
    try { await document.fonts.ready; } catch (e) {}
    savePics(await Promise.all(ix.map((i) => tilePic(photos[i], ME.card[i].t, ME.marks[i] && ME.marks[i].n, fname(i)))));
  };
  $('#ps').onclick = async () => {
    if (!pp) return;
    try { await document.fonts.ready; } catch (e) {}
    savePics([await tilePic(pp, ME.card[cur].t, $('#dn').value.trim(), fname(cur))]);
  };

  if (!token) showJoin();
})();
