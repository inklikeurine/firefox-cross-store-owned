/* Background (event page).
 * Fetches the Steam and GOG libraries, resolves cross-store IDs through IsThereAnyDeal,
 * and stores the lookup maps that the content scripts read from storage.local.
 *
 * storage.local layout:
 *   settings    user settings (see CSO.DEFAULT_SETTINGS in lib/common.js); also read by content scripts
 *   credentials Steam Web API key + SteamID64, IsThereAnyDeal key (CSO.DEFAULT_CREDENTIALS); background/options only
 *   hidden      badges the user hid, ["steam:app/55", "gog:2000", …] (CSO.hiddenList); read by content scripts
 *   hiddenNames { "<hidden id>": "game name" } for the settings page's list (CSO.hiddenNames)
 *   icons       each store's favicon as pixels and a PNG data: URL (CSO.iconOf); read by content scripts
 *   lib_steam   { apps: number[], subs: number[], names: {appid: name}, steamId, method, fetchedAt, warning }
 *   lib_gog     { ids: number[], info: {gogId: {title, url}}, fetchedAt, warning }
 *   itad_cache  { steamToItad, gogToItad, itadToSteam, itadToGog }  each {key: {v, t}}
 *   maps        { builtAt, stats, forSteam: {...}, forGog: {...} }   consumed by the content scripts
 *   both        { builtAt, games: [{ title, via, steam: [...], gog: [...] }] }   games owned on both stores
 *   status      { refreshing, startedAt, finishedAt, reason, errors[], warnings[], problems, progress }
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
const FETCH_TIMEOUT_MS = 30e3;      // one request; a refresh is many
const SEARCH_LIMIT = 30;
const BADGE_ERROR_COLOR = "#b3261e";
// The badges show the other store's own favicon. Fetched without cookies, kept a month.
const ICON_SOURCES = { steam: "https://store.steampowered.com/favicon.ico", gog: "https://www.gog.com/favicon.ico" };
const ICON_SIZE = 32;               // stored at 2× the 16 px it is drawn at
const ICON_MAX_AGE = 30 * 86400e3;
const BADGE_BUSY_COLOR = "#5b6470";

let refreshPromise = null;
let liveStatus = null;     // the status object of the refresh in flight, for progress writes
let searchIndex = null;    // built on the first search, dropped when a library or the matches change

/* ---------------------------------------------------------------- storage */

async function getLocal(key, fallback) {
  const r = await browser.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}
