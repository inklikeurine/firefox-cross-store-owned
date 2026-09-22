/* Shared helpers for Cross-Store Owned.
 * Loaded by the background page, both content scripts, and the options/popup pages. */
"use strict";

var CSO = globalThis.CSO || (globalThis.CSO = {});

CSO.NAME = "cross-store-owned";   // log prefix and DOM marker

// storage.local "settings": behaviour and appearance. Read by every part of the extension,
// including the content scripts on store pages, so nothing secret or personal lives here.
CSO.DEFAULT_SETTINGS = Object.freeze({
  steamMethod: "session",   // "session" = use the browser's Steam login; "api" = Steam Web API key + SteamID64
  refreshHours: 6,
  matchByTitle: true,       // fuzzy fallback: match by normalised title when no ID mapping exists
  gogColor: "#7b2fbe",
  steamColor: "#1a9fff"
});

// storage.local "credentials": what the user types in from a key page. Read only by the
// background page and the options page — never by a content script. Stored unencrypted
// (an extension has nowhere to keep a key that a reader of the profile could not also read).
CSO.DEFAULT_CREDENTIALS = Object.freeze({
  steamApiKey: "",          // Steam Web API key, "api" method only
  steamId64: "",            // SteamID64, "api" method only
  itadApiKey: ""            // optional; IsThereAnyDeal lookups currently work without one
});

// Every origin the background script needs to fetch from. Also used to check/request permissions.
CSO.HOST_ORIGINS = [
  "https://store.steampowered.com/*",
  "https://api.steampowered.com/*",
  "https://www.gog.com/*",
  "https://embed.gog.com/*",
  "https://api.gog.com/*",
  "https://api.isthereanydeal.com/*"
];

// Defaults over a stored object, keeping only the keys the defaults define: a missing or
// corrupt value yields the defaults, and stray keys (a pre-0.2 "settings" that still held
// the API keys, say) are dropped rather than passed along.
function csoPick(defaults, stored) {
  const src = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

CSO.withDefaults = (settings) => csoPick(CSO.DEFAULT_SETTINGS, settings);
CSO.withCredentialDefaults = (credentials) => csoPick(CSO.DEFAULT_CREDENTIALS, credentials);

async function csoRead(key, defaults) {
  let value;
  try {
    ({ [key]: value } = await browser.storage.local.get(key));
  } catch (e) {
    console.warn(`[${CSO.NAME}] could not read ${key}, using defaults: ${e.message}`);
  }
  return csoPick(defaults, value);
}

CSO.getSettings = () => csoRead("settings", CSO.DEFAULT_SETTINGS);
CSO.getCredentials = () => csoRead("credentials", CSO.DEFAULT_CREDENTIALS);

// The refresh interval in hours, clamped to [1, 168] and defaulting to 6 for garbage.
CSO.refreshHours = function (settings) {
  const n = Number(settings && settings.refreshHours);
  return Number.isFinite(n) && n >= 1 ? Math.min(168, Math.floor(n)) : CSO.DEFAULT_SETTINGS.refreshHours;
};

// True when a stored "maps" value has the shape the content scripts read.
CSO.isMaps = function (maps) {
  return !!(maps && typeof maps === "object" && maps.forSteam && typeof maps.forSteam === "object" &&
    maps.forGog && typeof maps.forGog === "object");
};

// Edition words that may precede "edition"/"cut" at the end of a title.
const OE_EDITION_QUALIFIERS =
  "game of the year|goty|complete|definitive|digital deluxe|deluxe|ultimate|enhanced|gold|premium|" +
  "special|collectors|anniversary|legendary|directors|extended|standard|royal|limited|the final|final|remastered";
const OE_EDITION_TAIL_RE = new RegExp("\\s+(?:(?:" + OE_EDITION_QUALIFIERS + ")\\s+)?(?:edition|cut)$");
// Edition markers that appear without the word "edition" ("Batman: Arkham City GOTY").
const OE_EDITION_BARE_RE = /\s+(?:game of the year|goty|complete|definitive|digital deluxe|deluxe|ultimate|enhanced)$/;

/* Normalise a title so that different editions of the same game compare equal:
 * "The Witcher 3: Wild Hunt - Complete Edition" -> "the witcher 3 wild hunt". */
CSO.normalizeTitle = function (title) {
  if (!title) return "";
  // Trademark marks go first: NFKD would otherwise expand "\u2122" into the letters "TM".
  let t = String(title).replace(/[\u2122\u00ae\u00a9\u2120]/g, " ");
  t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  t = t.replace(/&/g, " and ").replace(/['\u2019`]/g, "");
  t = t.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(OE_EDITION_TAIL_RE, "").replace(OE_EDITION_BARE_RE, "").trim();
    if (t === before) break;
  }
  return t;
};

CSO.formatTime = function (ts) {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString();
};
