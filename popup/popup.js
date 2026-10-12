"use strict";

const $ = (id) => document.getElementById(id);
const refreshBtn = $("refresh");
const PAGE_ROWS = 5;   // "On this page" shows this many, then "Show all N"

let settings = CSO.withDefaults(null);
let icons = {};
let lastStatus = null;
let lastPage = null;
let pageAll = false;        // "Show all N" clicked
let pageOpen = false;       // "Show" clicked while a search folds the list
let searchTimer = 0;
let searchSeq = 0;

// createElement with a class and text; children appended in order.
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

// The small badge used in the lists: the store's favicon on a dark pill (white for a title match).
function pill(store, href, label, maybe) {
  const a = link("", href || CSO.STORES[store].home, `pill pill--${store}${maybe ? " pill--maybe" : ""}`);
  a.append(CSO.storeIcon(icons, store, 14));
  a.title = label;
  a.setAttribute("aria-label", label);
  return a;
}

const searching = () => $("q").value.trim().length > 0;

/* ---------------------------------------------------------------- status */

function renderStore(store, lib, problem, busy) {
  const card = $(`store-${store}`);
  const count = card.querySelector(".store__count");
  const meta = card.querySelector(".store__meta");
  const login = card.querySelector(".store__login");
  const label = CSO.STORES[store].label;
  const iconSlot = card.querySelector(".store__icon");
  iconSlot.textContent = "";
  iconSlot.append(CSO.storeIcon(icons, store, 16));

  count.textContent = lib ? CSO.plural(lib.count, "item") : "Not read yet";
  let state = lib ? "ok" : "empty";
  let metaText = "";
  if (problem) {
    state = "error";
    metaText = problem.login ? `Logged out${lib ? " · last list kept" : ""}` : sentence(problem.message);
  }
  if (busy) state = "busy";
  card.dataset.state = state;
  meta.textContent = metaText;
  meta.hidden = !metaText;
  login.hidden = !(problem && problem.login);
  card.setAttribute("aria-label", `${label}: ${count.textContent}${metaText ? `, ${metaText}` : ""}`);
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

function renderMessages(status) {
  const ul = $("messages");
  ul.textContent = "";
  const { errors, warnings } = CSO.statusMessages(status);
  for (const text of errors) ul.append(el("li", "error", text));
  for (const text of warnings) ul.append(el("li", "warning", text));
}

function renderSetup(s, status) {
  const firstRun = !s.steam && !s.gog;
  $("setup").hidden = !firstRun;
  $("stores").hidden = firstRun;
  document.querySelector(".bottom").hidden = firstRun;   // step 3 is the Refresh button then
  if (!firstRun) return;
  const problems = status.problems || {};
  $("step-steam").classList.toggle("done", !!s.steam && !problems.steam);
  $("step-gog").classList.toggle("done", !!s.gog && !problems.gog);
  $("setupRefresh").disabled = !!status.refreshing;
}

async function render() {
  let s;
  try {
    s = await browser.runtime.sendMessage({ type: "getStatus" });
  } catch (e) {
    const ul = $("messages");
    ul.textContent = "";
    ul.append(el("li", "error", `The extension's background page is not reachable: ${e.message}`));
    return;
  }
  lastStatus = s;
  const status = s.status;
  const busyStep = status.refreshing && status.progress ? status.progress.step : "";
  $("perm").hidden = s.permissionsGranted;

  renderSetup(s, status);
  renderStore("steam", s.steam && { count: s.steam.apps + s.steam.subs }, status.problems.steam, busyStep === "steam");
  renderStore("gog", s.gog && { count: s.gog.ids }, status.problems.gog, busyStep === "gog");

  const stats = s.maps && s.maps.stats;
  const both = stats ? (Number(stats.ownedOnBoth) || 0) + (settings.matchByTitle ? Number(stats.ownedOnBothByTitle) || 0 : 0) : 0;
  $("both").hidden = !stats;
  $("bothLink").textContent = both ? `You own ${CSO.plural(both, "game")} on both stores →` : "No game is owned on both stores yet";

  renderProgress(status);
  renderMessages(status);
  // Search needs both libraries; until then the box could only ever say "not found".
  $("searchPanel").hidden = !(s.steam && s.gog);

  refreshBtn.disabled = !!status.refreshing;
  refreshBtn.textContent = status.refreshing ? "Refreshing…" : "Refresh now";
  $("last").textContent = status.refreshing ? "" : status.finishedAt ? `Updated ${CSO.since(status.finishedAt)}` : "";
}

/* ---------------------------------------------------------------- on this page */

async function loadPage() {
  let tab;
  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    tab = null;
  }
  let r = null;
  if (tab) {
    try {
      r = await browser.tabs.sendMessage(tab.id, { type: "getPageMatches" });
    } catch (e) {
      r = null;   // not a store page, or a page Firefox keeps extensions out of
    }
  }
  lastPage = r && r.ok ? r : null;
  renderPage();
}

