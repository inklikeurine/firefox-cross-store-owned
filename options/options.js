"use strict";

const $ = (id) => document.getElementById(id);
const form = $("form");
const BOTH_PAGE = 150;

let settings = CSO.withDefaults(null);
let credentials = CSO.withCredentialDefaults(null);
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

/* ---------------------------------------------------------------- the form */

// The form feeds two storage keys: "settings" (read everywhere, including store pages)
// and "credentials" (background and this page only). See lib/common.js.
function readSettings() {
  const data = new FormData(form);
  const checked = (name) => form.elements[name].checked;
  return CSO.withDefaults({
    steamMethod: data.get("steamMethod") === "api" ? "api" : "session",
    refreshHours: CSO.refreshHours({ refreshHours: data.get("refreshHours") }),
    matchByTitle: checked("matchByTitle"),
    showOnSteam: checked("showOnSteam"),
    showOnGog: checked("showOnGog"),
    badgeText: data.get("badgeText") === "name" ? "name" : "letter",
    toolbarCount: checked("toolbarCount"),
    gogColor: String(data.get("gogColor") || ""),
    steamColor: String(data.get("steamColor") || "")
  });
}

function fillSettings(s) {
  const f = form.elements;
  f.steamMethod.value = s.steamMethod;
  f.refreshHours.value = s.refreshHours;
  f.matchByTitle.checked = s.matchByTitle;
  f.showOnSteam.checked = s.showOnSteam;
  f.showOnGog.checked = s.showOnGog;
  f.badgeText.value = s.badgeText;
  f.toolbarCount.checked = s.toolbarCount;
  f.gogColor.value = s.gogColor;
  f.steamColor.value = s.steamColor;
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
  const root = document.documentElement.style;
  root.setProperty("--pv-gog", f.gogColor.value);
  root.setProperty("--pv-steam", f.steamColor.value);
  const name = f.badgeText.value === "name";
  for (const b of document.querySelectorAll(".pv-badge")) b.textContent = name ? b.dataset.name : b.dataset.letter;
  const preview = document.querySelector(".preview");
  preview.classList.toggle("off-steam", !f.showOnSteam.checked);
  preview.classList.toggle("off-gog", !f.showOnGog.checked);
  document.querySelector(".pv-fuzzy").hidden = !f.matchByTitle.checked;
}

async function saveSettings() {
  const next = readSettings();
  form.elements.refreshHours.value = next.refreshHours;   // show the clamped value
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

// Live preview while a colour picker is open; the setting itself is saved on "change".
form.addEventListener("input", (ev) => {
  if (ev.target && ev.target.type === "color") updatePreview();
});

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});

$("resetColors").addEventListener("click", async () => {
  form.elements.gogColor.value = CSO.DEFAULT_SETTINGS.gogColor;
  form.elements.steamColor.value = CSO.DEFAULT_SETTINGS.steamColor;
  updatePreview();
  await saveSettings();
});

/* ---------------------------------------------------------------- status */

function setTile(id, value, meta, error, loginUrl) {
  const tile = $(id);
  tile.querySelector(".tile__value").textContent = value;
  const m = tile.querySelector(".tile__meta");
  if (meta !== null) {
    m.textContent = meta;
    if (loginUrl) m.append(el("br"), link("Log in", loginUrl, "login"));
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

  const storeMeta = (lib, problem, label) => {
    if (problem) return problem.login ? `Not logged in to ${label}` : sentence(problem.message);
    return lib ? `read ${CSO.since(lib.fetchedAt)}` : "not read yet";
  };
  const login = (store) => (problems[store] && problems[store].login ? CSO.STORES[store].login : "");
  setTile("tileSteam", s.steam ? CSO.formatCount(s.steam.apps + s.steam.subs) : "—", storeMeta(s.steam, problems.steam, "Steam"), problems.steam, login("steam"));
  setTile("tileGog", s.gog ? CSO.formatCount(s.gog.ids) : "—", storeMeta(s.gog, problems.gog, "GOG"), problems.gog, login("gog"));
  const st = s.maps && s.maps.stats;
  const both = st ? (Number(st.ownedOnBoth) || 0) + (settings.matchByTitle ? Number(st.ownedOnBothByTitle) || 0 : 0) : null;
  setTile("tileBoth", both === null ? "—" : CSO.formatCount(both), null, false);

  const dl = $("status");
  dl.textContent = "";
  if (s.steam) {
    const who = s.steam.steamId ? ` (SteamID ${s.steam.steamId})` : "";
    row(dl, "Steam", `${CSO.plural(s.steam.apps, "app")} and ${CSO.plural(s.steam.subs, "package")}, ${CSO.formatCount(s.steam.named)} with names — via ${s.steam.method === "api" ? "Web API" : "browser login"}${who}, ${CSO.formatTime(s.steam.fetchedAt)}`);
  } else {
    row(dl, "Steam", "not loaded yet");
  }
  if (s.gog) {
    row(dl, "GOG", `${CSO.plural(s.gog.ids, "product")}, ${CSO.formatCount(s.gog.titled)} with titles — ${CSO.formatTime(s.gog.fetchedAt)}`);
  } else {
    row(dl, "GOG", "not loaded yet");
  }
  if (st) {
    row(dl, "Matched", `${CSO.formatCount(st.steamItemsOwnedOnGog)} Steam store items carry a GOG badge · ${CSO.formatCount(st.gogItemsOwnedOnSteam)} GOG products carry a Steam badge — built ${CSO.formatTime(s.maps.builtAt)}`);
  } else {
    row(dl, "Matched", "nothing yet");
  }
  row(dl, "Refresh", status.refreshing ? "running…" : `last finished ${CSO.formatTime(status.finishedAt)}`);

  renderProgress(status);
  const ul = $("messages");
  ul.textContent = "";
  for (const text of status.errors) ul.append(el("li", "error", text));
  for (const text of status.warnings) ul.append(el("li", "warning", text));

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
  li.append(el("span", "title", g.title));
  if (g.via === "title") li.append(el("span", "tag", "title match"));
  const links = el("span", "links");
  for (const s of g.steam) {
    const a = link("S", s.url, "chip steam");
    const what = s.name || `Steam ${s.key.startsWith("sub/") ? "package" : "app"} ${s.key.split("/")[1]}`;
    a.title = `On Steam: ${what}`;
    a.setAttribute("aria-label", `${g.title} on Steam: ${what}`);
    links.append(a);
  }
  for (const x of g.gog) {
    const a = link("G", x.url || "https://www.gog.com/en/account", "chip gog");
    const what = x.title || `GOG product ${x.id}`;
    a.title = `On GOG: ${what}`;
    a.setAttribute("aria-label", `${g.title} on GOG: ${what}`);
    links.append(a);
  }
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
  let hidden = [];
  try {
    ({ hidden } = await browser.storage.local.get("hidden"));
  } catch (e) {
    hidden = [];
  }
  const n = CSO.hiddenList(hidden).length;
  $("hiddenText").textContent = n ? `${CSO.plural(n, "badge")} ${n === 1 ? "is" : "are"} hidden.` : "No badges are hidden.";
  $("unhideAll").disabled = !n;
}

$("unhideAll").addEventListener("click", async () => {
  await browser.storage.local.set({ hidden: [] });
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
  if (changes.status || changes.maps || changes.settings) renderStatus();
  if (changes.both) loadBoth();
  if (changes.hidden) renderHidden();
});

(async () => {
  try {
    $("version").textContent = `v${browser.runtime.getManifest().version}`;
  } catch (e) {
    $("version").textContent = "";
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
