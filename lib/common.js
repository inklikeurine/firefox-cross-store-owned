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
  badgeLabel: "words",      // "words" = store icon + "Owned on GOG"; "icon" = the store icon alone
  toolbarCount: true        // number of badged games on the current store page, on the toolbar icon
});

// Top-level names in this file are `var`/`function`, never `const`/`let`: the file may be
// injected into the same content-script world twice, and a second `const` would throw.

// Allowed values for the settings that are one of a few strings.
var CSO_CHOICES = {
  steamMethod: ["session", "api"],
  badgeLabel: ["words", "icon"]
};

// Longest refresh interval the settings page offers (4 weeks), in hours.
CSO.MAX_REFRESH_HOURS = 672;

// Toolbar count background: one colour for both stores (the badges carry the store's icon instead).
CSO.TOOLBAR_COLOR = "#1d2229";

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

// The refresh interval in hours, clamped to [1, MAX_REFRESH_HOURS] and defaulting to 6 for garbage.
CSO.refreshHours = function (settings) {
  const n = Number(settings && settings.refreshHours);
  return Number.isFinite(n) && n >= 1 ? Math.min(CSO.MAX_REFRESH_HOURS, Math.floor(n)) : CSO.DEFAULT_SETTINGS.refreshHours;
};

// The settings page shows the interval in the largest whole unit: 48 → 2 days, 336 → 2 weeks.
CSO.REFRESH_UNITS = Object.freeze({ hours: 1, days: 24, weeks: 168 });
CSO.splitHours = function (hours) {
  const h = CSO.refreshHours({ refreshHours: hours });
  if (h % 168 === 0) return { value: h / 168, unit: "weeks" };
  if (h % 24 === 0) return { value: h / 24, unit: "days" };
  return { value: h, unit: "hours" };
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

/* storage.local "hiddenNames": { "<hidden id>": "game name" } for the settings page's list.
 * Badges hidden before names were kept have no entry and are described from their id. */
CSO.hiddenNames = function (value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (CSO.HIDDEN_RE.test(k) && typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 200);
  }
  return out;
};

// "Steam app 55", "Steam package 7", "GOG product 2000": a hidden id without a stored name.
CSO.describeHidden = function (id) {
  const [site, key] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  if (site === "gog") return `GOG product ${key}`;
  const [kind, num] = key.split(",")[0].split("/");
  return `Steam ${kind === "sub" ? "package" : "app"} ${num}${key.includes(",") ? " and others" : ""}`;
};

CSO.setHidden = async function (id, hide, title) {
  const { hidden, hiddenNames } = await browser.storage.local.get(["hidden", "hiddenNames"]);
  const list = CSO.hiddenList(hidden).filter((v) => v !== id);
  const names = CSO.hiddenNames(hiddenNames);
  delete names[id];
  if (hide && CSO.HIDDEN_RE.test(id)) {
    list.push(id);
    if (typeof title === "string" && title.trim()) names[id] = title.trim().slice(0, 200);
  }
  await browser.storage.local.set({ hidden: list, hiddenNames: names });
  return list;
};

/* storage.local "icons": each store's favicon, read by the background page, as
 * { steam: { size, rgba, png, fetchedAt }, gog: {…} } — `rgba` is the base64 of size×size
 * RGBA pixels (drawn on a canvas by the content scripts, so nothing is loaded into the store
 * page), `png` a data: URL for the popup and options page. */
CSO.iconOf = function (icons, store) {
  const i = icons && typeof icons === "object" ? icons[store] : null;
  if (!i || typeof i !== "object") return null;
  const size = Number(i.size);
  if (!Number.isInteger(size) || size < 1 || size > 64 || typeof i.rgba !== "string") return null;
  return { size, rgba: i.rgba, png: typeof i.png === "string" && i.png.startsWith("data:image/png;base64,") ? i.png : "" };
};

// An <img> (with the stored favicon) or a letter fallback, for the popup and options page.
CSO.storeIcon = function (icons, store, size = 16) {
  const icon = CSO.iconOf(icons, store);
  if (icon && icon.png) {
    const img = document.createElement("img");
    img.className = "store-icon";
    img.src = icon.png;
    img.width = size;
    img.height = size;
    img.alt = "";
    return img;
  }
  const s = document.createElement("span");
  s.className = "store-icon store-icon--letter";
  s.textContent = CSO.STORES[store].letter;
  return s;
};

// The status lines the popup and options page list under the store tiles: store problems are
// shown on the tiles themselves, so only matching and unexpected failures are listed here.
CSO.statusMessages = function (status) {
  const s = status && typeof status === "object" ? status : {};
  const problems = s.problems && typeof s.problems === "object" ? s.problems : {};
  const errors = [];
  if (problems.match) errors.push(`Matching the two libraries failed: ${problems.match.message}`);
  if (problems.other) errors.push(`The refresh failed: ${problems.other.message}`);
  if (!Object.keys(problems).length && Array.isArray(s.errors)) {
    // A status written before per-store problems existed.
    for (const e of s.errors) if (!/^Both libraries/.test(e)) errors.push(e);
  }
  return { errors, warnings: Array.isArray(s.warnings) ? s.warnings.filter((w) => typeof w === "string") : [] };
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

// "today at 19:45", "yesterday at 07:10", "3 Oct at 09:00", "3 Oct 2025 at 09:00".
CSO.formatWhen = function (ts, now = Date.now()) {
  if (!ts) return "never";
  const d = new Date(ts);
  const n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400e3);
  if (diff === 0) return `today at ${time}`;
  if (diff === 1) return `yesterday at ${time}`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${d.getDate()} ${month}${d.getFullYear() === n.getFullYear() ? "" : ` ${d.getFullYear()}`} at ${time}`;
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
