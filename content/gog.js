/* www.gog.com: show a blue Steam badge on games you own on Steam. */
"use strict";

(() => {
  const ID_ATTRS = ["data-product-id", "card-product", "menu-product", "gog-product", "product-tile-id"];
  const TILE_SEL = ID_ATTRS.map((a) => `[${a}]`).join(", ");
  const TITLE_SEL = "[selenium-id=productTitle], product-title, .product-title, .productcard-basics__title, h1";

  // Returns the numeric product id, or null while an Angular "{{ ... }}" placeholder is still unrendered.
  function idOf(el) {
    for (const a of ID_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null) return /^\d+$/.test(v.trim()) ? v.trim() : null;
    }
    return null;
  }

  function titleOf(el) {
    const t = el.querySelector(TITLE_SEL);
    if (t && t.textContent.trim()) return t.textContent.trim();
    const gt = el.querySelector("[selenium-id=productTileGameTitle]");
    if (gt) {
      // Tile titles may be prefixed with a label line ("DLC", "GOOD OLD GAME"); the title is the last line.
      const lines = gt.textContent.split("\n").map((s) => s.trim()).filter(Boolean);
      if (lines.length) return lines[lines.length - 1];
    }
    const img = el.querySelector("img[alt]");
    if (img && img.alt.trim()) return img.alt.trim();
    return el.getAttribute("title") || null;
  }

  function collect(root) {
    const out = [];
    for (const el of CSO.queryAll(root, TILE_SEL)) {
      const id = idOf(el);
      if (!id) continue;
      if (el.hasAttribute("card-product")) {
        // Game page: the attribute sits on the whole layout, so anchor the pill to the title instead.
        const h = document.querySelector("h1.productcard-basics__title") || el.querySelector("h1");
        if (!h) continue;
        out.push({ el: h, keys: [id], title: h.textContent.trim(), mode: "after", anchor: h, expanded: true });
        continue;
      }
      const cover = el.querySelector(".product-tile__image-wrapper");
      out.push({ el, keys: [id], title: titleOf(el), container: cover || undefined, mode: cover ? "overlay" : undefined, corner: "tr" });
    }
    return out;
  }

  CSO.startBadges({
    badgeClass: "steam",
    badgeLetter: "S",
    otherLabel: "Steam",
    attributes: ID_ATTRS,
    collect,
    matchKey(maps, gogId) {
      return (maps.forGog.ids && maps.forGog.ids[gogId]) || null;
    },
    matchTitle(maps, title) {
      const n = CSO.normalizeTitle(title);
      return (n && maps.forGog.steamTitles && maps.forGog.steamTitles[n]) || null;
    },
    describe(maps, steamKey) {
      const [kind, id] = String(steamKey).split("/");
      const name = maps.forGog.steamNames && maps.forGog.steamNames[id];
      return { title: name || (kind === "sub" ? `Steam package ${id}` : ""), url: `https://store.steampowered.com/${kind}/${id}/` };
    },
    fallbackUrl(steamKey) {
      const [kind, id] = String(steamKey).split("/");
      return `https://store.steampowered.com/${kind}/${id}/`;
    }
  });
})();
