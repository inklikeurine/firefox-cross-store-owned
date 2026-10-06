# Cross-Store Owned

Badges games on Steam that you already own on GOG, and games on GOG that you
already own on Steam.

If you buy on both stores, sooner or later you pay twice for the same game.
Cross-Store Owned reads your two libraries from the accounts you are already
logged in to, matches them through IsThereAnyDeal's cross-store ID database,
and puts a small badge on every game tile, row and page that you already own
on the *other* store — so you see it before you click "Add to cart".

## What it does

- On **store.steampowered.com**: a purple **G** on games you own on GOG.
- On **www.gog.com**: a blue **S** on games you own on Steam.
- Badges appear on every tile, row and page: search results, the front page,
  sale pages, wishlists, DLC lists and the game's own page. Clicking a badge
  (or focusing it and pressing Enter) opens the game on the other store in a
  new tab; hovering shows the matched title.
- Steam bundles and packages get a count: **G 2/5** means you own 2 of its
  5 apps on GOG.
- The **toolbar icon** shows how many games on the current store page you
  own on the other store. A red **!** on it means the last library read had a
  problem; **…** means a read is running.
- The **toolbar popup** shows both libraries at a glance, lists the badged
  games on the page you are on (with **Hide** for a wrong match), and has a
  **Do I own…?** search across both libraries — handy when a game is on sale
  somewhere else.
- The settings page lists **every game you own on both stores**.
- Libraries are refreshed automatically (every 6 hours by default), when you
  open a Steam page after logging back in, and on demand.

| Badge | Meaning |
| --- | --- |
| `G` / `S` | Exact match through IsThereAnyDeal's cross-store ID database |
| `G` / `S` with a dashed ring | Title match — same normalised name, edition words ignored (you own the base game, this tile is the *Complete Edition*) |
| `G 2/5` | Steam bundle or package: you own 2 of its 5 apps on GOG |

## Installation

There is no build step — the folder is loadable as-is.

**Temporary install (for trying it out):** open `about:debugging#/runtime/this-firefox`,
click **Load Temporary Add-on…** and select `manifest.json` inside this folder.
The extension is removed when Firefox restarts.

**With `web-ext` (for development):** `web-ext run --source-dir ./cross-store-owned`
launches a clean Firefox profile with the extension loaded.

