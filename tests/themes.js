// Theme check: for each party theme, screenshot a phone card, the big-screen lobby and the live big screen.
// Also checks that switching the theme mid-game restyles phones and the big screen live.
// Usage: BASE=http://localhost:3000 node tests/themes.js   (needs `playwright`)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.join(__dirname, 'out', 'themes');
fs.mkdirSync(OUT, { recursive: true });
const THEMES = ['general', 'christmas', 'fun', 'team', 'youth', 'minimal'];
const errors = [];

(async () => {
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const prompts = ['Has a pet', 'Plays guitar', 'Born abroad', 'Loves karaoke', 'Can juggle', 'Early riser', 'Speaks 3 languages', 'Has a twin', 'Runs marathons', 'Bakes bread', 'Collects stamps', 'Knows sign language', 'Has been on TV', 'Loves spicy food', 'Reads every day', 'Has a tattoo', 'Is left-handed', 'Plays chess', 'Went camping', 'Can whistle', 'Hates coffee', 'Night owl', 'Has a garden', 'Sings in a choir'];
  for (const theme of THEMES) {
    const hctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const hp = await hctx.newPage();
    hp.on('pageerror', (e) => errors.push(`${theme} host: ${e.message}`));
    hp.on('dialog', (d) => d.accept());
    const room = await hp.evaluate(([b, t, p]) => fetch(b + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Youth Night Bingo', size: 5, free: true, theme: t, prompts: p }) }).then((r) => r.json()), [BASE, theme, prompts]).catch(async () => {
      await hp.goto(BASE);
      return hp.evaluate(([t, p]) => fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Youth Night Bingo', size: 5, free: true, theme: t, prompts: p }) }).then((r) => r.json()), [theme, prompts]);
    });
    await hp.goto(`${BASE}/host/${room.code}#k=${room.hostKey}`);
    await hp.waitForSelector('#roomv:not([hidden])');
    assert.strictEqual(await hp.evaluate(() => document.documentElement.dataset.party), theme);
    const [sp] = await Promise.all([hctx.waitForEvent('page'), hp.click('#projBtn')]);
    sp.on('pageerror', (e) => errors.push(`${theme} screen: ${e.message}`));
    await sp.setViewportSize({ width: 1920, height: 1080 });
    await sp.waitForSelector('#lobbyV.on');

    const phones = [];
    for (const nm of ['Ana', 'Ben', 'Cara', 'Dee', 'Eli']) {
      const ctx = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`${theme} ${nm}: ${e.message}`));
      await p.goto(`${BASE}/join/${room.code}`);
      await p.fill('#name', nm);
      await p.click('#go');
      await p.waitForSelector('#wait:not([hidden])');
      phones.push(p);
    }
    assert.strictEqual(await phones[0].evaluate(() => document.documentElement.dataset.party), theme);
    await sp.waitForFunction(() => document.querySelectorAll('#names span').length === 5);
    await sp.waitForTimeout(800);
    await sp.screenshot({ path: `${OUT}/${theme}-screen-lobby.png` });

    await hp.click('#startBtn');
    const p0 = phones[0];
    await p0.waitForSelector('#grid .cell');
    for (const i of [0, 1, 2, 3, 4, 6, 8]) {
      const [fc] = await Promise.all([p0.waitForEvent('filechooser'), p0.click(`#grid .cell[data-i="${i}"]`)]);
      await fc.setFiles([]);
      await p0.waitForSelector('#dlg[open]');
      await p0.fill('#dn', ['Maria', 'Jon', 'Lee', 'Sam', 'Kai', 'Ivy', 'Noah'][[0, 1, 2, 3, 4, 6, 8].indexOf(i)]);
      await p0.click('#ds');
    }
    await hp.waitForSelector('#wins li.pend');
    await hp.click('#wins li.pend .chk');
    await hp.click('#verifyYes');
    await sp.waitForSelector('#celebrate:not([hidden])');
    await sp.waitForTimeout(1200);
    await sp.screenshot({ path: `${OUT}/${theme}-screen-celebrate.png` });
    await sp.waitForSelector('#celebrate', { state: 'hidden', timeout: 9000 });
    await p0.waitForTimeout(400);
    await p0.screenshot({ path: `${OUT}/${theme}-phone.png` });
    await sp.screenshot({ path: `${OUT}/${theme}-screen-live.png` });
    await hp.screenshot({ path: `${OUT}/${theme}-host.png` });

    if (theme === 'general') {
      // switch theme mid-game: phones and the big screen restyle live
      await hp.click('.theme-opt[data-theme="christmas"]');
      await p0.waitForFunction(() => document.documentElement.dataset.party === 'christmas');
      await sp.waitForFunction(() => document.documentElement.dataset.party === 'christmas' && !!document.querySelector('.deco .flake'));
      console.log('  ✓ switching the theme mid-game restyles phones and the big screen live');
    }
    console.log(`  ✓ ${theme}`);
    await Promise.all(phones.map((p) => p.context().close()));
    await hctx.close();
  }
  console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'No page errors.');
  await browser.close();
  console.log('THEMES PASSED');
})().catch((e) => { console.error('FAILED', e); console.log(errors.join('\n')); process.exit(1); });
