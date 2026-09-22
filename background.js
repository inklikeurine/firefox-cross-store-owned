/* Background (event page).
 * Fetches the Steam and GOG libraries, resolves cross-store IDs through IsThereAnyDeal,
 * and stores the lookup maps that the content scripts read from storage.local.
 *
 * storage.local layout:
 *   settings    user settings (see CSO.DEFAULT_SETTINGS in lib/common.js); also read by content scripts
 *   credentials Steam Web API key + SteamID64, IsThereAnyDeal key (CSO.DEFAULT_CREDENTIALS); background/options only
 *   lib_steam   { apps: number[], subs: number[], names: {appid: name}, steamId, method, fetchedAt, warning }
 *   lib_gog     { ids: number[], info: {gogId: {title, url}}, fetchedAt, warning }
 *   itad_cache  { steamToItad, gogToItad, itadToSteam, itadToGog }  each {key: {v, t}}
 *   maps        { builtAt, stats, forSteam: {...}, forGog: {...} }   consumed by the content scripts
 *   status      { refreshing, startedAt, finishedAt, reason, errors[], warnings[] }
 */
"use strict";

const STEAM_STORE = "https://store.steampowered.com";
const STEAM_API = "https://api.steampowered.com";
const GOG_HOSTS = ["https://www.gog.com", "https://embed.gog.com"];
const GOG_PRODUCT_API = "https://api.gog.com/products/";
const ITAD = "https://api.isthereanydeal.com";
const ITAD_SHOP = { steam: 61, gog: 35 };
const ITAD_BATCH = 200;             // documented maximum per lookup request
const ITAD_NULL_TTL = 7 * 86400e3;  // re-ask ITAD about unmapped games after a week
const ALARM = "cso-refresh";
const MIN_RETRY_MS = 10 * 60e3;     // don't hammer the stores when a refresh keeps failing
const STALE_LOCK_MS = 15 * 60e3;    // treat a "refreshing" flag older than this as abandoned

let refreshPromise = null;

/* ---------------------------------------------------------------- storage */

async function getLocal(key, fallback) {
  const r = await browser.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}
const setLocal = (obj) => browser.storage.local.set(obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- fetch */

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) throw new Error(`non-JSON reply from ${new URL(url).host} (not logged in?)`);
  return res.json();
}

/* ---------------------------------------------------------------- Steam */

function steamIdFromToken(jwt) {
  // The store's webapi_token is a JWT whose "sub" claim is the SteamID64.
  const payload = jwt.split(".")[1] || "";
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return String(JSON.parse(atob(b64)).sub || "");
}

async function fetchDynamicStore() {
  return fetchJson(`${STEAM_STORE}/dynamicstore/userdata/?t=${Date.now()}`, { credentials: "include" });
}

async function fetchOwnedGames(auth) {
  const params = new URLSearchParams({
    ...auth,
    include_appinfo: "1",
    include_played_free_games: "1",
    skip_unvetted_apps: "false",
    format: "json"
  });
  const data = await fetchJson(`${STEAM_API}/IPlayerService/GetOwnedGames/v1/?${params}`);
  const games = (data && data.response && data.response.games) || [];
  const names = {};
  const apps = [];
  for (const g of games) {
    apps.push(g.appid);
    if (g.name) names[g.appid] = g.name;
  }
  return { apps, names };
}

function union(a, b) {
  const s = new Set(a);
  for (const x of b) s.add(x);
  return [...s];
}

// "session": everything comes from the browser's Steam login. No keys to configure.
async function fetchSteamSession() {
  const ds = await fetchDynamicStore();
  let apps = ds.rgOwnedApps || [];
  const subs = ds.rgOwnedPackages || [];
  if (!apps.length && !subs.length) {
    throw new Error("empty library returned — log in to store.steampowered.com in this browser and refresh");
  }
  let names = {};
  let steamId = "";
  let warning = "";
  try {
    // Undocumented but long-standing: the store hands a logged-in user a short-lived Web API token,
    // which GetOwnedGames accepts in place of an API key. Only used for game names (title matching).
    const cfg = await fetchJson(`${STEAM_STORE}/pointssummary/ajaxgetasyncconfig`, { credentials: "include" });
    const token = cfg && cfg.data && cfg.data.webapi_token;
    if (!token) throw new Error("no webapi_token");
    steamId = steamIdFromToken(token);
    const owned = await fetchOwnedGames({ access_token: token, steamid: steamId });
    names = owned.names;
    apps = union(apps, owned.apps);
  } catch (e) {
    warning = `Steam game names unavailable, so title matching is off for Steam-owned games (${e.message}).`;
  }
  return { apps, subs, names, steamId, method: "session", fetchedAt: Date.now(), warning };
}

