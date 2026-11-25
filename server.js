'use strict';
// Find Someone Who… — Human Bingo rooms server
// Express + Socket.IO + SQLite (node:sqlite). One process comfortably serves 300+ players per room.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 600; // per room
const ROOMS_PER_IP_PER_HOUR = Number(process.env.ROOMS_PER_IP_PER_HOUR) || 40;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const MAX_PROMPTS = 300;
const MAX_PROMPT_LEN = 80;
const MAX_TITLE = 40;
const MAX_NAME = 24;
fs.mkdirSync(DATA_DIR, { recursive: true });

// ───────────────────────── Database ─────────────────────────
const db = new DatabaseSync(path.join(DATA_DIR, 'bingo.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  host_key TEXT NOT NULL,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  free INTEGER NOT NULL,
  prompts_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  join_no INTEGER NOT NULL,
  card_json TEXT,
  joined_at INTEGER NOT NULL,
  kicked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS players_room ON players(room_code);
CREATE TABLE IF NOT EXISTS marks (
  player_id TEXT NOT NULL,
  cell INTEGER NOT NULL,
  name TEXT NOT NULL,
  photo INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, cell)
);
CREATE TABLE IF NOT EXISTS bingos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (player_id, kind)
);
CREATE INDEX IF NOT EXISTS bingos_room ON bingos(room_code);
`);

const q = {
  room: db.prepare('SELECT * FROM rooms WHERE code = ?'),
  insertRoom: db.prepare('INSERT INTO rooms (code, host_key, title, size, free, prompts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateSettings: db.prepare('UPDATE rooms SET title = ?, size = ?, free = ?, prompts_json = ? WHERE code = ?'),
  setStatus: db.prepare('UPDATE rooms SET status = ?, started_at = COALESCE(started_at, ?), ended_at = ? WHERE code = ?'),
  players: db.prepare('SELECT * FROM players WHERE room_code = ? AND kicked = 0 ORDER BY join_no'),
  playerCount: db.prepare('SELECT COUNT(*) AS c FROM players WHERE room_code = ? AND kicked = 0'),
  maxJoin: db.prepare('SELECT COALESCE(MAX(join_no), 0) AS m FROM players WHERE room_code = ?'),
  playerByToken: db.prepare('SELECT * FROM players WHERE token = ?'),
  player: db.prepare('SELECT * FROM players WHERE id = ?'),
  insertPlayer: db.prepare('INSERT INTO players (id, room_code, token, name, join_no, card_json, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  setCard: db.prepare('UPDATE players SET card_json = ? WHERE id = ?'),
  kick: db.prepare('UPDATE players SET kicked = 1 WHERE id = ?'),
  marks: db.prepare('SELECT cell, name, photo FROM marks WHERE player_id = ?'),
  roomMarks: db.prepare('SELECT m.player_id, m.cell, m.name, m.photo FROM marks m JOIN players p ON p.id = m.player_id WHERE p.room_code = ? AND p.kicked = 0'),
  upsertMark: db.prepare(`INSERT INTO marks (player_id, cell, name, photo, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id, cell) DO UPDATE SET name = excluded.name, photo = excluded.photo, updated_at = excluded.updated_at`),
  deleteMark: db.prepare('DELETE FROM marks WHERE player_id = ? AND cell = ?'),
  clearMarks: db.prepare('DELETE FROM marks WHERE player_id = ?'),
  bingos: db.prepare('SELECT b.*, p.name, p.join_no FROM bingos b JOIN players p ON p.id = b.player_id WHERE b.room_code = ? ORDER BY b.id'),
  insertBingo: db.prepare('INSERT OR IGNORE INTO bingos (room_code, player_id, kind, at) VALUES (?, ?, ?, ?)'),
  countBingo: db.prepare('SELECT COUNT(*) AS c FROM bingos WHERE room_code = ? AND kind = ?'),
};

const now = () => Date.now();
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
function safeEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function genCode() {
  for (let len = 5; ; ) {
    let c = '';
    for (let i = 0; i < len; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!q.room.get(c)) return c;
  }
}
function normCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}
function getRoom(code) {
  const r = q.room.get(normCode(code));
  if (r) r.prompts = JSON.parse(r.prompts_json);
  return r;
}
const cellsNeeded = (size, free) => size * size - (free && size % 2 === 1 ? 1 : 0);

function validateSettings(b) {
  const size = Number(b.size);
  if (![3, 4, 5].includes(size)) return { error: 'Card size must be 3, 4 or 5' };
  const free = !!b.free && size % 2 === 1;
  const title = clean(b.title, MAX_TITLE) || 'Find Someone Who…';
  const seen = new Set();
  const prompts = (Array.isArray(b.prompts) ? b.prompts : [])
    .map((p) => clean(p, MAX_PROMPT_LEN))
    .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .slice(0, MAX_PROMPTS);
  const need = cellsNeeded(size, free);
  if (prompts.length < need) return { error: `Add at least ${need} different squares for a ${size} × ${size} card` };
  return { title, size, free, prompts };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function dealCard(room) {
  const k = room.size * room.size;
  const free = !!room.free && room.size % 2 === 1;
  const cells = shuffle(room.prompts.slice()).slice(0, k - (free ? 1 : 0)).map((t) => ({ t }));
  if (free) cells.splice((k - 1) / 2, 0, { t: 'Free', f: 1 });
  return cells;
}

// Lines (rows, columns, diagonals) for each size.
const LINES = {};
for (const z of [3, 4, 5]) {
  const R = [...Array(z).keys()];
  const L = [];
  R.forEach((i) => { L.push(R.map((j) => i * z + j)); L.push(R.map((j) => j * z + i)); });
  L.push(R.map((i) => i * z + i));
  L.push(R.map((i) => i * z + z - 1 - i));
  LINES[z] = L;
}
function progressOf(card, marks) {
  if (!card) return { filled: 0, total: 0, lines: 0 };
  const z = Math.round(Math.sqrt(card.length));
  const on = card.map((c, i) => !!c.f || !!marks[i]);
  return { filled: on.filter(Boolean).length, total: card.length, lines: LINES[z].filter((l) => l.every((i) => on[i])).length };
}

// In-memory caches (rebuilt lazily after restart)
const progressCache = new Map(); // playerId -> {filled,total,lines}
const online = new Map(); // playerId -> open socket count
function marksMap(playerId) {
  const m = {};
  for (const r of q.marks.all(playerId)) m[r.cell] = { n: r.name, p: !!r.photo };
  return m;
}
function progressFor(p) {
  let pr = progressCache.get(p.id);
  if (!pr) {
    pr = progressOf(p.card_json ? JSON.parse(p.card_json) : null, marksMap(p.id));
    progressCache.set(p.id, pr);
  }
  return pr;
}

function labelMap(players) {
  const count = {};
  for (const p of players) count[p.name.toLowerCase()] = (count[p.name.toLowerCase()] || 0) + 1;
  const m = {};
  for (const p of players) m[p.id] = count[p.name.toLowerCase()] > 1 ? `${p.name} #${p.join_no}` : p.name;
  return m;
}
function winners(code, labels) {
  return q.bingos.all(code).map((b) => ({ kind: b.kind, name: (labels && labels[b.player_id]) || b.name, playerId: b.player_id, at: b.at }));
}

