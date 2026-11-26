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
const PHOTO_DIR = path.join(DATA_DIR, 'photos'); // temporary: wiped when a game ends
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
fs.mkdirSync(PHOTO_DIR, { recursive: true });

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
for (const col of ["win_mode TEXT NOT NULL DEFAULT 'line'", 'display_key TEXT', 'show_photos INTEGER NOT NULL DEFAULT 1', 'verify INTEGER NOT NULL DEFAULT 1', 'stop_after INTEGER NOT NULL DEFAULT 0', "theme TEXT NOT NULL DEFAULT 'general'"]) {
  try { db.exec(`ALTER TABLE rooms ADD COLUMN ${col}`); } catch (e) { /* already there */ }
}
// A claim is 'pending' until the host checks the card, then 'verified' (rejected claims are deleted so the player can try again).
for (const col of ["status TEXT NOT NULL DEFAULT 'verified'", 'reviewed_at INTEGER']) {
  try { db.exec(`ALTER TABLE bingos ADD COLUMN ${col}`); } catch (e) { /* already there */ }
}

const q = {
  room: db.prepare('SELECT * FROM rooms WHERE code = ?'),
  insertRoom: db.prepare('INSERT INTO rooms (code, host_key, title, size, free, prompts_json, win_mode, verify, stop_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateSettings: db.prepare('UPDATE rooms SET title = ?, size = ?, free = ?, prompts_json = ?, win_mode = ?, verify = ?, stop_after = ? WHERE code = ?'),
  setStopAfter: db.prepare('UPDATE rooms SET stop_after = ? WHERE code = ?'),
  setTheme: db.prepare('UPDATE rooms SET theme = ? WHERE code = ?'),
  allRooms: db.prepare('SELECT code, status, created_at FROM rooms'),
  setDisplayKey: db.prepare('UPDATE rooms SET display_key = ? WHERE code = ?'),
  setShowPhotos: db.prepare('UPDATE rooms SET show_photos = ? WHERE code = ?'),
  recentJoins: db.prepare('SELECT name, join_no FROM players WHERE room_code = ? AND kicked = 0 ORDER BY join_no DESC LIMIT ?'),
  setStatus: db.prepare('UPDATE rooms SET status = ?, started_at = COALESCE(started_at, ?), ended_at = ? WHERE code = ?'),
  players: db.prepare('SELECT * FROM players WHERE room_code = ? AND kicked = 0 ORDER BY join_no'),
  playerCount: db.prepare('SELECT COUNT(*) AS c FROM players WHERE room_code = ? AND kicked = 0'),
  maxJoin: db.prepare('SELECT COALESCE(MAX(join_no), 0) AS m FROM players WHERE room_code = ?'),
  playerByToken: db.prepare('SELECT * FROM players WHERE token = ?'),
  player: db.prepare('SELECT * FROM players WHERE id = ?'),
  insertPlayer: db.prepare('INSERT INTO players (id, room_code, token, name, join_no, card_json, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  setCard: db.prepare('UPDATE players SET card_json = ? WHERE id = ?'),
  kick: db.prepare('UPDATE players SET kicked = 1 WHERE id = ?'),
  marks: db.prepare('SELECT cell, name, photo, updated_at FROM marks WHERE player_id = ?'),
  roomMarks: db.prepare('SELECT m.player_id, m.cell, m.name, m.photo FROM marks m JOIN players p ON p.id = m.player_id WHERE p.room_code = ? AND p.kicked = 0'),
  upsertMark: db.prepare(`INSERT INTO marks (player_id, cell, name, photo, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id, cell) DO UPDATE SET name = excluded.name, photo = excluded.photo, updated_at = excluded.updated_at`),
  deleteMark: db.prepare('DELETE FROM marks WHERE player_id = ? AND cell = ?'),
  clearMarks: db.prepare('DELETE FROM marks WHERE player_id = ?'),
  mark: db.prepare('SELECT * FROM marks WHERE player_id = ? AND cell = ?'),
  setPhotoFlag: db.prepare('UPDATE marks SET photo = 1, updated_at = ? WHERE player_id = ? AND cell = ?'),
  insertPhotoOnly: db.prepare("INSERT OR IGNORE INTO marks (player_id, cell, name, photo, updated_at) VALUES (?, ?, '', 1, ?)"),
  dropRoomPhotoFlags: db.prepare('UPDATE marks SET photo = 0 WHERE photo = 1 AND player_id IN (SELECT id FROM players WHERE room_code = ?)'),
  recentPhotos: db.prepare('SELECT m.player_id, m.cell, m.name, m.updated_at FROM marks m JOIN players p ON p.id = m.player_id WHERE p.room_code = ? AND p.kicked = 0 AND m.photo = 1 ORDER BY m.updated_at DESC LIMIT ?'),
  bingos: db.prepare('SELECT b.*, p.name, p.join_no FROM bingos b JOIN players p ON p.id = b.player_id WHERE b.room_code = ? ORDER BY b.id'),
  insertBingo: db.prepare('INSERT OR IGNORE INTO bingos (room_code, player_id, kind, at, status) VALUES (?, ?, ?, ?, ?)'),
  claimOf: db.prepare('SELECT * FROM bingos WHERE player_id = ? AND kind = ?'),
  setClaimStatus: db.prepare('UPDATE bingos SET status = ?, reviewed_at = ? WHERE id = ?'),
  deleteClaim: db.prepare('DELETE FROM bingos WHERE id = ?'),
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
  const winMode = b.winMode === 'blackout' ? 'blackout' : 'line';
  const verify = b.verify !== false;
  const stopAfter = clampStop(b.stopAfter);
  return { title, size, free, prompts, winMode, verify, stopAfter, theme: cleanTheme(b.theme) };
}

const clampStop = (n) => Math.max(0, Math.min(100, Math.floor(Number(n) || 0)));
const THEMES = ['general', 'christmas', 'fun', 'team', 'youth', 'minimal'];
const cleanTheme = (t) => (THEMES.includes(t) ? t : 'general');

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
  for (const r of q.marks.all(playerId)) m[r.cell] = { n: r.name, p: !!r.photo, u: r.updated_at };
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
  return q.bingos.all(code).map((b) => ({ kind: b.kind, name: (labels && labels[b.player_id]) || b.name, playerId: b.player_id, at: b.at, status: b.status }));
}
// Claims for this room's win mode, in the order the server received them.
// Confirmed winners are placed by that order (finishing first wins), whenever the host gets to check them.
function standings(r, labels) {
  let place = 0;
  return winners(r.code, labels).filter((w) => w.kind === winKind(r)).map((w) => ({ ...w, place: w.status === 'verified' ? ++place : 0 }));
}

function roomView(r) {
  const players = q.players.all(r.code);
  const labels = labelMap(players);
  return {
    code: r.code,
    title: r.title,
    size: r.size,
    free: !!r.free,
    winMode: r.win_mode,
    theme: r.theme,
    verify: !!r.verify,
    stopAfter: r.stop_after,
    status: r.status,
    playerCount: players.length,
    winners: standings(r, labels).filter((w) => w.place).slice(0, 50),
  };
}
// What the projector shows: no controls, no per-player details.
function screenView(r) {
  const players = q.players.all(r.code);
  const labels = labelMap(players);
  return {
    code: r.code,
    title: r.title,
    status: r.status,
    winMode: r.win_mode,
    theme: r.theme,
    showPhotos: !!r.show_photos,
    playerCount: players.length,
    recent: players.slice(-18).reverse().map((p) => labels[p.id]),
    stopAfter: r.stop_after,
    winners: standings(r, labels).filter((w) => w.place).slice(0, 30).map((w) => ({ name: w.name, at: w.at, place: w.place })),
    checking: standings(r, labels).filter((w) => w.status === 'pending').slice(0, 8).map((w) => w.name),
  };
}
function hostView(r) {
  const players = q.players.all(r.code);
  const labels = labelMap(players);
  const win = standings(r, labels);
  const rank = {};
  const pending = {};
  win.forEach((w) => { if (w.place) rank[w.playerId] = w.place; if (w.status === 'pending') pending[w.playerId] = true; });
  return {
    code: r.code,
    title: r.title,
    size: r.size,
    free: !!r.free,
    winMode: r.win_mode,
    theme: r.theme,
    verify: !!r.verify,
    stopAfter: r.stop_after,
    confirmed: win.filter((w) => w.place).length,
    displayKey: r.display_key,
    showPhotos: !!r.show_photos,
    prompts: r.prompts,
    status: r.status,
    createdAt: r.created_at,
    playerCount: players.length,
    onlineCount: players.filter((p) => online.get(p.id)).length,
    players: players.map((p) => ({ id: p.id, name: labels[p.id], joinNo: p.join_no, online: !!online.get(p.id), ...progressFor(p), rank: rank[p.id] || 0, pending: !!pending[p.id] })),
    winners: win,
  };
}
const winKind = (r) => (r.win_mode === 'blackout' ? 'blackout' : 'bingo');
function meView(p) {
  const r = getRoom(p.room_code);
  let claim = null;
  if (r) {
    const mine = standings(r).find((w) => w.playerId === p.id);
    if (mine) claim = { status: mine.status, place: mine.place };
  }
  return { id: p.id, name: p.name, card: p.card_json ? JSON.parse(p.card_json) : null, marks: marksMap(p.id), claim };
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
for (const f of ['mountains-of-christmas', 'fredoka', 'inter', 'bungee']) {
  app.use(`/fonts/${f}`, express.static(path.join(__dirname, `node_modules/@fontsource/${f}/files`), { maxAge: '30d', immutable: true }));
}
app.use(express.static(pub, { index: false, maxAge: '5m' }));
const page = (f) => (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, f)); };
app.get('/', page('index.html'));
app.get(['/host', '/host/:code'], page('host.html'));
app.get(['/join', '/join/:code'], page('play.html'));
app.get('/screen/:code', page('screen.html'));
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
  q.insertRoom.run(code, key, s.title, s.size, s.free ? 1 : 0, JSON.stringify(s.prompts), s.winMode, s.verify ? 1 : 0, s.stopAfter, now());
  q.setDisplayKey.run(rid(12), code);
  q.setTheme.run(s.theme, code);
  recent.push(now());
  createLog.set(ip, recent);
  log(code, `room created (${s.size}×${s.size}, ${s.prompts.length} squares)`);
  res.json({ code, hostKey: key });
});

