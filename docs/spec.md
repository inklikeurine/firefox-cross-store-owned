# Cross-Store Owned — product spec

**Status:** implemented (v0.2.0). Manual Review of 0.1.0 completed by the owner
in real Firefox on 2026-09-21; 0.2.0 (credentials split, masked key fields)
awaits review.

## About

- Badges games on Steam that you already own on GOG, and games on GOG that
  you already own on Steam, so you notice before paying twice.

## Goals

- Show, on every Steam and GOG store page, which games the user already owns
  on the other store — without the user maintaining anything by hand.
- Zero configuration for the common case: being logged in to both stores in
  Firefox is enough.
- Distinguish certain matches (cross-store IDs) from probable ones (title
  match) visually, so the user can judge.
- Keep everything local except the one lookup that cannot be done locally
  (IsThereAnyDeal ID resolution), and say so plainly.
- Fail per store: if one store's read breaks, badges from the last good
  read of that store keep working and the popup explains.

## Non-goals

- Other stores (Epic, Humble, itch, Xbox/PC Game Pass). The adapter shape
  allows them; none is implemented.
- Price comparison, deal alerts, wishlist sync or anything IsThereAnyDeal and
  Augmented Steam already do.
- Telling the user *which* edition they own beyond the tooltip title.
- Hiding or restyling store pages beyond adding the badge.
- Chrome/Chromium/Edge/Safari or Firefox for Android.

## Who it's for

- People who buy PC games on both Steam and GOG and have libraries large
  enough that they no longer remember what they own where.

## Core functionality (v0.1)

- **Library reads** (background, on install, on schedule, on demand):
  - Steam, *session* mode: `store.steampowered.com/dynamicstore/userdata`
    with cookies → owned apps (incl. DLC) and packages; then the store's
    `webapi_token` → `IPlayerService/GetOwnedGames` for names.
  - Steam, *api* mode: `GetOwnedGames` with the user's Web API key and
    SteamID64; the session read is merged in when available.
  - GOG: `/user/data/games` → owned product IDs; `/account/getFilteredProducts`
    (visible and hidden) → titles and store URLs.
- **Matching** (background): owned IDs → IsThereAnyDeal game IDs → every
  product ID of those games on the other store. Results and negative answers
  are cached; an unchanged library costs zero lookups on the next refresh.
  Optional normalised-title index for the fuzzy fallback.
- **Badges** (content scripts): find product tiles by the stores' own
  `data-*` attributes, look them up in the maps from `storage.local`, draw a
  `<span role="link">` badge (overlay on covers, inline in lists, expanded
  pill under page titles). Re-run on DOM mutations and when `maps` or
  `settings` change in storage. Idempotent per document.
- **Popup**: Steam/GOG counts and ages, match counts, last refresh, errors and
  warnings, **Refresh now**, **Settings**, and **Grant site access** when
  the host permissions are missing.
- **Options page**: Steam method and credentials, IsThereAnyDeal key, title
  matching toggle, refresh interval, badge colours, **Clear cached data**,
  and the same status block as the popup.

## Optional / future functionality

- Epic / Humble / itch adapters (IsThereAnyDeal has shop IDs for all; Epic
  has no library endpoint, so it would need a manual import).
- Steam's React wishlist page has not been checked for `data-ds-appid`.
- A "hide DLC badges" toggle was considered and dropped: neither library API
  reliably flags DLC.

## Permissions

- `storage` — settings, libraries, lookup cache, match tables.
- `unlimitedStorage` — the cache for a large library exceeds what Firefox
  guarantees under its normal IndexedDB quota; silent permission.
- `alarms` — the periodic refresh.
- Host permissions for `store.steampowered.com`, `api.steampowered.com`,
  `www.gog.com`, `embed.gog.com`, `api.gog.com`, `api.isthereanydeal.com` —
  the library reads, the name lookups, the store-link fallback and the ID
  resolution respectively. Each is explained in the README's Permissions
  table.
