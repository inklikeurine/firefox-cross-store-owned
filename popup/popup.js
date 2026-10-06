"use strict";

const $ = (id) => document.getElementById(id);
const refreshBtn = $("refresh");
const PAGE_LIMIT = 60;

let settings = CSO.withDefaults(null);
let lastStatus = null;
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

/* ---------------------------------------------------------------- status */

function renderStore(store, lib, problem, busy, extra) {
  const card = $(`store-${store}`);
  const count = card.querySelector(".store__count");
  const meta = card.querySelector(".store__meta");
  const login = card.querySelector(".store__login");
  const label = CSO.STORES[store].label;

  count.textContent = lib ? CSO.plural(lib.count, "item") : "Not loaded";
  let state = lib ? "ok" : "empty";
  let metaText = lib ? `${CSO.since(lib.fetchedAt)}${extra ? ` · ${extra}` : ""}` : "";
  if (problem) {
    state = "error";
    metaText = problem.login ? `Not logged in to ${label}${lib ? " — showing the last list read" : ""}` : sentence(problem.message);
  }
  if (busy) state = "busy";
  card.dataset.state = state;
  meta.textContent = metaText;
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
  const problems = status.problems || {};
  // Store problems are shown on the store cards; the rest are listed here.
  const own = [];
  if (problems.match) own.push(`Matching failed: ${problems.match.message}`);
  if (problems.other) own.push(`Refresh failed: ${problems.other.message}`);
  const legacy = Object.keys(problems).length ? [] : status.errors.filter((e) => !/^Both libraries/.test(e));
  for (const text of [...own, ...legacy]) ul.append(el("li", "error", text));
  for (const text of status.warnings) ul.append(el("li", "warning", text));
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

  renderStore("steam", s.steam && { count: s.steam.apps + s.steam.subs, fetchedAt: s.steam.fetchedAt },
    status.problems.steam, busyStep === "steam", s.steam && (s.steam.method === "api" ? "Web API" : "browser login"));
  renderStore("gog", s.gog && { count: s.gog.ids, fetchedAt: s.gog.fetchedAt }, status.problems.gog, busyStep === "gog", "");

  const stats = s.maps && s.maps.stats;
  const both = stats ? (Number(stats.ownedOnBoth) || 0) + (settings.matchByTitle ? Number(stats.ownedOnBothByTitle) || 0 : 0) : 0;
  $("both").hidden = !stats;
  $("bothLink").textContent = both ? `You own ${CSO.plural(both, "game")} on both stores →` : "No game is owned on both stores yet";
  $("intro").hidden = !!stats || status.refreshing;

  renderProgress(status);
  renderMessages(status);

  refreshBtn.disabled = !!status.refreshing;
  refreshBtn.textContent = status.refreshing ? "Refreshing…" : "Refresh now";
  $("last").textContent = status.refreshing ? "" : status.finishedAt ? `Updated ${CSO.since(status.finishedAt)}` : "";
}

/* ---------------------------------------------------------------- on this page */

async function loadPage() {
  const section = $("page");
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
  if (!r || !r.ok) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  renderPage(r);
}

function renderPage(r) {
  const list = $("pageList");
  const note = $("pageNote");
  const heading = $("pageHeading");
  list.textContent = "";
  heading.textContent = "On this page";
  note.textContent = "";
  note.hidden = true;

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
  const visible = r.items.filter((i) => !i.hidden).length;
  heading.append(" ", el("span", "muted", `· ${visible} owned on ${r.otherLabel}`));
  if (!r.items.length) {
    note.hidden = false;
    note.textContent = `Nothing on this page that you own on ${r.otherLabel}.`;
    return;
  }
  for (const item of r.items.slice(0, PAGE_LIMIT)) list.append(pageItem(item, r));
  if (r.items.length > PAGE_LIMIT) list.append(el("li", "muted", `… and ${r.items.length - PAGE_LIMIT} more`));
}

function pageItem(item, r) {
  const li = el("li", item.hidden ? "is-hidden" : "");
  const letter = r.site === "gog" ? "S" : "G";
  const chip = link(letter, item.url || "#", `chip ${r.site === "gog" ? "steam" : "gog"}${item.via === "title" ? " fuzzy" : ""}`);
  chip.title = `Open on ${r.otherLabel}`;
  chip.setAttribute("aria-label", `Open ${item.title} on ${r.otherLabel}`);
  const title = el("span", "title", item.title);
  const other = item.others.find((o) => o.title);
  title.title = other && other.title !== item.title ? `${item.title} — owned as “${other.title}”` : item.title;
  li.append(chip, title);
  if (item.total > 1) li.append(el("span", "tag", `${item.owned}/${item.total}`));
  if (item.via === "title") li.append(el("span", "tag", "title match"));
  const btn = el("button", "link-btn", item.hidden ? "Show" : "Hide");
  btn.type = "button";
  btn.title = item.hidden ? "Show this badge again" : "Hide this badge (for a wrong match)";
  btn.setAttribute("aria-label", `${item.hidden ? "Show" : "Hide"} the badge on ${item.title}`);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await CSO.setHidden(item.id, !item.hidden);
    // The content script redraws on the storage change; ask again once it has.
    setTimeout(loadPage, 200);
  });
  li.append(btn);
  return li;
}

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
    note.textContent = [`Not found in your libraries.`, ...hints].join(" ");
    return;
  }
  note.textContent = [r.total > r.results.length ? `Showing ${r.results.length} of ${r.total}.` : CSO.plural(r.total, "match", "matches") + ".", ...hints].join(" ");
  for (const item of r.results) {
    const li = el("li");
    li.append(el("span", "title", item.title));
    if (item.via === "title") li.append(el("span", "tag", "title match"));
    const links = el("span", "links");
    if (item.steam) {
      const a = link("S", item.steam, "chip steam");
      a.title = "Owned on Steam — open its store page";
      a.setAttribute("aria-label", `${item.title}: owned on Steam`);
      links.append(a);
    }
    if (item.gog) {
      const a = link("G", item.gog, "chip gog");
      a.title = "Owned on GOG — open its page";
      a.setAttribute("aria-label", `${item.title}: owned on GOG`);
      links.append(a);
    }
    li.append(links);
    list.append(li);
  }
}

$("q").addEventListener("input", () => {
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
  if (changes.status || changes.maps || changes.settings) render();
  if (changes.maps || changes.hidden || changes.settings) setTimeout(loadPage, 200);
  if (changes.both && $("q").value.trim()) search();
});

refreshBtn.addEventListener("click", () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";
  browser.runtime.sendMessage({ type: "refreshNow" }).catch(() => {}).then(render);
});

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
  await render();
  await loadPage();
})();
