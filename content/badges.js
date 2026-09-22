/* Shared badge engine for the store content scripts.
 * A store script calls CSO.startBadges(adapter); the adapter knows how to find game tiles
 * on its site and how to look those games up in the maps built by the background script.
 *
 * adapter = {
 *   badgeClass, badgeLetter, otherLabel,   // "gog" / "G" / "GOG" on Steam pages, etc.
 *   attributes: [...],                     // attributes to watch for late-rendered IDs
 *   collect(root) -> [target],             // {el, keys, altKeys?, title?, container?, mode?, anchor?, corner?, expanded?}
 *   matchKey(maps, key) -> [otherIds]|null,
 *   matchTitle(maps, title) -> [otherIds]|null,
 *   describe(maps, otherId) -> {title, url},
 *   fallbackUrl(otherId, title) -> url,
 *   onHover?(badge, otherIds)
 * }
 */
"use strict";

(() => {
  const ATTR_DONE = "data-cso-done";
  const ATTR_KEY = "data-cso-key";
  const pending = new Set();
  let adapter = null;
  let maps = null;
  let settings = null;
  let flushTimer = 0;

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
      stored = await browser.storage.local.get(["maps", "settings"]);
    } catch (e) {
      console.warn(`[${CSO.NAME}] storage unavailable, no badges on this page: ${e.message}`);
    }
    settings = CSO.withDefaults(stored.settings);
    maps = CSO.isMaps(stored.maps) ? stored.maps : null;
    applyColors();

    browser.runtime.sendMessage({ type: "ensureFresh" }).catch(() => {});

    processTree(document);
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
      if (changes.settings) {
        settings = CSO.withDefaults(changes.settings.newValue);
        applyColors();
      }
      if (changes.maps || changes.settings) {
        clearBadges();
        processTree(document);
      }
    });
  };

  function applyColors() {
    const s = document.documentElement.style;
    s.setProperty("--cso-gog", settings.gogColor || CSO.DEFAULT_SETTINGS.gogColor);
    s.setProperty("--cso-steam", settings.steamColor || CSO.DEFAULT_SETTINGS.steamColor);
  }

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
  }

  function processTree(root) {
    if (!maps) return;
    for (const t of adapter.collect(root)) processTarget(t);
  }

  function clearBadges() {
    for (const b of document.querySelectorAll(".cso-badge")) b.remove();
    for (const el of document.querySelectorAll(`[${ATTR_DONE}]`)) {
      el.removeAttribute(ATTR_DONE);
      el.removeAttribute(ATTR_KEY);
    }
  }

  function processTarget(t) {
    const el = t.el;
    if (!el || el.hasAttribute(ATTR_DONE)) return;
    const keys = t.keys || [];
    const altKeys = t.altKeys || [];
    if (!keys.length && !altKeys.length) return; // ID not rendered yet; try again on the next mutation
    el.setAttribute(ATTR_DONE, "1");

    // Skip nested wrappers that repeat an ancestor's game (Steam nests tiles inside tiles).
    const key = [...keys, ...altKeys].join(",");
    const ancestor = el.parentElement && el.parentElement.closest(`[${ATTR_KEY}]`);
    if (ancestor && ancestor.getAttribute(ATTR_KEY) === key) return;

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

    const badge = makeBadge({ owned, total: Math.max(keys.length, 1), via, others, tileTitle: t.title, expanded: !!t.expanded });
    place(t, badge);
    el.setAttribute(ATTR_KEY, key);
  }

  function makeBadge({ owned, total, via, others, tileTitle, expanded }) {
    const b = document.createElement("span");
    b.className = `cso-badge cso-badge--${adapter.badgeClass}` + (via === "title" ? " cso-badge--fuzzy" : "");
    b.setAttribute("role", "link");
    b.tabIndex = 0;

    const letter = document.createElement("span");
    letter.className = "cso-badge__letter";
    letter.textContent = adapter.badgeLetter;
    b.append(letter);

    if (total > 1) {
      const c = document.createElement("span");
      c.className = "cso-badge__count";
      c.textContent = `${owned}/${total}`;
      b.append(c);
    }

    const described = others.slice(0, 6).map((id) => adapter.describe(maps, id));
    const names = [...new Set(described.map((d) => d.title).filter(Boolean))];
    let head = `Owned on ${adapter.otherLabel}`;
    if (via === "title") head += " (title match)";
    if (total > 1) head += `: ${owned} of ${total}`;
    const tail = names.length ? `${names.join(" • ")}${others.length > 6 ? " …" : ""}` : "";
    b.title = tail ? `${head}: ${tail}` : head;

    if (expanded) {
      b.classList.add("cso-badge--expanded");
      const text = document.createElement("span");
      text.className = "cso-badge__text";
      text.textContent = tail ? `${head}: ${names[0]}${names.length > 1 ? ` (+${names.length - 1})` : ""}` : head;
      b.append(text);
    }

    const first = described.find((d) => d.url);
    b.dataset.url = first ? first.url : adapter.fallbackUrl(others[0], names[0] || tileTitle || "");

    const open = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (b.dataset.url) window.open(b.dataset.url, "_blank", "noopener");
    };
    b.addEventListener("click", open);
    b.addEventListener("auxclick", open);
    b.addEventListener("mousedown", (ev) => ev.stopPropagation());
    b.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") open(ev); });
    if (adapter.onHover) b.addEventListener("mouseenter", () => adapter.onHover(b, others), { once: true });
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
