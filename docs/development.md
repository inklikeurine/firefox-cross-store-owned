# Cross-Store Owned — development

## Run it

```sh
web-ext run --source-dir ./cross-store-owned      # clean profile, reloads on change
web-ext lint --source-dir ./cross-store-owned --warnings-as-errors
```

Or `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
`manifest.json`. Log in to both stores in that profile, open the popup and
click **Refresh now**; the options page's Status card shows counts, errors
and warnings.

## Where to look when something is off

- **No badges anywhere** — popup: do both store cards show a count and a ✓?
  If a card says *Logged out* or shows an error, the refresh failed for
  that store (a red **!** on the toolbar icon says the same). If both are
  fine, check Settings → Badges (*Show … badges on …*), then open the Browser
  Console (Ctrl+Shift+J) and filter on `cross-store-owned`.
- **One badge missing** — popup → **On this page**: if the game is listed
  struck through, it was hidden; click **Show**. Settings → Upkeep lists
  every hidden badge with its own **Show**.
- **A letter instead of the store icon** — the store's `/favicon.ico` could
  not be read or decoded (a warning in the Browser Console says which). The
  next refresh tries again; **Clear cached data** forces it.
- **Badges on some tiles, not others** — the tile is probably missing the
  attribute the adapter keys on. Inspect it: Steam tiles need
  `data-ds-appid` / `data-ds-packageid`; GOG tiles need one of
  `data-product-id`, `card-product`, `menu-product`, `gog-product`,
  `product-tile-id` with a numeric value. On Steam pages without
  `data-ds-*` markup, only image links to `/app/N` or `/sub/N` are badged.
  Selectors live at the top of `content/steam.js` and `content/gog.js`.
- **Badge in the wrong place** — the engine picks overlay vs inline from the
  element's computed display and whether it contains an image. An adapter can
  force `mode`, `container`, `anchor` and `corner` per tile.
- **Steam title matches missing** — the popup warning "Steam isn't giving out
  game names right now" means the store's `webapi_token` could not be read; ID matching
  still works. Switching to the Web API method in Settings restores names.

## With the workspace (`.dev/`)

```sh
node .dev/tools/check.mjs cross-store-owned              # every AGENTS.md rule + web-ext lint
node .dev/harness/run.mjs cross-store-owned --tests      # headless suites (common, background, content)
node .dev/harness/run.mjs cross-store-owned --tests --suite content   # one suite
sh .dev/review/cross-store-owned/live-gog.sh             # live check of the GOG adapter
node .dev/harness/run.mjs cross-store-owned --spec       # suites + live check from review/cross-store-owned/harness.json
```

Run `live-gog.sh` before `--spec`: both write `out/cross-store-owned/result.json`,
and the validator only accepts the spec run's.

The live check serves `.dev/fixtures/cross-store-owned/steam.html` at a
`store.steampowered.com` URL so the Steam content script runs against it,
seeds `maps`, both libraries and the owned-on-both list from the background,
and checks the badges, the toolbar badge, search, the popup and the options
page. `gog.html` does the same for the GOG adapter. Neither fixture is a saved
store page; both are hand-written with only the markup the adapters read. The
headless `content.test.mjs` loads the same two fixtures into jsdom.

The background's install-time refresh runs during the live check too; with no
store login it fails per store (Steam: not logged in; GOG: HTTP 403 to
headless Firefox) and records the problems in `status`, which is the
expected path: the toolbar shows "!" and the popup's Steam card offers
**Log in**.

## Adding a store

1. Add the host to `CSO.HOST_ORIGINS` in `lib/common.js` and to
   `host_permissions` + a `content_scripts` entry in `manifest.json`.
2. Write a library reader in `background.js` and extend `buildMaps` with the
   store's IsThereAnyDeal shop ID (look it up in the IsThereAnyDeal API docs;
   Steam is 61 and GOG is 35).
3. Write `content/<store>.js` implementing the adapter table in
   [architecture.md](./architecture.md).
4. Explain the new host permission in the README, add a fixture and evals,
   bump MINOR.

## Release

See the checklist at the end of [spec.md](./spec.md).
