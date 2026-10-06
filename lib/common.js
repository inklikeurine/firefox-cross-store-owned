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
  showOnSteam: true,        // draw GOG badges on store.steampowered.com
  showOnGog: true,          // draw Steam badges on www.gog.com
  badgeText: "letter",      // "letter" = G / S; "name" = GOG / Steam
  toolbarCount: true,       // number of badged games on the current store page, on the toolbar icon
  gogColor: "#7b2fbe",
  steamColor: "#1a9fff"
});

// Top-level names in this file are `var`/`function`, never `const`/`let`: the file may be
// injected into the same content-script world twice, and a second `const` would throw.

// Allowed values for the settings that are one of a few strings.
var CSO_CHOICES = {
  steamMethod: ["session", "api"],
  badgeText: ["letter", "name"]
};
var CSO_COLOR_RE = /^#[0-9a-f]{6}$/i;

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

// The two stores, for labels and links in the popup and options page.
CSO.STORES = Object.freeze({
  steam: Object.freeze({ label: "Steam", letter: "S", home: "https://store.steampowered.com/", login: "https://store.steampowered.com/login/" }),
  gog: Object.freeze({ label: "GOG", letter: "G", home: "https://www.gog.com/", login: "https://www.gog.com/#openlogin" })
});

// Defaults over a stored object, keeping only the keys the defaults define: a missing or
// corrupt value yields the default, and stray keys (a pre-0.2 "settings" that still held
// the API keys, say) are dropped rather than passed along. A stored value of the wrong
// type, or outside a key's allowed choices, is replaced by the default.
function csoPick(defaults, stored) {
  const src = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const v = src[k];
    if (v === undefined || typeof v !== typeof defaults[k]) continue;
    if (CSO_CHOICES[k] && !CSO_CHOICES[k].includes(v)) continue;
    if (/Color$/.test(k) && !CSO_COLOR_RE.test(v)) continue;
    out[k] = v;
  }
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

/* storage.local "hidden": badges the user chose to hide, as "<site>:<tile key>" strings —
 * "steam:app/55" is the badge on Steam app 55, "gog:2000" the badge on GOG product 2000.
 * Read by the content scripts; written by the popup and the options page. */
CSO.HIDDEN_RE = /^(steam:(app|sub)\/\d+(,(app|sub)\/\d+)*|gog:\d+)$/;

CSO.hiddenList = function (value) {
  return Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === "string" && CSO.HIDDEN_RE.test(v)))] : [];
};

CSO.setHidden = async function (id, hide) {
  const { hidden } = await browser.storage.local.get("hidden");
  const list = CSO.hiddenList(hidden).filter((v) => v !== id);
  if (hide && CSO.HIDDEN_RE.test(id)) list.push(id);
  await browser.storage.local.set({ hidden: list });
  return list;
};

// Edition words that may precede "edition"/"cut" at the end of a title.
var OE_EDITION_QUALIFIERS =
  "game of the year|goty|complete|definitive|digital deluxe|deluxe|ultimate|enhanced|gold|premium|" +
  "special|collectors|anniversary|legendary|directors|extended|standard|royal|limited|the final|final|remastered";
var OE_EDITION_TAIL_RE = new RegExp("\\s+(?:(?:" + OE_EDITION_QUALIFIERS + ")\\s+)?(?:edition|cut)$");
// Edition markers that appear without the word "edition" ("Batman: Arkham City GOTY").
var OE_EDITION_BARE_RE = /\s+(?:game of the year|goty|complete|definitive|digital deluxe|deluxe|ultimate|enhanced)$/;

/* Normalise a title so that different editions of the same game compare equal:
 * "The Witcher 3: Wild Hunt - Complete Edition" -> "the witcher 3 wild hunt". */
CSO.normalizeTitle = function (title) {
  if (!title) return "";
  // Trademark marks go first: NFKD would otherwise expand "™" into the letters "TM".
  let t = String(title).replace(/[™®©℠]/g, " ");
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(/&/g, " and ").replace(/['’`]/g, "");
  t = t.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(OE_EDITION_TAIL_RE, "").replace(OE_EDITION_BARE_RE, "").trim();
    if (t === before) break;
  }
  return t;
};

/* Store links built from IDs. */
CSO.steamUrl = function (key) {
  const [kind, id] = String(key).split("/");
  return `https://store.steampowered.com/${kind === "sub" ? "sub" : "app"}/${id}/`;
};

CSO.formatTime = function (ts) {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString();
};

// "just now", "5 min ago", "3 h ago", "2 days ago".
CSO.since = function (ts, now = Date.now()) {
  if (!ts) return "never";
  const mins = Math.round((now - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
};

// 1234 -> "1,234"; anything that is not a finite number -> "0".
CSO.formatCount = function (n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "0";
};

// "1 game" / "3 games".
CSO.plural = function (n, one, many = `${one}s`) {
  return `${CSO.formatCount(n)} ${n === 1 ? one : many}`;
};
