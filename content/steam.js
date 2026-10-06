/* store.steampowered.com: show a purple GOG badge on games you own on GOG. */
"use strict";

(() => {
  const TILE_SEL = "[data-ds-appid], [data-ds-packageid]";
  const TITLE_SEL = ".title, .tab_item_name, .game_area_dlc_name, .dlc_name, .match_name, .apphub_AppName";
  // Newer React pages (the wishlist, some hubs) have plain links instead of data-ds-* tiles.
  const LINK_SEL = 'a[href*="/app/"], a[href*="/sub/"]';
  // Header markup: the account menu when logged in, a "login" link when not.
  const LOGGED_IN_SEL = "#account_pulldown";
  const LOGGED_OUT_SEL = 'a.global_action_link[href*="/login"]';

  const splitIds = (v) => (v || "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));

  function titleOf(el) {
    const t = el.querySelector(TITLE_SEL);
    if (t && t.textContent.trim()) return t.textContent.trim();
    const img = el.querySelector("img[alt]");
    if (img && img.alt.trim()) return img.alt.trim();
    return el.getAttribute("title") || null;
  }

  // The current /app/N or /sub/N page: put a full pill under the page title.
  function pageTarget() {
    const m = location.pathname.match(/^\/(app|sub)\/(\d+)/);
    if (!m) return null;
    const h = document.querySelector(m[1] === "app" ? "#appHubAppName" : ".pageheader");
    if (!h) return null;
    return { el: h, keys: [`${m[1]}/${m[2]}`], title: h.textContent.trim(), mode: "after", anchor: h, expanded: true };
  }

  // "app/123" or "sub/45" for a link to a Steam store page, else null.
  function linkKey(href) {
    try {
      const u = new URL(href, location.href);
      if (u.hostname !== "store.steampowered.com") return null;
      const m = u.pathname.match(/^\/(app|sub)\/(\d+)/);
      return m ? `${m[1]}/${m[2]}` : null;
    } catch (e) {
      return null;
    }
  }

  // Image links to a store page that no data-ds-* tile covers: badge the cover.
  function linkTargets(root, out) {
    for (const a of CSO.queryAll(root, LINK_SEL)) {
      if (a.closest(TILE_SEL) || a.querySelector(TILE_SEL)) continue;
      const img = a.querySelector("img, picture");
      if (!img) continue;
      const key = linkKey(a.getAttribute("href"));
      if (!key) continue;
      const alt = a.querySelector("img[alt]");
      const title = (alt && alt.alt.trim()) || a.getAttribute("aria-label") || a.textContent.trim() || null;
      out.push({ el: a, keys: [key], title, corner: "tl" });
    }
  }

  function collect(root) {
    const out = [];
    for (const el of CSO.queryAll(root, TILE_SEL)) {
      const apps = splitIds(el.getAttribute("data-ds-appid")).map((id) => `app/${id}`);
      const subs = splitIds(el.getAttribute("data-ds-packageid")).map((id) => `sub/${id}`);
      if (!apps.length && !subs.length) continue;
      out.push({
        el,
        keys: apps.length ? apps : subs,   // apps are the "n/m" units on bundle/package tiles
        altKeys: apps.length ? subs : [],
        title: apps.length <= 1 ? titleOf(el) : null,   // matched by title only when it names one game
        label: titleOf(el),
        corner: "tl"
      });
    }
    linkTargets(root, out);
    const page = pageTarget();
    if (page && (root === document || root.contains(page.el))) out.push(page);
    return out;
  }

  CSO.startBadges({
    site: "steam",
    badgeClass: "gog",
    badgeLetter: "G",
    otherLabel: "GOG",
    attributes: ["data-ds-appid", "data-ds-packageid", "href"],
    collect,
    matchKey(maps, key) {
      const [kind, id] = key.split("/");
      const bucket = kind === "sub" ? maps.forSteam.subs : maps.forSteam.apps;
      return (bucket && bucket[id]) || null;
    },
    matchTitle(maps, title) {
      const n = CSO.normalizeTitle(title);
      return (n && maps.forSteam.gogTitles && maps.forSteam.gogTitles[n]) || null;
    },
    describe(maps, gogId) {
      const info = maps.forSteam.gogInfo && maps.forSteam.gogInfo[gogId];
      return { title: (info && info.title) || "", url: (info && info.url) || "" };
    },
    fallbackUrl(gogId, title) {
      return title ? `https://www.gog.com/en/games?query=${encodeURIComponent(title)}` : "https://www.gog.com/en/account";
    },
    isLoggedIn() {
      if (document.querySelector(LOGGED_IN_SEL)) return true;
      if (document.querySelector(LOGGED_OUT_SEL)) return false;
      return null;
    },
    onHover(badge, others) {
      // No stored GOG URL for this product: ask the background to look it up before the click lands.
      if (badge.dataset.url && !badge.dataset.url.includes("/games?query=") && !badge.dataset.url.endsWith("/account")) return;
      browser.runtime.sendMessage({ type: "resolveGogUrl", gogId: others[0] })
        .then((url) => { if (url) badge.dataset.url = url; })
        .catch(() => {});
    }
  });
})();
