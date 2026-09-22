# Changelog

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
