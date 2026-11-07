// Cross-Store Owned — the badge engine (content/badges.js) with both adapters
// (content/steam.js, content/gog.js) in jsdom, on the same fixture pages the
// live check serves. Covers matching and placement, the popup's "On this page"
// answer, the toolbar count report, hidden badges, the per-store switches, the
// badge text setting, reused tiles, the Steam link fallback, the login hint and
// re-injection.
import fs from 'node:fs';
import path from 'node:path';
import { T, makeBrowserShim, makeDom } from '../../firefox-tools/harness/lib.mjs';

const manifest = JSON.parse(fs.readFileSync(T.extFile('manifest.json'), 'utf8'));
const fixture = (f) => fs.readFileSync(path.join(T.testsDir, 'fixtures', f), 'utf8');
const scriptsFor = (host) => manifest.content_scripts.filter((cs) => cs.matches.some((m) => m.includes(host))).flatMap((cs) => cs.js).map((f) => T.extFile(f));

// The same seeded match tables as harness.json.
const MAPS = {
  builtAt: 1,
  stats: {},
  forSteam: {
    apps: { 10: ['1001'], 11: ['1001'] },
    subs: { 777: ['1002'] },
    gogTitles: { 'the witcher 3 wild hunt': ['1002'] },
    gogInfo: {
      1001: { title: 'Cyberpunk 2077', url: 'https://www.gog.com/game/cyberpunk_2077' },
      1002: { title: 'The Witcher 3: Wild Hunt - Game of the Year Edition', url: 'https://www.gog.com/game/the_witcher_3_wild_hunt_game_of_the_year_edition' },
    },
  },
  forGog: {
    ids: { 1001: ['app/10'], 1001999: ['app/10'], 1002: ['sub/500'] },
    steamTitles: { 'the witcher 3 wild hunt': ['app/20'] },
    steamNames: { 10: 'Cyberpunk 2077', 20: 'The Witcher 3: Wild Hunt - Complete Edition' },
  },
};

const STEAM_URL = 'https://store.steampowered.com/app/10/Cyberpunk_2077/';
const GOG_URL = 'https://www.gog.com/en/games';

async function page({ site = 'steam', url = site === 'steam' ? STEAM_URL : GOG_URL, storage = {}, html = null, edit = null } = {}) {
  const shim = makeBrowserShim({ storage: { maps: structuredClone(MAPS), ...storage } });
  // runtime.sendMessage from a content script goes to the background; record and answer like it.
  const sent = [];
  shim.browser.runtime.sendMessage = async (m) => { sent.push(m); return m.type === 'ensureFresh' ? { refreshing: false } : { ok: true }; };
  let src = html ?? fixture(`${site}.html`);
  if (edit) src = edit(src);
  const dom = makeDom({ html: src, url, browser: shim.browser });
  const opened = [];
  dom.window.open = (u, target, features) => { opened.push({ u, target, features }); return null; };
  dom.runScripts(scriptsFor(site === 'steam' ? 'store.steampowered.com' : 'www.gog.com'));
  await T.sleep(40);
  const doc = dom.document;
  return {
    shim, dom, doc, win: dom.window, sent, opened,
    $: (sel) => doc.querySelector(sel),
    badges: () => doc.querySelectorAll('.cso-badge'),
    ask: () => shim.sendToBackground({ type: 'getPageMatches' }),
    // Write storage and fire onChanged, as Firefox does for every open store tab.
    async change(values) {
      const changes = {};
      for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: shim.store[k], newValue: v }; if (v === undefined) delete shim.store[k]; else shim.store[k] = v; }
      await shim.changeStorage(changes);
      await T.sleep(20);
    },
    counts: () => sent.filter((m) => m.type === 'pageCount').map((m) => m.count),
  };
}

const wait = async (cond, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await T.sleep(20); } return false; };

/* ---------------------------------------------------------------- Steam */

