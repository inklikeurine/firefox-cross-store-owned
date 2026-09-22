# Cross-Store Owned — architecture

Manifest V3, Firefox 140+. No build step; every file is loaded as-is.

```text
manifest.json
lib/common.js         CSO namespace: settings + credentials defaults, host origins, validators, title normaliser
background.js         MV3 event page: library reads, IsThereAnyDeal lookups, map building, refresh alarm, messages
content/badges.js     store-agnostic badge engine (matching, placement, MutationObserver)
content/steam.js      Steam adapter for badges.js
content/gog.js        GOG adapter for badges.js
content/badges.css    badge styles; colours through --cso-gog / --cso-steam
popup/                toolbar popup: status, Refresh now, Settings, Grant site access
options/              options page (opens in a tab)
icons/icon.svg
```

## Why an event page

The background holds nothing that cannot be rebuilt from `storage.local`.
A refresh in flight is tracked by an in-memory promise *and* a
`status.refreshing` flag in storage; if Firefox unloads the page mid-refresh,
the flag is treated as abandoned after 15 minutes (`STALE_LOCK_MS`) and the
next trigger starts over. There is therefore no reason for a persistent page.

## Data flow

```text
                    ┌──────────────────────── background.js ─────────────────────────┐
 Steam (cookies) ──►│ fetchSteamSession / fetchSteamApi ─┐                            │
 GOG   (cookies) ──►│ fetchGogLibrary ───────────────────┼─► buildMaps ─► maps ───────┼─► storage.local
 IsThereAnyDeal  ◄─►│ lookupBatched (with itad_cache)   ─┘                            │       │
                    └────────────────────────────────────────────────────────────────┘       │
                                                                                  storage.onChanged
                                                                                             ▼
 store page ◄──── content/badges.js + adapter: collect tiles → matchKey / matchTitle → place badge
```

1. A refresh is triggered by `runtime.onInstalled`, `runtime.onStartup`, the
   `cso-refresh` alarm, the popup/options **Refresh now**, or a content
   script's `ensureFresh` message when the last refresh is older than
   `refreshHours`.
2. `refreshAll` writes `status.refreshing = true`, reads both libraries
   (each failure is recorded per store and the previous library is reused),
   rebuilds the maps when both libraries exist, and always ends with one
   `status` write. That final write is what the popup and options page
   re-render on; they never poll.
3. `buildMaps` runs four batched IsThereAnyDeal lookups (owned Steam IDs →
   game IDs, owned GOG IDs → game IDs, then each set of game IDs → product
   IDs on the *other* store). Every answer, including `null`, is cached with a
   timestamp in `itad_cache`; `null`s are re-asked after 7 days. Batches are
   200 keys (the documented maximum) with a 250 ms pause between them; HTTP
   429 honours `Retry-After` up to three times.
4. The content script reads `maps` and `settings` once on load, then
   subscribes to `storage.onChanged`; a new `maps` or `settings` value clears
   and redraws every badge on the page.

## Storage layout (`storage.local`)

| Key | Shape | Written by |
| --- | --- | --- |
| `settings` | see [spec.md](./spec.md) → Settings; non-secret, read by content scripts too | options page |
| `credentials` | `{ steamApiKey, steamId64, itadApiKey }` — background and options page only, never content scripts; unencrypted | options page (migrated from 0.1 `settings` by the background) |
| `lib_steam` | `{ apps: number[], subs: number[], names: {appid: name}, steamId, method: "session"\|"api", fetchedAt, warning }` | background |
| `lib_gog` | `{ ids: number[], info: {gogId: {title, url}}, fetchedAt, warning }` | background |
| `itad_cache` | `{ steamToItad, gogToItad, itadToSteam, itadToGog }`, each `{ key: { v, t } }` | background |
| `maps` | `{ builtAt, stats, forSteam: { apps, subs, gogTitles, gogInfo }, forGog: { ids, steamTitles, steamNames } }` | background |
| `status` | `{ refreshing, startedAt, finishedAt, reason, errors: string[], warnings: string[] }` | background |

