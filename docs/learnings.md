# Cross-Store Owned — learnings

The research behind the extension: prior art, the endpoints and their quirks, store markup, and the design
decisions worth remembering, so the next person doesn't have to rediscover them. Companion to the
[README](../README.md), which covers usage, and [architecture.md](./architecture.md), which describes the code.

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
- Header: logged in, the account menu is `#account_pulldown`; logged out, there is an
  `a.global_action_link` to `/login`. Augmented Steam reads the same element. The adapter uses it only as a
  hint (a fresh login after a failed read triggers one retry), never as proof.
- Newer React pages (the 2024 wishlist, some hubs) render capsules as plain `<a href="/app/<id>/…"><img>`
  without `data-ds-*`; the adapter's link fallback badges those image links and ignores text links, so a
  page's prose links to games stay clean.
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
- `strict_min_version` is 140, the floor for every extension in this repository; anything from 128 (the first
  release with `optional_host_permissions`, past the 127 host-permission change) would work.
- **Toolbar badge per tab** (`action.setBadgeText({ tabId })`) is reset by Firefox when the tab navigates, and a
  `null` text hands the tab back to the global text ("" would show nothing instead). Neither needs a permission.
- **`tabs.sendMessage` needs no `tabs` permission**, so the popup can ask the active tab's content script for its
  matches; on a page without one it rejects, which the popup treats as "not a store page".
- **A content-script file may run twice in one world** (re-injection); top-level `const`/`let` then throws on the
  second run, `var` and `function` do not.
- **`autocomplete` on a password input**: Firefox's `input.autocomplete` property does not return the attribute
  value; read it with `getAttribute`. `autocomplete="new-password"` keeps the login manager from offering to save
  a key typed on an extension page.

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
  abandoned (event page may have been unloaded) and one found at startup is cleared; after a failed refresh,
  page loads don't retry for 10 min — except one immediate retry when a Steam page shows the user logged in
  after a Steam login failure. The ITAD cache is saved even when a later lookup fails.
- **Errors are per store**, and a logged-out store is a *login* problem the UI can act on (a **Log in** button)
  rather than an error string. If Steam fails and GOG works, the previous Steam library is reused and maps are
  still rebuilt.
- **Title indexes are always built**; "Also match by title" is applied where badges are drawn, so switching it
  needs no refresh.
- **Owned on both** is a union-find over the ID links (so every edition of one game is one entry), then a title
  layer for owned GOG products no link covered. Search folds titles like the normaliser but keeps edition words,
  so "complete edition" finds the Complete Edition.
- **Hiding is by tile IDs on the page's store** (`steam:app/55`), not by match: a hidden Steam app stays hidden
  whichever GOG product it matched, and the page pill and every tile of that app go together.
- **Elements get re-used by the stores' front-ends** (React rows, Angular attributes): the engine remembers which
  IDs it looked at per element and redoes the element when they change.

## 6. Testing notes

How the extension is tested is in [development.md](./development.md); the facts below are what makes testing it
awkward and are worth knowing before trying something new.

- **Store pages cannot load local test code.** Steam's CSP blocks both `fetch()` and `<script src>` to
  localhost, so a script pasted into a live store page has to be inline. Extension content scripts are not subject
  to the page CSP.
- **IsThereAnyDeal has no CORS headers** and its Cloudflare front rejects non-browser user agents (Python
  `urllib` → `Error code: 1010`); `curl`, browsers and extension background pages are fine.
- **Headless Firefox gets HTTP 403 from www.gog.com** (Cloudflare) and an empty library from Steam when logged
  out, so the live check's install-time refresh always fails per store — useful, as it exercises the error
  path and the toolbar "!".
- **Heavy store pages time out screenshots**; DOM assertions are more reliable than pixels.
- A naive comment stripper (`/\*.*?\*/`) eats the `/*` inside `"https://…/*"` host-permission strings.
- **Only a real profile proves** the cookie-bearing background fetches against logged-in sessions, the options
  page's `permissions.request`, and the alarm firing on schedule.

## 7. Ideas not done

- Epic / Humble / itch support — the adapter pattern (`collect / matchKey / matchTitle / describe`) was designed
  for it; ITAD has shop IDs for all of them, but Epic has no library endpoint (would need a bookmarklet or
  Legendary-style login).
- Steam's React wishlist page is covered by the image-link fallback without its markup having been inspected;
  a dedicated selector may badge more of it.
- Login detection on GOG pages (only Steam's header is read today).
- Image-only Steam capsules with empty `alt` get no title, so they only match by ID.
- A "hide DLC badges" toggle was considered and dropped: neither library API reliably flags DLC, so it would have
  been a content-side guess.
- Signing for permanent install (unlisted AMO submission) — see the README's Installation section.
