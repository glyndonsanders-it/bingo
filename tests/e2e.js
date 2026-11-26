// Browser E2E: custom category → room with custom 5-char code → 3 phones join → start → play → bingo → host review → end.
// Usage: BASE=http://localhost:3000 node tests/e2e.js   (needs `playwright` installed)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const ok = (m) => console.log('  ✓ ' + m);
const errors = [];
const CODE = (process.env.CODE || 'T' + Math.random().toString(36).slice(2, 6)).toUpperCase().slice(0, 5);

(async () => {
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const watch = (p, tag) => p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  const hctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const hp = await hctx.newPage();
  watch(hp, 'host');
  hp.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'My saved list' : undefined));

  console.log('▶ Host edits categories');
  await hp.goto(BASE + '/host');
  await hp.click('#manageCats');
  await hp.click('#catNew');
  await hp.fill('#cName', 'Youth Night');
  await hp.fill('#cTitle', 'Youth Night Bingo');
  const squares = Array.from({ length: 12 }, (_, i) => `Custom square ${i + 1}`);
  await hp.fill('#cSquares', squares.join('\n'));
  await hp.click('#catList button:has-text("Party")');
  await hp.fill('#cName', 'Party (edited)');
  await hp.click('#catList button:has-text("Youth Night")');
  await hp.click('#catUse');
  assert.strictEqual(await hp.inputValue('#title'), 'Youth Night Bingo');
  const chips = await hp.$$eval('#chips button', (b) => b.map((x) => x.textContent.trim()));
  assert(chips.some((c) => c.startsWith('Youth Night')) && chips.some((c) => c.startsWith('Party (edited)')), chips.join('|'));
  ok(`categories: ${chips.join(' | ')}`);
  await hp.reload();
  assert((await hp.$$eval('#chips button', (b) => b.map((x) => x.textContent))).some((t) => t.includes('Youth Night')));
  ok('custom categories survive a reload');

  console.log('▶ Create a 3×3 room with a custom code');
  await hp.selectOption('#size', '3');
  await hp.check('#free');
  await hp.fill('#customCode', CODE.toLowerCase());
  await hp.click('#createBtn');
  await hp.waitForSelector('#roomv:not([hidden])');
  assert.strictEqual(await hp.textContent('#bigCode'), CODE);
  assert(hp.url().includes(`/host/${CODE}#k=`));
  ok(`room ${CODE} created; join link ${await hp.textContent('#joinUrl')}`);
  await hp.screenshot({ path: `${OUT}/01-host-room.png` });

  console.log('▶ Big screen opens as its own page (view-only)');
  const [sp] = await Promise.all([hctx.waitForEvent('page'), hp.click('#projBtn')]);
  watch(sp, 'screen');
  await sp.setViewportSize({ width: 1920, height: 1080 });
  await sp.waitForSelector('#lobbyV.on');
  assert.strictEqual(await sp.textContent('#lobbyV [data-code]'), CODE);
  await sp.waitForFunction(() => { const i = document.querySelector('#qrL'); return i.complete && i.naturalWidth > 0; });
  assert(!(await sp.$('#startBtn, #prompts, #plist')), 'no host controls on the big screen');
  const screenKey = new URL(sp.url()).hash.slice(3);
  const escalate = await sp.evaluate(([c, k]) => new Promise((res) => io().emit('host:auth', { code: c, key: k }, (r) => res(r))), [CODE, screenKey]);
  assert(!escalate.ok, 'big-screen key must not unlock host controls');
  ok('big screen: code + QR, no controls; its link can’t be used as a host link');

  console.log('▶ Three phones join');
  const P = [];
  for (const [i, nm] of ['Ana', 'Ben', 'Cara'].entries()) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const p = await ctx.newPage();
    watch(p, nm);
    if (i === 0) { await p.goto(BASE); await p.fill('#code', CODE.toLowerCase()); await p.click('button:has-text("Join room")'); }
    else await p.goto(`${BASE}/join/${CODE}`);
    await p.fill('#name', nm);
    await p.click('#go');
    await p.waitForSelector('#wait:not([hidden])');
    P.push(p);
  }
  await hp.waitForFunction(() => document.querySelector('#sPlayers').textContent === '3');
  await P[0].waitForFunction(() => /3 players/.test(document.querySelector('#waitCount').textContent), null, { timeout: 5000 });
  ok('host sees 3 players; phones see the lobby count');
  await sp.waitForFunction(() => document.querySelectorAll('#names span').length === 3 && document.querySelector('#lobbyV [data-count]').textContent === '3');
  ok(`big screen shows the names joining: ${await sp.$$eval('#names span', (n) => n.map((x) => x.textContent).join(', '))}`);
  await sp.screenshot({ path: `${OUT}/10-screen-lobby.png` });
  await P[0].screenshot({ path: `${OUT}/02-phone-wait.png` });

  console.log('▶ Start → cards dealt');
  await hp.click('#startBtn');
  await Promise.all(P.map((p) => p.waitForSelector('#play:not([hidden]) #grid .cell')));
  const cells = await P[0].$$eval('#grid .cell', (c) => c.map((x) => x.textContent));
  assert.strictEqual(cells.length, 9);
  assert(cells[4].includes('Free'));
  assert(cells.filter((t) => t.startsWith('Custom square')).length === 8);
  ok('3×3 card with free center, all from the custom category');
  assert(await hp.$('#prompts[disabled]'));
  ok('squares locked on the host after start');

  await sp.waitForSelector('#liveV.on');
  ok('big screen switched to the live view');

  console.log('▶ Ana fills the top row: tap → photo picker first → then the name → BINGO');
  const photo = path.join(OUT, 'photo.png');
  await hp.screenshot({ path: photo, clip: { x: 0, y: 0, width: 400, height: 300 } });
  const p0 = P[0];
  // tap an empty square: the photo picker opens right away; pick a photo (or none), then the name box follows
  async function tapFill(p, i, name, withPhoto) {
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click(`#grid .cell[data-i="${i}"]`)]);
    assert(!(await p.$('#dlg[open]')), 'the picker comes before the name dialog');
    await fc.setFiles(withPhoto ? photo : []);
    await p.waitForSelector('#dlg[open]');
    if (withPhoto) {
      await p.waitForSelector('#pv:not([hidden])');
      assert.strictEqual(await p.textContent('#dsub'), 'Nice shot! Now type their name.');
    }
    assert.strictEqual(await p.evaluate(() => document.activeElement.id), 'dn');
    await p.fill('#dn', name);
    await p.click('#ds');
  }
  await tapFill(p0, 0, 'Ben', true);
  ok('empty square → photo picker immediately → name box (focused) with the photo shown');
  await p0.screenshot({ path: `${OUT}/02b-phone-photo-then-name.png` });
  await tapFill(p0, 1, 'Cara', true);
  await tapFill(p0, 2, 'Dee', false);
  ok('closing the picker without a photo still goes to the name box');
  await p0.click('#grid .cell[data-i="0"]');
  await p0.waitForSelector('#dlg[open]');
  assert.strictEqual(await p0.inputValue('#dn'), 'Ben');
  await p0.click('#dc');
  ok('tapping a filled square opens it for checking (no picker)');
  console.log('▶ Ana finishes → “checking” until the host confirms');
  await p0.waitForSelector('#banner:has-text("The host is checking your card")');
  ok('Ana: “BINGO! The host is checking your card”');
  await P[1].waitForSelector('.toast:has-text("Ana called BINGO")');
  ok('other phones: “🔔 Ana called BINGO!”');
  await hp.waitForSelector('#wins li.pend:has-text("Ana")');
  assert(await hp.$('#checkNote:not([hidden])'));
  ok('host: Ana is waiting for a check');
  await sp.waitForSelector('#checking:not([hidden]):has-text("Ana")');
  assert(await sp.$('#celebrate[hidden]'), 'no celebration before the host confirms');
  ok('big screen: “Checking: Ana”, no celebration yet');
  await p0.screenshot({ path: `${OUT}/03-phone-checking.png` });

  console.log('▶ Host hides photos from the big screen');
  await hp.uncheck('#wallProj');
  await sp.waitForSelector('#liveV.nophotos');
  const sImg = await sp.evaluate(() => { const f = document.querySelector('#wall img'); return f ? f.src : null; });
  const ssrc = await sp.evaluate(() => location.hash);
  const blocked = await sp.evaluate(([c, d]) => fetch(`/photo/${c}/x/0.jpg?d=${d}`).then((r) => r.status), [CODE, ssrc.slice(3)]);
  assert.strictEqual(blocked, 403);
  ok('photo wall hidden on the big screen, and its link can no longer load photos (403)');
  void sImg;
  await hp.check('#wallProj');
  await sp.waitForFunction(() => !document.querySelector('#liveV').classList.contains('nophotos') && document.querySelectorAll('#wall img').length === 2);
  ok('turned back on: photos return');

  console.log('▶ Photo wall + save card on the phone');
  await hp.waitForFunction(() => { const i = document.querySelector('#wall figure img'); return i && i.complete && i.naturalWidth > 0; });
  ok(`host photo wall: ${await hp.textContent('#wall figcaption')}`);
  await p0.click('#save');
  await p0.waitForFunction(() => [...document.querySelectorAll('#saveList img')].filter((i) => i.complete && i.naturalWidth > 0).length === 3);
  const dims = await p0.$eval('#saveList img', (i) => [i.naturalWidth, i.naturalHeight]);
  ok(`save screen: whole-card picture (${dims.join('×')}) + 2 photo tiles, press-and-hold to save`);
  await p0.screenshot({ path: `${OUT}/03b-phone-save.png` });
  await p0.click('#saveClose');

  console.log('▶ Refresh keeps names + photo');
  await p0.reload();
  await p0.waitForSelector('#grid .cell.has');
  const names = await p0.$$eval('#grid .nm', (n) => n.map((x) => x.textContent));
  assert.deepStrictEqual(names, ['Ben', 'Cara', 'Dee']);
  ok('after reload: 3 names and the photo are still there');
  await p0.waitForSelector('#banner:has-text("checking your card")');
  ok('after reload the “checking” banner comes back');

  console.log('▶ Host opens Ana’s card and confirms it');
  await hp.click('#wins li:has-text("Ana") .chk');
  await hp.waitForSelector('#cardDlg[open] #cardGrid .cell');
  const hostNames = await hp.$$eval('#cardGrid .nm', (n) => n.map((x) => x.textContent));
  assert.deepStrictEqual(hostNames, ['Ben', 'Cara', 'Dee']);
  await hp.waitForFunction(() => { const i = document.querySelector('#cardGrid img.ph'); return i && i.complete && i.naturalWidth > 0; });
  ok('host sees Ana’s names and her photo');
  await hp.click('#cardGrid .ph-cell >> nth=0');
  await hp.waitForSelector('.lightbox img');
  await hp.screenshot({ path: `${OUT}/04b-host-lightbox.png` });
  await hp.click('.lightbox');
  assert(await hp.$('#verifyBar:not([hidden])'));
  await hp.screenshot({ path: `${OUT}/04-host-card.png` });
  await hp.click('#verifyYes');
  await p0.waitForSelector('#banner:has-text("Confirmed! You’re winner #1")');
  ok('Ana: “✓ Confirmed! You’re winner #1”');
  await P[1].waitForSelector('.toast:has-text("Ana is winner #1")');
  ok('other phones: “🎉 Ana is winner #1!”');
  await sp.waitForSelector('#celebrate:not([hidden]) .who:has-text("Ana")');
  await sp.waitForTimeout(900);
  await sp.screenshot({ path: `${OUT}/11-screen-bingo.png` });
  ok('big screen: full-screen “BINGO! Ana — ✓ Confirmed · 1st place”');
  await sp.waitForSelector('#celebrate', { state: 'hidden', timeout: 8000 });
  assert((await sp.textContent('#wl')).includes('Ana'));
  await sp.screenshot({ path: `${OUT}/12-screen-live.png` });

  console.log('▶ Auto-stop after 2 winners; a wrong card is rejected and fixed first');
  await hp.fill('#stopAfter', '2');
  await hp.$eval('#stopAfter', (el) => el.dispatchEvent(new Event('change')));
  await hp.waitForSelector('#stopHint:has-text("first 2 finishers")');
  ok(`host: ${await hp.textContent('#stopHint')}`);
  const pc = P[2];
  for (const [i, nm] of [[0, 'X'], [1, 'Y'], [2, 'Z']]) await tapFill(pc, i, nm, false);
  await pc.waitForSelector('#banner:has-text("checking your card")');
  await hp.click('#wins li.pend:has-text("Cara") .chk');
  await hp.waitForSelector('#verifyBar:not([hidden])');
  await hp.click('#verifyNo');
  await pc.waitForSelector('#banner.bad:has-text("couldn’t confirm your card")');
  ok('host marks Cara’s card not valid → Cara is told to fix it');
  assert(!(await hp.$('#wins li:has-text("Cara")')), 'rejected claim is removed');
  await pc.click('#grid .cell[data-i="0"]');
  await pc.waitForSelector('#dlg[open]');
  await pc.fill('#dn', 'Fixed name');
  await pc.click('#ds');
  await pc.waitForSelector('#banner:has-text("checking your card")');
  ok('Cara fixes a square → checked again');
  await hp.click('#wins li.pend:has-text("Cara") .chk');
  await hp.waitForSelector('#verifyBar:not([hidden])');
  const anaPhoto = await hp.getAttribute('#wall figure img', 'src');
  await hp.click('#verifyYes');
  await P[1].waitForSelector('.toast:has-text("We have our 2 winners")');
  ok('2nd winner confirmed → the game ended by itself: “We have our 2 winners — game over!”');
  await P[1].waitForSelector('#banner:has-text("Game over — Winners: #1 Ana · #2 Cara")');
  ok('phones: “Game over — Winners: #1 Ana · #2 Cara”');
  await hp.waitForSelector('#statusPill:has-text("Ended")');
  await hp.waitForSelector('#wall:has-text("photos were deleted")');
  const gone = await hp.evaluate((u) => fetch(u, { cache: 'no-store' }).then((r) => r.status), anaPhoto);
  assert.strictEqual(gone, 404);
  ok('photos deleted from the server when the game ended (404), wall cleared');
  assert.strictEqual(await p0.$$eval('#grid .cell.has', (c) => c.length), 2);
  ok('Ana still has her own photos on her phone');
  await sp.waitForSelector('#endV.on .podium .p1:has-text("Ana")');
  assert((await sp.textContent('#podium')).includes('Cara'));
  await sp.screenshot({ path: `${OUT}/13-screen-ended.png` });
  ok('big screen: “Game over!” podium — #1 Ana, #2 Cara');
  await hp.screenshot({ path: `${OUT}/05-host-ended.png` });
  await P[2].screenshot({ path: `${OUT}/06-phone-ended.png` });

  console.log('▶ Blackout mode, no host check, manual end');
  const sq = Array.from({ length: 8 }, (_, i) => `Thing ${i + 1}`);
  const room2 = await hp.evaluate((sq) => fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Blackout test', size: 3, free: true, winMode: 'blackout', verify: false, prompts: sq }) }).then((r) => r.json()), sq);
  await hp.goto(`${BASE}/host/${room2.code}#k=${room2.hostKey}`);
  await hp.waitForSelector('#roomv:not([hidden])');
  assert.strictEqual(await hp.inputValue('#winMode'), 'blackout');
  assert(!(await hp.isChecked('#verify')));
  const pb = P[1];
  await pb.goto(`${BASE}/join/${room2.code}`);
  await pb.fill('#name', 'Ben');
  await pb.click('#go');
  await pb.waitForSelector('#waitMode:has-text("fill EVERY square")');
  await hp.click('#startBtn');
  await pb.waitForSelector('#grid .cell');
  const order = [0, 1, 2, 3, 5, 6, 7, 8];
  for (const [n, i] of order.entries()) {
    await tapFill(pb, i, 'Person ' + i, false);
    if (n === 2) {
      await pb.waitForTimeout(500);
      assert(await pb.$('#banner[hidden]'), 'a single line must not win in blackout mode');
      ok('one complete line does not win in blackout mode');
    }
  }
  await pb.waitForSelector('#banner:has-text("Confirmed! You’re winner #1")');
  await hp.waitForSelector('#wins li:has-text("Ben")');
  assert.strictEqual(await hp.textContent('#winsH'), 'Blackout calls');
  ok('with checks off: full card → straight to “Confirmed! You’re winner #1”');
  await hp.click('#endBtn');
  await pb.waitForSelector('#banner:has-text("Game over")');
  ok('manual End game still works');

  console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'No page errors.');
  await browser.close();
  console.log('E2E PASSED');
})().catch((e) => { console.error('FAILED', e); console.log(errors.join('\n')); process.exit(1); });