// "api": Steam Web API key + SteamID64 from the stored credentials. Works even when not logged in to the store.
async function fetchSteamApi(credentials) {
  if (!credentials.steamApiKey || !credentials.steamId64) {
    throw new Error("the Web API method needs both an API key and a SteamID64 (see Settings)");
  }
  const owned = await fetchOwnedGames({ key: credentials.steamApiKey, steamid: credentials.steamId64 });
  if (!owned.apps.length) {
    throw new Error("Web API returned no games — check the SteamID64 and set 'Game details' to Public in Steam privacy settings");
  }
  let apps = owned.apps;
  let subs = [];
  let warning = "";
  try {
    // If the browser also happens to be logged in, fold in DLC and packages from the store session.
    const ds = await fetchDynamicStore();
    apps = union(apps, ds.rgOwnedApps || []);
    subs = ds.rgOwnedPackages || [];
  } catch (e) {
    warning = "Not logged in to the Steam store in this browser, so DLC/package ownership is not included.";
  }
  return { apps, subs, names: owned.names, steamId: credentials.steamId64, method: "api", fetchedAt: Date.now(), warning };
}

/* ---------------------------------------------------------------- GOG */

// Tries www.gog.com first, then embed.gog.com; reports the primary host's error when both fail.
async function gogFetch(path) {
  let firstErr;
  for (const host of GOG_HOSTS) {
    try {
      return await fetchJson(host + path, { credentials: "include", headers: { Accept: "application/json" } });
    } catch (e) {
      firstErr = firstErr || e;
    }
  }
  throw firstErr;
}

function absoluteGogUrl(u) {
  if (!u) return "";
  if (/^https?:/.test(u)) return u;
  return "https://www.gog.com" + (u.startsWith("/") ? "" : "/") + u;
}

async function fetchGogLibrary() {
  const data = await gogFetch("/user/data/games");
  const ids = (data.owned || []).map(Number);
  if (!ids.length) throw new Error("empty library returned — log in to gog.com in this browser and refresh");

  // Titles and store URLs for tooltips, links, and title matching (best effort).
  const info = {};
  let warning = "";
  try {
    for (const hiddenFlag of [0, 1]) {
      let page = 1;
      let totalPages = 1;
      do {
        const res = await gogFetch(`/account/getFilteredProducts?mediaType=1&hiddenFlag=${hiddenFlag}&sortBy=title&page=${page}`);
        totalPages = Number(res.totalPages) || 1;
        for (const p of res.products || []) {
          info[p.id] = { title: p.title || "", url: absoluteGogUrl(p.url) };
        }
        page++;
      } while (page <= totalPages && page <= 400);
    }
  } catch (e) {
    warning = `GOG titles only partially loaded, so links/title matching may be incomplete (${e.message}).`;
  }
  return { ids, info, fetchedAt: Date.now(), warning };
}

async function resolveGogUrl(gogId) {
  const lib = await getLocal("lib_gog", null);
  const known = lib && lib.info && lib.info[gogId];
  if (known && known.url) return known.url;
  try {
    const p = await fetchJson(GOG_PRODUCT_API + encodeURIComponent(gogId));
    return (p.links && p.links.product_card) || "";
  } catch (e) {
    return "";
  }
}

/* ---------------------------------------------------------------- IsThereAnyDeal */

async function itadPost(path, body, credentials, attempt = 0) {
  const headers = { "Content-Type": "application/json" };
  if (credentials.itadApiKey) headers["ITAD-API-Key"] = credentials.itadApiKey;
  const res = await fetch(ITAD + path, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get("Retry-After")) || 15;
    await sleep(wait * 1000);
    return itadPost(path, body, credentials, attempt + 1);
  }
  if (!res.ok) throw new Error(`IsThereAnyDeal answered HTTP ${res.status} for ${path}`);
  return res.json();
}

// Resolve `keys` through one ITAD lookup endpoint, using/refilling the persistent cache.
async function lookupBatched(path, keys, cache, credentials) {
  const now = Date.now();
  const missing = keys.filter((k) => {
    const c = cache[k];
    return !c || (c.v === null && now - c.t > ITAD_NULL_TTL);
  });
  for (let i = 0; i < missing.length; i += ITAD_BATCH) {
    const chunk = missing.slice(i, i + ITAD_BATCH);
    const data = await itadPost(path, chunk, credentials);
    for (const k of chunk) cache[k] = { v: data[k] === undefined ? null : data[k], t: now };
    if (i + ITAD_BATCH < missing.length) await sleep(250);
  }
  const out = {};
  for (const k of keys) out[k] = cache[k] ? cache[k].v : null;
  return out;
}

