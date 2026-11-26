/* Big screen for the projector: view-only, no controls, no player details. */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const code = String(location.pathname.split('/')[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const key = new URLSearchParams(location.hash.slice(1)).get('d');
  let S = null;
  let photos = [];
  const seenNames = new Set();
  const seenWinners = new Set();
  let firstPaint = true;

  const setAll = (sel, txt) => document.querySelectorAll(sel).forEach((el) => (el.textContent = txt));
  function fail(msg) { const e = $('#err'); e.textContent = msg; e.style.display = 'grid'; document.querySelectorAll('.view').forEach((v) => v.classList.remove('on')); }

  const socket = io();
  socket.on('connect', auth);
  function auth() {
    if (!code || !key) return fail('This big-screen link is incomplete. Open it from the host page (“Open big screen”).');
    socket.timeout(10000).emit('screen:auth', { code, key }, (err, r) => {
      if (err || !r || !r.ok) return fail((r && r.error) || 'Can’t reach the game server.');
      $('#err').style.display = 'none';
      photos = r.photos || [];
      apply(r.state);
    });
  }
  socket.on('screen', (s) => {
    const photosTurnedOn = S && !S.showPhotos && s.showPhotos;
    apply(s);
    if (photosTurnedOn) auth(); // fetch the current photos
  });
  socket.on('fx', (fx) => {
    if (fx.type === 'photo') {
      photos = [fx].concat(photos.filter((p) => !(p.playerId === fx.playerId && p.cell === fx.cell))).slice(0, 24);
      renderWall(fx);
    }
    if (fx.type === 'claim' && fx.pending) ping(`🔔 ${fx.name} called ${fx.kind === 'blackout' ? 'BLACKOUT' : 'BINGO'}! Checking their card…`);
    if (fx.type === 'winner') celebrate(fx); // the big moment waits for the host's confirmation
    if (fx.type === 'end') { photos = []; renderWall(); }
  });

  function apply(s) {
    S = s;
    Theme.apply(s.theme);
    const url = `${location.host}/join`;
    setAll('[data-title]', s.title);
    setAll('[data-code]', s.code);
    setAll('[data-url]', url);
    setAll('[data-count]', s.playerCount);
    setAll('[data-countl]', s.playerCount === 1 ? 'player in' : 'players in');
    setAll('[data-rule]', s.winMode === 'blackout' ? 'To win: fill EVERY square' : 'To win: one row, column or diagonal');
    setAll('[data-winh]', s.winMode === 'blackout' ? 'Blackout winners' : 'Bingo winners');
    const qr = `/qr/${s.code}.svg`;
    if ($('#qrL').getAttribute('src') !== qr) { $('#qrL').src = qr; $('#qrS').src = qr; }
    document.title = `${s.title} – Room ${s.code}`;
    const view = s.status === 'lobby' ? 'lobbyV' : s.status === 'live' ? 'liveV' : 'endV';
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === view));
    $('#liveV').classList.toggle('nophotos', !s.showPhotos);
    renderNames();
    renderWinners();
    const ch = $('#checking');
    ch.hidden = !s.checking.length;
    ch.textContent = `⏳ Checking: ${s.checking.join(', ')}`;
    renderEnd();
    if (s.status !== 'live') { photos = []; }
    renderWall();
    firstPaint = false;
  }

  function renderNames() {
    $('#names').innerHTML = S.recent.map((n) => `<span class="${!firstPaint && !seenNames.has(n) ? 'new' : ''}">${esc(n)}</span>`).join('');
    S.recent.forEach((n) => seenNames.add(n));
  }
  function renderWinners() {
    const w = S.winners;
    $('#wl').innerHTML = w.slice(0, 12).map((x, i) => {
      const k = x.name + x.at;
      const isNew = !firstPaint && !seenWinners.has(k);
      seenWinners.add(k);
      return `<li class="${isNew ? 'new' : ''}"><span class="o">#${i + 1}</span><span>${esc(x.name)}</span></li>`;
    }).join('') || `<li class="empty" style="background:none;color:#fff">No winners yet — who will be first?</li>`;
    w.forEach((x) => seenWinners.add(x.name + x.at));
  }
  function renderEnd() {
    const w = S.winners;
    const pod = [w[1], w[0], w[2]];
    const cls = ['p2', 'p1', 'p3'];
    const place = [2, 1, 3];
    $('#podium').innerHTML = w.length
      ? pod.map((x, i) => (x ? `<div class="${cls[i]}"><b>#${place[i]}</b><span>${esc(x.name)}</span></div>` : '')).join('')
      : `<p class="lbl">No winners this time — thanks for playing!</p>`;
    $('#rest').innerHTML = w.slice(3, 30).map((x, i) => `<span>#${i + 4} ${esc(x.name)}</span>`).join('');
  }
  function renderWall(fresh) {
    const el = $('#wall');
    if (!S || !S.showPhotos) { el.innerHTML = ''; return; }
    el.innerHTML = photos.slice(0, 15).map((p) => {
      const cap = `${p.player}${p.with ? ' with ' + p.with : ''} — ${p.prompt}`;
      const src = `/photo/${S.code}/${encodeURIComponent(p.playerId)}/${p.cell}.jpg?d=${encodeURIComponent(key)}&v=${p.at}`;
      const isNew = fresh && fresh.playerId === p.playerId && fresh.cell === p.cell;
      return `<figure class="${isNew ? 'new' : ''}"><img src="${esc(src)}" alt="${esc(cap)}"><figcaption>${esc(cap)}</figcaption></figure>`;
    }).join('') || '<p class="empty">Photos will appear here as people snap them.</p>';
  }

  // Full-screen celebration for each winner, one after another.
  const queue = [];
  let showing = false;
  function celebrate(fx) {
    queue.push(fx);
    if (!showing) next();
  }
  function next() {
    const fx = queue.shift();
    const box = $('#celebrate');
    if (!fx) { box.hidden = true; showing = false; return; }
    showing = true;
    const colors = ['#ffd93d', '#d62839', '#ffffff', '#7cf0ff', '#9fff7a'];
    let conf = '';
    for (let i = 0; i < 70; i++) conf += `<i class="conf" style="left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${2.2 + Math.random() * 2}s;animation-delay:${Math.random() * 0.8}s"></i>`;
    box.innerHTML = `${conf}<div><div class="word">${fx.kind === 'blackout' ? 'BLACKOUT!' : 'BINGO!'}</div><div class="who">${esc(fx.name)}</div><div class="place">✓ Confirmed · ${ordinal(fx.place)} place</div></div>`;
    box.hidden = false;
    setTimeout(next, queue.length > 3 ? 2200 : 4500); // speed up if many winners arrive at once
  }
  // Small, non-blocking note at the top of the screen.
  function ping(text) {
    const el = document.createElement('div');
    el.className = 'ping';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  // Full screen + hide the cursor when idle
  const fsBtn = $('#fsBtn');
  fsBtn.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}));
  document.addEventListener('fullscreenchange', () => { fsBtn.hidden = !!document.fullscreenElement; });
  document.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') fsBtn.click(); });
  let idle;
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    if (!document.fullscreenElement) fsBtn.hidden = false;
    clearTimeout(idle);
    idle = setTimeout(() => { document.body.classList.add('idle'); if (document.fullscreenElement) fsBtn.hidden = true; }, 2500);
  });
})();
