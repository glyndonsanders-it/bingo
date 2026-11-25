// Load test: N simulated phones join one room in a rush, the host starts, everyone fills their whole card.
// Usage: BASE=http://localhost:3000 PLAYERS=300 node tests/load-test.js
const { io } = require('socket.io-client');
const BASE = process.env.BASE || 'http://localhost:3000';
const N = Number(process.env.PLAYERS) || 300;
const MARK_WINDOW_MS = Number(process.env.MARK_WINDOW_MS) || 30000;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, d) => new Promise((res) => { const t = Date.now(); s.timeout(20000).emit(ev, d, (err, r) => res({ ms: Date.now() - t, r: err ? { ok: false, error: String(err) } : r })); });

(async () => {
  const prompts = Array.from({ length: 40 }, (_, i) => `Square ${i + 1}`);
  const room = await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Load test', size: 5, free: true, prompts }) }).then((r) => r.json());
  console.log(`room ${room.code} · ${N} players`);
  const host = io(BASE, { transports: ['websocket'] });
  let hostMsgs = 0, hostBytes = 0, last = null;
  host.on('state', (s) => { hostMsgs++; hostBytes += JSON.stringify(s).length; last = s; });
  await new Promise((r) => host.on('connect', r));
  await call(host, 'host:auth', { code: room.code, key: room.hostKey });

  const players = [];
  const joinMs = [];
  let joinFail = 0, roomMsgs = 0, fxMsgs = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, async (_, i) => {
    await sleep(i * 20); // ~50 joins/second
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    s.on('room', () => roomMsgs++);
    s.on('fx', () => fxMsgs++);
    const pl = { s, card: null };
    s.on('me', (m) => { pl.card = m.card; pl.cardAt = Date.now(); });
    await new Promise((r) => s.on('connect', r));
    const { ms, r } = await call(s, 'player:join', { code: room.code, name: `Player ${i + 1}` });
    if (!r.ok) { joinFail++; return; }
    joinMs.push(ms);
    players.push(pl);
  }));
  console.log(`joins: ${players.length} ok, ${joinFail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s · ack p50 ${pct(joinMs, 50)}ms p95 ${pct(joinMs, 95)}ms max ${Math.max(...joinMs)}ms`);

  const tStart = Date.now();
  await call(host, 'host:start');
  while (players.some((p) => !p.card) && Date.now() - tStart < 15000) await sleep(50);
  console.log(`start: ${players.filter((p) => p.card).length}/${players.length} cards delivered in ${Math.max(...players.map((p) => p.cardAt - tStart))}ms`);

  const markMs = [];
  let markFail = 0;
  const tm = Date.now();
  await Promise.all(players.map(async (p, i) => {
    const cells = p.card.map((c, j) => (c.f ? -1 : j)).filter((j) => j >= 0).sort(() => Math.random() - 0.5);
    for (const cell of cells) {
      await sleep(Math.random() * (MARK_WINDOW_MS / cells.length) * 2);
      const { ms, r } = await call(p.s, 'player:mark', { cell, name: `Friend ${cell}`, photo: cell % 3 === 0 });
      if (r.ok) markMs.push(ms); else markFail++;
    }
  }));
  console.log(`marks: ${markMs.length} ok, ${markFail} failed in ${((Date.now() - tm) / 1000).toFixed(1)}s · ack p50 ${pct(markMs, 50)}ms p95 ${pct(markMs, 95)}ms p99 ${pct(markMs, 99)}ms max ${Math.max(...markMs)}ms`);
  await sleep(1500);
  const bingos = last.winners.filter((w) => w.kind === 'bingo').length;
  const blackouts = last.winners.filter((w) => w.kind === 'blackout').length;
  console.log(`host view: ${last.playerCount} players, ${last.onlineCount} online, all cards full: ${last.players.every((p) => p.filled === 25)}, bingos ${bingos}, blackouts ${blackouts}`);
  console.log(`traffic: host got ${hostMsgs} updates (avg ${Math.round(hostBytes / Math.max(1, hostMsgs) / 1024)} KB); phones got ${roomMsgs} lobby updates + ${fxMsgs} event messages in total`);
  const pass = players.length === N && !joinFail && !markFail && last.playerCount === N && bingos === N && blackouts === N && pct(markMs, 95) < 1000;
  players.forEach((p) => p.s.close());
  host.close();
  console.log(pass ? 'LOAD TEST PASSED' : 'LOAD TEST FAILED');
  process.exit(pass ? 0 : 1);
})();
