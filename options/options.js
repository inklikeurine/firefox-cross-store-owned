"use strict";

const $ = (id) => document.getElementById(id);
const form = $("form");
const BOTH_PAGE = 150;

let settings = CSO.withDefaults(null);
let credentials = CSO.withCredentialDefaults(null);
let icons = {};
let bothGames = [];
let bothShown = BOTH_PAGE;
let toastTimer = 0;
let filterTimer = 0;

function el(tag, className, text, ...children) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  for (const c of children) if (c) e.append(c);
  return e;
}

function link(text, href, className) {
  const a = el("a", className, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function sentence(s) {
  const t = String(s || "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function toast(text = "Saved") {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

// The badge as the store pages draw it: `store` is the store whose icon it shows.
function badge(store, { maybe = false, iconOnly = false } = {}) {
  const b = el("span", `pv-badge${maybe ? " maybe" : ""}${iconOnly ? " icon-only" : ""}`);
  b.append(CSO.storeIcon(icons, store, 16));
  if (!iconOnly) b.append(`${maybe ? "Maybe owned" : "Owned"} on ${CSO.STORES[store].label}`);
  return b;
}

// The small badge used in lists, linking to the store page.
function pill(store, href, label) {
  const a = link("", href || CSO.STORES[store].home, "pill");
  a.append(CSO.storeIcon(icons, store, 14));
  a.title = label;
  a.setAttribute("aria-label", label);
  return a;
}

/* ---------------------------------------------------------------- the form */

// The form feeds two storage keys: "settings" (read everywhere, including store pages)
// and "credentials" (background and this page only). See lib/common.js.
function refreshHoursFromFields() {
  const value = Math.floor(Number($("refreshValue").value));
  const unit = CSO.REFRESH_UNITS[$("refreshUnit").value] || 1;
  return CSO.refreshHours({ refreshHours: Number.isFinite(value) ? value * unit : NaN });
}

function readSettings() {
  const data = new FormData(form);
  const checked = (name) => form.elements[name].checked;
  return CSO.withDefaults({
    steamMethod: data.get("steamMethod") === "api" ? "api" : "session",
    refreshHours: refreshHoursFromFields(),
    matchByTitle: checked("matchByTitle"),
    showOnSteam: checked("showOnSteam"),
    showOnGog: checked("showOnGog"),
    badgeLabel: data.get("badgeLabel") === "icon" ? "icon" : "words",
    toolbarCount: checked("toolbarCount")
  });
}

function fillRefresh(hours) {
  const { value, unit } = CSO.splitHours(hours);
  $("refreshValue").value = value;
  $("refreshUnit").value = unit;
}

function fillSettings(s) {
  const f = form.elements;
  f.steamMethod.value = s.steamMethod;
  f.matchByTitle.checked = s.matchByTitle;
  f.showOnSteam.checked = s.showOnSteam;
  f.showOnGog.checked = s.showOnGog;
  f.badgeLabel.value = s.badgeLabel;
  f.toolbarCount.checked = s.toolbarCount;
  fillRefresh(s.refreshHours);
  toggleApiFields();
  updatePreview();
}

function fillCredentials(c) {
  form.elements.steamApiKey.value = c.steamApiKey;
  form.elements.steamId64.value = c.steamId64;
  form.elements.itadApiKey.value = c.itadApiKey;
  checkApiKey();
}

function toggleApiFields() {
  $("apiFields").hidden = form.elements.steamMethod.value !== "api";
}

function updatePreview() {
  const f = form.elements;
  const iconOnly = f.badgeLabel.value === "icon";
  const put = (id, b) => {
    const cover = $(id).querySelector(".preview__cover");
    cover.textContent = "";
    cover.append(b);
  };
  put("pvSteam", badge("gog", { iconOnly }));
  put("pvGog", badge("steam", { iconOnly }));
  put("pvMaybe", badge("gog", { iconOnly, maybe: true }));
  const preview = document.querySelector(".preview");
  preview.classList.toggle("off-steam", !f.showOnSteam.checked);
  preview.classList.toggle("off-gog", !f.showOnGog.checked);
  $("pvMaybe").hidden = !f.matchByTitle.checked;
  const lead = $("leadBadge");
  lead.textContent = "";
  lead.append(badge("gog"));
}

async function saveSettings() {
  const next = readSettings();
  fillRefresh(next.refreshHours);   // show the clamped value in its largest whole unit
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  settings = next;
  await browser.storage.local.set({ settings });
  toast();
}

async function saveCredentials(patch) {
  const next = CSO.withCredentialDefaults({ ...credentials, ...patch });
  if (JSON.stringify(next) === JSON.stringify(credentials)) return;
  credentials = next;
  await browser.storage.local.set({ credentials });
  toast();
}

function fieldMessage(input, msgEl, text, kind) {
  msgEl.textContent = text;
  msgEl.className = `field-msg${kind ? ` ${kind}` : ""}`;
  if (kind === "error") input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function checkApiKey() {
  const input = form.elements.steamApiKey;
  const v = input.value.trim();
  const bad = v && !/^[0-9a-f]{32}$/i.test(v);
  fieldMessage(input, $("steamApiKeyMsg"), bad ? "Steam Web API keys are 32 letters and digits — check for a missing or extra character." : "", bad ? "error" : "");
}

// Accepts the 17-digit ID, a /profiles/<id> link, or a custom profile name or /id/<name>
// link (looked up with the API key by the background page).
async function onSteamIdChange() {
  const input = form.elements.steamId64;
  const msg = $("steamIdMsg");
  const raw = input.value.trim();
  if (!raw || /^\d{17}$/.test(raw)) {
    fieldMessage(input, msg, "", "");
    if (raw !== input.value) input.value = raw;
    await saveCredentials({ steamId64: raw });
    return;
  }
  fieldMessage(input, msg, "Looking up…", "");
  let r;
  try {
    r = await browser.runtime.sendMessage({ type: "resolveSteamId", input: raw, apiKey: form.elements.steamApiKey.value.trim() });
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (input.value.trim() !== raw) return;   // edited again meanwhile; that change answers for itself
  if (r && r.ok) {
    input.value = r.steamId;
    fieldMessage(input, msg, `SteamID64 ${r.steamId}`, "ok");
    await saveCredentials({ steamId64: r.steamId });
  } else {
    fieldMessage(input, msg, (r && r.error) || "Could not read that.", "error");
  }
}

form.addEventListener("change", async (ev) => {
  const name = ev.target && ev.target.name;
  if (name === "steamApiKey") {
    checkApiKey();
    await saveCredentials({ steamApiKey: ev.target.value.trim() });
    if (form.elements.steamId64.getAttribute("aria-invalid") === "true") onSteamIdChange();
  } else if (name === "itadApiKey") {
    await saveCredentials({ itadApiKey: ev.target.value.trim() });
  } else if (name === "steamId64") {
    await onSteamIdChange();
  } else if (name) {
    toggleApiFields();
    updatePreview();
    await saveSettings();
  }
});

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});

$("refreshValue").addEventListener("change", saveSettings);
$("refreshUnit").addEventListener("change", saveSettings);

/* ---------------------------------------------------------------- status */

function setTile(id, value, meta, error, loginUrl) {
  const tile = $(id);
  tile.querySelector(".tile__value").textContent = value;
  const m = tile.querySelector(".tile__meta");
  if (meta !== null) {
    m.textContent = meta;
    if (loginUrl) m.append(" · ", link("Log in", loginUrl, "login"));
  }
  tile.classList.toggle("error", !!error);
}

function row(dl, label, value) {
  dl.append(el("dt", "", label), el("dd", "", value));
}

function renderProgress(status) {
  const p = status.refreshing ? status.progress || {} : null;
  $("progress").hidden = !p;
  if (!p) return;
  const total = Number(p.total) || 0;
  const done = Math.min(Number(p.done) || 0, total);
  const bar = $("progressBar");
  $("progressLabel").textContent = total ? `${p.label || "Working"} — ${CSO.formatCount(done)} of ${CSO.formatCount(total)}` : `${p.label || "Reading your libraries"}…`;
  bar.classList.toggle("indeterminate", !total);
  $("progressFill").style.width = total ? `${Math.round((done / total) * 100)}%` : "";
  if (total) {
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(done));
  } else {
    bar.removeAttribute("aria-valuenow");
  }
}

function renderTileIcons() {
  for (const [id, store] of [["tileSteam", "steam"], ["tileGog", "gog"]]) {
    const slot = $(id).querySelector(".tile__icon");
    slot.textContent = "";
    slot.append(CSO.storeIcon(icons, store, 16));
  }
}

async function renderStatus() {
  let s;
  try {
    s = await browser.runtime.sendMessage({ type: "getStatus" });
  } catch (e) {
    const ul = $("messages");
    ul.textContent = "";
    ul.append(el("li", "error", `The extension's background page is not reachable: ${e.message}`));
    return;
  }
  const status = s.status;
  const problems = status.problems || {};
  $("permissions").hidden = s.permissionsGranted;

  // A store's problem is said once, on its tile.
  const storeMeta = (lib, problem) => {
    if (problem) return problem.login ? "Logged out" : sentence(problem.message);
    return lib ? `read ${CSO.since(lib.fetchedAt)}` : "not read yet";
  };
  const login = (store) => (problems[store] && problems[store].login ? CSO.STORES[store].login : "");
  setTile("tileSteam", s.steam ? CSO.formatCount(s.steam.apps + s.steam.subs) : "—", storeMeta(s.steam, problems.steam), problems.steam, login("steam"));
  setTile("tileGog", s.gog ? CSO.formatCount(s.gog.ids) : "—", storeMeta(s.gog, problems.gog), problems.gog, login("gog"));
  const st = s.maps && s.maps.stats;
  const both = st ? (Number(st.ownedOnBoth) || 0) + (settings.matchByTitle ? Number(st.ownedOnBothByTitle) || 0 : 0) : null;
  setTile("tileBoth", both === null ? "—" : CSO.formatCount(both), null, false);
  renderTileIcons();

  const dl = $("status");
  dl.textContent = "";
  if (s.steam) {
    const how = s.steam.method === "api" ? `the Steam Web API${s.steam.steamId ? ` (SteamID ${s.steam.steamId})` : ""}` : "your browser login";
    row(dl, "Steam", `${CSO.plural(s.steam.apps, "game")} and ${CSO.plural(s.steam.subs, "package")} (names for ${CSO.formatCount(s.steam.named)}), read ${CSO.formatWhen(s.steam.fetchedAt)} through ${how}`);
  } else {
    row(dl, "Steam", "not read yet");
  }
  row(dl, "GOG", s.gog ? `${CSO.plural(s.gog.ids, "game")} (names for ${CSO.formatCount(s.gog.titled)}), read ${CSO.formatWhen(s.gog.fetchedAt)}` : "not read yet");
  row(dl, "Badges", st ? `${CSO.plural(st.steamItemsOwnedOnGog, "Steam game")} and ${CSO.plural(st.gogItemsOwnedOnSteam, "GOG game")} get a badge` : "none yet");
  row(dl, "Last refresh", status.refreshing ? "running now" : status.finishedAt ? `finished ${CSO.formatWhen(status.finishedAt)}` : "never");

  renderProgress(status);
  const ul = $("messages");
  ul.textContent = "";
  const { errors, warnings } = CSO.statusMessages(status);
  for (const text of errors) ul.append(el("li", "error", text));
  for (const text of warnings) ul.append(el("li", "warning", text));

  const btn = $("refresh");
  btn.disabled = !!status.refreshing;
  btn.textContent = status.refreshing ? "Refreshing…" : "Refresh now";
}

/* ---------------------------------------------------------------- owned on both */

async function loadBoth() {
  let both = null;
  try {
    ({ both } = await browser.storage.local.get("both"));
  } catch (e) {
    both = null;
  }
  bothGames = both && Array.isArray(both.games) ? both.games.filter((g) => g && typeof g.title === "string" && Array.isArray(g.steam) && Array.isArray(g.gog)) : [];
  renderBoth();
}

// The edition a game's one badge links to: an app over a package, then the shortest name
// (the base game is usually the plain title, editions add words to it).
function baseOf(items, nameOf, isApp) {
  return [...items].sort((a, b) => (isApp(b) - isApp(a)) || ((nameOf(a) || "~").length - (nameOf(b) || "~").length))[0];
}

function renderBoth() {
  const list = $("bothList");
  const note = $("bothNote");
  const more = $("bothMore");
  const q = $("bothFilter").value.trim().toLowerCase();
  const games = bothGames.filter((g) => (settings.matchByTitle || g.via !== "title") && (!q || g.title.toLowerCase().includes(q)));
  const all = bothGames.filter((g) => settings.matchByTitle || g.via !== "title").length;
  $("bothCount").textContent = all ? `· ${CSO.formatCount(all)}` : "";
  list.textContent = "";
  if (!bothGames.length) {
    note.textContent = "Nothing yet — the list fills in once both libraries have been read and matched.";
    more.hidden = true;
    return;
  }
  note.textContent = q && !games.length
    ? "No game in the list matches the filter."
    : "Every game you own on both Steam and GOG, editions grouped together. Entries marked “title match” only share a name.";
  for (const g of games.slice(0, bothShown)) list.append(bothItem(g));
  more.hidden = games.length <= bothShown;
  more.textContent = `Show all ${CSO.formatCount(games.length)}`;
}

function bothItem(g) {
  const li = el("li");
  const steamName = (s) => s.name || `Steam ${s.key.startsWith("sub/") ? "package" : "app"} ${s.key.split("/")[1]}`;
  const gogName = (x) => x.title || `GOG product ${x.id}`;
  const steamBase = baseOf(g.steam, (s) => s.name, (s) => s.key.startsWith("app/"));
  const gogBase = baseOf(g.gog, (x) => x.title, () => true);

  const title = el("span", "title");
  const head = el("span", "", g.title);
  if (g.via === "title") head.append(" ", el("span", "tag", "· title match"));
  title.append(head);
  // One badge per store for the base game; any other editions you own are named underneath.
  const also = [
    ...g.steam.filter((s) => s !== steamBase).map((s) => `${steamName(s)} on Steam`),
    ...g.gog.filter((x) => x !== gogBase).map((x) => `${gogName(x)} on GOG`)
  ];
  if (also.length) title.append(el("span", "also", `Also owned: ${also.join(", ")}`));
  li.append(title);

  const links = el("span", "links");
  if (steamBase) links.append(pill("steam", steamBase.url, `${g.title} on Steam: ${steamName(steamBase)}`));
  if (gogBase) links.append(pill("gog", gogBase.url || "https://www.gog.com/en/account", `${g.title} on GOG: ${gogName(gogBase)}`));
  li.append(links);
  return li;
}

$("bothFilter").addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { bothShown = BOTH_PAGE; renderBoth(); }, 120);
});

