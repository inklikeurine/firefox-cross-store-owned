// Cross-Store Owned — background.js under the browser.* shim with a fake fetch.
// Covers the refresh path end to end (Steam session/API modes, GOG, the four
// IsThereAnyDeal lookups, batching, caching, per-store failure), every
// message type, ensureFresh's throttling, the alarm schedule, and corrupt
// storage.
import fs from 'node:fs';
import vm from 'node:vm';
import { T, loadScript, makeBrowserShim } from '../../firefox-tools/harness/lib.mjs';

const DAY = 86400e3;

// ---------------------------------------------------------------- fake network

// A fetch() that routes by URL prefix and records every call. Handlers get
// (url, init) and return { status?, type?, body } or throw to simulate a
// network failure.
function makeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`no route for ${url}`);
    const r = await hit[1](url, init);
    const status = r.status ?? 200;
    const type = r.type ?? 'application/json';
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : h.toLowerCase() === 'retry-after' ? r.retryAfter ?? null : null) },
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return { fetch, calls, itadCalls: () => calls.filter((c) => c.url.includes('isthereanydeal')), to: (s) => calls.filter((c) => c.url.includes(s)) };
}

// JWT with { sub } in the payload, the way the Steam store hands it out.
const jwt = (sub) => `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`;

// The library the tests work with: Steam owns apps 10, 20, 30 and package 500;
// GOG owns 1001, 1002, 1003. IsThereAnyDeal groups 10/1001 (game A), 20 (B),
// sub/500→1002 (C), 1002 (D); 30 and 1003 are unknown to it.
function happyRoutes(overrides = {}) {
  return {
    'https://store.steampowered.com/dynamicstore/userdata/': () => ({ body: { rgOwnedApps: [10, 20, 30], rgOwnedPackages: [500] } }),
    'https://store.steampowered.com/pointssummary/ajaxgetasyncconfig': () => ({ body: { success: 1, data: { webapi_token: jwt('76561198000000001') } } }),
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/': () => ({
      body: { response: { games: [{ appid: 10, name: 'Cyberpunk 2077™' }, { appid: 20, name: 'The Witcher 3: Wild Hunt - Complete Edition' }] } },
    }),
    'https://www.gog.com/user/data/games': () => ({ body: { owned: [1001, 1002, 1003] } }),
    'https://www.gog.com/account/getFilteredProducts': (url) => {
      const hidden = /hiddenFlag=1/.test(url);
      return {
        body: hidden
          ? { totalPages: 1, products: [{ id: 1003, title: 'Blade Runner: The Final Cut', url: '/en/game/blade_runner' }] }
          : {
            totalPages: 1,
            products: [
              { id: 1001, title: 'Cyberpunk 2077', url: '/game/cyberpunk_2077' },
              { id: 1002, title: 'The Witcher 3: Wild Hunt – Game of the Year Edition', url: 'https://www.gog.com/game/the_witcher_3_wild_hunt_game_of_the_year_edition' },
            ],
          },
      };
    },
    'https://api.isthereanydeal.com/lookup/id/shop/61/v1': (url, init) => {
      const keys = JSON.parse(init.body);
      const table = { 'app/10': 'uuid-A', 'app/20': 'uuid-B', 'app/30': null, 'sub/500': 'uuid-C' };
      return { body: Object.fromEntries(keys.map((k) => [k, table[k] ?? null])) };
    },
    'https://api.isthereanydeal.com/lookup/id/shop/35/v1': (url, init) => {
      const keys = JSON.parse(init.body);
      const table = { 1001: 'uuid-A', 1002: 'uuid-D', 1003: null };
      return { body: Object.fromEntries(keys.map((k) => [k, table[k] ?? null])) };
    },
    'https://api.isthereanydeal.com/lookup/shop/35/id/v1': (url, init) => {
      const uuids = JSON.parse(init.body);
      const table = { 'uuid-A': [1001, 1001999], 'uuid-B': null, 'uuid-C': [1002] };
      return { body: Object.fromEntries(uuids.map((u) => [u, table[u] ?? null])) };
    },
    'https://api.isthereanydeal.com/lookup/shop/61/id/v1': (url, init) => {
      const uuids = JSON.parse(init.body);
      const table = { 'uuid-A': ['app/10', 'app/11'], 'uuid-D': ['sub/777', 'app/40'] };
      return { body: Object.fromEntries(uuids.map((u) => [u, table[u] ?? null])) };
    },
    'https://api.gog.com/products/': (url) => ({ body: { id: Number(url.split('/').pop()), links: { product_card: `https://www.gog.com/game/p${url.split('/').pop()}` } } }),
    ...overrides,
  };
}

// ---------------------------------------------------------------- boot

