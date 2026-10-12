# Cross-Store Owned — product spec

**Status:** implemented, v0.3.0. Validated, Automated Test and Manual Review.

## About

- Badges games on Steam that you already own on GOG, and games on GOG that
  you already own on Steam, so you notice before paying twice.

## Goals

- Show, on every Steam and GOG store page, which games the user already owns
  on the other store — without the user maintaining anything by hand.
- Zero configuration for the common case: being logged in to both stores in
  Firefox is enough.
- Distinguish certain matches (cross-store IDs) from probable ones (title
  match) visually, and let the user dismiss a wrong one.
- Answer "do I already own this?" quickly even away from the two stores
  (the popup's search), and show the overlap between the libraries.
- Keep everything local except the one lookup that cannot be done locally
  (IsThereAnyDeal ID resolution), and say so plainly.
- Fail per store: if one store's read breaks, badges from the last good
  read of that store keep working, and the popup says which store and what
  to do (usually: log in).

## Non-goals

- Other stores (Epic, Humble, itch, Xbox/PC Game Pass). The adapter shape
  allows them; none is implemented.
- Price comparison, deal alerts, wishlist sync or anything IsThereAnyDeal and
  Augmented Steam already do.
- Hiding or restyling store pages beyond adding the badge.
- Notifications. The toolbar icon's "!" is the only out-of-page signal.
- Chrome/Chromium/Edge/Safari or Firefox for Android.

## Who it's for

- People who buy PC games on both Steam and GOG and have libraries large
  enough that they no longer remember what they own where.

## Core functionality

- **Library reads** (background; on install, on startup, on schedule, on
  demand, and when a Steam page shows a fresh login after a login failure):
  - Steam, *session* mode: `store.steampowered.com/dynamicstore/userdata`
    with cookies → owned apps (incl. DLC) and packages; then the store's
    `webapi_token` → `IPlayerService/GetOwnedGames` for names.
  - Steam, *api* mode: `GetOwnedGames` with the user's Web API key and
    SteamID64; the session read is merged in when available.
  - GOG: `/user/data/games` → owned product IDs; `/account/getFilteredProducts`
    (visible and hidden) → titles and store URLs.
  - Every request times out after 30 s. A logged-out store is reported as a
    *login* problem (Steam: empty lists; GOG: an HTML login page instead of
    JSON).
- **Matching** (background): owned IDs → IsThereAnyDeal game IDs → every
  product ID of those games on the other store. Results and negative answers
  are cached; an unchanged library costs zero lookups on the next refresh,
  and answers already received are kept when a later lookup fails.
  Normalised-title indexes are always built; the title setting applies where
  badges are drawn.
- **Owned on both** (background): games owned on both stores, grouped across
  editions — first by ID links, then owned GOG products whose normalised title
  equals an owned, named Steam app's ("title" entries). Stored as `both`;
  counted in `maps.stats.ownedOnBoth` / `ownedOnBothByTitle`.
- **Badges** (content scripts): find product tiles by the stores' own
  `data-*` attributes (and, on Steam, image links to `/app/N` / `/sub/N`
  outside any tile), look them up in the maps from `storage.local`, draw a
  `<span role="link">` badge: the other store's favicon (drawn on a
  `<canvas>` from stored pixels, so nothing is loaded into the store page;
  the store's letter when there is no icon) and "Owned on GOG" / "Owned on
  Steam" — "Maybe owned on …" for a title match, "Own 2 of 5 on …" for a
  bundle; the same look on both stores. Placement: a tag merged into the
  cover's corner (top-left on Steam; top-right on GOG, whose own release
  label takes the top-left), inline in lists, a larger badge with an arrow
  under page titles. Re-run on DOM mutations — including an element reused
  for another game — and when `maps`, `settings`, `hidden` or `icons`
  change. Idempotent per document.
- **Store icons** (background): each store's `/favicon.ico`, fetched without
  cookies after a refresh when missing or a month old, decoded on the
  background page to 32×32 RGBA pixels and a PNG `data:` URL (`icons`).
- **Toolbar icon**: per-tab count of badged games (one fixed dark colour);
  globally "…" while a refresh runs and "!" after one with errors.