$("bothMore").addEventListener("click", () => {
  bothShown = Infinity;
  renderBoth();
});

/* ---------------------------------------------------------------- hidden badges */

async function renderHidden() {
  let stored = {};
  try {
    stored = await browser.storage.local.get(["hidden", "hiddenNames"]);
  } catch (e) {
    stored = {};
  }
  const ids = CSO.hiddenList(stored.hidden);
  const names = CSO.hiddenNames(stored.hiddenNames);
  const list = $("hiddenList");
  list.textContent = "";
  $("hiddenCount").textContent = ids.length ? `· ${ids.length}` : "";
  $("hiddenText").hidden = ids.length > 0;
  $("unhideAll").disabled = !ids.length;
  const rows = ids.map((id) => ({ id, name: names[id] || CSO.describeHidden(id), site: id.startsWith("gog:") ? "GOG" : "Steam" }));
  rows.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  for (const r of rows) {
    const li = el("li");
    const title = el("span", "title");
    title.append(el("span", "", r.name), el("span", "also", `badge hidden on ${r.site}`));
    const btn = el("button", "small", "Show");
    btn.type = "button";
    btn.setAttribute("aria-label", `Show the badge on ${r.name} again`);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await CSO.setHidden(r.id, false);
      toast("Badge shown again");
    });
    li.append(title, btn);
    list.append(li);
  }
}