- `data_collection_permissions: { required: ["websiteContent"] }` — the
  owned-ID lists (content read from the stores' responses) are transmitted to
  IsThereAnyDeal. Nothing goes to the author.

## Architecture overview

See [architecture.md](./architecture.md). In one paragraph: `lib/common.js`
holds defaults and the title normaliser and is loaded everywhere;
`background.js` (MV3 event page) owns every network call and writes `maps`
to `storage.local`; `content/badges.js` is a store-agnostic badge engine
driven by an adapter from `content/steam.js` or `content/gog.js`; the popup
and options page talk to the background with `runtime.sendMessage` and
re-render on `storage.onChanged`.

## Settings and storage

`storage.local`, key `settings`, one object, defaults applied on read
(`CSO.withDefaults`, which also drops any key the defaults do not define).
Read by the background, the popup, the options page **and the content
scripts**, so nothing secret or personal is kept here:

| Key | Default | Meaning |
| --- | --- | --- |
| `steamMethod` | `"session"` | `"session"` reads the store with cookies; `"api"` uses the Web API key + SteamID64 |
| `refreshHours` | `6` | Refresh interval, clamped to 1–168 |
| `matchByTitle` | `true` | Build and use the normalised-title fallback |
| `gogColor` | `"#7b2fbe"` | Badge colour on Steam |
| `steamColor` | `"#1a9fff"` | Badge colour on GOG |

`storage.local`, key `credentials` (`CSO.withCredentialDefaults`). Read only
by the background page and the options page; stored unencrypted (see the
README's "About keys"); masked on the options page:

| Key | Default | Meaning |
| --- | --- | --- |
| `steamApiKey` | `""` | Steam Web API key (api mode) |
| `steamId64` | `""` | 17-digit SteamID64 (api mode) |
| `itadApiKey` | `""` | Optional IsThereAnyDeal key, sent as `ITAD-API-Key` |

A 0.1 `settings` object that still holds these three keys is migrated into
`credentials` on the first install/startup of 0.2.

Other keys (`lib_steam`, `lib_gog`, `itad_cache`, `maps`, `status`) are
documented in [architecture.md](./architecture.md).

## Testing

Headless suites in `.dev/tests/cross-store-owned/` cover the title normaliser,
settings defaults/corruption, and the background's refresh + matching path
against a fake `fetch` (Steam session and API modes, GOG, IsThereAnyDeal
batching, caching, per-store failure, every message type). The live check
serves a Steam-shaped fixture at a `store.steampowered.com` URL, seeds
`maps` from the background, and counts the badges the content script draws.

Manual checklist (the click-list in the verification report is written from this):

- Load temporarily → toolbar icon appears; popup shows "not loaded" for both
  stores and no errors.
- Logged in to both stores → **Refresh now** → counts appear for Steam and
  GOG and "On GOG too / On Steam too" numbers are plausible.
- Steam search for a game you own on GOG → purple **G** on its tile; hover
  shows the GOG title; click opens the GOG page in a new tab without
  navigating the Steam tile.
- GOG catalog page for a game you own on Steam → blue **S** top-right of the
  cover; click opens the Steam page.
- A game page on either store → expanded pill under the title.
- A Steam sale page with a bundle → `G n/m` badge.
- Options → change a badge colour → open store tabs recolour without reload.
- Options → turn off title matching → dashed-ring badges disappear.
- Options → **Clear cached data** → popup returns to "not loaded"; settings
  and keys unchanged.
- Options → type into the Steam Web API key field → masked input; after Save
  and a reload the field is still filled (masked).
- Log out of GOG → **Refresh now** → popup shows the GOG error; Steam-side
  badges still show from the last good GOG library.
- Browser Console: no errors from `cross-store-owned`; at most one warning per
  failed refresh.

## Known limitations

See the README's **Known limitations**; the research behind each is in
[learnings.md](./learnings.md).

## Release checklist

- Bump `version` in `manifest.json`; add the `CHANGELOG.md` entry.
- `node .dev/tools/check.mjs cross-store-owned` clean;
  `node .dev/harness/run.mjs cross-store-owned --spec` passes.
- Manual checklist above in a fresh profile, logged in to both stores.
- `web-ext build --source-dir ./cross-store-owned`; sign on AMO as unlisted.