T.runAsync('Steam: badges on owned tiles, counts, titles, pill and nothing on unowned', async () => {
  const p = await page();
  T.eq(p.doc.documentElement.getAttribute('data-cross-store-owned'), 'gog', 'marked once per document');
  T.eq(p.badges().length, 8, 'rows 10/55, capsule 11, bundle, package, nested once, pill, React link');
  T.eq(p.doc.querySelectorAll('.cso-badge--fuzzy').length, 1);
  T.ok(p.$('#appHubAppName').nextElementSibling.classList.contains('cso-badge--expanded'), 'pill after the page title');
  T.eq(p.$('#appHubAppName').textContent, 'Cyberpunk 2077', 'title text untouched');
  T.eq(p.$('#bundle .cso-badge__count').textContent, '2/3');
  T.ok(p.$('#package .cso-badge'), 'package badge');
  T.eq(p.$('[data-ds-appid="999"] .cso-badge'), null, 'unowned row');
  T.eq(p.doc.querySelectorAll('#nested .cso-badge').length, 1, 'nested wrapper badged once');
  const row = p.$('a.search_result_row[data-ds-appid="10"] .cso-badge');
  T.eq(row.dataset.url, 'https://www.gog.com/game/cyberpunk_2077');
  T.eq(row.title, 'Owned on GOG: Cyberpunk 2077');
  T.eq(row.getAttribute('aria-label'), 'Owned on GOG: Cyberpunk 2077. Opens GOG in a new tab.');
  T.eq(row.getAttribute('role'), 'link');
  T.eq(row.tabIndex, 0);
  T.eq(row.querySelector('.cso-badge__letter').textContent, 'G');
  const fuzzy = p.$('a[data-ds-appid="55"] .cso-badge');
  T.eq(fuzzy.title, 'Owned on GOG (title match): The Witcher 3: Wild Hunt - Game of the Year Edition\nMatched by name, not by store ID — it may be a different edition.');
  T.eq(p.$('#bundle .cso-badge').title, 'Owned on GOG: 2 of 3: Cyberpunk 2077');
  T.ok(/^Owned on GOG: Cyberpunk 2077$/.test(p.$('.cso-badge--expanded .cso-badge__text').textContent));
});

T.runAsync('Steam: React-style image links get a badge; text links, unowned and other hosts do not', async () => {
  const p = await page();
  T.ok(p.$('#link-owned .cso-badge'), 'image link to an owned app');
  T.eq(p.$('#link-owned .cso-badge').title, 'Owned on GOG: Cyberpunk 2077');
  T.eq(p.$('#link-unowned .cso-badge'), null);
  T.eq(p.$('#link-text .cso-badge'), null, 'text-only link');
  T.eq(p.$('#link-community .cso-badge'), null, 'steamcommunity.com link');
  // A link inside a data-ds tile is the tile's business, not the fallback's.
  const tile = p.$('.tile[data-ds-appid="11"]');
  const inner = p.doc.createElement('a');
  inner.href = '/app/11/';
  inner.append(p.doc.createElement('img'));
  tile.append(inner);
  await T.sleep(200);
  T.eq(tile.querySelectorAll('.cso-badge').length, 1, 'no second badge from an inner link');
});

T.runAsync('Steam: late tiles are badged; a tile reused for another game is re-badged', async () => {
  const p = await page();
  const a = p.doc.createElement('a');
  a.setAttribute('data-ds-appid', '11');
  a.href = '#';
  a.textContent = 'Late tile';
  p.$('#late').append(a);
  T.ok(await wait(() => a.querySelector('.cso-badge')), 'MutationObserver picked it up');

  const row = p.$('a.search_result_row[data-ds-appid="999"]');
  row.setAttribute('data-ds-appid', '11');
  T.ok(await wait(() => row.querySelector('.cso-badge')), 'now an owned game');
  row.setAttribute('data-ds-appid', '999');
  T.ok(await wait(() => !row.querySelector('.cso-badge')), 'back to unowned: badge removed');
  T.eq(row.getAttribute('data-cso-key'), null);

  const link = p.$('#link-unowned');
  link.setAttribute('href', '/app/10/');
  T.ok(await wait(() => link.querySelector('.cso-badge')), 'href change re-checked');
});