app.get('/api/rooms/:code', (req, res) => {
  const r = getRoom(req.params.code);
  if (!r) return res.status(404).json({ error: 'No room with that code' });
  res.json({ code: r.code, title: r.title, status: r.status, theme: r.theme });
});

// ── Temporary photo session ──
// Photos are uploaded during a game so the host can see them, and deleted from the server when the game ends.
const photoPath = (code, pid, cell) => path.join(PHOTO_DIR, code, `${pid}_${cell}.jpg`);
function purgePhotos(code) {
  fs.rmSync(path.join(PHOTO_DIR, code), { recursive: true, force: true });
  q.dropRoomPhotoFlags.run(code);
}
function deletePhoto(code, pid, cell) {
  fs.rmSync(photoPath(code, pid, cell), { force: true });
}
// Safety net: remove photo folders of ended, missing or day-old rooms.
function sweepPhotos() {
  const rooms = Object.fromEntries(q.allRooms.all().map((r) => [r.code, r]));
  for (const dir of fs.readdirSync(PHOTO_DIR)) {
    const r = rooms[dir];
    if (!r || r.status !== 'live' || now() - r.created_at > 24 * 3600e3) purgePhotos(dir);
  }
}
sweepPhotos();
setInterval(sweepPhotos, 3600e3).unref();