const setLocal = (obj) => browser.storage.local.set(obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- fetch */

function timeoutSignal() {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
}

async function fetchJson(url, init = {}) {
  const host = new URL(url).host;
  let res;
  try {
    res = await fetch(url, { cache: "no-store", signal: timeoutSignal(), ...init });
  } catch (e) {
    throw new Error(e && e.name === "TimeoutError" ? `${host} did not answer within ${FETCH_TIMEOUT_MS / 1000} s` : `could not reach ${host} (${e.message})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    const err = new Error(`non-JSON reply from ${host}`);
    err.notJson = true;
    throw err;
  }
  return res.json();
}

// An error that means "log in to this store in Firefox"; the popup offers a login link for it.
function loginError(message) {
  const err = new Error(message);
  err.login = true;
  return err;
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
    throw loginError("not logged in to the Steam store — log in at store.steampowered.com in this browser, then refresh");
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
    console.warn(`[${CSO.NAME}] Steam game names unavailable: ${e.message}`);
    warning = "Steam isn't giving out game names right now, so search and title matches only cover GOG titles. Badges by store ID still work.";
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
    warning = "You're not logged in to the Steam store in Firefox, so DLC and packages you own aren't included.";
  }
  return { apps, subs, names: owned.names, steamId: credentials.steamId64, method: "api", fetchedAt: Date.now(), warning };
}

// A SteamID64 from what the user typed: the ID itself, a /profiles/<id> link, or a custom
// profile name (/id/<name> link or bare) resolved with the Steam Web API key.
async function resolveSteamId(input, apiKey) {
  const s = String(input || "").trim();
  if (/^\d{17}$/.test(s)) return { ok: true, steamId: s };
  const profile = s.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profile) return { ok: true, steamId: profile[1] };
  const fromLink = s.match(/steamcommunity\.com\/id\/([^/?#\s]+)/);
  const vanity = fromLink ? fromLink[1] : /^[A-Za-z0-9_-]{2,32}$/.test(s) ? s : "";
  if (!vanity) return { ok: false, error: "Enter your 17-digit SteamID64 or a link to your Steam profile." };
  const key = String(apiKey || "").trim() || (await CSO.getCredentials()).steamApiKey;
  if (!key) return { ok: false, error: "To look up a custom profile name, enter the Web API key first — or paste the 17-digit SteamID64." };
  try {
    const params = new URLSearchParams({ key, vanityurl: vanity });
    const data = await fetchJson(`${STEAM_API}/ISteamUser/ResolveVanityURL/v1/?${params}`);
    const r = data && data.response;
    if (r && r.success === 1 && /^\d{17}$/.test(String(r.steamid))) return { ok: true, steamId: String(r.steamid) };
    return { ok: false, error: `No Steam profile is called "${vanity}".` };
  } catch (e) {
    return { ok: false, error: `Could not look up "${vanity}": ${e.message}.` };
  }
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
  let data;
  try {
    data = await gogFetch("/user/data/games");
  } catch (e) {
    // Logged out, GOG redirects the library request to its login page (HTML, not a 401).
    if (e.notJson) throw loginError("not logged in to GOG — log in at gog.com in this browser, then refresh");
    throw e;
  }
  const ids = (data.owned || []).map(Number);
  if (!ids.length) throw loginError("empty library — log in at gog.com in this browser, then refresh");

  // Titles and store URLs for tooltips, links, search and title matching (best effort).
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
        await reportProgress({ step: "gog", label: hiddenFlag ? "Reading hidden GOG games" : "Reading GOG game titles", done: page, total: totalPages });
        page++;
      } while (page <= totalPages && page <= 400);
    }
  } catch (e) {
    console.warn(`[${CSO.NAME}] GOG titles only partly read: ${e.message}`);
    warning = "Only some GOG game names could be read, so links, search and title matches may miss some games.";
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
  let res;
  try {
    res = await fetch(ITAD + path, { method: "POST", headers, body: JSON.stringify(body), signal: timeoutSignal() });
  } catch (e) {
    throw new Error(e && e.name === "TimeoutError" ? "IsThereAnyDeal did not answer in time" : `could not reach IsThereAnyDeal (${e.message})`);
  }
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get("Retry-After")) || 15;
    await sleep(wait * 1000);
    return itadPost(path, body, credentials, attempt + 1);
  }
  if (!res.ok) throw new Error(`IsThereAnyDeal answered HTTP ${res.status} for ${path}`);
  return res.json();
}

// Resolve `keys` through one ITAD lookup endpoint, using/refilling the persistent cache.
// `onProgress(done, total)` is called before the first batch and after each one.
async function lookupBatched(path, keys, cache, credentials, onProgress) {
  const now = Date.now();
  const missing = keys.filter((k) => {
    const c = cache[k];
    return !c || (c.v === null && now - c.t > ITAD_NULL_TTL);
  });
  if (missing.length && onProgress) await onProgress(0, missing.length);
  for (let i = 0; i < missing.length; i += ITAD_BATCH) {
    const chunk = missing.slice(i, i + ITAD_BATCH);
    const data = await itadPost(path, chunk, credentials);
    for (const k of chunk) cache[k] = { v: data[k] === undefined ? null : data[k], t: now };
    if (onProgress) await onProgress(Math.min(i + ITAD_BATCH, missing.length), missing.length);
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

// Builds the match tables. Mutates `cache` as answers arrive, so a caller can keep what
// was learned even when a later lookup fails.
async function buildMaps(steam, gog, cache, credentials) {
  for (const k of ["steamToItad", "gogToItad", "itadToSteam", "itadToGog"]) cache[k] = cache[k] || {};

  const steamKeys = [...steam.apps.map((a) => `app/${a}`), ...steam.subs.map((s) => `sub/${s}`)];
  const gogKeys = gog.ids.map(String);
  const step = (n, label) => (done, total) => reportProgress({ step: "match", label: `${label} (${n} of 4)`, done, total });

  // Store IDs -> ITAD game IDs for everything owned on each store.
  const steamToItad = await lookupBatched(`/lookup/id/shop/${ITAD_SHOP.steam}/v1`, steamKeys, cache.steamToItad, credentials, step(1, "Identifying your Steam games"));
  const gogToItad = await lookupBatched(`/lookup/id/shop/${ITAD_SHOP.gog}/v1`, gogKeys, cache.gogToItad, credentials, step(2, "Identifying your GOG games"));
  const ownedSteamByUuid = groupByValue(steamToItad);
  const ownedGogByUuid = groupByValue(gogToItad);

  // ITAD game IDs -> every store ID on the *other* store (all editions ITAD groups together).
  const itadToGog = await lookupBatched(`/lookup/shop/${ITAD_SHOP.gog}/id/v1`, Object.keys(ownedSteamByUuid), cache.itadToGog, credentials, step(3, "Finding your Steam games on GOG"));
  const itadToSteam = await lookupBatched(`/lookup/shop/${ITAD_SHOP.steam}/id/v1`, Object.keys(ownedGogByUuid), cache.itadToSteam, credentials, step(4, "Finding your GOG games on Steam"));

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

  // Normalised-title indexes for the fuzzy fallback (editions ITAD keeps separate). Always
  // built; the "Also match by title" setting is applied where the badges are drawn, so
  // switching it takes effect at once.
  for (const [appid, name] of Object.entries(forGog.steamNames)) {
    const n = CSO.normalizeTitle(name);
    if (n) pushUnique(forGog.steamTitles, n, [`app/${appid}`]);
  }
  for (const [gid, inf] of Object.entries(forSteam.gogInfo)) {
    const n = CSO.normalizeTitle(inf && inf.title);
    if (n) pushUnique(forSteam.gogTitles, n, [String(gid)]);
  }

  const both = findOwnedOnBoth(steam, gog, forSteam, forGog);
  const builtAt = Date.now();
  const stats = {
    steamOwned: steam.apps.length,
    steamPackages: steam.subs.length,
    steamNamed: Object.keys(forGog.steamNames).length,
    gogOwned: gog.ids.length,
    gogTitled: Object.keys(forSteam.gogInfo).length,
    steamItemsOwnedOnGog: Object.keys(forSteam.apps).length + Object.keys(forSteam.subs).length,
    gogItemsOwnedOnSteam: Object.keys(forGog.ids).length,
    ownedOnBoth: both.filter((g) => g.via === "id").length,
    ownedOnBothByTitle: both.filter((g) => g.via === "title").length
  };
  return { maps: { builtAt, stats, forSteam, forGog }, both: { builtAt, games: both } };
}

/* Games you own on both stores: the Steam keys and GOG ids linked by the ID maps, grouped
 * so that every edition of one game is one entry, then (via "title") owned GOG products
 * whose normalised title equals an owned Steam game's and that no ID link covered. */
function findOwnedOnBoth(steam, gog, forSteam, forGog) {
  const ownedSteam = new Set([...steam.apps.map((a) => `app/${a}`), ...steam.subs.map((s) => `sub/${s}`)]);
  const ownedGog = new Set(gog.ids.map(String));
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const link = (a, b) => {
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const g of ownedGog) {
    for (const k of forGog.ids[g] || []) if (ownedSteam.has(k)) link(`gog:${g}`, `steam:${k}`);
  }
  for (const [kind, bucket] of [["app", forSteam.apps], ["sub", forSteam.subs]]) {
    for (const [id, gogIds] of Object.entries(bucket)) {
      const k = `${kind}/${id}`;
      if (!ownedSteam.has(k)) continue;
      for (const g of gogIds) if (ownedGog.has(String(g))) link(`steam:${k}`, `gog:${g}`);
    }
  }

  const groups = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    const grp = groups.get(root) || { steam: [], gog: [] };
    const [store, id] = [node.slice(0, node.indexOf(":")), node.slice(node.indexOf(":") + 1)];
    grp[store].push(id);
    groups.set(root, grp);
  }
  const out = [...groups.values()].map((g) => describeBoth(g.steam, g.gog, "id", steam, gog));

  // Title layer: owned GOG products no ID link covered, matched to owned, named Steam apps.
  const linked = new Set(parent.keys());
  const steamByTitle = {};
  for (const [appid, name] of Object.entries(steam.names || {})) {
    const k = `app/${appid}`;
    if (!ownedSteam.has(k) || linked.has(`steam:${k}`)) continue;
    const n = CSO.normalizeTitle(name);
    if (n) pushUnique(steamByTitle, n, [k]);
  }
  const byTitle = {};
  for (const g of ownedGog) {
    if (linked.has(`gog:${g}`)) continue;
    const n = CSO.normalizeTitle(gog.info && gog.info[g] && gog.info[g].title);
    if (n && steamByTitle[n]) pushUnique(byTitle, n, [g]);
  }
  for (const [n, gogIds] of Object.entries(byTitle)) out.push(describeBoth(steamByTitle[n], gogIds, "title", steam, gog));

  return out.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
}

function describeBoth(steamKeys, gogIds, via, steam, gog) {
  const info = (gog && gog.info) || {};
  const names = (steam && steam.names) || {};
  const steamItems = [...steamKeys].sort().map((key) => {
    const [kind, id] = key.split("/");
    return { key, name: (kind === "app" && names[id]) || "", url: CSO.steamUrl(key) };
  });
  const gogItems = [...gogIds].sort().map((id) => ({
    id: String(id),
    title: (info[id] && info[id].title) || "",
    url: (info[id] && info[id].url) || ""
  }));
  const title = (gogItems.find((g) => g.title) || {}).title ||
    (steamItems.find((s) => s.name) || {}).name ||
    `Steam ${steamItems[0] ? steamItems[0].key : ""}`;
  return { title, via, steam: steamItems, gog: gogItems };
}

/* ---------------------------------------------------------------- search ("Do I own …?") */

// Lower-case, no diacritics or punctuation — but, unlike normalizeTitle, edition words stay.
function foldTitle(s) {
  return String(s || "").replace(/[™®©℠]/g, " ").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

async function buildSearchIndex() {
  const [steam, gog, both] = await Promise.all([getLocal("lib_steam", null), getLocal("lib_gog", null), getLocal("both", null)]);
  const entries = [];
  const covered = new Set();
  const games = both && Array.isArray(both.games) ? both.games : [];
  for (const g of games) {
    entries.push({ title: g.title, via: g.via, steam: g.steam[0] ? g.steam[0].url : "", gog: (g.gog.find((x) => x.url) || {}).url || "https://www.gog.com/en/account" });
    for (const s of g.steam) covered.add(`steam:${s.key}`);
    for (const x of g.gog) covered.add(`gog:${x.id}`);
  }
  const steamOk = steam && typeof steam === "object";
  const gogOk = gog && typeof gog === "object";
  const ownedSteam = new Set(steamOk && Array.isArray(steam.apps) ? steam.apps.map(String) : []);
  if (steamOk && steam.names && typeof steam.names === "object") {
    for (const [appid, name] of Object.entries(steam.names)) {
      if (!name || !ownedSteam.has(appid) || covered.has(`steam:app/${appid}`)) continue;
      entries.push({ title: name, via: "", steam: CSO.steamUrl(`app/${appid}`), gog: "" });
    }
  }
  const ownedGog = new Set(gogOk && Array.isArray(gog.ids) ? gog.ids.map(String) : []);
  if (gogOk && gog.info && typeof gog.info === "object") {
    for (const [id, inf] of Object.entries(gog.info)) {
      if (!inf || !inf.title || !ownedGog.has(id) || covered.has(`gog:${id}`)) continue;
      entries.push({ title: inf.title, via: "", steam: "", gog: inf.url || "https://www.gog.com/en/account" });
    }
  }
  for (const e of entries) e.folded = foldTitle(e.title);
  return {
    entries,
    ready: !!(steamOk || gogOk),
    steamNames: steamOk ? Object.keys(steam.names || {}).length : 0,
    gogTitles: gogOk ? Object.keys(gog.info || {}).length : 0
  };
}

async function searchLibraries(query) {
  const words = foldTitle(query).split(" ").filter(Boolean);
  if (!searchIndex) searchIndex = await buildSearchIndex();
  const idx = searchIndex;
  const base = { ok: true, ready: idx.ready, steamNames: idx.steamNames, gogTitles: idx.gogTitles };
  if (!words.length) return { ...base, total: 0, results: [] };
  const phrase = words.join(" ");
  const hits = [];
  for (const e of idx.entries) {
    if (!words.every((w) => e.folded.includes(w))) continue;
    // Whole title, then title start, then a word start, then anywhere.
    const rank = e.folded === phrase ? 0 : e.folded.startsWith(phrase) ? 1 : (` ${e.folded}`).includes(` ${phrase}`) ? 2 : 3;
    hits.push({ rank, e });
  }
  hits.sort((a, b) => a.rank - b.rank || a.e.title.localeCompare(b.e.title, "en", { sensitivity: "base" }));
  return {
    ...base,
    total: hits.length,
    results: hits.slice(0, SEARCH_LIMIT).map(({ e }) => ({ title: e.title, via: e.via, steam: e.steam, gog: e.gog }))
  };
}

/* ---------------------------------------------------------------- toolbar icon */

// The global badge says whether the libraries are being read ("…") or the last read had a
// problem ("!"). A store tab's own count (setPageCount) overrides it on that tab.
async function updateGlobalBadge(status) {
  const s = status && typeof status === "object" ? status : {};
  const busy = !!s.refreshing;
  const failed = !busy && Array.isArray(s.errors) && s.errors.length > 0;
  try {
    await browser.action.setBadgeText({ text: busy ? "…" : failed ? "!" : "" });
    if (busy || failed) await browser.action.setBadgeBackgroundColor({ color: busy ? BADGE_BUSY_COLOR : BADGE_ERROR_COLOR });
    await browser.action.setTitle({
      title: busy ? "Cross-Store Owned — reading your libraries…" : failed ? "Cross-Store Owned — the last refresh had a problem" : "Cross-Store Owned"
    });
  } catch (e) {
    console.warn(`[${CSO.NAME}] could not update the toolbar badge: ${e.message}`);
  }
}

// A content script reports how many games on its page carry a badge.
async function setPageCount(tab, count, site) {
  if (!tab || typeof tab.id !== "number") return { ok: false, error: "not sent from a tab" };
  const settings = await CSO.getSettings();
  const n = settings.toolbarCount ? Math.max(0, Math.floor(Number(count) || 0)) : 0;
  const tabId = tab.id;
  try {
    if (n) {
      const other = site === "gog" ? "Steam" : "GOG";
      await browser.action.setBadgeText({ tabId, text: n > 999 ? "999+" : String(n) });
      await browser.action.setBadgeBackgroundColor({ tabId, color: CSO.TOOLBAR_COLOR });
      await browser.action.setTitle({ tabId, title: `Cross-Store Owned — ${CSO.plural(n, "game")} on this page you own on ${other}` });
    } else {
      // null hands the tab back to the global badge (which may be "!").
      await browser.action.setBadgeText({ tabId, text: null });
      await browser.action.setBadgeBackgroundColor({ tabId, color: null });
      await browser.action.setTitle({ tabId, title: null });
    }
  } catch (e) {
    return { ok: false, error: e.message };   // the tab closed meanwhile
  }
  return { ok: true, count: n };
}

/* ---------------------------------------------------------------- store icons */

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A favicon file -> { size, rgba, png } at ICON_SIZE px. The background page has a DOM, so
// decoding happens here and the store pages only ever receive pixels.
async function decodeIcon(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, ICON_SIZE, ICON_SIZE);
  const rgba = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
  return { size: ICON_SIZE, rgba: bytesToBase64(new Uint8Array(rgba.buffer)), png: canvas.toDataURL("image/png") };
}

// Fetch any store icon that is missing or older than ICON_MAX_AGE. Best effort: a store that
// cannot be reached keeps its old icon, or the badge falls back to the store's letter.
async function refreshIcons(force) {
  const stored = await getLocal("icons", {});
  const icons = {};
  for (const store of Object.keys(ICON_SOURCES)) if (CSO.iconOf(stored, store)) icons[store] = stored[store];
  let changed = false;
  for (const [store, url] of Object.entries(ICON_SOURCES)) {
    const have = icons[store];
    if (!force && have && Date.now() - (Number(have.fetchedAt) || 0) < ICON_MAX_AGE) continue;
    try {
      const res = await fetch(url, { credentials: "omit", signal: timeoutSignal() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      icons[store] = { ...(await decodeIcon(await res.blob())), fetchedAt: Date.now() };
      changed = true;
    } catch (e) {
      console.warn(`[${CSO.NAME}] could not read the ${CSO.STORES[store].label} icon: ${e.message}`);
    }
  }
  if (changed) await setLocal({ icons });
  return icons;
}

/* ---------------------------------------------------------------- refresh orchestration */

// Merge `progress` into the status of the refresh in flight; the popup and options page
// draw their progress bar from it.
async function reportProgress(progress) {
  if (!liveStatus) return;
  liveStatus = { ...liveStatus, progress };
  await setLocal({ status: liveStatus });
}

async function refreshAll(reason) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const startedAt = Date.now();
    const errors = [];
    const problems = {};
    let warnings = [];
    try {
      const prev = await getLocal("status", {});
      liveStatus = { ...(prev && typeof prev === "object" ? prev : {}), refreshing: true, startedAt, reason, progress: { step: "start", label: "Starting", done: 0, total: 0 } };
      await setLocal({ status: liveStatus });
      updateGlobalBadge(liveStatus);
      warnings = await refreshLibraries(errors, problems);
    } catch (e) {
      errors.push(`Unexpected: ${e.message}`);
      problems.other = { message: e.message };
    }
    liveStatus = null;
    searchIndex = null;   // the libraries or matches may have changed
    if (errors.length) console.warn(`[${CSO.NAME}] refresh (${reason}) finished with errors: ${errors.join(" | ")}`);
    // The popup and options page re-render on this write; it must happen on every path.
    const status = { refreshing: false, startedAt, finishedAt: Date.now(), reason, errors, warnings, problems };
    await setLocal({ status });
    await updateGlobalBadge(status);
    // After the status write, so a slow icon request never holds up the popup.
    await refreshIcons(false).catch((e) => console.warn(`[${CSO.NAME}] store icons: ${e.message}`));
  })().finally(() => {
    liveStatus = null;
    refreshPromise = null;
  });
  return refreshPromise;
}

// Fetch both libraries, rebuild the maps, and return the per-store warnings. Errors go into
// `errors` (display strings) and `problems` (per store, with `login: true` for a login problem).
async function refreshLibraries(errors, problems) {
  const settings = await CSO.getSettings();
  const credentials = await CSO.getCredentials();
  let steam = await getLocal("lib_steam", null);
  let gog = await getLocal("lib_gog", null);
  const fail = (store, label, e) => {
    errors.push(`${label}: ${e.message}`);
    problems[store] = { message: e.message, login: !!e.login };
  };

  try {
    await reportProgress({ step: "steam", label: "Reading your Steam library", done: 0, total: 0 });
    steam = settings.steamMethod === "api" ? await fetchSteamApi(credentials) : await fetchSteamSession();
    await setLocal({ lib_steam: steam });
  } catch (e) {
    fail("steam", "Steam", e);
  }
  try {
    await reportProgress({ step: "gog", label: "Reading your GOG library", done: 0, total: 0 });
    gog = await fetchGogLibrary();
    await setLocal({ lib_gog: gog });
  } catch (e) {
    fail("gog", "GOG", e);
  }

  if (steam && gog) {
    const cache = await getLocal("itad_cache", {});
    try {
      const { maps, both } = await buildMaps(steam, gog, cache, credentials);
      await setLocal({ maps, both });
    } catch (e) {
      fail("match", "Matching", e);
    }
    // What IsThereAnyDeal answered is kept even when a later lookup failed: the next
    // refresh carries on from there instead of asking again.
    await setLocal({ itad_cache: cache });
  } else {
    errors.push("Both libraries are needed before badges can be shown.");
  }
  return [steam && steam.warning, gog && gog.warning].filter(Boolean);
}

// A store page asks whether the libraries are due a refresh. `loggedInOn` names the store
// whose page shows the user logged in: if the last refresh failed because that store was
// logged out, it is retried at once (once — a retry that fails the same way waits as usual).
async function ensureFresh(loggedInOn) {
  const settings = await CSO.getSettings();
  const status = await getLocal("status", {});
  const now = Date.now();
  if (status.refreshing && now - (status.startedAt || 0) < STALE_LOCK_MS) return { refreshing: true };
  const problem = status.problems && loggedInOn && status.problems[loggedInOn];
  if (problem && problem.login && status.reason !== "login") {
    refreshAll("login");
    return { refreshing: true };
  }
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
  let [steam, gog, maps, status, hidden, granted] = await Promise.all([
    getLocal("lib_steam", null),
    getLocal("lib_gog", null),
    getLocal("maps", null),
    getLocal("status", {}),
    getLocal("hidden", []),
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
    maps: maps && { builtAt: maps.builtAt, stats: obj(maps.stats) || {} },
    hidden: CSO.hiddenList(hidden).length,
    status: {
      ...status,
      errors: Array.isArray(status.errors) ? status.errors : [],
      warnings: Array.isArray(status.warnings) ? status.warnings : [],
      problems: obj(status.problems) || {},
      refreshing: !!refreshPromise || !!status.refreshing
    }
  };
}

async function scheduleAlarm() {
  const settings = await CSO.getSettings();
  const period = CSO.refreshHours(settings) * 60;
  await browser.alarms.clear(ALARM);
  browser.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
}

async function clearCache() {
  await browser.storage.local.remove(["lib_steam", "lib_gog", "itad_cache", "maps", "both", "status", "icons"]);
  searchIndex = null;
  await updateGlobalBadge({});
  return { ok: true };
}

/* ---------------------------------------------------------------- migration */

// 0.1 kept the API keys inside "settings", which the content scripts read. 0.2 moved them
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

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case "ensureFresh":
      return ensureFresh(msg.loggedInOn === "steam" || msg.loggedInOn === "gog" ? msg.loggedInOn : null);
    case "refreshNow":
      return refreshAll("manual").then(getStatusSummary);
    case "getStatus":
      return getStatusSummary();
    case "resolveGogUrl":
      return resolveGogUrl(msg.gogId);
    case "resolveSteamId":
      return resolveSteamId(msg.input, msg.apiKey);
    case "search":
      return searchLibraries(msg.query);
    case "pageCount":
      return setPageCount(sender && sender.tab, msg.count, msg.site);
    case "clearCache":
      return clearCache();
    default:
      return Promise.resolve({ ok: false, error: `unknown message type ${JSON.stringify(msg && msg.type)}` });
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshAll("alarm");
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.lib_steam || changes.lib_gog || changes.both) searchIndex = null;
  // Only a new interval moves the schedule; another setting must not postpone the next refresh.
  if (changes.settings) {
    const before = CSO.refreshHours(CSO.withDefaults(changes.settings.oldValue));
    const after = CSO.refreshHours(CSO.withDefaults(changes.settings.newValue));
    if (before !== after || !changes.settings.oldValue) scheduleAlarm();
  }
});

async function boot() {
  await migrateCredentials();
  await scheduleAlarm();
  // At startup or after an update no refresh can be running yet: a stored "refreshing"
  // flag is left over from before and would show a busy icon until the stale-lock timeout.
  let status = await getLocal("status", {});
  if (status && status.refreshing && !refreshPromise) {
    status = { ...status, refreshing: false, progress: null };
    await setLocal({ status });
  }
  await updateGlobalBadge(status);
  ensureFresh(null);
}

browser.runtime.onInstalled.addListener(boot);
browser.runtime.onStartup.addListener(boot);