function boot({ storage = {}, routes = happyRoutes(), permissionsGranted = true } = {}) {
  const shim = makeBrowserShim({ storage });
  const net = makeFetch(routes);
  const alarms = { created: [], cleared: [], listeners: [] };
  shim.browser.alarms = {
    create: (name, info) => { alarms.created.push({ name, ...info }); },
    clear: async (name) => { alarms.cleared.push(name); return true; },
    onAlarm: { addListener: (fn) => alarms.listeners.push(fn) },
  };
  shim.browser.permissions = { contains: async () => permissionsGranted, request: async () => true };
  const warned = [];
  const fakeConsole = { ...console, warn: (m) => warned.push(String(m)), error: (m) => { throw new Error(`console.error called: ${m}`); } };
  const ctx = loadScript(T.extFile('lib/common.js'), { browser: shim.browser, fetch: net.fetch, atob: globalThis.atob, console: fakeConsole });
  vm.runInContext(fs.readFileSync(T.extFile('background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { shim, net, alarms, ctx, warned, send: (msg) => shim.sendToBackground(msg) };
}

// ---------------------------------------------------------------- tests

T.runAsync('registers message, alarm, storage and lifecycle listeners', async () => {
  const { shim, alarms } = boot();
  T.eq(shim.listeners.message.length, 1, 'onMessage');
  T.eq(shim.listeners.installed.length, 1, 'onInstalled');
  T.eq(shim.listeners.startup.length, 1, 'onStartup');
  T.eq(shim.listeners.storageChanged.length, 1, 'storage.onChanged');
  T.eq(alarms.listeners.length, 1, 'alarms.onAlarm');
});

T.runAsync('getStatus on empty storage: nothing loaded, not refreshing, permissions reported', async () => {
  const { send } = boot();
  const s = await send({ type: 'getStatus' });
  T.eq(s.steam, null);
  T.eq(s.gog, null);
  T.eq(s.maps, null);
  T.eq(s.status.refreshing, false);
  T.eq(s.permissionsGranted, true);
  const denied = boot({ permissionsGranted: false });
  T.eq((await denied.send({ type: 'getStatus' })).permissionsGranted, false);
});

T.runAsync('unknown message types are answered with ok:false', async () => {
  const { send } = boot();
  const r = await send({ type: 'nope' });
  T.eq(r.ok, false);
  T.ok(/unknown message type "nope"/.test(r.error), r.error);
  const r2 = await send({});
  T.eq(r2.ok, false, 'missing type');
  const r3 = await send(null);
  T.eq(r3.ok, false, 'null message');
});

T.runAsync('refreshNow (session mode) reads both libraries, resolves through ITAD and builds both maps', async () => {
  const { send, net, shim, warned } = boot();
  const s = await send({ type: 'refreshNow' });

  T.eq(s.status.errors, [], 'no errors');
  T.eq(s.status.warnings, [], 'no warnings');
  T.eq(s.status.refreshing, false);
  T.eq(warned, [], 'nothing logged on the happy path');
  T.eq(s.steam.apps, 3);
  T.eq(s.steam.subs, 1);
  T.eq(s.steam.named, 2);
  T.eq(s.steam.method, 'session');
  T.eq(s.steam.steamId, '76561198000000001', 'SteamID from the JWT sub claim');
  T.eq(s.gog.ids, 3);
  T.eq(s.gog.titled, 3, 'visible + hidden products');

  const maps = shim.store.maps;
  T.eq(maps.forSteam.apps, { 10: ['1001'], 11: ['1001'], 40: ['1002'] }, 'Steam app → owned GOG ids');
  T.eq(maps.forSteam.subs, { 777: ['1002'] }, 'Steam package → owned GOG ids');
  T.eq(maps.forGog.ids, { 1001: ['app/10'], 1001999: ['app/10'], 1002: ['sub/500'] }, 'GOG id → owned Steam keys');
  T.eq(maps.forSteam.gogTitles, { 'cyberpunk 2077': ['1001'], 'the witcher 3 wild hunt': ['1002'], 'blade runner': ['1003'] });
  T.eq(maps.forGog.steamTitles, { 'cyberpunk 2077': ['app/10'], 'the witcher 3 wild hunt': ['app/20'] }, 'trademark stripped before indexing');
  T.eq(maps.forSteam.gogInfo[1001].url, 'https://www.gog.com/game/cyberpunk_2077', 'relative GOG url made absolute');
  T.eq(maps.forSteam.gogInfo[1003].url, 'https://www.gog.com/en/game/blade_runner');
  T.eq(maps.stats, { steamOwned: 3, steamPackages: 1, steamNamed: 2, gogOwned: 3, gogTitled: 3, steamItemsOwnedOnGog: 4, gogItemsOwnedOnSteam: 3, ownedOnBoth: 2, ownedOnBothByTitle: 0 });

  T.eq(net.itadCalls().length, 4, 'one call per lookup direction');
  const steamLookup = net.itadCalls().find((c) => c.url.endsWith('/lookup/id/shop/61/v1'));
  T.eq(JSON.parse(steamLookup.init.body), ['app/10', 'app/20', 'app/30', 'sub/500'], 'apps then subs');
  T.eq(steamLookup.init.headers['ITAD-API-Key'], undefined, 'no key header without a key');
  const gogNames = net.to('getFilteredProducts');
  T.eq(gogNames.length, 2, 'visible and hidden pass');
  T.ok(net.to('dynamicstore')[0].init.credentials === 'include', 'store read sends cookies');
});

T.runAsync('second refresh of an unchanged library makes zero ITAD calls; stale nulls are re-asked', async () => {
  const { send, net, shim } = boot();
  await send({ type: 'refreshNow' });
  const before = net.itadCalls().length;
  await send({ type: 'refreshNow' });
  T.eq(net.itadCalls().length, before, 'all four lookups served from itad_cache');

  // Age the negative answer for app/30 past the 7-day TTL: only it is asked again.
  shim.store.itad_cache.steamToItad['app/30'].t = Date.now() - 8 * DAY;
  await send({ type: 'refreshNow' });
  const again = net.itadCalls().slice(before);
  T.eq(again.length, 1);
  T.eq(JSON.parse(again[0].init.body), ['app/30']);
});

T.runAsync('lookups are batched 200 at a time', async () => {
  const apps = Array.from({ length: 450 }, (_, i) => 1000 + i);
  const routes = happyRoutes({
    'https://store.steampowered.com/dynamicstore/userdata/': () => ({ body: { rgOwnedApps: apps, rgOwnedPackages: [] } }),
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/': () => ({ body: { response: { games: [] } } }),
    'https://api.isthereanydeal.com/lookup/id/shop/61/v1': (url, init) => ({ body: Object.fromEntries(JSON.parse(init.body).map((k) => [k, null])) }),
  });
  const { send, net } = boot({ routes });
  const s = await send({ type: 'refreshNow' });
  T.eq(s.status.errors, []);
  const sizes = net.itadCalls().filter((c) => c.url.endsWith('/lookup/id/shop/61/v1')).map((c) => JSON.parse(c.init.body).length);
  T.eq(sizes, [200, 200, 50]);
}, 15000);

T.runAsync('ITAD 429 is retried after Retry-After; the API key header is sent when configured', async () => {
  let hits = 0;
  const routes = happyRoutes({
    'https://api.isthereanydeal.com/lookup/id/shop/61/v1': (url, init) => {
      hits++;
      if (hits === 1) return { status: 429, retryAfter: '1', body: {} };
      T.eq(init.headers['ITAD-API-Key'], 'secret', 'key header');
      return { body: Object.fromEntries(JSON.parse(init.body).map((k) => [k, null])) };
    },
  });
  const { send } = boot({ routes, storage: { credentials: { itadApiKey: 'secret' } } });
  const s = await send({ type: 'refreshNow' });
  T.eq(s.status.errors, []);
  T.eq(hits, 2, 'one retry');
}, 15000);

T.runAsync('Steam logged out: per-store error, previous Steam library reused, maps still rebuilt', async () => {
  const { send, shim, warned } = boot();
  await send({ type: 'refreshNow' });
  const builtAt = shim.store.maps.builtAt;
  await T.sleep(5);

  const loggedOut = boot({
    storage: structuredClone(shim.store),
    routes: happyRoutes({ 'https://store.steampowered.com/dynamicstore/userdata/': () => ({ body: { rgOwnedApps: [], rgOwnedPackages: [] } }) }),
  });
  const s = await loggedOut.send({ type: 'refreshNow' });
  T.eq(s.status.errors.length, 1);
  T.ok(/^Steam: not logged in to the Steam store/.test(s.status.errors[0]), s.status.errors[0]);
  T.eq(s.status.problems.steam.login, true, 'flagged as a login problem');
  T.eq(s.status.problems.gog, undefined, 'GOG fine');
  T.eq(s.steam.apps, 3, 'previous library kept');
  T.ok(loggedOut.shim.store.maps.builtAt > builtAt, 'maps rebuilt from the previous Steam library');
  T.eq(loggedOut.warned.length, 1, 'one console.warn');
  T.ok(loggedOut.warned[0].startsWith('[cross-store-owned] refresh (manual) finished with errors: Steam:'), loggedOut.warned[0]);
  T.eq(warned, [], 'the first (clean) run logged nothing');
});

T.runAsync('GOG logged out (HTML redirect) and no previous library: both stores needed, no maps', async () => {
  const loginPage = () => ({ type: 'text/html; charset=utf-8', body: '<html>login</html>' });
  const routes = happyRoutes({
    'https://www.gog.com/user/data/games': loginPage,
    'https://embed.gog.com/user/data/games': loginPage,
  });
  const { send, shim, net } = boot({ routes });
  const s = await send({ type: 'refreshNow' });
  T.ok(s.status.errors.some((e) => /^GOG: not logged in to GOG/.test(e)), JSON.stringify(s.status.errors));
  T.eq(s.status.problems.gog.login, true);
  T.ok(s.status.errors.includes('Both libraries are needed before badges can be shown.'));
  T.eq(shim.store.maps, undefined, 'no maps written');
  T.eq(shim.store.lib_steam.apps, [10, 20, 30], 'Steam library still saved');
  T.eq(net.itadCalls().length, 0, 'no ITAD traffic without both libraries');
  T.ok(net.to('embed.gog.com').length > 0, 'embed.gog.com tried as a fallback host');
});

T.runAsync('network failure on every host still ends the refresh with a status write', async () => {
  const { send, shim } = boot({ routes: { '': () => { throw new Error('offline'); } } });
  const s = await send({ type: 'refreshNow' });
  T.eq(s.status.refreshing, false);
  T.eq(s.status.errors.length, 3, 'Steam, GOG, both-needed');
  T.eq(typeof shim.store.status.finishedAt, 'number');
});

T.runAsync('session mode without a store token: names unavailable warning, IDs still matched', async () => {
  const routes = happyRoutes({ 'https://store.steampowered.com/pointssummary/ajaxgetasyncconfig': () => ({ body: { success: 1, data: [] } }) });
  const { send, shim } = boot({ routes });
  const s = await send({ type: 'refreshNow' });
  T.eq(s.status.errors, []);
  T.eq(s.status.warnings.length, 1);
  T.ok(/^Steam game names unavailable/.test(s.status.warnings[0]));
  T.eq(s.steam.named, 0);
  T.eq(shim.store.maps.forGog.steamTitles, {}, 'no Steam title index');
  T.eq(shim.store.maps.forSteam.apps[10], ['1001'], 'ID matching intact');
});

T.runAsync('API mode: key and SteamID64 are used, session DLC folded in, missing key is an error', async () => {
  const { send, net } = boot({ storage: { settings: { steamMethod: 'api' }, credentials: { steamApiKey: 'KEY', steamId64: '76561198000000002' } } });
  const s = await send({ type: 'refreshNow' });
  T.eq(s.status.errors, []);
  T.eq(s.steam.method, 'api');
  T.eq(s.steam.steamId, '76561198000000002');
  const call = net.to('GetOwnedGames')[0];
  T.ok(call.url.includes('key=KEY') && call.url.includes('steamid=76561198000000002'), call.url);
  T.eq(s.steam.apps, 3, 'API games (10, 20) merged with the session read (10, 20, 30)');
  T.eq(s.steam.subs, 1, 'packages from the session read');

  const noKey = boot({ storage: { settings: { steamMethod: 'api' } } });
  const s2 = await noKey.send({ type: 'refreshNow' });
  T.ok(s2.status.errors.some((e) => /Web API method needs both/.test(e)), JSON.stringify(s2.status.errors));

  const privateProfile = boot({
    storage: { settings: { steamMethod: 'api' }, credentials: { steamApiKey: 'KEY', steamId64: '1' } },
    routes: happyRoutes({ 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/': () => ({ body: { response: {} } }) }),
  });
  const s3 = await privateProfile.send({ type: 'refreshNow' });
  T.ok(s3.status.errors.some((e) => /Game details/.test(e)), 'private profile hint');
});

T.runAsync('title indexes are built even with matchByTitle=false (the setting applies where badges are drawn)', async () => {
  const { send, shim } = boot({ storage: { settings: { matchByTitle: false } } });
  await send({ type: 'refreshNow' });
  T.eq(Object.keys(shim.store.maps.forSteam.gogTitles).sort(), ['blade runner', 'cyberpunk 2077', 'the witcher 3 wild hunt']);
  T.eq(shim.store.maps.forSteam.apps[10], ['1001'], 'ID matches unaffected');
});

T.runAsync('concurrent refreshNow calls share one refresh', async () => {
  const { send, net } = boot();
  const [a, b] = await Promise.all([send({ type: 'refreshNow' }), send({ type: 'refreshNow' })]);
  T.eq(net.to('dynamicstore').length, 1, 'one Steam read');
  T.eq(a.status.finishedAt, b.status.finishedAt);
});

T.runAsync('ensureFresh: stale → starts a refresh; fresh → no; recent failure → no; abandoned lock → yes', async () => {
  const fresh = boot({ storage: { status: { refreshing: false, finishedAt: Date.now() - 60e3, errors: [] } } });
  T.eq(await fresh.send({ type: 'ensureFresh' }), { refreshing: false });
  T.eq(fresh.net.calls.length, 0);

  const stale = boot({ storage: { status: { refreshing: false, finishedAt: Date.now() - 7 * 3600e3, errors: [] } } });
  T.eq(await stale.send({ type: 'ensureFresh' }), { refreshing: true });
  await T.sleep(20);
  T.ok(stale.net.to('dynamicstore').length === 1, 'refresh started');

  const failed = boot({ storage: { status: { refreshing: false, startedAt: Date.now() - 60e3, finishedAt: Date.now() - 59e3, errors: ['Steam: x'] } } });
  T.eq(await failed.send({ type: 'ensureFresh' }), { refreshing: false }, 'failed a minute ago → wait');
  T.eq(failed.net.calls.length, 0);

  const running = boot({ storage: { status: { refreshing: true, startedAt: Date.now() - 60e3 } } });
  T.eq(await running.send({ type: 'ensureFresh' }), { refreshing: true }, 'lock held → report refreshing, start nothing');
  T.eq(running.net.calls.length, 0);

  const abandoned = boot({ storage: { status: { refreshing: true, startedAt: Date.now() - 20 * 60e3 } } });
  T.eq(await abandoned.send({ type: 'ensureFresh' }), { refreshing: true }, 'stale lock → a new refresh');
  await T.sleep(20);
  T.eq(abandoned.net.to('dynamicstore').length, 1);

  const custom = boot({ storage: { settings: { refreshHours: 1 }, status: { refreshing: false, finishedAt: Date.now() - 2 * 3600e3, errors: [] } } });
  T.eq(await custom.send({ type: 'ensureFresh' }), { refreshing: true }, 'honours refreshHours');
});

T.runAsync('clearCache drops libraries, cache, maps and status but keeps settings', async () => {
  const { send, shim } = boot({ storage: { settings: { refreshHours: 3 } } });
  await send({ type: 'refreshNow' });
  T.ok(shim.store.maps && shim.store.itad_cache && shim.store.lib_steam && shim.store.lib_gog);
  T.eq(await send({ type: 'clearCache' }), { ok: true });
  for (const k of ['lib_steam', 'lib_gog', 'itad_cache', 'maps', 'both', 'status']) T.eq(shim.store[k], undefined, k);
  T.eq(shim.store.settings, { refreshHours: 3 });
});

T.runAsync('resolveGogUrl: known product from the library, else api.gog.com, else empty string', async () => {
  const { send, net } = boot({ storage: { lib_gog: { ids: [1001], info: { 1001: { title: 'CP', url: 'https://www.gog.com/game/cyberpunk_2077' } } } } });
  T.eq(await send({ type: 'resolveGogUrl', gogId: 1001 }), 'https://www.gog.com/game/cyberpunk_2077');
  T.eq(net.to('api.gog.com').length, 0, 'no network for a known product');
  T.eq(await send({ type: 'resolveGogUrl', gogId: 4242 }), 'https://www.gog.com/game/p4242');
  const offline = boot({ routes: { 'https://api.gog.com/products/': () => ({ status: 404, body: {} }) } });
  T.eq(await offline.send({ type: 'resolveGogUrl', gogId: 1 }), '');
});

T.runAsync('onInstalled schedules the alarm from settings and kicks a refresh; settings change reschedules', async () => {
  const { shim, alarms, net } = boot({ storage: { settings: { refreshHours: 12 } } });
  await shim.listeners.installed[0].fn({ reason: 'install' });
  await T.sleep(30);
  T.eq(alarms.cleared, ['cso-refresh']);
  T.eq(alarms.created, [{ name: 'cso-refresh', periodInMinutes: 720, delayInMinutes: 720 }]);
  T.ok(net.to('dynamicstore').length === 1, 'refresh started on install');

  await shim.listeners.storageChanged[0].fn({ settings: { newValue: { refreshHours: 'abc' } } }, 'local');
  shim.store.settings = { refreshHours: 'abc' };
  await shim.listeners.storageChanged[0].fn({ settings: { newValue: { refreshHours: 'abc' } } }, 'local');
  await T.sleep(5);
  T.eq(alarms.created.at(-1).periodInMinutes, 360, 'garbage interval → default 6 h');

  await shim.listeners.storageChanged[0].fn({ maps: { newValue: {} } }, 'local');
  await shim.listeners.storageChanged[0].fn({ settings: { newValue: {} } }, 'sync');
  await T.sleep(5);
  T.eq(alarms.created.length, 3, 'only local settings changes reschedule');
});

T.runAsync('0.1 → 0.2 migration moves API keys out of settings into credentials, once', async () => {
  const legacy = { steamMethod: 'api', steamApiKey: 'KEY', steamId64: '76561198000000002', itadApiKey: 'ITAD', refreshHours: 3 };
  const { shim, warned, send, net } = boot({ storage: { settings: legacy } });
  await shim.listeners.startup[0].fn();
  await T.sleep(30);
  T.eq(shim.store.credentials, { steamApiKey: 'KEY', steamId64: '76561198000000002', itadApiKey: 'ITAD' }, 'moved');
  T.eq(shim.store.settings, { steamMethod: 'api', refreshHours: 3, matchByTitle: true, showOnSteam: true, showOnGog: true, badgeText: 'letter', toolbarCount: true, gogColor: '#7b2fbe', steamColor: '#1a9fff' }, 'stripped, defaults filled');
  T.eq(warned.filter((w) => /moved steamApiKey, steamId64, itadApiKey/.test(w)).length, 1, 'logged once');
  // API mode keeps working from the migrated credentials.
  const s = await send({ type: 'refreshNow' });
  T.eq(s.status.errors, []);
  T.ok(net.to('GetOwnedGames')[0].url.includes('key=KEY'));
  // Second startup: nothing left to move, no second warning, existing credentials win over stale legacy values.
  shim.store.settings.steamApiKey = 'STALE';
  shim.store.credentials.steamApiKey = 'CURRENT';
  await shim.listeners.startup[0].fn();
  await T.sleep(30);
  T.eq(shim.store.credentials.steamApiKey, 'CURRENT');
  T.eq(shim.store.settings.steamApiKey, undefined, 'stray key removed again');
  const clean = boot({ storage: { settings: { refreshHours: 3 } } });
  await clean.shim.listeners.startup[0].fn();
  await T.sleep(30);
  T.eq(clean.shim.store.credentials, undefined, 'no credentials written when nothing to migrate');
  T.eq(clean.warned.filter((w) => /moved/.test(w)).length, 0);
});

T.runAsync('alarm fires a refresh; other alarms are ignored', async () => {
  const { alarms, net } = boot();
  alarms.listeners[0]({ name: 'something-else' });
  await T.sleep(10);
  T.eq(net.calls.length, 0);
  alarms.listeners[0]({ name: 'cso-refresh' });
  await T.sleep(20);
  T.ok(net.to('dynamicstore').length === 1);
});

T.runAsync('corrupt stored values never make getStatus throw', async () => {
  const { send } = boot({ storage: { lib_steam: 'garbage', lib_gog: { ids: 'nope', info: 7 }, maps: {}, status: 5, settings: [1] } });
  const s = await send({ type: 'getStatus' });
  T.eq(s.steam, null);
  T.eq(s.gog.ids, 0);
  T.eq(s.gog.titled, 0);
  T.eq(s.maps.stats, {});
  T.eq(s.status.errors, [], 'errors array even when status is garbage');
  T.eq(s.status.problems, {});
  T.eq(s.status.refreshing, false);
});

// ---------------------------------------------------------------- 0.3: owned on both, progress, search, toolbar

T.runAsync('owned on both: ID-linked editions grouped, titles from GOG, Steam links built', async () => {
  const { send, shim } = boot();
  await send({ type: 'refreshNow' });
  const games = shim.store.both.games;
  T.eq(games.length, 2);
  T.eq(games.map((g) => g.title), ['Cyberpunk 2077', 'The Witcher 3: Wild Hunt – Game of the Year Edition'], 'sorted by title');
  T.eq(games[0], {
    title: 'Cyberpunk 2077', via: 'id',
    steam: [{ key: 'app/10', name: 'Cyberpunk 2077™', url: 'https://store.steampowered.com/app/10/' }],
    gog: [{ id: '1001', title: 'Cyberpunk 2077', url: 'https://www.gog.com/game/cyberpunk_2077' }],
  });
  T.eq(games[1].steam, [{ key: 'sub/500', name: '', url: 'https://store.steampowered.com/sub/500/' }], 'a package');
  T.eq(typeof shim.store.both.builtAt, 'number');
});

T.runAsync('owned on both: the title layer pairs unlinked games with equal normalised names', async () => {
  const routes = happyRoutes({
    'https://store.steampowered.com/dynamicstore/userdata/': () => ({ body: { rgOwnedApps: [10, 50], rgOwnedPackages: [] } }),
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/': () => ({ body: { response: { games: [{ appid: 10, name: 'Cyberpunk 2077' }, { appid: 50, name: 'Hollow Knight' }] } } }),
    'https://www.gog.com/user/data/games': () => ({ body: { owned: [1001, 1004] } }),
    'https://www.gog.com/account/getFilteredProducts': (url) => ({
      body: /hiddenFlag=1/.test(url) ? { totalPages: 1, products: [] } : { totalPages: 1, products: [{ id: 1001, title: 'Cyberpunk 2077', url: '/game/cp' }, { id: 1004, title: 'Hollow Knight: Complete Edition', url: '/game/hk' }] },
    }),
  });
  const { send, shim } = boot({ routes });
  const s = await send({ type: 'refreshNow' });
  T.eq(s.status.errors, []);
  const hk = shim.store.both.games.find((g) => g.via === 'title');
  T.ok(hk, 'title-layer entry');
  T.eq(hk.title, 'Hollow Knight: Complete Edition');
  T.eq(hk.steam.map((x) => x.key), ['app/50']);
  T.eq(hk.gog.map((x) => x.id), ['1004']);
  T.eq(shim.store.maps.stats.ownedOnBoth, 1);
  T.eq(shim.store.maps.stats.ownedOnBothByTitle, 1);
});

T.runAsync('progress: status carries the step while refreshing and none afterwards', async () => {
  const { send, shim } = boot();
  await send({ type: 'refreshNow' });
  const steps = shim.callsTo('storage.local.set').map((c) => c.args[0].status).filter((st) => st && st.refreshing).map((st) => st.progress && st.progress.step);
  for (const step of ['start', 'steam', 'gog', 'match']) T.ok(steps.includes(step), `step ${step} reported (${steps.join(',')})`);
  const matchSteps = shim.callsTo('storage.local.set').map((c) => c.args[0].status).filter((st) => st && st.progress && st.progress.step === 'match');
  T.ok(matchSteps.some((st) => st.progress.total > 0 && st.progress.done === st.progress.total), 'a lookup reported complete');
  T.ok(matchSteps.every((st) => /\(\d of 4\)$/.test(st.progress.label)), 'labelled n of 4');
  T.eq(shim.store.status.progress, undefined, 'final status has no progress');
  T.eq(shim.store.status.refreshing, false);
});

T.runAsync('a failed lookup keeps what IsThereAnyDeal already answered', async () => {
  const routes = happyRoutes({ 'https://api.isthereanydeal.com/lookup/id/shop/35/v1': () => ({ status: 500, body: {} }) });
  const { send, shim } = boot({ routes });
  const s = await send({ type: 'refreshNow' });
  T.ok(s.status.errors.some((e) => /^Matching: IsThereAnyDeal answered HTTP 500/.test(e)), JSON.stringify(s.status.errors));
  T.ok(s.status.problems.match, 'match problem recorded');
  T.eq(Object.keys(shim.store.itad_cache.steamToItad).sort(), ['app/10', 'app/20', 'app/30', 'sub/500'], 'Steam answers cached');
  T.eq(shim.store.maps, undefined, 'no maps from a half-done match');
});

T.runAsync('a request that times out is reported in plain words', async () => {
  const timeout = () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e; };
  const { send } = boot({ routes: happyRoutes({ 'https://store.steampowered.com/dynamicstore/userdata/': timeout }) });
  const s = await send({ type: 'refreshNow' });
  T.ok(s.status.errors.includes('Steam: store.steampowered.com did not answer within 30 s'), JSON.stringify(s.status.errors));
  T.eq(s.status.problems.steam.login, false);
});

T.runAsync('search finds owned games by any words, flags the stores, ranks title starts first', async () => {
  const { send } = boot();
  T.eq((await send({ type: 'search', query: 'witcher' })).ready, false, 'nothing read yet');
  await send({ type: 'refreshNow' });
  const w = await send({ type: 'search', query: 'witcher' });
  T.eq(w.ok, true);
  T.eq(w.ready, true);
  T.eq(w.results.map((r) => r.title), ['The Witcher 3: Wild Hunt - Complete Edition', 'The Witcher 3: Wild Hunt – Game of the Year Edition'], 'same rank → alphabetical');
  T.eq(w.results[0].gog, '', 'Complete Edition: Steam only');
  T.ok(w.results[1].steam && w.results[1].gog, 'GOTY: owned on both (via the sub)');
  T.eq((await send({ type: 'search', query: 'complete edition' })).results.length, 1, 'edition words are searchable');
  const cp = await send({ type: 'search', query: 'CYBERPUNK™' });
  T.eq(cp.total, 1, 'both editions of one game are one result');
  T.eq(cp.results[0].steam, 'https://store.steampowered.com/app/10/');
  T.eq(cp.results[0].gog, 'https://www.gog.com/game/cyberpunk_2077');
  const br = await send({ type: 'search', query: 'runner blade' });
  T.eq(br.results.map((r) => [r.title, !!r.steam, !!r.gog]), [['Blade Runner: The Final Cut', false, true]], 'word order free');
  T.eq((await send({ type: 'search', query: 'zzz' })).total, 0);
  T.eq((await send({ type: 'search', query: '  ' })).results, []);
  T.eq(w.steamNames, 2);
  T.eq(w.gogTitles, 3);
});

T.runAsync('search index is rebuilt when a library changes', async () => {
  const { send, shim } = boot();
  await send({ type: 'refreshNow' });
  T.eq((await send({ type: 'search', query: 'hollow' })).total, 0);
  shim.store.lib_gog.info[1003] = { title: 'Hollow Knight', url: 'https://www.gog.com/game/hk' };
  await shim.changeStorage({ lib_gog: { newValue: shim.store.lib_gog } });
  T.eq((await send({ type: 'search', query: 'hollow' })).total, 1);
});

T.runAsync('resolveSteamId: ID, profile link, custom name with and without a key', async () => {
  let asked = null;
  const routes = happyRoutes({
    'https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/': (url) => {
      asked = new URL(url).searchParams;
      return { body: { response: asked.get('vanityurl') === 'gaben' ? { success: 1, steamid: '76561197960287930' } : { success: 42, message: 'No match' } } };
    },
  });
  const { send } = boot({ routes });
  T.eq(await send({ type: 'resolveSteamId', input: ' 76561198000000001 ' }), { ok: true, steamId: '76561198000000001' });
  T.eq(await send({ type: 'resolveSteamId', input: 'https://steamcommunity.com/profiles/76561198000000002/' }), { ok: true, steamId: '76561198000000002' });
  const noKey = await send({ type: 'resolveSteamId', input: 'gaben' });
  T.eq(noKey.ok, false);
  T.ok(/Web API key first/.test(noKey.error), noKey.error);
  T.eq(asked, null, 'no request without a key');
  T.eq(await send({ type: 'resolveSteamId', input: 'https://steamcommunity.com/id/gaben/', apiKey: 'K' }), { ok: true, steamId: '76561197960287930' });
  T.eq(asked.get('key'), 'K');
  const missing = await send({ type: 'resolveSteamId', input: 'nobody', apiKey: 'K' });
  T.eq(missing.ok, false);
  T.ok(/No Steam profile is called "nobody"/.test(missing.error), missing.error);
  const junk = await send({ type: 'resolveSteamId', input: 'not a valid thing!' });
  T.ok(/17-digit SteamID64/.test(junk.error), junk.error);
  const stored = boot({ routes, storage: { credentials: { steamApiKey: 'STORED' } } });
  T.eq((await stored.send({ type: 'resolveSteamId', input: 'gaben' })).ok, true, 'falls back to the saved key');
  T.eq(asked.get('key'), 'STORED');
});

T.runAsync('pageCount sets the tab badge in the other store\'s colour; 0 or switched off hands back to the global badge', async () => {
  const { shim, send } = boot({ storage: { settings: { gogColor: '#123456' } } });
  const tab = { id: 7 };
  const r = await shim.sendToBackground({ type: 'pageCount', count: 3, site: 'steam' }, { tab });
  T.eq(r, { ok: true, count: 3 });
  T.eq(shim.callsTo('browserAction.setBadgeText').at(-1).args[0], { tabId: 7, text: '3' });
  T.eq(shim.callsTo('browserAction.setBadgeBackgroundColor').at(-1).args[0], { tabId: 7, color: '#123456' });
  T.ok(/3 games on this page you own on GOG/.test(shim.callsTo('browserAction.setTitle').at(-1).args[0].title));
  await shim.sendToBackground({ type: 'pageCount', count: 1, site: 'gog' }, { tab });
  T.eq(shim.callsTo('browserAction.setBadgeBackgroundColor').at(-1).args[0].color, '#1a9fff', 'GOG page → Steam colour');
  T.ok(/1 game on this page you own on Steam/.test(shim.callsTo('browserAction.setTitle').at(-1).args[0].title));
  await shim.sendToBackground({ type: 'pageCount', count: 0, site: 'steam' }, { tab });
  T.eq(shim.callsTo('browserAction.setBadgeText').at(-1).args[0], { tabId: 7, text: null });
  await shim.sendToBackground({ type: 'pageCount', count: 5000, site: 'steam' }, { tab });
  T.eq(shim.callsTo('browserAction.setBadgeText').at(-1).args[0].text, '999+');
  shim.store.settings = { toolbarCount: false };
  await shim.sendToBackground({ type: 'pageCount', count: 4, site: 'steam' }, { tab });
  T.eq(shim.callsTo('browserAction.setBadgeText').at(-1).args[0], { tabId: 7, text: null }, 'switched off');
  const noTab = await shim.sendToBackground({ type: 'pageCount', count: 2 }, { id: 'popup' });
  T.eq(noTab.ok, false);
});

T.runAsync('global toolbar badge: "…" while refreshing, "!" after a failed refresh, cleared after a clean one', async () => {
  const failing = boot({ routes: { '': () => { throw new Error('offline'); } } });
  await failing.send({ type: 'refreshNow' });
  const texts = failing.shim.callsTo('browserAction.setBadgeText').map((c) => c.args[0]).filter((a) => a.tabId === undefined).map((a) => a.text);
  T.eq(texts, ['…', '!']);
  T.ok(/had a problem/.test(failing.shim.callsTo('browserAction.setTitle').at(-1).args[0].title));
  const ok = boot();
  await ok.send({ type: 'refreshNow' });
  T.eq(ok.shim.callsTo('browserAction.setBadgeText').at(-1).args[0], { text: '' });
  await failing.send({ type: 'clearCache' });
  T.eq(failing.shim.callsTo('browserAction.setBadgeText').at(-1).args[0], { text: '' }, 'clearCache clears the "!"');
});

T.runAsync('ensureFresh retries at once when a store page shows the user logged in after a login failure (once)', async () => {
  const status = { refreshing: false, startedAt: Date.now() - 60e3, finishedAt: Date.now() - 59e3, reason: 'manual', errors: ['Steam: not logged in'], problems: { steam: { message: 'x', login: true } } };
  const a = boot({ storage: { status } });
  T.eq(await a.send({ type: 'ensureFresh', loggedInOn: 'gog' }), { refreshing: false }, 'other store: normal throttling');
  T.eq(await a.send({ type: 'ensureFresh', loggedInOn: 'steam' }), { refreshing: true });
  await T.sleep(20);
  T.eq(a.net.to('dynamicstore').length, 1);
  T.eq(a.shim.store.status.reason, 'login');
  const b = boot({ storage: { status: { ...status, reason: 'login' } } });
  T.eq(await b.send({ type: 'ensureFresh', loggedInOn: 'steam' }), { refreshing: false }, 'the retry already happened');
  const c = boot({ storage: { status } });
  T.eq(await c.send({ type: 'ensureFresh', loggedInOn: 'evil' }), { refreshing: false }, 'unknown store ignored');
});

T.runAsync('only a new refresh interval reschedules the alarm', async () => {
  const { shim, alarms } = boot();
  const change = (oldValue, newValue) => shim.listeners.storageChanged[0].fn({ settings: { oldValue, newValue } }, 'local');
  await change({ refreshHours: 6, gogColor: '#000000' }, { refreshHours: 6, gogColor: '#ffffff' });
  await T.sleep(5);
  T.eq(alarms.created.length, 0, 'colour change: schedule kept');
  await change({ refreshHours: 6 }, { refreshHours: 12 });
  await T.sleep(5);
  T.eq(alarms.created.length, 1);
  T.eq(alarms.created[0].periodInMinutes, 360, 'reads the stored settings');
});

T.runAsync('startup clears a refreshing flag left over from before', async () => {
  const { shim } = boot({ storage: { status: { refreshing: true, startedAt: Date.now() - 60e3, finishedAt: Date.now() - 3600e3, errors: [], progress: { step: 'gog' } } } });
  await shim.listeners.startup[0].fn();
  const first = shim.callsTo('storage.local.set').map((c) => c.args[0].status).find(Boolean);
  T.eq(first.refreshing, false, 'flag cleared before anything else');
  T.eq(first.progress, null);
  T.eq(shim.callsTo('browserAction.setBadgeText')[0].args[0], { text: '' }, 'no busy icon');
});

T.runAsync('getStatus reports the number of hidden badges, ignoring junk entries', async () => {
  const { send } = boot({ storage: { hidden: ['steam:app/10', 'gog:1001', 'steam:app/10', 'nonsense', 5] } });
  T.eq((await send({ type: 'getStatus' })).hidden, 2);
});

await T.exit();