function roomView(r) {
  const players = q.players.all(r.code);
  const labels = labelMap(players);
  return {
    code: r.code,
    title: r.title,
    size: r.size,
    free: !!r.free,
    status: r.status,
    playerCount: players.length,
    winners: winners(r.code, labels).slice(0, 50),
  };
}
function hostView(r) {
  const players = q.players.all(r.code);
  const labels = labelMap(players);
  const win = winners(r.code, labels);
  const firstBingo = {};
  const blackout = {};
  win.forEach((w, i) => {
    if (w.kind === 'bingo' && !firstBingo[w.playerId]) firstBingo[w.playerId] = win.filter((x, j) => j <= i && x.kind === 'bingo').length;
    if (w.kind === 'blackout') blackout[w.playerId] = true;
  });
  return {
    code: r.code,
    title: r.title,
    size: r.size,
    free: !!r.free,
    prompts: r.prompts,
    status: r.status,
    createdAt: r.created_at,
    playerCount: players.length,
    onlineCount: players.filter((p) => online.get(p.id)).length,
    players: players.map((p) => ({ id: p.id, name: labels[p.id], joinNo: p.join_no, online: !!online.get(p.id), ...progressFor(p), bingo: firstBingo[p.id] || 0, blackout: !!blackout[p.id] })),
    winners: win,
  };
}
function meView(p) {
  return { id: p.id, name: p.name, card: p.card_json ? JSON.parse(p.card_json) : null, marks: marksMap(p.id) };
}