app.post('/api/photo', express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), (req, res) => {
  const p = q.playerByToken.get(String(req.get('x-player-token') || ''));
  if (!p || p.kicked) return res.status(401).json({ error: 'Join the room first' });
  const r = getRoom(p.room_code);
  if (!r || r.status !== 'live') return res.status(409).json({ error: 'Photos can only be added while the game is running' });
  const card = p.card_json && JSON.parse(p.card_json);
  const cell = Number(req.get('x-cell'));
  if (!card || !Number.isInteger(cell) || cell < 0 || cell >= card.length || card[cell].f) return res.status(400).json({ error: 'Not a square on your card' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Send a JPEG photo' });
  fs.mkdirSync(path.join(PHOTO_DIR, r.code), { recursive: true });
  fs.writeFileSync(photoPath(r.code, p.id, cell), buf);
  const t = now();
  if (!q.setPhotoFlag.run(t, p.id, cell).changes) q.insertPhotoOnly.run(p.id, cell, t);
  const pr = progressOf(card, marksMap(p.id));
  progressCache.set(p.id, pr);
  const m = q.mark.get(p.id, cell);
  const photoFx = { type: 'photo', playerId: p.id, cell, at: t, prompt: card[cell].t, with: m ? m.name : '', player: p.name };
  io.to(`host:${r.code}`).emit('fx', photoFx);
  if (r.show_photos) io.to(`screen:${r.code}`).emit('fx', photoFx);
  pushHost(r.code);
  res.json({ ok: true, v: t });
});

app.get('/photo/:code/:pid/:cell.jpg', (req, res) => {
  const r = getRoom(req.params.code);
  if (!r) return res.sendStatus(404);
  let ok = false;
  if (req.query.k) ok = safeEq(r.host_key, req.query.k);
  else if (req.query.d) ok = !!r.show_photos && !!r.display_key && safeEq(r.display_key, req.query.d);
  else if (req.query.t) {
    const p = q.playerByToken.get(String(req.query.t));
    ok = !!p && p.id === req.params.pid && p.room_code === r.code;
  }
  if (!ok) return res.sendStatus(403);
  const f = photoPath(r.code, String(req.params.pid).replace(/[^\w-]/g, ''), Number(req.params.cell) | 0);
  if (!fs.existsSync(f)) return res.sendStatus(404);
  // no-cache: browsers revalidate (cheap 304s), so once a game ends and photos are deleted, they stop showing.
  res.set('Cache-Control', 'private, no-cache');
  res.type('image/jpeg').sendFile(f);
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
    if (r) {
      io.to(`room:${code}`).emit('room', roomView(r));
      io.to(`screen:${code}`).emit('screen', screenView(r));
    }
  }, delay));
}
function pushNow(code) {
  clearTimeout(hostTimers.get(code)); hostTimers.delete(code);
  clearTimeout(roomTimers.get(code)); roomTimers.delete(code);
  const r = getRoom(code);
  if (!r) return;
  io.to(`host:${code}`).emit('state', hostView(r));
  io.to(`room:${code}`).emit('room', roomView(r));
  io.to(`screen:${code}`).emit('screen', screenView(r));
}
function log(code, msg) {
  console.log(`[${new Date().toISOString()}] [${code}] ${msg}`);
}