**Permanent install:** Firefox only permanently installs signed extensions.
`web-ext build` produces a package to submit to
[addons.mozilla.org](https://addons.mozilla.org/developers/) for signing
(unlisted self-distribution is fine).

Source: https://github.com/inklikeurine/firefox-extensions/tree/main/cross-store-owned

## Usage

1. Log in to both `store.steampowered.com` and `www.gog.com` in Firefox.
2. Click the toolbar icon → **Refresh now**. The first run looks up your whole
   library on IsThereAnyDeal (a progress bar shows how far it is — a few
   seconds per thousand games); after that only new games are looked up and
   the libraries are re-read every 6 hours.
3. Browse either store. Badges appear as pages load, and the toolbar icon
   counts them.

### The toolbar popup

- **Steam / GOG cards** — how many items each library holds and when it was
  read. A card that says *Not logged in* has a **Log in** button; log in,
  then click **Refresh now** (or just open a Steam page — a fresh login there
  is noticed and the read retried).
- **You own N games on both stores →** opens the full list in Settings.
- **On this page** (on a Steam or GOG page) — each badged game, with its
  badge letter (click it to open the other store) and **Hide**. Hide a badge
  when a title match is wrong; it disappears from every page and the popup
  keeps it listed with **Show** to bring it back.
- **Do I own…?** — type part of a name to search both libraries. Each result
  shows **S** and/or **G** for where you own it; click one to open that store
  page.

### Settings

Toolbar popup → the sliders button, or `about:addons` → Cross-Store Owned →
Preferences. Changes save as you make them.

- **Status** — counts, the last read, any problem, **Refresh now**.
- **Steam library** — *Use my browser's Steam login* (default) reads your
  owned apps, DLC and packages from the store with your cookies, and the
  store's own session token to fetch game names for title matching and
  search. *Use the Steam Web API* instead takes a
  [Steam Web API key](https://steamcommunity.com/dev/apikey) and your
  SteamID64 and works without being logged in to the store; it needs
  "Game details" set to **Public** in your Steam privacy settings. The
  SteamID64 field also takes a profile link
  (`steamcommunity.com/profiles/…`, or `steamcommunity.com/id/<name>` once the
  key is filled in).
- **GOG library** — always read from your browser's GOG login. GOG has no
  public library API, so there is nothing to configure.
- **IsThereAnyDeal API key** — optional. The lookup endpoints answer
  anonymous requests today; add a key from
  [isthereanydeal.com/apps/my](https://isthereanydeal.com/apps/my/) if that
  changes.
- **About keys.** Any key you enter is kept in this extension's local
  storage in your Firefox profile, **unencrypted** — an extension has nowhere
  to keep an encryption key that someone who can read your profile could not
  also read, and the same profile already holds your logged-in Steam and GOG
  sessions. The default Steam mode needs no key at all. Keys are only sent
  to the service they belong to, are masked on the settings page, and never
  reach the store pages' content scripts. To forget a key, empty the field,
  or remove the extension (**Clear cached data** keeps settings and keys).
- **Also match by title** — the dashed-ring fallback described above. Turn
  it off if you only want exact ID matches; it takes effect at once.
- **Badges** — show or hide the badges on each store separately; the badge
  text (**G / S** or **GOG / Steam**); the toolbar count on or off; the two
  badge colours, with a live preview and **Default colours**.
- **Refresh** — how often both libraries are re-read (1–168 hours).
- **Owned on both stores** — every game you own on both, editions grouped,
  with links to each store page and a filter box.
- **Hidden badges** — how many you have hidden, and **Show all hidden badges
  again**.
- **Clear cached data** — drops the libraries, matches and lookup cache.
  Settings, keys and hidden badges are kept.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `storage` | Keeps your settings, the two libraries, the IsThereAnyDeal lookup cache, the match tables the badges read, the owned-on-both list and the badges you hid. |
| `unlimitedStorage` | A library of several thousand games plus its lookup cache is a few megabytes; this keeps it from being evicted under Firefox's normal storage quota. Silent permission, no prompt. |
| `alarms` | Schedules the periodic library refresh (default every 6 hours). |
| `https://store.steampowered.com/*` | Reads your owned apps, DLC and packages from the store with your login (`/dynamicstore/userdata`), and the session token the store hands logged-in users. Also where the Steam badges are shown. |
| `https://api.steampowered.com/*` | Fetches game names (`GetOwnedGames`) for title matching and search, with the session token or your own Web API key; turns a custom profile name into a SteamID64 (`ResolveVanityURL`, only when you type one in Settings). |
| `https://www.gog.com/*` | Reads your owned product IDs and titles with your login (`/user/data/games`, `/account/getFilteredProducts`). Also where the GOG badges are shown. |
| `https://embed.gog.com/*` | Fallback host for the same GOG library endpoints. |
| `https://api.gog.com/*` | Looks up a store link for a GOG product the library listing did not cover (public endpoint, no login). |
| `https://api.isthereanydeal.com/*` | Resolves Steam and GOG product IDs to IsThereAnyDeal game IDs and back, which is how the two libraries are matched. |

Content scripts run on `https://store.steampowered.com/*` and
`https://www.gog.com/*` to find game tiles and draw the badges. They read
only the page's own product attributes, links and titles, and whether
Steam's page header shows you logged in. The popup's **On this page** list
comes from those content scripts; the popup needs no `tabs` permission for it.

**Data collection and transmission.** The manifest declares
`data_collection_permissions: { required: ["websiteContent"] }` because the
extension cannot work without sending something out of the browser: the
**lists of Steam app/package IDs and GOG product IDs you own** are posted to
`api.isthereanydeal.com` so they can be matched. No account name, SteamID,
e-mail, cookie or browsing history goes with them, and nothing at all is sent
to the extension's author or anyone else. The requests to Steam and GOG are
the same ones the two sites make for you while you browse them logged in, and
your Steam Web API key (if you enter one) is sent only to
`api.steampowered.com`. The **Do I own…?** search runs entirely inside
Firefox. Everything the extension keeps — including any API key you enter,
stored unencrypted — lives in Firefox's local extension storage and is
deleted with the extension.

## Known limitations

- Steam's `dynamicstore/userdata` list omits apps without a store page;
  those cannot be badged anyway.
- GOG sells several product IDs for one game (base, pack, GOTY). Exact ID
  matches cover the editions IsThereAnyDeal links together; the title
  fallback catches the rest, which is why it is on by default. A title
  match can still be wrong when two different games share a name — hide that
  badge from the popup.
- Steam packages (`/sub/…`) are only matched by ID, not by title.
- Getting game names without a Steam Web API key relies on an undocumented
  store session token. If Steam changes it, Steam-side title matching and
  search of Steam names silently stop (the popup shows a warning) and ID
  matching carries on.
- Pages Steam builds without its usual `data-ds-*` markup (the React
  wishlist, some hubs) are covered by a fallback that badges image links to
  `/app/…` and `/sub/…` pages; text-only links there get no badge.
- Only Steam pages can tell the extension you have just logged in; after
  logging in to GOG, click **Refresh now**.
- The first refresh of a large library takes a while (IsThereAnyDeal
  lookups are batched 200 at a time); later refreshes only ask about new
  games, and an interrupted one carries on where it stopped.
- Store markup changes need selector updates in `content/steam.js` /
  `content/gog.js`.
- Firefox on desktop only. Not tested on Firefox for Android.

## AI-generated

This extension was generated by an AI agent under human direction. It is
provided as-is and used at your own risk; read the source before installing.

## License

Public domain under [The Unlicense](../UNLICENSE).
