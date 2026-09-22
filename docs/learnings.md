# Cross-Store Owned — learnings

Everything discovered while researching, building, and testing the extension on 2026-09-21, when it was still
prototyped under the working name "Double Dip"; its code prefix was already `CSO`, "cross-store owned", which
became the name. Written so the
next person (or the next session) doesn't have to rediscover it. Companion to the [README](../README.md), which
covers usage, and [architecture.md](./architecture.md), which describes the code as it is now.

## 1. Prior art — nothing did both directions

| Project | What it does | Why it wasn't enough |
|---|---|---|
| [SteGOG](https://addons.mozilla.org/en-US/firefox/addon/stegog/) ([source](https://github.com/Ugzuzg/gog-owned-on-steam-extension), MV2, updated Sep 2025) | Steam-owned games badged on gog.com | One direction; ships a hard-coded Steam Web API key; needs you to paste a SteamID64 and have a public profile |
| Steam Owned (Chrome only) | Multi-store, name-based | Manual trigger, name matching only, not on Firefox |
| Augmented Steam + ITAD Collection | "Owned elsewhere" banner + gold highlight on Steam if your GOG library is synced to an ITAD account | Steam side only, needs an ITAD account and public GOG profile; feature request [#2230](https://github.com/IsThereAnyDeal/AugmentedSteam/issues/2230) to badge other stores was closed as not planned |
| Steam → GOG Checker | Shows whether a Steam game *exists* on GOG | Availability, not ownership |

SteGOG's ITAD lookup chain was the right idea and is what this extension uses. Everything else (session-based
library reads, the reverse direction, editions, `n/m`) is new.

## 2. Data sources

### Steam

- **`GET https://store.steampowered.com/dynamicstore/userdata/`** with the browser's cookies returns
  `rgOwnedApps` (apps incl. DLC), `rgOwnedPackages` (subs), wishlist, ignored, etc. Logged out it returns the same
  shape with empty arrays — so "empty" is the only signal you're not logged in. Steam caches this response;
  fetch with `cache: "no-store"` and a throwaway query param. Augmented Steam uses exactly this call. Documented as
  "non-exhaustive": it omits apps without a store page, which is irrelevant for badging store pages.
- **Names without an API key**: `GET /pointssummary/ajaxgetasyncconfig` (logged in) returns
  `{"success":1,"data":{"webapi_token":"<JWT>"}}`. Logged out it returns `"data":[]`. The JWT's `sub` claim is the
  SteamID64, and `IPlayerService/GetOwnedGames/v1/?access_token=<JWT>&steamid=<sub>&include_appinfo=1` accepts it in
  place of `key=`. Both `access_token` and `key` return HTTP 401 when invalid, so the endpoint recognises both.
  This is undocumented; treat it as best-effort (it only feeds the title fallback).
- **API-key method** (`key=` + `steamid=`) needs "Game details" set to Public in Steam privacy settings, otherwise
  `games` is empty with no error. GetOwnedGames returns games only — no DLC, no packages — so the session read is
  still merged in when available.
- Mature-rated app pages redirect a logged-out browser to `/agecheck/app/<id>/`, which has no `data-ds-*` markup.

### GOG

- **`GET /user/data/games`** on either `www.gog.com` or `embed.gog.com` returns `{"owned":[ids…]}` with cookies.
  Logged out it **302s to `/en##openlogin`** (HTML), not a 401 — check the response content-type, not the status.
- **`GET /account/getFilteredProducts?mediaType=1&hiddenFlag={0|1}&sortBy=title&page=N`** returns
  `totalPages`, `products[]` with `id`, `title`, `url` (`/game/<slug>`), `slug`, `image`, `isGame`, `dlcCount`…
  Hidden library items need a second pass with `hiddenFlag=1`. This is the only source of GOG titles/links for
  owned games; GOG has no public library API.
- **`GET https://api.gog.com/products/<id>`** is public (no auth, no CORS problem from an extension) and returns
  `title`, `slug`, `game_type` (`game` / `pack` / `dlc`), `links.product_card`. Used as the lazy fallback for a
  store link when `getFilteredProducts` didn't cover a product.
- **One game, many product IDs.** The Witcher 3 alone has `1207664643` (`game`), `1207664663` (`pack`, the
  "Complete Edition" sold at `/game/the_witcher_3_wild_hunt`) and `1640424747` (`pack`, GOTY, the ID the store
  page actually puts in `card-product`). This is the root cause of the edition problem below.

### IsThereAnyDeal

- **Lookups work without an API key** (verified with plain `curl`): `POST /lookup/id/shop/{shop}/v1` with a JSON
  array of shop IDs → `{shopId: uuid|null}`; `POST /lookup/shop/{shop}/id/v1` with UUIDs → `{uuid: [shopIds]|null}`.
- Shop IDs: Steam = **61**, GOG = **35**. Steam keys are `app/<id>` **or `sub/<id>`** (ITAD returns package IDs
  for editions — e.g. Witcher 3 GOTY → `sub/68476`, `sub/124923`); GOG keys are bare numeric product IDs.
- One UUID maps to several IDs on a store (Cyberpunk → 3 GOG IDs). Reverse lookups therefore give you *all*
  editions ITAD groups together for free — but ITAD keeps some editions as **separate games** (the Witcher 3 GOTY
  pack is `018d937f-3a29-…`, not the base game's `018d937f-1212-…`), so ID mapping alone misses those.
- Documented max is 200 IDs per request; 300 was accepted. Stick to 200. Rate limit with a verified account is
  1000 requests / 5 min; 429 comes with `Retry-After`.
- **Cloudflare in front of the API rejects non-browser user agents** (Python `urllib` → `Error code: 1010`).
  `curl` and real browsers are fine. Not an issue for the extension, but it bit the test proxy.
- The API does not send CORS headers, so a normal web page cannot call it. Extension background scripts with
  `host_permissions` can.

## 3. Store markup

### Steam (server-rendered, stable, well known from Augmented Steam)

- Almost every game element carries `data-ds-appid`; packages/bundles carry `data-ds-packageid` /
  `data-ds-bundleid` **plus a comma-separated `data-ds-appid` list** of the apps inside (e.g. front-page
  `sale_capsule` with `data-ds-appid="3958690,3958700" data-ds-packageid="1390270"`). That list is what makes
  the `n/m` badge possible.
- Search results hide packages/bundles by default, so `n/m` mostly shows on the front page and sale pages.
  Bundle pages list each app as its own `.tab_item[data-ds-appid]`; the bundle element itself has no app list.
- App page: title is `#appHubAppName` (a `div[role=heading]`, display block). DLC rows are
  `a.game_area_dlc_row[data-ds-appid]` — some have an image (`dlc_highlight`), most don't, hence the
  overlay-vs-inline heuristic.
- Tiles nest: the same appid can appear on a wrapper and its child. Processing in document order and skipping
  any element whose nearest badged ancestor has the same key avoids double badges.
- Hidden tab rows (`.tab_row_item`, width 0) still get badges; harmless, they show when the tab opens.
- Page CSP: `connect-src` and `script-src` are locked down (no localhost, no inline `<script src>` from elsewhere),
  but `eval` from a devtools context works. Extension content scripts are not subject to page CSP.

### GOG (two different front-ends)

- **Catalog / search / front page** is Angular. Rendered DOM: `<product-tile>` → `a.product-tile[data-product-id]`
  → `.product-tile__image-wrapper` (cover + release label at top-left) and `.product-tile__info` →
  `.product-tile__title` → `product-title[selenium-id=productTitle]`. Use `productTitle` for the clean name;
  `[selenium-id=productTileGameTitle]` includes label lines like `"DLC\n \nSome Game"` or `"GOOD OLD GAME\n…"`.
  Wishlist heart lives in `.product-tile__footer`, so top-right of the image wrapper is the free corner.
- **Game pages** are AngularJS (`ng-scope` classes). The product ID is `card-product="<id>"` on the page-level
  `div.layout`; the title is `h1.productcard-basics__title`. Related tiles use `product-tile-id="{{ … }}"` and
  nav items `menu-product="{{ … }}"` **before interpolation** — the attribute value literally contains `{{`.
  So: skip non-numeric values without marking them done, and observe those attributes for changes
  (`MutationObserver` with `attributeFilter`), not just child-list mutations.
- The old-style attributes SteGOG handles (`gog-product`, `menu-product`, `product-tile-id`, `card-product`) are
  all still present in Sep 2026, alongside the newer `data-product-id`.
- Mature games show a full-page "17+" overlay to logged-out visitors; the real DOM (and the badge) is rendered
  behind it. There's also a Cookiebot banner that covers the lower half of the page.

## 4. Firefox extension specifics (MV3)

- Firefox supports `"background": {"scripts": [...]}` in MV3 (an event page); no service worker needed. Multiple
  scripts share one global, so `lib/common.js` + `background.js` works like classic script tags.
- `host_permissions` (and content-script `matches`) are granted at install from **Firefox 127+**; earlier versions
  treat them as optional and content scripts silently don't run. Keep a `permissions.contains()` check and a
  `permissions.request()` button (must run inside a user-gesture handler — a click in the popup/options is fine).
- `fetch(url, {credentials: "include"})` from the background sends the site's cookies as long as the host is in
  `host_permissions`. Total Cookie Protection doesn't partition the extension principal. This is how the
  zero-config "use my login" mode works.
- `browser.runtime.onMessage` listeners can return a Promise directly; no `sendResponse` juggling.
- `storage.local` in Firefox is subject to the same quota as IndexedDB (MDN, checked 2026-09-21), so
  `unlimitedStorage` is declared for large libraries; it is a silent permission (no install prompt).
  Content scripts can read `storage.local` and subscribe to `storage.onChanged`, which is simpler than messaging
  the whole map to every tab: the background writes `maps` once, every open store tab re-badges itself.
- MV3 extension pages forbid inline scripts — all page logic lives in external `.js` files.
- `strict_min_version` was 128 in the prototype (first release with `optional_host_permissions`, safely past the
  127 change); it is 140 now, the floor for every extension in this repository.

## 5. Design decisions worth remembering

- **Two-layer matching.** Precise ITAD ID mapping first; normalised-title fallback second, rendered differently
  (dashed ring, "(title match)" in the tooltip) so you can tell certainty apart. The fallback exists purely because
  of GOG's multiple-product-IDs-per-game and ITAD's separate GOTY entries.
- **Title normalisation** (`CSO.normalizeTitle`): NFKD + strip diacritics, lower-case, drop ™®©, `&`→`and`, remove
  apostrophes, collapse non-alphanumerics, then repeatedly strip trailing `<qualifier>? (edition|cut)` and bare
  qualifiers (`goty`, `complete`, `deluxe`, …). Verified: *The Witcher: Enhanced Edition Director's Cut* →
  `the witcher`; *Blade Runner: The Final Cut* → `blade runner`; *Witch's Rhythm Puzzle Soundtrack Edition* →
  `witchs rhythm puzzle soundtrack` (correctly ≠ the base game). "Remastered" alone is deliberately **not**
  stripped — remasters are usually separate products.
- **Steam packages are first-class.** `sub/<id>` keys from ITAD go into `forSteam.subs` and are matched against
  `data-ds-packageid`; on a multi-app tile a matching package counts as owning everything (`altKeys`).
- **`n/m` only for ID matches.** Title matching is skipped when a tile has more than one app — there's no
  per-app title on a bundle tile.
- **Placement heuristic**: `mode: "after"` + expanded pill next to page titles; otherwise overlay if the element
  has an `img/picture/video` and isn't `display: inline`, else inline-prepend. Containers get
  `position: relative` only when computed position is `static`.
- **Never prepend into `#appHubAppName`** — other extensions (Augmented Steam) read its `textContent`.
- **Badge is a `<span role=link>`**, not an `<a>`: tiles are usually anchors, nested anchors are invalid, and
  `preventDefault()` + `stopPropagation()` on the span's click reliably stops the tile navigation.
- **Caching**: every ITAD answer is cached with a timestamp; `null` answers are re-asked after 7 days (games get
  added to ITAD). Second refresh of an unchanged library makes **zero** ITAD calls.
- **Refresh hygiene**: one in-flight refresh at a time; a `refreshing` flag older than 15 min is treated as
  abandoned (event page may have been unloaded); after a failed refresh, page loads don't retry for 10 min.
- **Errors are per store.** If Steam fails and GOG works, the previous Steam library is reused and maps are still
  rebuilt; the popup shows the Steam error.

## 6. How it was tested without a real Firefox

No Node on the machine, and the extension couldn't be loaded into the built-in (Chromium) browser pane. What worked:

- **Content scripts**: inject the concatenated sources into the live store page with a mocked
  `window.browser` (`storage.local.get` returning fake `maps`, `runtime.sendMessage` recording calls), inject the
  CSS via a `<style>`, then assert on `.cso-badge` elements via DOM queries. Verified on Steam search, front page,
  app page, bundle page and on GOG catalog + game page.
- **Same-origin navigation trick**: stash the source in `sessionStorage` to reuse it across pages on the same
  origin without re-pasting 12 KB (it does not survive a cross-origin navigation; `window.name` doesn't either).
- **Background logic**: fetch the files from a local static server on a neutral origin, `new Function(src)` for a
  syntax check, then run `buildMaps()` for real with a fake 3+3-game library. ITAD calls went through a tiny local
  proxy (Python) because the API has no CORS headers — and the proxy needed a browser `User-Agent` for Cloudflare.
- **Gotchas hit along the way**: port 8765 was already in use by another local Python service (returned a JSON
  404 — confusing); a quick-and-dirty comment stripper (`/\*.*?\*/`) ate the `/*` inside `"https://…/*"` host
  permission strings; Steam's CSP blocks both `fetch()` and `<script src>` to localhost so sources had to be
  pasted inline; screenshots of the heavy store pages regularly timed out — DOM assertions were more reliable.
- **Still untested**: the whole thing running inside an actual Firefox profile with real logged-in sessions
  (cookie-bearing background fetches, the options page's `permissions.request`, alarms).

## 7. Ideas not done

- Epic / Humble / itch support — the adapter pattern (`collect / matchKey / matchTitle / describe`) was designed
  for it; ITAD has shop IDs for all of them, but Epic has no library endpoint (would need a bookmarklet or
  Legendary-style login).
- Steam's React wishlist page wasn't inspected for `data-ds-appid`.
- Image-only Steam capsules with empty `alt` get no title, so they only match by ID.
- A "hide DLC badges" toggle was considered and dropped: neither library API reliably flags DLC, so it would have
  been a content-side guess.
- Signing for permanent install (unlisted AMO submission) — see the README's Installation section.
