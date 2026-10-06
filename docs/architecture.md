# Cross-Store Owned — architecture

Manifest V3, Firefox 140+. No build step; every file is loaded as-is.

```text
manifest.json
lib/common.js         CSO namespace: settings + credentials defaults and validation, host origins,
                      hidden-badge helpers, title normaliser, formatting helpers
background.js         MV3 event page: library reads, IsThereAnyDeal lookups, map and owned-on-both
                      building, search, toolbar badge, refresh alarm, messages
content/badges.js     store-agnostic badge engine (matching, placement, MutationObserver,
                      "On this page" answer, toolbar count report)
content/steam.js      Steam adapter for badges.js
content/gog.js        GOG adapter for badges.js
content/badges.css    badge styles; colours through --cso-gog / --cso-steam
popup/                toolbar popup: store cards, progress, On this page, Do I own…?, Refresh now
options/              options page (opens in a tab): status, settings (autosaved), owned on both
icons/icon.svg
```

`lib/common.js` is injected into store pages too, possibly twice into the
same content-script world; its top-level names are `var` and `function`,
never `const`/`let`, so a second injection does not throw.

## Why an event page

The background holds nothing that cannot be rebuilt from `storage.local`.
A refresh in flight is tracked by an in-memory promise *and* a
`status.refreshing` flag in storage; if Firefox unloads the page mid-refresh,
the flag is treated as abandoned after 15 minutes (`STALE_LOCK_MS`) and the
next trigger starts over. At startup and after an update the flag is cleared
outright, since nothing can be running yet. The search index is a cache,
rebuilt on the first search after a wake-up. There is therefore no reason for
a persistent page.

## Data flow

```text
                    ┌──────────────────────── background.js ───────────────────────────┐
 Steam (cookies) ──►│ fetchSteamSession / fetchSteamApi ─┐                              │
 GOG   (cookies) ──►│ fetchGogLibrary ───────────────────┼─► buildMaps ─► maps, both ───┼─► storage.local
 IsThereAnyDeal  ◄─►│ lookupBatched (with itad_cache)   ─┘                              │       │
                    │ status (+ progress) ──► toolbar "…" / "!"                         │       │
                    └───────────────────────────────────────────────────────────────────┘       │
                                                                                   storage.onChanged
                                                                                               ▼
 store page ◄──── content/badges.js + adapter: collect tiles → matchKey / matchTitle → place badge
                      │  pageCount ──► background ──► per-tab toolbar count
                      └─ getPageMatches ◄── popup (tabs.sendMessage)
```

1. A refresh is triggered by `runtime.onInstalled`, `runtime.onStartup`, the
   `cso-refresh` alarm, the popup/options **Refresh now**, or a content
   script's `ensureFresh` message — when the last refresh is older than
   `refreshHours`, or when a Steam page shows the user logged in and the last
   refresh failed with a Steam login problem (once; reason `"login"`).
2. `refreshAll` writes `status.refreshing = true`, reads both libraries
   (each failure is recorded per store in `status.problems` and the previous
   library is reused), rebuilds the maps when both libraries exist, and
   always ends with one `status` write without `progress`. While it runs,
   `reportProgress` merges `{ step, label, done, total }` into `status`
   (steps `start`, `steam`, `gog` per page of titles, `match` per lookup
   batch). Those writes are what the popup and options page re-render on;
   they never poll.
3. `buildMaps` runs four batched IsThereAnyDeal lookups (owned Steam IDs →
   game IDs, owned GOG IDs → game IDs, then each set of game IDs → product
   IDs on the *other* store). Every answer, including `null`, is cached with a
   timestamp in `itad_cache`; `null`s are re-asked after 7 days. The cache is
   saved even when a later lookup fails. Batches are 200 keys (the documented
   maximum) with a 250 ms pause between them; HTTP 429 honours `Retry-After`
   up to three times. It then builds the title indexes and the owned-on-both
   list (`findOwnedOnBoth`: union-find over the ID links, then a title layer).
4. The content script reads `maps`, `settings` and `hidden` once on load,
   then subscribes to `storage.onChanged`; a new value of any of the three
   clears and redraws every badge on the page.

## Storage layout (`storage.local`)