function endGame(r, reason) {
  q.setStatus.run('ended', now(), now(), r.code);
  purgePhotos(r.code);
  log(r.code, `game ended (${reason}) — uploaded photos deleted`);
  pushNow(r.code);
  const confirmed = standings(getRoom(r.code)).filter((w) => w.place).length;
  io.to(`room:${r.code}`).to(`screen:${r.code}`).to(`host:${r.code}`).emit('fx', { type: 'end', reason, winners: confirmed });
}
// Auto-stop once the first N valid finishers are all confirmed (a still-unchecked earlier claim holds it open).
function checkAutoStop(code) {
  const r = getRoom(code);
  if (!r || r.status !== 'live' || !r.stop_after) return;
  let confirmed = 0;
  for (const w of standings(r)) {
    if (w.status === 'pending') return;
    if (w.place && ++confirmed >= r.stop_after) return endGame(r, 'auto');
  }
}
// A confirmed winner: big celebration on the screen, the player's own "you're #n", and the first 20 for everyone.
function announceWinner(r, playerId) {
  const labels = labelMap(q.players.all(r.code));
  const w = standings(r, labels).find((x) => x.playerId === playerId);
  if (!w || !w.place) return;
  const fx = { type: 'winner', kind: w.kind, name: w.name, place: w.place, playerId };
  io.to(`host:${r.code}`).to(`p:${playerId}`).to(`screen:${r.code}`).emit('fx', fx);
  if (w.place <= 20) io.to(`room:${r.code}`).except(`p:${playerId}`).emit('fx', fx);
  log(r.code, `WINNER #${w.place}: ${w.name}`);
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
    if (!r.display_key) { r.display_key = rid(12); q.setDisplayKey.run(r.display_key, r.code); }
    socket.data = { role: 'host', code: r.code };
    socket.join(`host:${r.code}`);
    ack(cb, { ok: true, state: hostView(r) });
  });
  socket.on('host:showPhotos', ({ on } = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    q.setShowPhotos.run(on ? 1 : 0, r.code);
    pushNow(r.code);
    ack(cb, { ok: true });
  });

  // ── Big screen (projector): view-only link ──
  socket.on('screen:auth', ({ code, key } = {}, cb) => {
    const r = getRoom(code);
    if (!r || !r.display_key || !safeEq(r.display_key, key)) return fail(cb, 'This big-screen link is not valid');
    socket.data = { role: 'screen', code: r.code };
    socket.join(`screen:${r.code}`);
    let photos = [];
    if (r.show_photos && r.status === 'live') {
      const players = Object.fromEntries(q.players.all(r.code).map((p) => [p.id, p]));
      photos = q.recentPhotos.all(r.code, 24).filter((m) => players[m.player_id]).map((m) => {
        const p = players[m.player_id];
        const card = p.card_json ? JSON.parse(p.card_json) : [];
        return { playerId: p.id, cell: m.cell, at: m.updated_at, prompt: card[m.cell] ? card[m.cell].t : '', with: m.name, player: p.name };
      });
    }
    ack(cb, { ok: true, state: screenView(r), photos });
  });
  socket.on('host:update', (body = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    if (r.status !== 'lobby') return fail(cb, 'Squares are locked once the game starts');
    const s = validateSettings(body);
    if (s.error) return fail(cb, s.error);
    q.updateSettings.run(s.title, s.size, s.free ? 1 : 0, JSON.stringify(s.prompts), s.winMode, s.verify ? 1 : 0, s.stopAfter, r.code);
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
    io.to(`room:${r.code}`).to(`screen:${r.code}`).emit('fx', { type: 'start' });
    log(r.code, `game started with ${players.length} players`);
    ack(cb, { ok: true });
  });
  socket.on('host:end', (_, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    if (r.status !== 'live') return fail(cb, 'The game is not running');
    endGame(r, 'host');
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
  socket.on('host:verify', ({ playerId, ok } = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    const c = q.claimOf.get(String(playerId), winKind(r));
    if (!c || c.room_code !== r.code) return fail(cb, 'That player has no bingo to check');
    if (c.status !== 'pending') return fail(cb, 'Already confirmed');
    if (ok) {
      q.setClaimStatus.run('verified', now(), c.id);
      announceWinner(r, c.player_id);
    } else {
      q.deleteClaim.run(c.id);
      io.to(`p:${c.player_id}`).emit('fx', { type: 'rejected' });
      log(r.code, `claim rejected for player ${c.player_id}`);
    }
    const p = q.player.get(c.player_id);
    if (p) io.to(`p:${p.id}`).emit('me', meView(p));
    pushHost(r.code, 0);
    pushRoom(r.code, 300); // batched for phones and the big screen
    ack(cb, { ok: true });
    checkAutoStop(r.code);
  });
  // The theme is only decoration, so it can change at any time — every phone and the big screen restyle live.
  socket.on('host:setTheme', ({ theme } = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    q.setTheme.run(cleanTheme(theme), r.code);
    pushNow(r.code);
    ack(cb, { ok: true });
  });
  socket.on('host:setStopAfter', ({ n } = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    q.setStopAfter.run(clampStop(n), r.code);
    pushNow(r.code);
    ack(cb, { ok: true });
    checkAutoStop(r.code);
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
  socket.on('host:photos', ({ limit } = {}, cb) => {
    const r = hostRoom(cb);
    if (!r) return;
    const players = Object.fromEntries(q.players.all(r.code).map((p) => [p.id, p]));
    const cards = {};
    const rows = q.recentPhotos.all(r.code, Math.min(200, Number(limit) || 40)).filter((m) => players[m.player_id]).map((m) => {
      const p = players[m.player_id];
      const card = cards[p.id] || (cards[p.id] = p.card_json ? JSON.parse(p.card_json) : []);
      return { playerId: p.id, cell: m.cell, at: m.updated_at, prompt: card[m.cell] ? card[m.cell].t : '', with: m.name, player: p.name };
    });
    ack(cb, { ok: true, photos: rows });
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
    const prev = q.mark.get(p.id, cell);
    // The photo flag is set by the upload itself; a mark can only keep or drop it.
    const keepPhoto = !!photo && !!prev && !!prev.photo;
    if (prev && prev.photo && !photo) deletePhoto(r.code, p.id, cell);
    if (nm || keepPhoto || photo) q.upsertMark.run(p.id, cell, nm, keepPhoto ? 1 : 0, now());
    else q.deleteMark.run(p.id, cell);
    const pr = progressOf(card, marksMap(p.id));
    progressCache.set(p.id, pr);
    // A finished card becomes a claim: 'pending' until the host checks it (or confirmed at once if checks are off).
    const kind = winKind(r);
    const done = kind === 'blackout' ? pr.filled === pr.total : pr.lines > 0;
    let claimed = false;
    if (done && q.insertBingo.run(r.code, p.id, kind, now(), r.verify ? 'pending' : 'verified').changes) {
      claimed = true;
      const order = q.countBingo.get(r.code, kind).c;
      const name = labelMap(q.players.all(r.code))[p.id] || p.name;
      const fx = { type: 'claim', kind, name, order, playerId: p.id, pending: !!r.verify };
      // Host, the player and the big screen hear every claim; other phones hear the first 20 (no pop-up storm at 300+).
      io.to(`host:${r.code}`).to(`p:${p.id}`).to(`screen:${r.code}`).emit('fx', fx);
      if (order <= 20) io.to(`room:${r.code}`).except(`p:${p.id}`).emit('fx', fx);
      log(r.code, `${kind.toUpperCase()} claim #${order}: ${name}${r.verify ? ' (waiting for host check)' : ''}`);
      if (!r.verify) announceWinner(r, p.id);
      pushRoom(r.code, 200);
    }
    pushHost(r.code);
    ack(cb, { ok: true, progress: pr });
    if (claimed && !r.verify) checkAutoStop(r.code);
  });
  socket.on('player:clearAll', (_, cb) => {
    const c = me(cb);
    if (!c) return;
    if (c.r.status !== 'live') return fail(cb, 'The game is not running');
    const card = c.p.card_json ? JSON.parse(c.p.card_json) : [];
    card.forEach((_, i) => deletePhoto(c.r.code, c.p.id, i)); // only this player's photos
    q.clearMarks.run(c.p.id);
    progressCache.delete(c.p.id);
    pushHost(c.r.code);
    ack(cb, { ok: true });
  });
});

server.listen(PORT, () => console.log(`Human Bingo rooms on http://localhost:${PORT}`));
