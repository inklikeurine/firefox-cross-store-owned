# Changelog

## [0.4.0] — 2026-10-12

### Changed

- New badges: the other store's own icon and the words **Owned on GOG** /
  **Owned on Steam**, the same look on both stores. On a cover image the
  badge is a tag merged into the corner. A title match reads **Maybe owned
  on …** on a white badge instead of a dashed ring; bundles read **Own 2 of 5
  on GOG**; the game-page badge shows an arrow because it opens the other
  store.
- The badge setting is now **Icon and words** or **Icon only**; the 0.3
  badge text and badge colour settings are gone (the store icon replaces our
  colours), and the toolbar count has one fixed colour.
- Popup: fits Firefox's 600 px popup height; store cards show just the count
  and a ✓ or the problem; **On this page** shows five games, then **Show
  all**, and folds away while you search; a hidden game's badge fades with
  its row; the first run shows three numbered steps instead of empty cards,
  and the search box appears once both libraries are read; warnings sit in a
  notice box in plain words.
- Settings page regrouped into five cards: Status, Badges, Libraries, Owned
  on both stores, Upkeep. The status numbers are behind **Details**, in
  plain words; a store problem is said once, on its tile.
- **Owned on both stores** shows one Steam and one GOG badge per game, for
  the base game, and names the other editions you own underneath.
- The refresh interval is set in hours, days or weeks, up to 4 weeks (was
  1–168 hours).

### Added

- Settings → Upkeep lists each hidden badge by game name, with its own
  **Show**. Badges hidden before 0.4.0 are listed by store and ID.

## [0.3.0] — 2026-10-05

### Added

- The toolbar icon shows how many games on the current Steam or GOG page you
  own on the other store, a red **!** when the last library read had a
  problem, and **…** while one is running.
- Popup: a card per store with its count and age, and **Log in** when that
  store's login is the problem; "You own N games on both stores"; a progress
  bar during a refresh; **On this page**, listing the badged games of the
  current store page with **Hide** / **Show** for wrong matches; **Do I own…?**,
  a search across both libraries.
- Settings: **Owned on both stores**, every game you own on both, editions
  grouped, with store links and a filter; switches for Steam badges, GOG
  badges and the toolbar count; badge text as a letter or the store name; a
  live badge preview and **Default colours**; **Show all hidden badges again**.
- The SteamID64 field accepts a profile link, or a custom profile name once
  the Web API key is filled in.
- On Steam pages without the usual product markup (the wishlist, some hubs),
  image links to a game get a badge.
- Opening a Steam page after logging back in re-reads the libraries at once
  when the last read failed because Steam was logged out.

### Changed

- Settings save as you change them; the Save buttons are gone.
- Popup and settings page redesigned; the settings page puts the status first.
- "Not logged in" problems read as such instead of an HTTP or format error.
- Badge tooltips on title matches say the match is by name; badges have a
  screen-reader label, a visible keyboard-focus ring, and open on Enter,
  click or middle-click (not right-click).
- Turning title matching on or off takes effect at once, without a refresh.
- The key fields no longer invite Firefox to save them as a website login.

### Fixed

- Changing a colour or another setting no longer postpones the next
  scheduled refresh; only a new interval does.
- What IsThereAnyDeal already answered is kept when a later lookup in the
  same refresh fails, so the next refresh carries on from there.
- A request that never answers no longer stalls a refresh (30-second
  timeout).
- A refresh that was running when Firefox closed no longer shows as running
  after the next start.
- A store tile the page reuses for another game is re-checked instead of
  keeping the old game's badge.
- Settings values of the wrong type (a corrupt profile) fall back to their
  defaults instead of being used.
- Loading the content scripts twice into one page no longer throws.

## [0.2.0] — 2026-09-21

### Changed

- API keys and the SteamID64 now live in their own `credentials` storage
  entry, read only by the background page and the options page. Content
  scripts on store pages no longer receive them (they only ever needed the
  colours and the title-matching switch). An existing 0.1 `settings` object
  is migrated on the first start.
- The Steam Web API key and IsThereAnyDeal key fields on the options page are
  masked (`type="password"`), and the page says plainly that keys are stored
  unencrypted in local extension storage.


## [0.1.0] — 2026-09-21

### Added

- First version: badges games on Steam that you already own on GOG (purple
  **G**) and games on GOG that you already own on Steam (blue **S**), on
  every tile, row and game page of both stores.
- Two-layer matching: exact cross-store IDs through IsThereAnyDeal, then a
  normalised-title fallback (dashed ring) for editions the database keeps
  separate.
- `n/m` badges on Steam bundles and packages.
- Libraries read from the browser's Steam and GOG logins; optional Steam Web
  API key mode; optional IsThereAnyDeal API key.
- Toolbar popup with status and **Refresh now**; options page for the Steam
  method, title matching, refresh interval and badge colours.

This is the first release under the name Cross-Store Owned; the extension was
prototyped as "Double Dip" before it joined this repository and never
shipped under that name.