function renderPage() {
  const r = lastPage;
  const section = $("page");
  section.hidden = !r;
  if (!r) return;
  const list = $("pageList");
  const note = $("pageNote");
  const count = $("pageCount");
  const toggle = $("pageToggle");
  const more = $("pageMore");
  list.textContent = "";
  note.textContent = "";
  note.hidden = true;
  count.textContent = "";
  toggle.hidden = true;
  more.hidden = true;

  if (!r.enabled) {
    note.hidden = false;
    note.append(`Badges are turned off for ${r.site === "gog" ? "GOG" : "Steam"} pages. `);
    const on = el("button", "link-btn", "Turn them on");
    on.type = "button";
    on.addEventListener("click", async () => {
      const key = r.site === "gog" ? "showOnGog" : "showOnSteam";
      settings = { ...settings, [key]: true };
      await browser.storage.local.set({ settings });
      setTimeout(loadPage, 250);
    });
    note.append(on);
    return;
  }
  if (!r.mapsReady) {
    note.hidden = false;
    note.textContent = "Matches are not ready yet — they appear once both libraries have been read.";
    return;
  }
  if (!r.items.length) {
    note.hidden = false;
    note.textContent = `Nothing on this page that you own on ${r.otherLabel}.`;
    return;
  }
  const visible = r.items.filter((i) => !i.hidden).length;
  count.textContent = `· ${visible} owned on ${r.otherLabel}`;
  // While you search, the page list folds to its heading so the results fit the popup.
  if (searching() && !pageOpen) {
    toggle.hidden = false;
    note.hidden = false;
    note.textContent = "Folded while you search.";
    return;
  }
  const rows = pageAll ? r.items : r.items.slice(0, PAGE_ROWS);
  for (const item of rows) list.append(pageItem(item, r));
  if (r.items.length > rows.length) {
    more.hidden = false;
    more.textContent = `Show all ${r.items.length}`;
  }
}

function pageItem(item, r) {
  const li = el("li", item.hidden ? "is-hidden" : "");
  const other = r.site === "gog" ? "steam" : "gog";
  li.append(pill(other, item.url, `Open ${item.title} on ${r.otherLabel}`, item.via === "title"));
  const title = el("span", "title", item.title);
  const owned = item.others.find((o) => o.title);
  title.title = owned && owned.title !== item.title ? `${item.title} — owned as “${owned.title}”` : item.title;
  li.append(title);
  if (item.total > 1) li.append(el("span", "tag", `${item.owned}/${item.total}`));
  if (item.via === "title") li.append(el("span", "tag", "title match"));
  const btn = el("button", "link-btn", item.hidden ? "Show" : "Hide");
  btn.type = "button";
  btn.title = item.hidden ? "Show this badge again" : "Hide this badge (for a wrong match)";
  btn.setAttribute("aria-label", `${item.hidden ? "Show" : "Hide"} the badge on ${item.title}`);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await CSO.setHidden(item.id, !item.hidden, item.title);
    // The content script redraws on the storage change; ask again once it has.
    setTimeout(loadPage, 200);
  });
  li.append(btn);
  return li;
}

$("pageToggle").addEventListener("click", () => {
  pageOpen = true;
  renderPage();
});

$("pageMore").addEventListener("click", () => {
  pageAll = true;
  renderPage();
});

/* ---------------------------------------------------------------- search */

async function search() {
  const q = $("q").value;
  const seq = ++searchSeq;
  const list = $("results");
  const note = $("searchNote");
  if (!q.trim()) {
    list.textContent = "";
    note.hidden = true;
    return;
  }
  let r;
  try {
    r = await browser.runtime.sendMessage({ type: "search", query: q });
  } catch (e) {
    r = { ok: false };
  }
  if (seq !== searchSeq) return;   // a newer keystroke already answered
  list.textContent = "";
  note.hidden = false;
  if (!r || !r.ok) {
    note.textContent = "Search is not available right now.";
    return;
  }
  if (!r.ready) {
    note.textContent = "Your libraries have not been read yet.";
    return;
  }
  const hints = [];
  if (lastStatus && lastStatus.steam && !r.steamNames) hints.push("Steam game names are unavailable, so only GOG titles are searched.");
  if (!r.total) {
    note.textContent = ["Not found in your libraries.", ...hints].join(" ");
    return;
  }
  note.textContent = [r.total > r.results.length ? `Showing ${r.results.length} of ${r.total}.` : CSO.plural(r.total, "match", "matches") + ".", ...hints].join(" ");
  for (const item of r.results) {
    const li = el("li");
    li.append(el("span", "title", item.title));
    if (item.via === "title") li.append(el("span", "tag", "title match"));
    const pills = el("span", "pill-group");
    if (item.steam) pills.append(pill("steam", item.steam, `${item.title}: owned on Steam`));
    if (item.gog) pills.append(pill("gog", item.gog, `${item.title}: owned on GOG`));
    li.append(pills);
    list.append(li);
  }
}

$("q").addEventListener("input", () => {
  pageOpen = false;
  renderPage();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 120);
});

/* ---------------------------------------------------------------- actions */

// The background writes `status` when a refresh starts, as it progresses and when it ends,
// and `maps` when the match tables are rebuilt; re-rendering on those writes is all the
// popup needs (no polling).
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) settings = CSO.withDefaults(changes.settings.newValue);
  if (changes.icons) icons = changes.icons.newValue || {};
  if (changes.status || changes.maps || changes.settings || changes.icons) render();
  if (changes.maps || changes.hidden || changes.settings || changes.icons) setTimeout(loadPage, 200);
  if ((changes.both || changes.icons) && $("q").value.trim()) search();
});

function refreshNow(btn) {
  btn.disabled = true;
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";
  browser.runtime.sendMessage({ type: "refreshNow" }).catch(() => {}).then(render);
}

refreshBtn.addEventListener("click", () => refreshNow(refreshBtn));
$("setupRefresh").addEventListener("click", (ev) => refreshNow(ev.currentTarget));

$("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

$("bothLink").addEventListener("click", (ev) => {
  ev.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL("options/options.html#both") });
  window.close();
});

$("grant").addEventListener("click", async () => {
  const ok = await browser.permissions.request({ origins: CSO.HOST_ORIGINS });
  if (ok) browser.runtime.sendMessage({ type: "refreshNow" }).catch(() => {});
  render();
});

(async () => {
  settings = await CSO.getSettings();
  try {
    ({ icons = {} } = await browser.storage.local.get("icons"));
  } catch (e) {
    icons = {};
  }
  await render();
  await loadPage();
})();