function groupByValue(map) {
  // {key: uuid|null} -> {uuid: [keys]}
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue;
    (out[v] || (out[v] = [])).push(k);
  }
  return out;
}

function pushUnique(bucket, id, values) {
  const arr = bucket[id] || (bucket[id] = []);
  for (const v of values) if (!arr.includes(v)) arr.push(v);
}

async function buildMaps(steam, gog, settings, cache, credentials) {
  for (const k of ["steamToItad", "gogToItad", "itadToSteam", "itadToGog"]) cache[k] = cache[k] || {};

  const steamKeys = [...steam.apps.map((a) => `app/${a}`), ...steam.subs.map((s) => `sub/${s}`)];
  const gogKeys = gog.ids.map(String);

  // Store IDs -> ITAD game IDs for everything owned on each store.
  const steamToItad = await lookupBatched(`/lookup/id/shop/${ITAD_SHOP.steam}/v1`, steamKeys, cache.steamToItad, credentials);
  const gogToItad = await lookupBatched(`/lookup/id/shop/${ITAD_SHOP.gog}/v1`, gogKeys, cache.gogToItad, credentials);
  const ownedSteamByUuid = groupByValue(steamToItad);
  const ownedGogByUuid = groupByValue(gogToItad);

  // ITAD game IDs -> every store ID on the *other* store (all editions ITAD groups together).
  const itadToGog = await lookupBatched(`/lookup/shop/${ITAD_SHOP.gog}/id/v1`, Object.keys(ownedSteamByUuid), cache.itadToGog, credentials);
  const itadToSteam = await lookupBatched(`/lookup/shop/${ITAD_SHOP.steam}/id/v1`, Object.keys(ownedGogByUuid), cache.itadToSteam, credentials);

  // forGog.ids: GOG product id -> Steam keys you own for that game (shown on gog.com)
  const forGog = { ids: {}, steamTitles: {}, steamNames: steam.names || {} };
  for (const [uuid, gogIds] of Object.entries(itadToGog)) {
    if (!gogIds) continue;
    for (const gid of gogIds) pushUnique(forGog.ids, String(gid), ownedSteamByUuid[uuid]);
  }

  // forSteam.apps/subs: Steam app/package id -> GOG product ids you own (shown on Steam)
  const forSteam = { apps: {}, subs: {}, gogTitles: {}, gogInfo: gog.info || {} };
  for (const [uuid, keys] of Object.entries(itadToSteam)) {
    if (!keys) continue;
    for (const key of keys) {
      const [kind, id] = String(key).split("/");
      const bucket = kind === "sub" ? forSteam.subs : forSteam.apps;
      pushUnique(bucket, id, ownedGogByUuid[uuid]);
    }
  }

  // Normalised-title indexes for the fuzzy fallback (editions ITAD keeps separate).
  if (settings.matchByTitle) {
    for (const [appid, name] of Object.entries(forGog.steamNames)) {
      const n = CSO.normalizeTitle(name);
      if (n) pushUnique(forGog.steamTitles, n, [`app/${appid}`]);
    }
    for (const [gid, inf] of Object.entries(forSteam.gogInfo)) {
      const n = CSO.normalizeTitle(inf.title);
      if (n) pushUnique(forSteam.gogTitles, n, [String(gid)]);
    }
  }

  const stats = {
    steamOwned: steam.apps.length,
    steamPackages: steam.subs.length,
    steamNamed: Object.keys(forGog.steamNames).length,
    gogOwned: gog.ids.length,
    gogTitled: Object.keys(forSteam.gogInfo).length,
    steamItemsOwnedOnGog: Object.keys(forSteam.apps).length + Object.keys(forSteam.subs).length,
    gogItemsOwnedOnSteam: Object.keys(forGog.ids).length
  };
  return { builtAt: Date.now(), stats, forSteam, forGog };
}

/* ---------------------------------------------------------------- refresh orchestration */

async function refreshAll(reason) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const startedAt = Date.now();
    const errors = [];
    let warnings = [];
    try {
      const prev = await getLocal("status", {});
      await setLocal({ status: { ...prev, refreshing: true, startedAt, reason } });
      warnings = await refreshLibraries(errors);
    } catch (e) {
      errors.push(`Unexpected: ${e.message}`);
    }
    if (errors.length) console.warn(`[${CSO.NAME}] refresh (${reason}) finished with errors: ${errors.join(" | ")}`);
    // The popup and options page re-render on this write; it must happen on every path.
    await setLocal({ status: { refreshing: false, startedAt, finishedAt: Date.now(), reason, errors, warnings } });
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