| Key | Shape | Written by |
| --- | --- | --- |
| `settings` | see [spec.md](./spec.md) → Settings; non-secret, read by content scripts too | options page (popup: the per-store switch) |
| `credentials` | `{ steamApiKey, steamId64, itadApiKey }` — background and options page only, never content scripts; unencrypted | options page (migrated from 0.1 `settings` by the background) |
| `hidden` | `["steam:app/55", "gog:2000", …]` — badges the user hid | popup, options page |
| `lib_steam` | `{ apps: number[], subs: number[], names: {appid: name}, steamId, method: "session"\|"api", fetchedAt, warning }` | background |
| `lib_gog` | `{ ids: number[], info: {gogId: {title, url}}, fetchedAt, warning }` | background |
| `itad_cache` | `{ steamToItad, gogToItad, itadToSteam, itadToGog }`, each `{ key: { v, t } }` | background |
| `maps` | `{ builtAt, stats, forSteam: { apps, subs, gogTitles, gogInfo }, forGog: { ids, steamTitles, steamNames } }` | background |
| `both` | `{ builtAt, games: [{ title, via: "id"\|"title", steam: [{ key, name, url }], gog: [{ id, title, url }] }] }`, sorted by title | background |
| `status` | `{ refreshing, startedAt, finishedAt, reason, errors: string[], warnings: string[], problems: { steam?, gog?, match?, other? }, progress? }`; a problem is `{ message, login }` | background |

`maps.forSteam.apps[appid]` and `.subs[packageid]` list the GOG product IDs
you own for that Steam item; `maps.forGog.ids[gogId]` lists the Steam keys
(`app/N` or `sub/N`) you own for that GOG product. `gogTitles` /
`steamTitles` map a normalised title to the same values for the fuzzy
fallback. `stats` holds the library sizes, the badge-table sizes and
`ownedOnBoth` / `ownedOnBothByTitle`.

Every reader applies defaults and validates shape (`CSO.withDefaults`,
`CSO.withCredentialDefaults`, `CSO.isMaps`, `CSO.hiddenList`, the guards in
`getStatusSummary` and `buildSearchIndex`), so a corrupt or missing value
degrades to "no badges" rather than a throw. `withDefaults` keeps only the
keys `DEFAULT_SETTINGS` defines, which is what guarantees a content script can
never see a credential even if one is lying in `settings` from before the
0.2 split.

## Messages

All messages are `{ type, …fields }`; every handler answers, unknown types
included.

To the background (`runtime.sendMessage`):

| `type` | From | Fields | Answer |
| --- | --- | --- | --- |
| `getStatus` | popup, options | — | `{ permissionsGranted, steam, gog, maps: { builtAt, stats }, hidden: number, status }` — counts and timestamps, never the raw libraries; `status.errors`, `.warnings`, `.problems` always present |
| `refreshNow` | popup, options | — | resolves with the `getStatus` shape when the refresh has finished |
| `ensureFresh` | content scripts | `loggedInOn`: `"steam"` \| `"gog"` \| `null` | `{ refreshing: boolean }`; starts a refresh if the last one is stale and did not fail in the last 10 minutes, or for the login retry above |
| `pageCount` | content scripts | `count`, `site` | `{ ok: true, count }` after setting the sender tab's toolbar badge (`null` text hands the tab back to the global badge); `{ ok: false, error }` without a sender tab |
| `search` | popup | `query` | `{ ok, ready, steamNames, gogTitles, total, results: [{ title, via, steam: url\|"", gog: url\|"" }] }` — at most 30, every query word must appear; whole-title, title-start and word-start hits first |
| `resolveSteamId` | options | `input`, `apiKey?` | `{ ok: true, steamId }` or `{ ok: false, error }` — a 17-digit ID, a `/profiles/<id>` link, or a custom name / `/id/<name>` link via `ISteamUser/ResolveVanityURL` (with `apiKey` or the saved key) |
| `resolveGogUrl` | Steam content script (on badge hover or focus) | `gogId` | the GOG store URL as a string, `""` when unknown |
| `clearCache` | options | — | `{ ok: true }` after removing `lib_steam`, `lib_gog`, `itad_cache`, `maps`, `both`, `status` and clearing the toolbar "!" |
| anything else | — | — | `{ ok: false, error: "unknown message type …" }` |

To a content script (`tabs.sendMessage`, no `tabs` permission needed):