$("unhideAll").addEventListener("click", async () => {
  await browser.storage.local.set({ hidden: [], hiddenNames: {} });
  toast("All badges shown again");
});

/* ---------------------------------------------------------------- actions */

$("refresh").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    await browser.runtime.sendMessage({ type: "refreshNow" });
  } finally {
    renderStatus();
  }
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Clear the cached libraries and matches? Settings, keys and hidden badges are kept.")) return;
  await browser.runtime.sendMessage({ type: "clearCache" });
  renderStatus();
  toast("Cached data cleared");
});

$("grant").addEventListener("click", async () => {
  const ok = await browser.permissions.request({ origins: CSO.HOST_ORIGINS });
  if (ok) await browser.runtime.sendMessage({ type: "refreshNow" });
  renderStatus();
});

// The background writes `status` at the start, during and at the end of every refresh, and
// `maps` / `both` when the match tables change; those writes drive this page (no polling).
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    const next = CSO.withDefaults(changes.settings.newValue);
    if (JSON.stringify(next) !== JSON.stringify(settings)) {
      settings = next;
      fillSettings(settings);   // changed elsewhere, e.g. "Turn them on" in the popup
    }
    renderBoth();
  }
  if (changes.icons) {
    icons = changes.icons.newValue || {};
    updatePreview();
    renderBoth();
  }
  if (changes.status || changes.maps || changes.settings || changes.icons) renderStatus();
  if (changes.both) loadBoth();
  if (changes.hidden || changes.hiddenNames) renderHidden();
});

(async () => {
  try {
    $("version").textContent = `v${browser.runtime.getManifest().version}`;
  } catch (e) {
    $("version").textContent = "";
  }
  try {
    ({ icons = {} } = await browser.storage.local.get("icons"));
  } catch (e) {
    icons = {};
  }
  settings = await CSO.getSettings();
  credentials = await CSO.getCredentials();
  fillSettings(settings);
  fillCredentials(credentials);
  renderStatus();
  renderHidden();
  await loadBoth();
  if (location.hash === "#both") $("both").scrollIntoView();
})();