// ───────────────────────── HTTP ─────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024, perMessageDeflate: false });
const pub = path.join(__dirname, 'public');

app.use('/fonts/bricolage', express.static(path.join(__dirname, 'node_modules/@fontsource/bricolage-grotesque/files'), { maxAge: '30d', immutable: true }));
app.use('/fonts/caveat', express.static(path.join(__dirname, 'node_modules/@fontsource/caveat/files'), { maxAge: '30d', immutable: true }));
app.use(express.static(pub, { index: false, maxAge: '5m' }));
const page = (f) => (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, f)); };
app.get('/', page('index.html'));
app.get(['/host', '/host/:code'], page('host.html'));
app.get(['/join', '/join/:code'], page('play.html'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

const createLog = new Map(); // ip -> timestamps
app.post('/api/rooms', express.json({ limit: '64kb' }), (req, res) => {
  const ip = req.ip || 'x';
  const recent = (createLog.get(ip) || []).filter((t) => now() - t < 3600e3);
  if (recent.length >= ROOMS_PER_IP_PER_HOUR) return res.status(429).json({ error: 'Too many rooms created from this network. Try again later.' });
  const s = validateSettings(req.body || {});
  if (s.error) return res.status(400).json({ error: s.error });
  let code;
  if (req.body.code) {
    code = normCode(req.body.code);
    if (!code) return res.status(400).json({ error: 'Room codes use letters and numbers only (max 5)' });
    if (q.room.get(code)) return res.status(409).json({ error: `Room code ${code} is already taken — try another` });
  } else code = genCode();
  const key = rid(18);
  q.insertRoom.run(code, key, s.title, s.size, s.free ? 1 : 0, JSON.stringify(s.prompts), now());
  recent.push(now());
  createLog.set(ip, recent);
  log(code, `room created (${s.size}×${s.size}, ${s.prompts.length} squares)`);
  res.json({ code, hostKey: key });
});

app.get('/api/rooms/:code', (req, res) => {
  const r = getRoom(req.params.code);
  if (!r) return res.status(404).json({ error: 'No room with that code' });
  res.json({ code: r.code, title: r.title, status: r.status });
});

app.get('/qr/:code.svg', async (req, res) => {
  const code = normCode(req.params.code);
  if (!q.room.get(code)) return res.sendStatus(404);
  const url = `${req.protocol}://${req.get('host')}/join/${code}`;
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600');
  res.send(await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#14163a', light: '#ffffff' } }));
});

// ───────────────────────── Real-time ─────────────────────────
// Host and lobby updates are coalesced so a join rush of hundreds of phones stays cheap.
const hostTimers = new Map();
const roomTimers = new Map();
function pushHost(code, delay = 300) {
  if (hostTimers.has(code)) return;
  hostTimers.set(code, setTimeout(() => {
    hostTimers.delete(code);
    const r = getRoom(code);
    if (r) io.to(`host:${code}`).emit('state', hostView(r));
  }, delay));
}
function pushRoom(code, delay = 1200) {
  if (roomTimers.has(code)) return;
  roomTimers.set(code, setTimeout(() => {
    roomTimers.delete(code);
    const r = getRoom(code);
    if (r) io.to(`room:${code}`).emit('room', roomView(r));
  }, delay));
}
function pushNow(code) {
  clearTimeout(hostTimers.get(code)); hostTimers.delete(code);
  clearTimeout(roomTimers.get(code)); roomTimers.delete(code);
  const r = getRoom(code);
  if (!r) return;
  io.to(`host:${code}`).emit('state', hostView(r));
  io.to(`room:${code}`).emit('room', roomView(r));
}
function log(code, msg) {
  console.log(`[${new Date().toISOString()}] [${code}] ${msg}`);
}

io.on('connection', (socket) => {
  const ack = (cb, v) => typeof cb === 'function' && cb(v);
  const fail = (cb, error) => ack(cb, { ok: false, error });

  // ── Host ──
  function hostRoom(cb) {
    if (socket.data.role !== 'host') return fail(cb, 'Not the host'), null;
    const r = getRoom(socket.data.code);
    if (!r) return fail(cb, 'Room not found'), null;
    return r;
  }
  socket.on('host:auth', ({ code, key } = {}, cb) => {
    const r = getRoom(code);
    if (!r || !safeEq(r.host_key, key)) return fail(cb, 'This host link is not valid for that room');
    socket.data = { role: 'host', code: r.code };
    socket.join(`host:${r.code}`);
    ack(cb, { ok: true, state: hostView(r) });
  });
  socket.on('host:update', (body = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    if (r.status !== 'lobby') return fail(cb, 'Squares are locked once the game starts');
    const s = validateSettings(body);
    if (s.error) return fail(cb, s.error);
    q.updateSettings.run(s.title, s.size, s.free ? 1 : 0, JSON.stringify(s.prompts), r.code);
    pushNow(r.code);
    ack(cb, { ok: true });
  });
  socket.on('host:start', (_, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    if (r.status !== 'lobby') return fail(cb, 'The game already started');
    const players = q.players.all(r.code);
    db.exec('BEGIN');
    try {
      for (const p of players) if (!p.card_json) q.setCard.run(JSON.stringify(dealCard(r)), p.id);
      q.setStatus.run('live', now(), null, r.code);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const p of players) {
      progressCache.delete(p.id);
      io.to(`p:${p.id}`).emit('me', meView(q.player.get(p.id)));
    }
    pushNow(r.code);
    io.to(`room:${r.code}`).emit('fx', { type: 'start' });
    log(r.code, `game started with ${players.length} players`);
    ack(cb, { ok: true });
  });
  socket.on('host:end', (_, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    if (r.status !== 'live') return fail(cb, 'The game is not running');
    q.setStatus.run('ended', now(), now(), r.code);
    pushNow(r.code);
    io.to(`room:${r.code}`).emit('fx', { type: 'end' });
    ack(cb, { ok: true });
  });
  socket.on('host:resume', (_, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    if (r.status !== 'ended') return fail(cb, 'The game has not ended');
    q.setStatus.run('live', now(), null, r.code);
    pushNow(r.code);
    io.to(`room:${r.code}`).emit('fx', { type: 'resume' });
    ack(cb, { ok: true });
  });
  socket.on('host:kick', ({ playerId } = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    const p = q.player.get(String(playerId));
    if (!p || p.room_code !== r.code) return fail(cb, 'No such player');
    q.kick.run(p.id);
    io.to(`p:${p.id}`).emit('kicked');
    pushNow(r.code);
    ack(cb, { ok: true });
  });
  socket.on('host:card', ({ playerId } = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    const p = q.player.get(String(playerId));
    if (!p || p.room_code !== r.code) return fail(cb, 'No such player');
    ack(cb, { ok: true, name: p.name, ...meView(p), progress: progressFor(p) });
  });

  // ── Player ──
  function attach(r, p) {
    socket.data = { role: 'player', code: r.code, playerId: p.id };
    socket.join(`room:${r.code}`);
    socket.join(`p:${p.id}`);
    online.set(p.id, (online.get(p.id) || 0) + 1);
    pushHost(r.code);
  }
  socket.on('disconnect', () => {
    const { role, playerId, code } = socket.data || {};
    if (role !== 'player') return;
    const n = (online.get(playerId) || 1) - 1;
    if (n > 0) online.set(playerId, n);
    else online.delete(playerId);
    pushHost(code, 1500);
  });
  function me(cb) {
    if (socket.data.role !== 'player') return fail(cb, 'Join a room first'), null;
    const p = q.player.get(socket.data.playerId);
    if (!p || p.kicked) return fail(cb, 'You were removed from this room'), null;
    return { p, r: getRoom(p.room_code) };
  }

  socket.on('player:join', ({ code, name } = {}, cb) => {
    const r = getRoom(code);
    if (!r) return fail(cb, 'No room with that code — check it and try again');
    if (r.status === 'ended') return fail(cb, 'This game has ended');
    const nm = clean(name, MAX_NAME);
    if (!nm) return fail(cb, 'Enter your name');
    if (q.playerCount.get(r.code).c >= MAX_PLAYERS) return fail(cb, 'This room is full');
    const p = { id: rid(8), token: rid(18) };
    const joinNo = q.maxJoin.get(r.code).m + 1;
    q.insertPlayer.run(p.id, r.code, p.token, nm, joinNo, r.status === 'live' ? JSON.stringify(dealCard(r)) : null, now());
    const full = q.player.get(p.id);
    attach(r, full);
    pushRoom(r.code);
    ack(cb, { ok: true, token: p.token, room: roomView(r), me: meView(full) });
  });
  socket.on('player:resume', ({ code, token } = {}, cb) => {
    const p = q.playerByToken.get(String(token || ''));
    if (!p || (code && p.room_code !== normCode(code))) return fail(cb, 'unknown');
    if (p.kicked) return fail(cb, 'kicked');
    const r = getRoom(p.room_code);
    attach(r, p);
    ack(cb, { ok: true, room: roomView(r), me: meView(p) });
  });
  socket.on('player:mark', ({ cell, name, photo } = {}, cb) => {
    const c = me(cb);
    if (!c) return;
    const { p, r } = c;
    if (r.status !== 'live') return fail(cb, r.status === 'ended' ? 'The game has ended' : 'The game has not started yet');
    const card = p.card_json && JSON.parse(p.card_json);
    cell = Number(cell);
    if (!card || !Number.isInteger(cell) || cell < 0 || cell >= card.length || card[cell].f) return fail(cb, 'Not a square on your card');
    const nm = clean(name, MAX_NAME);
    if (nm || photo) q.upsertMark.run(p.id, cell, nm, photo ? 1 : 0, now());
    else q.deleteMark.run(p.id, cell);
    const pr = progressOf(card, marksMap(p.id));
    progressCache.set(p.id, pr);
    const events = [];
    let label = null; // full-roster lookup only when someone actually scores
    const nameOf = () => label || (label = labelMap(q.players.all(r.code))[p.id] || p.name);
    if (pr.lines > 0 && q.insertBingo.run(r.code, p.id, 'bingo', now()).changes) {
      const order = q.countBingo.get(r.code, 'bingo').c;
      events.push({ type: 'bingo', name: nameOf(), order, playerId: p.id });
      log(r.code, `BINGO #${order}: ${nameOf()}`);
    }
    if (pr.filled === pr.total && q.insertBingo.run(r.code, p.id, 'blackout', now()).changes) {
      const order = q.countBingo.get(r.code, 'blackout').c;
      events.push({ type: 'blackout', name: nameOf(), order, playerId: p.id });
      log(r.code, `BLACKOUT #${order}: ${nameOf()}`);
    }
    // Host hears every call; the whole room hears the first 20 (enough for the race, no pop-up storm at 300+ players);
    // the player always hears their own.
    for (const e of events) {
      io.to(`host:${r.code}`).to(`p:${p.id}`).emit('fx', e);
      if (e.order <= 20) io.to(`room:${r.code}`).except(`p:${p.id}`).emit('fx', e);
    }
    if (events.some((e) => e.order <= 50)) pushRoom(r.code, 200); // phones show the top 50 winners
    pushHost(r.code);
    ack(cb, { ok: true, progress: pr });
  });
  socket.on('player:clearAll', (_, cb) => {
    const c = me(cb);
    if (!c) return;
    if (c.r.status !== 'live') return fail(cb, 'The game is not running');
    q.clearMarks.run(c.p.id);
    progressCache.delete(c.p.id);
    pushHost(c.r.code);
    ack(cb, { ok: true });
  });
});

server.listen(PORT, () => console.log(`Human Bingo rooms on http://localhost:${PORT}`));