| `type` | From | Answer |
| --- | --- | --- |
| `getPageMatches` | popup | `{ ok: true, site, otherLabel, enabled, mapsReady, items: [{ id, title, via, owned, total, others: [{ title, url }], url, hidden }] }` — one item per game on the page, sorted by title; `id` is the `hidden` entry for it |
| anything else | — | `{ ok: false, error }` |

The background never messages content scripts; they get everything else
through `storage.onChanged`.

## Toolbar icon

- Global badge text (`updateGlobalBadge`): `"…"` (grey) while a refresh runs,
  `"!"` (red) when the last refresh recorded errors, empty otherwise; the
  title says which. Set at the start and end of every refresh, on boot and by
  `clearCache`.
- Per-tab text (`setPageCount`): the content script's count of badged games
  (hidden ones excluded), in the other store's badge colour, `"999+"` above
  999. A count of 0 or `toolbarCount: false` sets `null`, which shows the
  global badge again. Firefox clears a tab's own text on navigation; the
  content script reports again whenever the count or `location.href`
  changes (debounced 400 ms).

## Badge engine and adapters

`CSO.startBadges(adapter)` in `content/badges.js` is called once per document
(a `data-cross-store-owned` attribute on `<html>` makes a second injection a
no-op). The adapter supplies:

| Member | Purpose |
| --- | --- |
| `site` | `"steam"` / `"gog"`: the store the page belongs to (settings switch, hidden ids, toolbar colour) |
| `badgeClass`, `badgeLetter`, `otherLabel` | `"gog"`, `"G"`, `"GOG"` on Steam pages; `"steam"`, `"S"`, `"Steam"` on GOG |
| `attributes` | attribute names to watch for late-rendered or changed IDs (GOG's Angular `{{ }}` placeholders; `href` for Steam's link fallback) |
| `collect(root)` | returns `{ el, keys, altKeys?, title?, label?, container?, mode?, anchor?, corner?, expanded? }` per tile; `title` is matched by name, `label` is what the popup shows |
| `matchKey(maps, key)` / `matchTitle(maps, title)` | the two match layers |
| `describe(maps, otherId)` | `{ title, url }` for tooltips and the click target |
| `fallbackUrl(otherId, title)` | link when no URL is known (a GOG search, a Steam app page) |
| `onHover?(badge, otherIds)` | Steam adapter asks the background for a GOG URL before the click lands |
| `isLoggedIn?()` | `true` / `false` / `null` from the page header; Steam only (`#account_pulldown` vs the login link) |

Each tile element carries `data-cso-done="<its IDs>"`; when the page changes
an element's IDs (a reused React row, an interpolated Angular attribute) the
old badge is removed and the element is looked at again. Matched tiles also
get `data-cso-key`; a nested tile repeating its ancestor's key is skipped so
Steam's nested capsules get one badge. A `found` map keyed by the tile IDs
holds what `getPageMatches` and the toolbar count report, pruned of elements
that left the page. A tile whose `<site>:<IDs>` is in `hidden` is recorded
there but gets no badge.

Placement: `mode: "after"` puts an expanded pill after a page title; `"inline"`
prepends into the element; otherwise the engine overlays the badge on the
tile's cover (`position: relative` is added only when the container is
`static`). The badge is a `<span role="link" tabindex="0">` with an
`aria-label`, not an `<a>`, because tiles are usually anchors; its click,
middle-click and Enter/Space handlers stop propagation and open the other
store in a new tab. Title matches carry a dashed ring and a second tooltip
line saying so.

The Steam adapter's link fallback badges `a[href*="/app/"]` /
`a[href*="/sub/"]` links to `store.steampowered.com` that contain an image
and are neither inside nor around a `data-ds-*` tile.

Site-specific selectors are confined to the top of each adapter
(`TILE_SEL`, `TITLE_SEL`, `LINK_SEL`, `LOGGED_IN_SEL`, `ID_ATTRS`) so a store
markup change is a data fix. The markup notes that justify each selector are
in [learnings.md](./learnings.md).

## Logging

`console.warn` only, prefixed `[cross-store-owned]`: one line per refresh that
finished with errors, one when settings or storage cannot be read, one if the
toolbar badge cannot be set. Nothing on the happy path.
