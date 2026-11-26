/* Host: build a game, create a room with a short code, run it live. */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const ROOMS_KEY = 'hb2:rooms';
  const DRAFT_KEY = 'hb2:draft';
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  let cats = Cats.load();
  let code = normCode(location.pathname.split('/')[2]);
  let key = new URLSearchParams(location.hash.slice(1)).get('k');
  if (code && !key) key = (store.get(ROOMS_KEY, []).find((r) => r.code === code) || {}).key;
  let S = null; // host state from the server
  let dirty = false; // unsaved lobby edits
  let filter = 'all';
  let socket = null;

  // ── Toasts ──
  function toast(msg, bad) {
    let box = $('.toast-box');
    if (!box) { box = document.createElement('div'); box.className = 'toast-box'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ── Settings form (shared by builder and lobby editor) ──
  function list() {
    const seen = new Set();
    return $('#prompts').value.split('\n').map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
  }
  function readForm() {
    const size = +$('#size').value;
    return { title: $('#title').value.trim() || 'Find Someone Who…', size, free: $('#free').checked && size % 2 === 1, winMode: $('#winMode').value, theme: Theme.current(), verify: $('#verify').checked, stopAfter: +$('#stopAfter').value || 0, prompts: list() };
  }
  function fillForm(s) {
    $('#title').value = s.title;
    $('#size').value = s.size;
    $('#free').checked = !!s.free;
    $('#winMode').value = s.winMode === 'blackout' ? 'blackout' : 'line';
    $('#verify').checked = s.verify !== false;
    Theme.apply(s.theme);
    paintThemes();
    if (document.activeElement !== $('#stopAfter')) $('#stopAfter').value = s.stopAfter || 0;
    $('#prompts').value = (s.prompts || []).join('\n');
    refresh();
  }
  function need(s) { return s.size * s.size - (s.free ? 1 : 0); }
  function refresh() {
    $('#free').disabled = +$('#size').value % 2 === 0 || locked();
    const s = readForm();
    const k = need(s);
    const n = s.prompts.length;
    const ok = n >= k;
    $('#hint').textContent = ok
      ? `${n} squares. Each card uses ${k}${n > k ? ', so players get different cards' : ' — everyone gets the same squares, shuffled'}.`
      : `Add ${k - n} more square${k - n > 1 ? 's' : ''} to fill a ${s.size} × ${s.size} card.`;
    $('#createBtn').disabled = !ok;
    $('#printb').disabled = !ok;
    $('#saveSettings').disabled = !ok || !dirty;
    if (!S) store.set(DRAFT_KEY, s);
  }
  function locked() { return !!S && S.status !== 'lobby'; }
  function onEdit() { if (S) dirty = true; refresh(); }
  ['#title', '#prompts'].forEach((s) => $(s).addEventListener('input', onEdit));
  ['#size', '#free', '#winMode', '#verify'].forEach((s) => $(s).addEventListener('change', onEdit));

  // ── Party theme picker (not locked: the theme can change mid-game) ──
  function paintThemes() {
    const cur = Theme.current();
    $('#themes').innerHTML = Theme.list().map((t) => {
      const m = Theme.META[t];
      return `<button class="theme-opt" data-theme="${t}" aria-pressed="${t === cur}"><span class="sw sw-${t}">${m.emoji}</span><span class="tx">${esc(m.name)}<small>${esc(m.desc)}</small></span></button>`;
    }).join('');
  }
  $('#themes').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    Theme.apply(b.dataset.theme);
    paintThemes();
    if (S) {
      const r = await emit('host:setTheme', { theme: b.dataset.theme });
      if (r.ok) toast(`${Theme.META[b.dataset.theme].name} theme is on — phones and the big screen update now`);
      else toast(r.error, true);
    } else refresh(); // builder: remembered in the draft
  });
  function renderChips() {
    $('#chips').innerHTML = cats.map((c) => `<button class="btn alt" data-cat="${esc(c.id)}">${esc(c.name)} <span class="muted">· ${c.p.length}</span></button>`).join('');
  }
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b || locked()) return;
    useCat(cats.find((c) => c.id === b.dataset.cat));
  });
  function useCat(c) {
    if (!c) return;
    $('#title').value = c.title;
    $('#prompts').value = c.p.join('\n');
    onEdit();
  }
  $('#saveAsCat').addEventListener('click', () => {
    const s = readForm();
    if (!s.prompts.length) return toast('Add some squares first', true);
    const name = (prompt('Name for this category:', s.title) || '').trim();
    if (!name) return;
    cats.push({ id: Cats.newId(), name: name.slice(0, 30), title: s.title, p: s.prompts });
    Cats.save(cats);
    renderChips();
    toast(`Saved “${name}” to your categories`);
  });

  // ── Category manager ──
  let curCat = null;
  function openCats() {
    curCat = curCat && cats.find((c) => c.id === curCat) ? curCat : cats[0] && cats[0].id;
    paintCatList();
    paintCatEditor();
    $('#catDlg').showModal();
  }
  function paintCatList() {
    $('#catList').innerHTML = cats.map((c) => `<button data-id="${esc(c.id)}" aria-current="${c.id === curCat}">${esc(c.name)}<small>${c.p.length} squares</small></button>`).join('') || '<p class="muted">No categories yet.</p>';
  }
  function paintCatEditor() {
    const c = cats.find((x) => x.id === curCat);
    ['#cName', '#cTitle', '#cSquares', '#catUse', '#catDup', '#catDel'].forEach((s) => ($(s).disabled = !c));
    $('#cName').value = c ? c.name : '';
    $('#cTitle').value = c ? c.title : '';
    $('#cSquares').value = c ? c.p.join('\n') : '';
    $('#catUse').disabled = !c || locked();
    countCat();
  }
  function countCat() {
    const n = $('#cSquares').value.split('\n').filter((x) => x.trim()).length;
    $('#cCount').textContent = `${n} squares (a 5 × 5 card needs 24–25)`;
  }
  function editCat() {
    const c = cats.find((x) => x.id === curCat);
    if (!c) return;
    c.name = $('#cName').value.trim().slice(0, 30) || 'Untitled';
    c.title = $('#cTitle').value.trim().slice(0, 40) || 'Find Someone Who…';
    c.p = $('#cSquares').value.split('\n').map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 300);
    Cats.save(cats);
    paintCatList();
    countCat();
  }
  ['#cName', '#cTitle', '#cSquares'].forEach((s) => $(s).addEventListener('input', editCat));
  $('#catList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    curCat = b.dataset.id;
    paintCatList();
    paintCatEditor();
  });
  $('#catNew').addEventListener('click', () => {
    const c = { id: Cats.newId(), name: 'New category', title: 'Find Someone Who…', p: [] };
    cats.push(c);
    curCat = c.id;
    Cats.save(cats);
    paintCatList();
    paintCatEditor();
    $('#cName').select();
  });
  $('#catDup').addEventListener('click', () => {
    const c = cats.find((x) => x.id === curCat);
    if (!c) return;
    const d = { ...JSON.parse(JSON.stringify(c)), id: Cats.newId(), name: (c.name + ' copy').slice(0, 30) };
    cats.splice(cats.indexOf(c) + 1, 0, d);
    curCat = d.id;
    Cats.save(cats);
    paintCatList();
    paintCatEditor();
  });
  $('#catDel').addEventListener('click', () => {
    const c = cats.find((x) => x.id === curCat);
    if (!c || !confirm(`Delete the category “${c.name}”?`)) return;
    cats = cats.filter((x) => x !== c);
    curCat = cats[0] && cats[0].id;
    Cats.save(cats);
    paintCatList();
    paintCatEditor();
  });
  $('#catUse').addEventListener('click', () => {
    useCat(cats.find((x) => x.id === curCat));
    $('#catDlg').close();
  });
  $('#catReset').addEventListener('click', () => {
    if (!confirm('Add back the four built-in lists? Your own categories are kept; edited built-in lists are replaced.')) return;
    const bi = Cats.builtIn();
    cats = cats.filter((c) => !bi.some((b) => b.id === c.id)).concat(bi);
    curCat = bi[0].id;
    Cats.save(cats);
    paintCatList();
    paintCatEditor();
  });
  $('#catExport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(cats, null, 2)], { type: 'application/json' }));
    a.download = 'bingo-categories.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('#catImport').addEventListener('click', () => $('#catFile').click());
  $('#catFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const imp = Cats.sanitize(JSON.parse(await f.text()));
      if (!imp) throw new Error();
      imp.forEach((c) => { if (cats.some((x) => x.id === c.id)) c.id = Cats.newId(); });
      cats = cats.concat(imp);
      Cats.save(cats);
      paintCatList();
      toast(`Imported ${imp.length} categor${imp.length === 1 ? 'y' : 'ies'}`);
    } catch (err) { toast('That file is not a categories export', true); }
  });
  $('#catDone').addEventListener('click', () => $('#catDlg').close());
  $('#catDlg').addEventListener('close', renderChips);
  $('#manageCats').addEventListener('click', openCats);

  // ── Print paper cards ──
  $('#printb').addEventListener('click', () => {
    const s = readForm();
    const n = Math.max(1, Math.min(300, +$('#cnt').value || 1));
    const k = s.size * s.size;
    const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    let h = '';
    for (let i = 0; i < n; i++) {
      const c = shuf(s.prompts.slice()).slice(0, k - (s.free ? 1 : 0)).map((t) => ({ t }));
      if (s.free) c.splice((k - 1) / 2, 0, { t: 'FREE', f: 1 });
      h += `<div class="pc"><h2>${esc(s.title)}</h2><div class="pg" style="grid-template-columns:repeat(${s.size},1fr)">${c.map((x) => `<div class="pcell${x.f ? ' fr' : ''}">${esc(x.t)}</div>`).join('')}</div></div>`;
    }
    $('#sheet').innerHTML = h;
    document.body.classList.add('pr');
    try { window.print(); } catch (e) {}
    document.body.classList.remove('pr');
  });

  // ── Create room ──
  const cc = $('#customCode');
  cc.addEventListener('input', () => { cc.value = normCode(cc.value); });
  $('#createBtn').addEventListener('click', async () => {
    const b = $('#createBtn');
    b.disabled = true;
    $('#createErr').textContent = '';
    try {
      const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...readForm(), code: cc.value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not create the room');
      code = j.code;
      key = j.hostKey;
      const rooms = store.get(ROOMS_KEY, []).filter((x) => x.code !== code);
      rooms.unshift({ code, key, title: readForm().title, at: Date.now() });
      store.set(ROOMS_KEY, rooms.slice(0, 20));
      history.replaceState(null, '', `/host/${code}#k=${key}`);
      connect();
    } catch (e) {
      $('#createErr').textContent = e.message;
      b.disabled = false;
    }
  });

  // ── Live room ──
  function connect() {
    socket = io();
    socket.on('connect', auth);
    socket.on('state', apply);
    socket.on('fx', (fx) => {
      if (fx.type === 'photo') {
        wall = [fx].concat(wall.filter((w) => !(w.playerId === fx.playerId && w.cell === fx.cell))).slice(0, 40);
        renderWall();
      }
      if (fx.type === 'claim' && fx.pending) toast(`🔔 ${fx.name} finished — open their card to check it`);
      if (fx.type === 'winner') toast(`🎉 Winner #${fx.place} — ${fx.name}`);
      if (fx.type === 'end' && fx.reason === 'auto') toast(`🏁 Game ended automatically — ${fx.winners} winners confirmed`);
    });
    socket.on('disconnect', () => toast('Connection lost — reconnecting…', true));
  }
  function auth() {
    socket.timeout(10000).emit('host:auth', { code, key }, (err, r) => {
      if (err || !r || !r.ok) {
        $('#fatal').hidden = false;
        $('#fatal').textContent = (r && r.error) || 'Could not reach the server.';
        return;
      }
      $('#fatal').hidden = true;
      enterRoomMode();
      apply(r.state);
      loadWall();
    });
  }
  function emit(ev, data) {
    return new Promise((res) => socket.timeout(10000).emit(ev, data, (err, r) => res(err ? { ok: false, error: 'Connection problem — try again' } : r)));
  }
  function enterRoomMode() {
    if (!$('#roomv').hidden) return;
    $('#roomv').hidden = false;
    $('#createPanel').hidden = true;
    $('#setSlot').appendChild($('#setPanel'));
    $('#setH').textContent = 'Game settings';
    $('#setP').textContent = 'You can change the squares until you start the game.';
    $('#saveSettings').hidden = false;
    const url = `${location.origin}/join/${code}`;
    $('#bigCode').textContent = code;
    $('#joinUrl').textContent = url.replace(/^https?:\/\//, '');
    $('#qr').src = `/qr/${code}.svg`;
    document.title = `Room ${code} – Human Bingo host`;
  }
  function apply(s) {
    const prevStatus = S && S.status;
    S = s;
    if (!dirty) fillForm({ title: s.title, size: s.size, free: s.free, winMode: s.winMode, theme: s.theme, verify: s.verify, stopAfter: s.stopAfter, prompts: s.prompts });
    if (Theme.current() !== s.theme) { Theme.apply(s.theme); paintThemes(); } // the theme isn't part of unsaved edits
    else if (document.activeElement !== $('#stopAfter')) $('#stopAfter').value = s.stopAfter || 0;
    const lock = locked();
    ['#title', '#prompts', '#size', '#winMode', '#verify'].forEach((x) => { $(x).disabled = lock; });
    $('#title').readOnly = lock;
    $('#lockedNote').hidden = !lock;
    $('#setP').textContent = lock ? 'These are the squares players are using.' : 'You can change the squares until you start the game.';
    $('#chips').querySelectorAll('button').forEach((b) => (b.disabled = lock));
    $('#saveSettings').hidden = lock;
    refresh();
    const label = { lobby: 'Lobby — not started', live: 'Live', ended: 'Ended' }[s.status];
    const pill = $('#statusPill');
    pill.textContent = label;
    pill.className = 'pill ' + (s.status === 'live' ? 'live' : s.status === 'ended' ? 'ended' : '');
    $('#startBtn').hidden = s.status !== 'lobby';
    $('#endBtn').hidden = s.status !== 'live';
    $('#resumeBtn').hidden = s.status !== 'ended';
    $('#gameHint').textContent = s.status === 'lobby'
      ? 'Players who join now wait on a “get ready” screen. Their cards appear the moment you start.'
      : s.status === 'live' ? 'Late arrivals can still join and get a card right away.' : 'The game is over. Players can still see their cards and the winners.';
    $('#wallProj').checked = !!s.showPhotos;
    $('#sPlayers').textContent = s.playerCount;
    $('#sOnline').textContent = s.onlineCount;
    const bo = s.winMode === 'blackout';
    const waiting = s.winners.filter((w) => w.status === 'pending').length;
    $('#sBingo').textContent = s.confirmed;
    $('#sBingoL').textContent = waiting ? `winners · ${waiting} to check` : 'winners confirmed';
    $('#winsH').textContent = bo ? 'Blackout calls' : 'Bingo calls';
    $('#checkNote').hidden = !waiting;
    $('#checkNote').textContent = `⏳ ${waiting} card${waiting === 1 ? '' : 's'} waiting for your check — tap “Check card”.`;
    $('#stopHint').textContent = s.stopAfter
      ? `The game ends by itself once the first ${s.stopAfter} finishers are confirmed (${s.confirmed}/${s.stopAfter} so far).`
      : 'Off — you end the game yourself.';
    if (s.status === 'ended') { wall = []; renderWall(); }
    renderWins();
    renderPlayers();
    if (prevStatus && prevStatus !== s.status && s.status === 'live' && prevStatus === 'lobby') toast(`Game started — ${s.playerCount} cards dealt`);
  }
  function renderWins() {
    const t = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#wins').innerHTML = S.winners.map((w) => (w.status === 'pending'
      ? `<li class="pend" data-pid="${esc(w.playerId)}" style="cursor:pointer"><span class="o">⏳</span><span>${esc(w.name)}</span><span class="k">needs your check · ${t(w.at)}</span><button class="btn chk">Check card</button></li>`
      : `<li data-pid="${esc(w.playerId)}" style="cursor:pointer"><span class="o">#${w.place}</span><span>${esc(w.name)}</span><span class="k">✓ ${w.kind === 'blackout' ? 'Blackout' : 'Bingo'} · ${t(w.at)}</span></li>`)).join('')
      || `<li class="muted" style="font-weight:600">No ${S.winMode === 'blackout' ? 'blackouts' : 'bingos'} yet.</li>`;
  }
  function renderPlayers() {
    const qs = $('#search').value.trim().toLowerCase();
    let ps = S.players.slice();
    if (filter === 'online') ps = ps.filter((p) => p.online);
    if (filter === 'bingo') ps = ps.filter((p) => p.rank || p.pending);
    if (qs) ps = ps.filter((p) => p.name.toLowerCase().includes(qs));
    ps.sort((a, b) => (a.rank || (a.pending ? 5e8 : 1e9)) - (b.rank || (b.pending ? 5e8 : 1e9)) || b.filled - a.filled || b.lines - a.lines || a.joinNo - b.joinNo);
    $('#plist').innerHTML = ps.map((p) => `<button class="prow" data-pid="${esc(p.id)}"><span class="dot ${p.online ? 'on' : ''}" title="${p.online ? 'Online' : 'Offline'}"></span>
      <span style="min-width:0"><span class="nm2">${esc(p.name)}</span>${p.total ? `<span class="meter"><i style="width:${Math.round((p.filled / p.total) * 100)}%"></i></span>` : ''}</span>
      <span class="badges">${p.total ? `${p.filled}/${p.total}` : 'waiting'}${p.rank ? ` <span class="badge">Winner #${p.rank}</span>` : p.pending ? ' <span class="badge wait">⏳ Check</span>' : ''}</span></button>`).join('')
      || `<p class="muted">${S.players.length ? 'No players match.' : 'Nobody has joined yet. Share the room code!'}</p>`;
  }
  $('#search').addEventListener('input', () => S && renderPlayers());
  document.querySelectorAll('.seg [data-f]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    document.querySelectorAll('.seg [data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderPlayers();
  }));
  $('#plist').addEventListener('click', (e) => { const b = e.target.closest('[data-pid]'); if (b) openCard(b.dataset.pid); });
  $('#wins').addEventListener('click', (e) => { const b = e.target.closest('[data-pid]'); if (b) openCard(b.dataset.pid); });

  $('#saveSettings').addEventListener('click', async () => {
    const r = await emit('host:update', readForm());
    $('#setErr').textContent = r.ok ? '' : r.error;
    if (r.ok) { dirty = false; toast('Changes saved'); refresh(); }
  });
  $('#startBtn').addEventListener('click', async () => {
    if (dirty && !confirm('You have unsaved changes to the squares. Start without them?')) return;
    dirty = false;
    const r = await emit('host:start');
    if (!r.ok) toast(r.error, true);
  });
  $('#endBtn').addEventListener('click', async () => {
    if (!confirm('End the game for everyone? Cards freeze and the winners list stays up.')) return;
    const r = await emit('host:end');
    if (!r.ok) toast(r.error, true);
  });
  // Auto-stop: can be changed at any time, even mid-game.
  async function setStop(n) {
    const r = await emit('host:setStopAfter', { n });
    if (!r.ok) toast(r.error, true);
  }
  $('#stopAfter').addEventListener('change', () => setStop(+$('#stopAfter').value || 0));
  document.querySelectorAll('[data-stop]').forEach((b) => b.addEventListener('click', () => { $('#stopAfter').value = b.dataset.stop; setStop(+b.dataset.stop); }));
  $('#resumeBtn').addEventListener('click', async () => {
    const r = await emit('host:resume');
    if (!r.ok) toast(r.error, true);
  });
  const copy = (txt, msg) => (navigator.clipboard ? navigator.clipboard.writeText(txt).then(() => toast(msg), () => prompt('Copy this:', txt)) : prompt('Copy this:', txt));
  $('#copyLink').addEventListener('click', () => copy(`${location.origin}/join/${code}`, 'Join link copied'));
  $('#copyHost').addEventListener('click', () => copy(`${location.origin}/host/${code}#k=${key}`, 'Host link copied — keep it private'));
  // The big screen is its own page with a view-only key, so the projector never shows host controls.
  const screenUrl = () => `${location.origin}/screen/${code}#d=${S && S.displayKey}`;
  $('#projBtn').addEventListener('click', () => { if (S && S.displayKey) window.open(screenUrl(), `bingo-screen-${code}`); });
  $('#copyScreen').addEventListener('click', () => S && S.displayKey && copy(screenUrl(), 'Big-screen link copied — open it on the projector computer'));

  // ── Player card viewer ──
  let cardPid = null;
  async function openCard(pid) {
    const r = await emit('host:card', { playerId: pid });
    if (!r.ok) return toast(r.error, true);
    cardPid = pid;
    const p = S.players.find((x) => x.id === pid);
    $('#cardH').textContent = p ? p.name : r.name;
    $('#cardSub').textContent = r.card
      ? `${r.progress.filled} of ${r.progress.total} squares · ${r.progress.lines} line${r.progress.lines === 1 ? '' : 's'} complete. Tap a photo to enlarge it.`
      : 'Waiting for the game to start — no card yet.';
    const g = $('#cardGrid');
    if (r.card) {
      const z = Math.round(Math.sqrt(r.card.length));
      g.style.gridTemplateColumns = `repeat(${z},1fr)`;
      g.className = 's' + z;
      g.innerHTML = r.card.map((c, i) => {
        const m = r.marks[i];
        const url = m && m.p ? photoUrl(pid, i, m.u) : '';
        return `<div class="cell${c.f ? ' free' : ''}${m && m.n ? ' got' : ''}${url ? ' has ph-cell' : ''}"${url ? ` data-zoom="${esc(url)}" data-cap="${esc(c.t + (m.n ? ' — with ' + m.n : ''))}"` : ''}>${url ? `<img class="ph" src="${esc(url)}" alt="" loading="lazy">` : ''}<span class="q">${esc(c.f ? Theme.free() : c.t)}</span>${m && m.n ? `<span class="nm">${esc(m.n)}</span>` : ''}</div>`;
      }).join('');
    } else g.innerHTML = '';
    $('#kickBtn').hidden = false;
    $('#verifyBar').hidden = !(p && p.pending);
    $('#cardDlg').showModal();
  }
  async function verify(ok) {
    const p = S.players.find((x) => x.id === cardPid);
    if (!ok && !confirm(`Mark ${p ? p.name : 'this'}’s card as not valid? They’ll be told to fix it and can finish again.`)) return;
    const r = await emit('host:verify', { playerId: cardPid, ok });
    if (!r.ok) return toast(r.error, true);
    $('#cardDlg').close();
    if (!ok) toast(`${p ? p.name : 'Player'} was asked to fix their card`);
  }
  $('#verifyYes').addEventListener('click', () => verify(true));
  $('#verifyNo').addEventListener('click', () => verify(false));
  $('#cardClose').addEventListener('click', () => $('#cardDlg').close());
  $('#cardGrid').addEventListener('click', (e) => { const c = e.target.closest('[data-zoom]'); if (c) lightbox(c.dataset.zoom, c.dataset.cap); });

  // ── Photos (temporary: deleted from the server when the game ends) ──
  const photoUrl = (pid, cell, v) => `/photo/${code}/${encodeURIComponent(pid)}/${cell}.jpg?k=${encodeURIComponent(key)}&v=${v || 0}`;
  let wall = [];
  function renderWall() {
    const el = $('#wall');
    if (!el) return;
    el.innerHTML = wall.slice(0, 24).map((w) => {
      const cap = `${w.player}${w.with ? ' with ' + w.with : ''} — ${w.prompt}`;
      const url = photoUrl(w.playerId, w.cell, w.at);
      return `<figure data-zoom="${esc(url)}" data-cap="${esc(cap)}"><img src="${esc(url)}" alt="${esc(cap)}" loading="lazy"><figcaption>${esc(cap)}</figcaption></figure>`;
    }).join('') || `<p class="muted" style="margin:0">${S && S.status === 'ended' ? 'The game has ended, so the photos were deleted from the server.' : 'No photos yet.'}</p>`;
  }
  async function loadWall() {
    const r = await emit('host:photos', { limit: 40 });
    if (r.ok) { wall = r.photos; renderWall(); }
  }
  $('#wall').addEventListener('click', (e) => { const f = e.target.closest('[data-zoom]'); if (f) lightbox(f.dataset.zoom, f.dataset.cap); });
  $('#wallProj').addEventListener('change', async () => {
    const r = await emit('host:showPhotos', { on: $('#wallProj').checked });
    if (!r.ok) toast(r.error, true);
  });
  // A modal <dialog>, so it stacks above the player-card dialog it may be opened from.
  function lightbox(url, cap) {
    const lb = document.createElement('dialog');
    lb.className = 'lightbox';
    lb.innerHTML = `<div><img src="${esc(url)}" alt=""><p>${esc(cap || '')}</p></div>`;
    lb.addEventListener('click', () => lb.close());
    lb.addEventListener('close', () => lb.remove());
    document.body.appendChild(lb);
    lb.showModal();
  }
  $('#kickBtn').addEventListener('click', async () => {
    const p = S.players.find((x) => x.id === cardPid);
    if (!confirm(`Remove ${p ? p.name : 'this player'} from the room?`)) return;
    const r = await emit('host:kick', { playerId: cardPid });
    if (!r.ok) return toast(r.error, true);
    $('#cardDlg').close();
  });

  // ── Boot ──
  renderChips();
  if (code) {
    if (!key) {
      $('#fatal').hidden = false;
      $('#fatal').textContent = 'This host link is missing its key. Open the full host link (it ends in #k=…) or create a new room.';
      $('#setPanel').hidden = true;
      $('#createPanel').hidden = true;
    } else connect();
  } else {
    const d = store.get(DRAFT_KEY, null);
    const c0 = cats[0];
    fillForm(d && Array.isArray(d.prompts) && d.prompts.length ? d : { title: c0 ? c0.title : 'Find Someone Who…', size: 5, free: true, prompts: c0 ? c0.p : [] });
  }
})();