- **Popup** (fits Firefox's 600 px popup height; the list area scrolls, the
  footer stays): first run — three numbered steps (log in to Steam, log in to
  GOG, **Refresh now**) instead of the store cards; then one card per store
  (count and ✓, or the problem and **Log in**), the owned-on-both count
  (links to the list), a progress bar during a refresh, remaining errors and
  warnings in notice boxes, **On this page** (badged games of the active store
  tab, five then **Show all**, **Hide**/**Show**, a link to each; folded to
  its heading while a search is typed), **Do I own…?** search (once both
  libraries are read), and **Refresh now**; **Grant site access** when the
  host permissions are missing.
- **Options page**, five cards: Status (tiles, progress, a store problem said
  once on its tile, **Details** in plain words, **Refresh now**); Badges
  (per-store switches, icon and words or icon only, toolbar count, live
  preview); Libraries (Steam method and credentials — SteamID64 from an ID,
  profile link or custom name — GOG, title matching, IsThereAnyDeal key);
  Owned on both stores (one badge per store for the base game, other editions
  named, a filter); Upkeep (refresh interval in hours, days or weeks, hidden
  badges by name with **Show** each and **Show all**, **Clear cached data**).
  Every change saves itself.

## Optional / future functionality

- Epic / Humble / itch adapters (IsThereAnyDeal has shop IDs for all; Epic
  has no library endpoint, so it would need a manual import).
- Login detection on GOG pages (the header markup that would show it has not
  been checked).
- A "hide DLC badges" toggle was considered and dropped: neither library API
  reliably flags DLC.

## Permissions

- `storage` — settings, libraries, lookup cache, match tables, owned-on-both
  list, store icons, hidden badges and their names.
- `unlimitedStorage` — the cache for a large library exceeds what Firefox
  guarantees under its normal IndexedDB quota; silent permission.
- `alarms` — the periodic refresh.
- Host permissions for `store.steampowered.com`, `api.steampowered.com`,
  `www.gog.com`, `embed.gog.com`, `api.gog.com`, `api.isthereanydeal.com` —
  the library reads, the name and profile-name lookups, the store-link
  fallback and the ID resolution respectively. Each is explained in the
  README's Permissions table.
- No `tabs`: the popup reaches the active tab's content script with
  `tabs.sendMessage`, and the toolbar count comes from the content script.
- `data_collection_permissions: { required: ["websiteContent"] }` — the
  owned-ID lists (content read from the stores' responses) are transmitted to
  IsThereAnyDeal. Nothing goes to the author.

## Architecture overview

See [architecture.md](./architecture.md). In one paragraph: `lib/common.js`
holds defaults, validators, the hidden-badge list helpers and the title
normaliser and is loaded everywhere; `background.js` (MV3 event page) owns
every network call, writes `maps` and `both` to `storage.local`, answers the
popup's search and sets the toolbar badge; `content/badges.js` is a
store-agnostic badge engine driven by an adapter from `content/steam.js` or
`content/gog.js`; the popup and options page talk to the background with
`runtime.sendMessage`, to the page with `tabs.sendMessage`, and re-render on
`storage.onChanged`.

## Settings and storage

`storage.local`, key `settings`, one object, defaults applied on read
(`CSO.withDefaults`: keys the defaults do not define are dropped, and a value
of the wrong type or outside its allowed choices falls back to the default). Read by the background, the popup, the
options page **and the content scripts**, so nothing secret or personal is
kept here:

| Key | Default | Meaning |
| --- | --- | --- |
| `steamMethod` | `"session"` | `"session"` reads the store with cookies; `"api"` uses the Web API key + SteamID64 |
| `refreshHours` | `6` | Refresh interval in hours, clamped to 1–672 (4 weeks); the options page shows it in hours, days or weeks |
| `matchByTitle` | `true` | Draw title-match badges (and count title entries in "owned on both") |
| `showOnSteam` | `true` | Draw GOG badges on Steam pages |
| `showOnGog` | `true` | Draw Steam badges on GOG pages |
| `badgeLabel` | `"words"` | `"words"` = store icon + "Owned on …"; `"icon"` = the icon alone (bundles keep their `n/m`; the game-page badge always has words) |
| `toolbarCount` | `true` | Show the per-page count on the toolbar icon |

`storage.local`, key `credentials` (`CSO.withCredentialDefaults`). Read only
by the background page and the options page; stored unencrypted (see the
README's "About keys"); masked on the options page
(`autocomplete="new-password"` so Firefox does not offer to save them as a
login):

| Key | Default | Meaning |
| --- | --- | --- |
| `steamApiKey` | `""` | Steam Web API key (api mode) |
| `steamId64` | `""` | 17-digit SteamID64 (api mode) |
| `itadApiKey` | `""` | Optional IsThereAnyDeal key, sent as `ITAD-API-Key` |

`storage.local`, key `hidden`: `["steam:app/55", "gog:2000", …]` — badges the
user hid (`<page's store>:<tile IDs>`), validated by `CSO.hiddenList`. Read by
the content scripts; written by the popup and the options page. Kept by
**Clear cached data**.

A 0.1 `settings` object that still holds the three credential keys is
migrated into `credentials` on install/startup.

Other keys (`lib_steam`, `lib_gog`, `itad_cache`, `maps`, `both`, `status`)
are documented in [architecture.md](./architecture.md).

## Testing

Headless suites in `.dev/tests/cross-store-owned/`:

- `common.test.mjs` — the title normaliser, settings defaults and type checks,
  credentials, hidden-badge helpers, formatting helpers.
- `background.test.mjs` — the refresh and matching path against a fake
  `fetch` (Steam session and API modes, GOG, IsThereAnyDeal batching,
  caching, partial failure, timeouts, per-store login problems), owned on
  both (ID and title layers), progress, search, SteamID resolution, the
  toolbar badge, the login retry, the alarm schedule, every message type.
- `content.test.mjs` — the badge engine with both adapters in jsdom on the
  live check's fixture pages: placement, counts, titles, the link fallback,
  reused tiles, clicks and keys, the "On this page" answer, the toolbar count
  report, hidden badges, every badge setting, corrupt maps, the login hint,
  re-injection, the favicon drawn on a canvas.
- `ui.test.mjs` — the popup and the options page in jsdom: first-run steps,
  the five-row cap and folding while searching, hidden rows, problems said
  once, refresh units, one badge per store in the owned-on-both list, the
  hidden-badges list, the badge preview.

The live check serves a Steam-shaped fixture at a `store.steampowered.com`
URL, seeds `maps` and both libraries from the background, and checks the
badges, the real toolbar badge text and title, search, the popup (store
cards, On this page with Hide/Show round trip, search) and the options page
(form, status tiles, owned-on-both list and filter, autosave, preview,
SteamID link parsing). `review/cross-store-owned/live-gog.sh` does the same
for the GOG adapter.

Manual checklist (the click-list in the verification report is written from this):

- Load temporarily → toolbar icon appears; popup shows the three first-run
  steps, no search box, no errors.
- Logged in to both stores → **Refresh now** → progress bar moves through
  Steam, GOG and the four matching steps; both cards show counts and a ✓; the
  "own N games on both stores" line is plausible.
- Steam search for a game you own on GOG → **Owned on GOG** badge with GOG's
  icon on its row; hover
  shows the GOG title; click opens the GOG page in a new tab without
  navigating the Steam tile; the toolbar icon shows a number.
- Popup on that page → **On this page** lists it; **Hide** removes the badge
  from the page and fades the row, **Show** brings it back; Settings →
  Upkeep lists it by name while hidden.
- GOG catalog page for a game you own on Steam → **Owned on Steam** tag merged
  into the top-right corner of the cover; click opens the Steam page.
- A game page on either store → the larger badge with an arrow under the
  title.
- A Steam sale page with a bundle → **Own n of m on GOG**.
- A popup with more than five games on the page → **Show all**; type in
  **Do I own…?** → the page list folds; the popup never needs to scroll as a
  whole.
- Steam wishlist → badges on owned games' capsules (the link fallback).
- Popup → **Do I own…?** → type part of a game you own on one store → it is
  listed with the Steam and/or GOG badge.
- Options → **Icon only** → open store tabs show the icon without words
  (bundles keep `n/m`), without reload.
- Options → refresh every 2 days → reopen Settings → still "2 days".
- Options → untick *Show GOG badges on Steam* → Steam badges and the
  toolbar count go away.
- Options → turn off title matching → "Maybe owned" badges disappear at once.
- Options → **Owned on both stores** → list is plausible; filter narrows it.
- Options → **Clear cached data** → popup returns to the first-run steps;
  settings, keys and hidden badges unchanged; the next refresh brings the
  store icons back.
- Options → Web API method → paste a profile link in the SteamID64 field →
  it becomes the 17-digit ID.
- Log out of GOG → **Refresh now** → GOG card "Logged out · last list kept"
  with **Log in**, toolbar "!"; Settings says it once, on the GOG tile; Steam-side badges still show from the last good
  GOG library.
- Log out of Steam → refresh → log back in → open any Steam page → the
  libraries are read again without clicking anything.
- Browser Console: no errors from `cross-store-owned`; at most one warning per
  failed refresh.

## Known limitations

See the README's **Known limitations**; the research behind each is in
[learnings.md](./learnings.md).

## Release checklist

- Bump `version` in `manifest.json`; add the `CHANGELOG.md` entry.
- `node .dev/tools/check.mjs cross-store-owned` clean;
  `sh .dev/review/cross-store-owned/live-gog.sh`, then
  `node .dev/harness/run.mjs cross-store-owned --spec` pass.
- Manual checklist above in a fresh profile, logged in to both stores.
- `web-ext build --source-dir ./cross-store-owned`; sign on AMO as unlisted.