// Fetch both libraries, rebuild the maps, and return the per-store warnings. Errors go into `errors`.
async function refreshLibraries(errors) {
  const settings = await CSO.getSettings();
  const credentials = await CSO.getCredentials();
  let steam = await getLocal("lib_steam", null);
  let gog = await getLocal("lib_gog", null);

  try {
    steam = settings.steamMethod === "api" ? await fetchSteamApi(credentials) : await fetchSteamSession();
    await setLocal({ lib_steam: steam });
  } catch (e) {
    errors.push(`Steam: ${e.message}`);
  }
  try {
    gog = await fetchGogLibrary();
    await setLocal({ lib_gog: gog });
  } catch (e) {
    errors.push(`GOG: ${e.message}`);
  }

  if (steam && gog) {
    try {
      const cache = await getLocal("itad_cache", {});
      const maps = await buildMaps(steam, gog, settings, cache, credentials);
      await setLocal({ maps, itad_cache: cache });
    } catch (e) {
      errors.push(`Matching: ${e.message}`);
    }
  } else {
    errors.push("Both libraries are needed before badges can be shown.");
  }
  return [steam && steam.warning, gog && gog.warning].filter(Boolean);
}

async function ensureFresh() {
  const settings = await CSO.getSettings();
  const status = await getLocal("status", {});
  const now = Date.now();
  if (status.refreshing && now - (status.startedAt || 0) < STALE_LOCK_MS) return { refreshing: true };
  const maxAge = CSO.refreshHours(settings) * 3600e3;
  const stale = !status.finishedAt || now - status.finishedAt > maxAge;
  const failedRecently = status.errors && status.errors.length && now - (status.startedAt || 0) < MIN_RETRY_MS;
  if (stale && !failedRecently) {
    refreshAll("stale");
    return { refreshing: true };
  }
  return { refreshing: false };
}

async function getStatusSummary() {
  let [steam, gog, maps, status, granted] = await Promise.all([
    getLocal("lib_steam", null),
    getLocal("lib_gog", null),
    getLocal("maps", null),
    getLocal("status", {}),
    browser.permissions.contains({ origins: CSO.HOST_ORIGINS })
  ]);
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  const keys = (v) => (v && typeof v === "object" ? Object.keys(v).length : 0);
  const obj = (v) => (v && typeof v === "object" ? v : null);
  steam = obj(steam);
  gog = obj(gog);
  maps = obj(maps);
  status = obj(status) || {};
  return {
    permissionsGranted: granted,
    steam: steam && {
      apps: count(steam.apps),
      subs: count(steam.subs),
      named: keys(steam.names),
      steamId: steam.steamId,
      method: steam.method,
      fetchedAt: steam.fetchedAt,
      warning: steam.warning
    },
    gog: gog && { ids: count(gog.ids), titled: keys(gog.info), fetchedAt: gog.fetchedAt, warning: gog.warning },
    maps: maps && { builtAt: maps.builtAt, stats: maps.stats },
    status: { ...status, refreshing: !!refreshPromise || !!status.refreshing }
  };
}

async function scheduleAlarm() {
  const settings = await CSO.getSettings();
  const period = CSO.refreshHours(settings) * 60;
  await browser.alarms.clear(ALARM);
  browser.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
}

/* ---------------------------------------------------------------- migration */

// 0.1 kept the API keys inside "settings", which the content scripts read. 0.2 moves them
// to "credentials". Runs on install and startup; a no-op once nothing is left to move.
async function migrateCredentials() {
  const raw = await getLocal("settings", null);
  if (!raw || typeof raw !== "object") return;
  const legacy = Object.keys(CSO.DEFAULT_CREDENTIALS).filter((k) => raw[k] !== undefined);
  if (!legacy.length) return;
  const credentials = await CSO.getCredentials();
  for (const k of legacy) if (!credentials[k] && typeof raw[k] === "string") credentials[k] = raw[k];
  await setLocal({ credentials, settings: CSO.withDefaults(raw) });
  console.warn(`[${CSO.NAME}] moved ${legacy.join(", ")} out of settings into credentials`);
}

/* ---------------------------------------------------------------- events */

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "ensureFresh":
      return ensureFresh();
    case "refreshNow":
      return refreshAll("manual").then(getStatusSummary);
    case "getStatus":
      return getStatusSummary();
    case "resolveGogUrl":
      return resolveGogUrl(msg.gogId);
    case "clearCache":
      return browser.storage.local.remove(["lib_steam", "lib_gog", "itad_cache", "maps", "status"]).then(() => ({ ok: true }));
    default:
      return Promise.resolve({ ok: false, error: `unknown message type ${JSON.stringify(msg && msg.type)}` });
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshAll("alarm");
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) scheduleAlarm();
});

async function boot() {
  await migrateCredentials();
  await scheduleAlarm();
  ensureFresh();
}

browser.runtime.onInstalled.addListener(boot);
browser.runtime.onStartup.addListener(boot);
