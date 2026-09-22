/* store.steampowered.com: show a purple GOG badge on games you own on GOG. */
"use strict";

(() => {
  const TILE_SEL = "[data-ds-appid], [data-ds-packageid]";
  const TITLE_SEL = ".title, .tab_item_name, .game_area_dlc_name, .dlc_name, .match_name, .apphub_AppName";

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
        title: apps.length <= 1 ? titleOf(el) : null,
        corner: "tl"
      });
    }
    const page = pageTarget();
    if (page && (root === document || root.contains(page.el))) out.push(page);
    return out;
  }

  CSO.startBadges({
    badgeClass: "gog",
    badgeLetter: "G",
    otherLabel: "GOG",
    attributes: ["data-ds-appid", "data-ds-packageid"],
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
    onHover(badge, others) {
      // No stored GOG URL for this product: ask the background to look it up before the click lands.
      if (badge.dataset.url && !badge.dataset.url.includes("/games?query=") && !badge.dataset.url.endsWith("/account")) return;
      browser.runtime.sendMessage({ type: "resolveGogUrl", gogId: others[0] })
        .then((url) => { if (url) badge.dataset.url = url; })
        .catch(() => {});
    }
  });
})();
