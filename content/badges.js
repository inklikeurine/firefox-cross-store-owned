/* Shared badge engine for the store content scripts.
 * A store script calls CSO.startBadges(adapter); the adapter knows how to find game tiles
 * on its site and how to look those games up in the maps built by the background script.
 *
 * adapter = {
 *   site,                                  // "steam" / "gog": the store this page belongs to
 *   badgeClass, badgeLetter, otherLabel,   // "gog" / "G" / "GOG" on Steam pages, etc.
 *   attributes: [...],                     // attributes to watch for late-rendered or changed IDs
 *   collect(root) -> [target],             // {el, keys, altKeys?, title?, label?, container?, mode?, anchor?, corner?, expanded?}
 *                                          //   title: matched by name; label: shown in the popup (defaults to title)
 *   matchKey(maps, key) -> [otherIds]|null,
 *   matchTitle(maps, title) -> [otherIds]|null,
 *   describe(maps, otherId) -> {title, url},
 *   fallbackUrl(otherId, title) -> url,
 *   onHover?(badge, otherIds),
 *   isLoggedIn?() -> true|false|null       // what the page shows; null when it cannot tell
 * }
 */
"use strict";

(() => {
  const ATTR_DONE = "data-cso-done";   // on every tile looked at; value = the IDs it was looked at with
  const ATTR_KEY = "data-cso-key";     // on tiles that matched (badged or hidden by the user)
  const pending = new Set();
  const badgeOf = new WeakMap();       // tile element -> its badge
  const found = new Map();             // tile IDs -> what the popup's "On this page" lists
  let adapter = null;
  let maps = null;
  let settings = null;
  let hidden = new Set();
  let flushTimer = 0;
  let reportTimer = 0;
  let lastReport = "";

  CSO.queryAll = function (root, selector) {
    const out = root.matches && root.matches(selector) ? [root] : [];
    if (root.querySelectorAll) out.push(...root.querySelectorAll(selector));
    return out;
  };

  CSO.startBadges = async function (a) {
    // Idempotent: a second injection into the same document (all_frames, manual re-injection)
    // must not attach a second observer. The mark lives on the document, so a reload starts fresh.
    const root = document.documentElement;
    if (root.hasAttribute(`data-${CSO.NAME}`)) return;
    root.setAttribute(`data-${CSO.NAME}`, a.badgeClass);
    adapter = a;
    let stored = {};
    try {
      stored = await browser.storage.local.get(["maps", "settings", "hidden"]);
    } catch (e) {
      console.warn(`[${CSO.NAME}] storage unavailable, no badges on this page: ${e.message}`);
    }
    settings = CSO.withDefaults(stored.settings);
    maps = CSO.isMaps(stored.maps) ? stored.maps : null;
    hidden = new Set(CSO.hiddenList(stored.hidden));
    applyColors();

    let loggedIn = null;
    try {
      loggedIn = adapter.isLoggedIn ? adapter.isLoggedIn() : null;
    } catch (e) {
      loggedIn = null;
    }
    browser.runtime.sendMessage({ type: "ensureFresh", loggedInOn: loggedIn ? adapter.site : null }).catch(() => {});
    browser.runtime.onMessage.addListener(onMessage);

    processTree(document);
    scheduleReport();
    const observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: adapter.attributes
    });

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.maps) maps = CSO.isMaps(changes.maps.newValue) ? changes.maps.newValue : null;
      if (changes.hidden) hidden = new Set(CSO.hiddenList(changes.hidden.newValue));
      if (changes.settings) {
        settings = CSO.withDefaults(changes.settings.newValue);
        applyColors();
      }
      if (changes.maps || changes.settings || changes.hidden) {
        clearBadges();
        processTree(document);
        scheduleReport(true);
      }
    });
  };

  function enabled() {
    return adapter.site === "gog" ? settings.showOnGog : settings.showOnSteam;
  }

  function applyColors() {
    const s = document.documentElement.style;
    s.setProperty("--cso-gog", settings.gogColor || CSO.DEFAULT_SETTINGS.gogColor);
    s.setProperty("--cso-steam", settings.steamColor || CSO.DEFAULT_SETTINGS.steamColor);
  }

  /* ---------------------------------------------------------------- popup and toolbar */

  // tabs.sendMessage from the popup. Only one message type is addressed to content scripts.
  function onMessage(msg) {
    if (msg && msg.type === "getPageMatches") return Promise.resolve(pageMatches());
    return Promise.resolve({ ok: false, error: `unknown message type ${JSON.stringify(msg && msg.type)}` });
  }

  function liveEntries() {
    for (const [sig, e] of found) {
      e.els = e.els.filter((el) => el.isConnected && el.getAttribute(ATTR_KEY) === sig);
      if (!e.els.length) found.delete(sig);
    }
    return [...found.values()];
  }

  function pageMatches() {
    const items = liveEntries().map((e) => ({
      id: e.id,
      title: e.title,
      via: e.via,
      owned: e.owned,
      total: e.total,
      others: e.others,
      url: e.url,
      hidden: hidden.has(e.id)
    }));
    items.sort((x, y) => x.title.localeCompare(y.title, "en", { sensitivity: "base" }));
    return { ok: true, site: adapter.site, otherLabel: adapter.otherLabel, enabled: enabled(), mapsReady: !!maps, items };
  }

  // Tell the background how many games on this page carry a badge (the toolbar count).
  // Debounced; repeated when the address changes, because Firefox clears a tab's count on navigation.
  function scheduleReport(force) {
    if (force) lastReport = "";
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = 0;
      const count = liveEntries().filter((e) => !hidden.has(e.id)).length;
      const signature = `${count}|${location.href}`;
      if (signature === lastReport) return;
      lastReport = signature;
      browser.runtime.sendMessage({ type: "pageCount", count, site: adapter.site }).catch(() => {});
    }, 400);
  }

  /* ---------------------------------------------------------------- finding tiles */

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === "attributes") {
        pending.add(m.target);
      } else {
        for (const n of m.addedNodes) if (n.nodeType === 1) pending.add(n);
      }
    }
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  }

  function flush() {
    flushTimer = 0;
    const nodes = [...pending];
    pending.clear();
    for (const n of nodes) {
      if (!n.isConnected || n.classList.contains("cso-badge") || n.closest(".cso-badge")) continue;
      processTree(n);
    }
    scheduleReport();
  }

  function processTree(root) {
    if (!maps || !enabled()) return;
    for (const t of adapter.collect(root)) processTarget(t);
  }

  function clearBadges() {
    for (const b of document.querySelectorAll(".cso-badge")) b.remove();
    for (const el of document.querySelectorAll(`[${ATTR_DONE}]`)) {
      el.removeAttribute(ATTR_DONE);
      el.removeAttribute(ATTR_KEY);
    }
    found.clear();
  }

  // The page reused a tile element for another game: drop what was drawn for the old one.
  function unbadge(el) {
    const b = badgeOf.get(el);
    if (b) b.remove();
    badgeOf.delete(el);
    el.removeAttribute(ATTR_KEY);
  }

  function processTarget(t) {
    const el = t.el;
    if (!el) return;
    const keys = t.keys || [];
    const altKeys = t.altKeys || [];
    if (!keys.length && !altKeys.length) return; // ID not rendered yet; try again on the next mutation
    const sig = [...keys, ...altKeys].join(",");
    const seen = el.getAttribute(ATTR_DONE);
    if (seen === sig) return;
    if (seen !== null) unbadge(el);
    el.setAttribute(ATTR_DONE, sig);

    // Skip nested wrappers that repeat an ancestor's game (Steam nests tiles inside tiles).
    const ancestor = el.parentElement && el.parentElement.closest(`[${ATTR_KEY}]`);
    if (ancestor && ancestor.getAttribute(ATTR_KEY) === sig) return;

    let owned = 0;
    let via = "id";
    const others = [];
    const add = (ids) => { for (const id of ids) if (!others.includes(id)) others.push(id); };

    for (const k of keys) {
      const m = adapter.matchKey(maps, k);
      if (m && m.length) { owned++; add(m); }
    }
    // A matching package/bundle key counts as owning the whole thing.
    for (const k of altKeys) {
      const m = adapter.matchKey(maps, k);
      if (m && m.length) { owned = Math.max(owned, keys.length || 1); add(m); }
    }
    if (!owned && settings.matchByTitle && t.title && keys.length <= 1) {
      const m = adapter.matchTitle(maps, t.title);
      if (m && m.length) { owned = 1; via = "title"; add(m); }
    }
    if (!owned) return;

    el.setAttribute(ATTR_KEY, sig);
    const total = Math.max(keys.length, 1);
    const described = others.slice(0, 6).map((id) => adapter.describe(maps, id));
    const names = [...new Set(described.map((d) => d.title).filter(Boolean))];
    const firstUrl = (described.find((d) => d.url) || {}).url;
    const url = firstUrl || adapter.fallbackUrl(others[0], names[0] || t.title || "");
    const id = `${adapter.site}:${sig}`;

    const entry = found.get(sig) || {
      id,
      title: (t.label || t.title || names[0] || "").trim() || (adapter.site === "steam" ? `Steam ${sig}` : `GOG product ${sig}`),
      via,
      owned,
      total,
      others: described.map((d) => ({ title: d.title, url: d.url })),
      url,
      els: []
    };
    entry.els.push(el);
    found.set(sig, entry);

    if (hidden.has(id)) return;
    const badge = makeBadge({ owned, total, via, names, more: others.length > 6, url, expanded: !!t.expanded, others });
    place(t, badge);
    badgeOf.set(el, badge);
  }

  /* ---------------------------------------------------------------- the badge */

  function makeBadge({ owned, total, via, names, more, url, expanded, others }) {
    const b = document.createElement("span");
    b.className = `cso-badge cso-badge--${adapter.badgeClass}` + (via === "title" ? " cso-badge--fuzzy" : "");
    if (settings.badgeText === "name") b.classList.add("cso-badge--name");
    b.setAttribute("role", "link");
    b.tabIndex = 0;

    const letter = document.createElement("span");
    letter.className = "cso-badge__letter";
    letter.textContent = settings.badgeText === "name" ? adapter.otherLabel : adapter.badgeLetter;
    b.append(letter);

    if (total > 1) {
      const c = document.createElement("span");
      c.className = "cso-badge__count";
      c.textContent = `${owned}/${total}`;
      b.append(c);
    }

    let head = `Owned on ${adapter.otherLabel}`;
    if (via === "title") head += " (title match)";
    if (total > 1) head += `: ${owned} of ${total}`;
    const tail = names.length ? `${names.join(" • ")}${more ? " …" : ""}` : "";
    const line = tail ? `${head}: ${tail}` : head;
    const note = via === "title" ? "\nMatched by name, not by store ID — it may be a different edition." : "";
    b.title = `${line}${note}`;
    b.setAttribute("aria-label", `${line}. Opens ${adapter.otherLabel} in a new tab.`);

    if (expanded) {
      b.classList.add("cso-badge--expanded");
      const text = document.createElement("span");
      text.className = "cso-badge__text";
      text.textContent = tail ? `${head}: ${names[0]}${names.length > 1 ? ` (+${names.length - 1})` : ""}` : head;
      b.append(text);
    }

    b.dataset.url = url;

    const open = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (b.dataset.url) window.open(b.dataset.url, "_blank", "noopener");
    };
    b.addEventListener("click", open);
    b.addEventListener("auxclick", (ev) => { if (ev.button === 1) open(ev); });
    b.addEventListener("mousedown", (ev) => ev.stopPropagation());
    b.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") open(ev); });
    if (adapter.onHover) {
      const hover = () => adapter.onHover(b, others);
      b.addEventListener("mouseenter", hover, { once: true });
      b.addEventListener("focus", hover, { once: true });
    }
    return b;
  }

  function autoMode(el) {
    const display = getComputedStyle(el).display;
    if (display === "inline" || display === "contents") return "inline";
    return el.querySelector("img, picture, video") ? "overlay" : "inline";
  }

  function place(t, badge) {
    const mode = t.mode || autoMode(t.el);
    if (mode === "after") {
      badge.classList.add("cso-badge--inline");
      (t.anchor || t.el).insertAdjacentElement("afterend", badge);
    } else if (mode === "inline") {
      badge.classList.add("cso-badge--inline");
      (t.anchor || t.el).prepend(badge);
    } else {
      const container = t.container || t.el;
      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      badge.classList.add("cso-badge--overlay", t.corner === "tr" ? "cso-tr" : "cso-tl");
      container.append(badge);
    }
  }
})();
