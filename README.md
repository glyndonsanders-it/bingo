# Find Someone Who… — Human Bingo with live rooms

A mingling bingo game for big groups. The host builds a card from fully editable categories, creates a room with a **short code (up to 5 letters/numbers)**, and puts the code and QR code on screen. Players join on their phones, find people who fit each square, add a name or photo, and call bingo when they complete a row, column or diagonal.

Tested with **300 and 600 simulated players in one room** (see *Scale* below).

## What's in it

**Host** (`/host`)
- **Customizable categories:** the four starter lists (Icebreakers, Team & work, Party, Classroom) are fully editable. You can rename them, change the card title, edit the squares, duplicate, delete, add new categories, restore the built-ins, and export or import them as a JSON file to use on another device. You can also save any squares you typed as a new category.
- Card size 3 × 3, 4 × 4 or 5 × 5, with an optional free center. If you add more squares than a card holds, every player gets a different shuffled card.
- **Room codes:** you get a random 5-character code (no look-alike characters such as 0/O or 1/I), or you can type your own (1–5 letters/numbers).
- A live dashboard with the code, a QR code, the join link, player counts (joined/online), every player's progress, and the bingo calls in the order the server received them. Tap any player to see their card.
- **Start / End / Resume.** Players who join before the start wait on a "get ready" screen. Late arrivals get a card immediately.
- Squares stay editable in the lobby and lock when the game starts. You can remove players. **Show on projector** gives a big-screen view of the code, QR and winners. You can still print paper cards.

**Players** (`/join/CODE`, or type the code on the home page)
- Same card and dialog as before: their name, a photo (camera or gallery), or both. Completed lines are highlighted, and Blackout is called when the whole card is full.
- Progress syncs to the server, so refreshing or losing signal doesn't lose the card. Changes made offline sync on reconnect.
- **Photos never leave the phone.** They're stored on the device (IndexedDB), and only a "has photo" flag is sent. **Save photos** exports captioned tiles to the share sheet or downloads.
- Everyone sees the first 20 bingo calls announced. Each player always sees their own place ("BINGO! You're #7").

## Run locally

Requires Node 22.5+ (uses the built-in `node:sqlite`).

```bash
npm install
npm start
```

Open http://localhost:3000.

| Env var | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `DATA_DIR` | `./data` | SQLite database (`bingo.db`) |
| `MAX_PLAYERS` | 600 | Per room |
| `ROOMS_PER_IP_PER_HOUR` | 40 | Room-creation limit per network |

## Deploy on Railway

The repo includes a `Dockerfile` and `railway.json` (health check `/healthz`, single replica).

1. In Railway, open your service and go to **Settings → Source → Connect Repo**, then choose this repository. Every push to `main` redeploys.
2. Optional, but recommended: add a **Volume** mounted at `/data` so rooms survive redeploys.
3. Under **Settings → Networking**, the service's public domain is the address players use.

Keep **one replica**: rooms and live updates run in a single process. That process handles hundreds of players easily (see below).

## Scale

`tests/load-test.js` simulates a join rush (about 50 phones/second), a game start, and every player filling the whole card over about 40 seconds:

| Players | Joins | Cards dealt | Square saves (p95 / max) | Peak server memory |
|---|---|---|---|---|
| 300 | 300/300 | 23 ms | 4 ms / 27 ms | ~120 MB |
| 600 | 600/600 | 49 ms | 10 ms / 61 ms | — |

The host dashboard and lobby counts are batched (at most a few updates per second), so a join rush doesn't flood phones.

```bash
BASE=http://localhost:3000 PLAYERS=300 node tests/load-test.js
```

```bash
BASE=http://localhost:3000 node tests/e2e.js
```

The second command is the browser flow test and needs `playwright`.