`maps.forSteam.apps[appid]` and `.subs[packageid]` list the GOG product IDs
you own for that Steam item; `maps.forGog.ids[gogId]` lists the Steam keys
(`app/N` or `sub/N`) you own for that GOG product. `gogTitles` /
`steamTitles` map a normalised title to the same values for the fuzzy
fallback. Every reader applies defaults and validates shape
(`CSO.withDefaults`, `CSO.withCredentialDefaults`, `CSO.isMaps`, the guards in
`getStatusSummary`), so a corrupt or missing value degrades to "no badges"
rather than a throw. `withDefaults` keeps only the keys `DEFAULT_SETTINGS`
defines, which is what guarantees a content script can never see a credential
even if one is lying in `settings` from before the 0.2 split.

## Messages

All messages are `{ type, …fields }` sent with `runtime.sendMessage`; the
background answers every one, unknown types included.

| `type` | From | Fields | Answer |
| --- | --- | --- | --- |
| `getStatus` | popup, options | — | `{ permissionsGranted, steam, gog, maps, status }` — counts and timestamps, never the raw libraries |
| `refreshNow` | popup, options | — | resolves with the `getStatus` shape when the refresh has finished |
| `ensureFresh` | content scripts | — | `{ refreshing: boolean }`; starts a refresh only if the last one is stale and did not fail in the last 10 minutes |
| `resolveGogUrl` | Steam content script (on badge hover) | `gogId` | the GOG store URL as a string, `""` when unknown |
| `clearCache` | options | — | `{ ok: true }` after removing `lib_steam`, `lib_gog`, `itad_cache`, `maps`, `status` |
| anything else | — | — | `{ ok: false, error: "unknown message type …" }` |

There are no background → content messages; content scripts get everything
through `storage.onChanged`.

## Badge engine and adapters

`CSO.startBadges(adapter)` in `content/badges.js` is called once per document
(a `data-cross-store-owned` attribute on `<html>` makes a second injection a
no-op). The adapter supplies:

| Member | Purpose |
| --- | --- |
| `badgeClass`, `badgeLetter`, `otherLabel` | `"gog"`, `"G"`, `"GOG"` on Steam pages; `"steam"`, `"S"`, `"Steam"` on GOG |
| `attributes` | attribute names to watch for late-rendered IDs (GOG's Angular `{{ }}` placeholders) |
| `collect(root)` | returns `{ el, keys, altKeys?, title?, container?, mode?, anchor?, corner?, expanded? }` per tile |
| `matchKey(maps, key)` / `matchTitle(maps, title)` | the two match layers |
| `describe(maps, otherId)` | `{ title, url }` for tooltips and the click target |
| `fallbackUrl(otherId, title)` | link when no URL is known (a GOG search, a Steam app page) |
| `onHover?(badge, otherIds)` | Steam adapter asks the background for a GOG URL before the click lands |

Placement: `mode: "after"` puts an expanded pill after a page title; `"inline"`
prepends into the element; otherwise the engine overlays the badge on the
tile's cover (`position: relative` is added only when the container is
`static`). Elements are marked `data-cso-done` / `data-cso-key`; a nested tile
repeating its ancestor's key is skipped so Steam's nested capsules get one
badge. The badge is a `<span role="link" tabindex="0">`, not an `<a>`, because
tiles are usually anchors; its click handler stops propagation and opens the
other store in a new tab.

Site-specific selectors are confined to the top of each adapter
(`TILE_SEL`, `TITLE_SEL`, `ID_ATTRS`) so a store markup change is a data fix.
The markup notes that justify each selector are in [learnings.md](./learnings.md).

## Logging

`console.warn` only, prefixed `[cross-store-owned]`: one line per refresh that
finished with errors, one when settings or storage cannot be read. Nothing on
the happy path.