T.runAsync('Steam: clicking or pressing Enter opens the GOG page without following the tile', async () => {
  const p = await page();
  let followed = 0;
  const tile = p.$('a.search_result_row[data-ds-appid="10"]');
  tile.addEventListener('click', () => { followed++; });
  const badge = tile.querySelector('.cso-badge');
  badge.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  T.eq(p.opened, [{ u: 'https://www.gog.com/game/cyberpunk_2077', target: '_blank', features: 'noopener' }]);
  T.eq(followed, 0, 'tile click handler not reached');
  p.dom.key('Enter', {}, badge);
  T.eq(p.opened.length, 2, 'Enter opens too');
  badge.dispatchEvent(new p.win.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
  T.eq(p.opened.length, 2, 'right button does not open');
  badge.dispatchEvent(new p.win.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  T.eq(p.opened.length, 3, 'middle button opens');
});

T.runAsync('Steam: "On this page" answer lists each game once, sorted, with ids the popup can hide', async () => {
  const p = await page();
  const r = await p.ask();
  T.eq(r.ok, true);
  T.eq(r.site, 'steam');
  T.eq(r.otherLabel, 'GOG');
  T.eq(r.enabled, true);
  T.eq(r.mapsReady, true);
  T.eq(r.items.map((i) => i.id), ['steam:app/10,app/11,app/12,sub/1390270', 'steam:app/10', 'steam:app/11', 'steam:sub/777', 'steam:app/55']);
  T.eq(r.items.map((i) => i.title), ['Bundle', 'Cyberpunk 2077', 'Cyberpunk 2077 — Phantom Liberty', 'Package 777', 'The Witcher 3: Wild Hunt']);
  const w = r.items.find((i) => i.id === 'steam:app/55');
  T.eq([w.via, w.hidden, w.url], ['title', false, 'https://www.gog.com/game/the_witcher_3_wild_hunt_game_of_the_year_edition']);
  T.eq(w.others, [{ title: 'The Witcher 3: Wild Hunt - Game of the Year Edition', url: 'https://www.gog.com/game/the_witcher_3_wild_hunt_game_of_the_year_edition' }]);
  const b = r.items[0];
  T.eq([b.owned, b.total], [2, 3]);
  T.eq((await p.shim.sendToBackground({ type: 'nope' })).ok, false, 'unknown messages answered');
});

T.runAsync('Steam: the toolbar count is reported once the page settles, and again when it changes', async () => {
  const p = await page();
  T.ok(await wait(() => p.counts().length >= 1), 'reported');
  T.eq(p.counts(), [5]);
  T.eq(p.sent.find((m) => m.type === 'pageCount').site, 'steam');
  const a = p.doc.createElement('a');
  a.setAttribute('data-ds-appid', '777');   // not owned as an app → no change in count
  p.$('#late').append(a);
  await T.sleep(700);
  T.eq(p.counts(), [5], 'unchanged count not resent');
  const b = p.doc.createElement('a');
  b.setAttribute('data-ds-packageid', '777');
  b.id = 'pkg-late';
  p.$('#late').append(b);
  await T.sleep(700);
  T.eq(p.counts(), [5], 'same game as an existing entry');
  p.$('#bundle').remove();
  T.ok(await wait(() => p.counts().length === 2));
  T.eq(p.counts().at(-1), 4, 'removed tile no longer counted');
});

T.runAsync('Steam: hidden badges disappear everywhere on the page and stay listed as hidden', async () => {
  const p = await page();
  await p.change({ hidden: ['steam:app/10', 'gog:1001'] });
  T.eq(p.$('a.search_result_row[data-ds-appid="10"] .cso-badge'), null, 'row');
  T.eq(p.$('#nested .cso-badge'), null, 'nested');
  T.eq(p.$('.cso-badge--expanded'), null, 'page pill (same game)');
  T.ok(p.$('.tile[data-ds-appid="11"] .cso-badge'), 'other games untouched');
  const r = await p.ask();
  T.eq(r.items.find((i) => i.id === 'steam:app/10').hidden, true);
  T.ok(await wait(() => p.counts().at(-1) === 4), `count excludes hidden (${p.counts()})`);
  await p.change({ hidden: [] });
  T.ok(p.$('a.search_result_row[data-ds-appid="10"] .cso-badge'), 'shown again');
});

T.runAsync('Steam: settings — off for Steam, store-name text, no title matching, colours', async () => {
  const p = await page({ storage: { settings: { showOnSteam: false } } });
  T.eq(p.badges().length, 0, 'switched off');
  const r = await p.ask();
  T.eq([r.enabled, r.items], [false, []]);
  T.ok(await wait(() => p.counts().length === 1));
  T.eq(p.counts(), [0]);

  await p.change({ settings: { showOnSteam: true, badgeText: 'name', matchByTitle: false, gogColor: '#ff0000' } });
  T.eq(p.badges().length, 7, 'back on, minus the title match');
  T.eq(p.doc.querySelectorAll('.cso-badge--fuzzy').length, 0);
  const row = p.$('a.search_result_row[data-ds-appid="10"] .cso-badge');
  T.eq(row.querySelector('.cso-badge__letter').textContent, 'GOG');
  T.ok(row.classList.contains('cso-badge--name'));
  T.eq(p.doc.documentElement.style.getPropertyValue('--cso-gog'), '#ff0000');
  await p.change({ settings: { gogColor: 'javascript:alert(1)' } });
  T.eq(p.doc.documentElement.style.getPropertyValue('--cso-gog'), '#7b2fbe', 'invalid colour → default');
});

T.runAsync('Steam: new or removed maps redraw; corrupt maps draw nothing and do not throw', async () => {
  const p = await page({ storage: { maps: 'garbage' } });
  T.eq(p.badges().length, 0);
  T.eq((await p.ask()).mapsReady, false);
  await p.change({ maps: structuredClone(MAPS) });
  T.eq(p.badges().length, 8);
  await p.change({ maps: undefined });
  T.eq(p.badges().length, 0, 'cleared');
});

T.runAsync('Steam: ensureFresh says whether the page shows the user logged in', async () => {
  const out = await page();
  T.eq(out.sent.find((m) => m.type === 'ensureFresh'), { type: 'ensureFresh', loggedInOn: null }, 'login link → not logged in');
  const inn = await page({ edit: (h) => h.replace('<div id="global_actions">', '<div id="global_actions"><span id="account_pulldown">Someone</span>') });
  T.eq(inn.sent.find((m) => m.type === 'ensureFresh').loggedInOn, 'steam');
});

T.runAsync('Steam: a second injection does not attach twice', async () => {
  const p = await page();
  p.dom.runScripts(scriptsFor('store.steampowered.com'));
  await T.sleep(60);
  T.eq(p.badges().length, 8);
  T.eq(p.sent.filter((m) => m.type === 'ensureFresh').length, 1);
});

/* ---------------------------------------------------------------- GOG */

T.runAsync('GOG: badges on covers, the game-page pill, title match, unowned none', async () => {
  const p = await page({ site: 'gog' });
  T.eq(p.doc.documentElement.getAttribute('data-cross-store-owned'), 'steam');
  T.eq(p.badges().length, 5, 'pill, 1001, 2000 (title), rendered 1002, nav 1001999');
  T.eq(p.doc.querySelectorAll('.cso-badge--fuzzy').length, 1);
  const pill = p.$('h1.productcard-basics__title').nextElementSibling;
  T.ok(pill.classList.contains('cso-badge--expanded'));
  T.eq(pill.title, 'Owned on Steam: Steam package 500');
  const cover = p.$('[data-product-id="1001"] .product-tile__image-wrapper > .cso-badge');
  T.ok(cover && cover.classList.contains('cso-tr') && cover.classList.contains('cso-badge--overlay'), 'top-right of the cover');
  T.eq(cover.dataset.url, 'https://store.steampowered.com/app/10/');
  T.eq(cover.title, 'Owned on Steam: Cyberpunk 2077');
  T.eq(cover.querySelector('.cso-badge__letter').textContent, 'S');
  T.ok(p.$('[data-product-id="2000"] .cso-badge').classList.contains('cso-badge--fuzzy'));
  T.eq(p.$('[data-product-id="3000"] .cso-badge'), null);
  T.eq(p.$('#unrendered').hasAttribute('data-cso-done'), false, '{{ }} placeholder not marked');
});

T.runAsync('GOG: an interpolated placeholder is badged; the answer uses gog: ids', async () => {
  const p = await page({ site: 'gog' });
  p.$('#unrendered').setAttribute('product-tile-id', '1001');
  T.ok(await wait(() => p.$('#unrendered .cso-badge')));
  const r = await p.ask();
  T.eq(r.site, 'gog');
  T.eq(r.otherLabel, 'Steam');
  T.eq(r.items.map((i) => i.id).sort(), ['gog:1001', 'gog:1001999', 'gog:1002', 'gog:2000']);
  await p.change({ settings: { showOnGog: false } });
  T.eq(p.badges().length, 0, 'GOG switch');
  await p.change({ settings: { showOnGog: true, showOnSteam: false, badgeText: 'name' } });
  T.eq(p.badges().length, 6, 'Steam switch does not affect GOG pages');
  T.eq(p.$('[data-product-id="1001"] .cso-badge__letter').textContent, 'Steam');
  T.eq(p.sent.find((m) => m.type === 'ensureFresh').loggedInOn, null, 'GOG adapter does not guess login');
});

await T.exit();
