// Cross-Store Owned — lib/common.js: title normaliser, settings defaults, validators.
import { readFileSync } from 'node:fs';
import { T, loadScript, makeBrowserShim } from '../../firefox-tools/harness/lib.mjs';

function boot(storage = {}) {
  const shim = makeBrowserShim({ storage });
  const ctx = loadScript(T.extFile('lib/common.js'), { browser: shim.browser });
  return { shim, CSO: ctx.CSO };
}

T.run('normalizeTitle strips editions, punctuation, diacritics and marks', () => {
  const { CSO } = boot();
  const n = CSO.normalizeTitle;
  T.eq(n('The Witcher 3: Wild Hunt - Complete Edition'), 'the witcher 3 wild hunt');
  T.eq(n('The Witcher 3: Wild Hunt – Game of the Year Edition'), 'the witcher 3 wild hunt');
  T.eq(n('The Witcher: Enhanced Edition Director’s Cut'), 'the witcher');
  T.eq(n('Blade Runner: The Final Cut'), 'blade runner');
  T.eq(n('Batman: Arkham City GOTY'), 'batman arkham city');
  T.eq(n('Cyberpunk 2077™'), 'cyberpunk 2077');
  T.eq(n('Bastion & Transistor'), 'bastion and transistor');
  T.eq(n('Pokémon'), 'pokemon');
  T.eq(n('DOOM Eternal Deluxe'), 'doom eternal', 'bare qualifier');
});

T.run('normalizeTitle keeps distinct products distinct', () => {
  const { CSO } = boot();
  const n = CSO.normalizeTitle;
  T.eq(n("Witch's Rhythm Puzzle Soundtrack Edition"), 'witchs rhythm puzzle soundtrack', 'soundtrack is not an edition word');
  T.eq(n('Dark Souls Remastered'), 'dark souls remastered', '"remastered" alone is not stripped');
  T.ok(n('Half-Life 2') !== n('Half-Life 2: Episode One'), 'episodes differ');
  T.eq(n(''), '');
  T.eq(n(null), '');
  T.eq(n(undefined), '');
  T.eq(n(42), '42', 'non-strings are stringified');
});

T.run('withDefaults applies defaults over missing and corrupt settings', () => {
  const { CSO } = boot();
  T.eq(CSO.withDefaults(undefined), CSO.DEFAULT_SETTINGS, 'undefined → defaults');
  T.eq(CSO.withDefaults('garbage'), CSO.DEFAULT_SETTINGS, 'string → defaults');
  T.eq(CSO.withDefaults([1, 2]), CSO.DEFAULT_SETTINGS, 'array → defaults');
  T.eq(CSO.withDefaults({ refreshHours: 12 }).refreshHours, 12, 'stored value wins');
  T.eq(CSO.withDefaults({ refreshHours: 12 }).matchByTitle, true, 'others default');
});

T.run('settings never carry a credential: unknown keys are dropped, defaults hold none', () => {
  const { CSO } = boot();
  for (const k of ['steamApiKey', 'steamId64', 'itadApiKey']) T.notOk(k in CSO.DEFAULT_SETTINGS, `${k} not a setting`);
  // A pre-0.2 settings object still holding the keys: what content scripts get must not include them.
  const legacy = { steamMethod: 'api', steamApiKey: 'SECRET', steamId64: '76561198000000001', itadApiKey: 'ITAD', gogColor: '#000000', extra: 1 };
  const seen = CSO.withDefaults(legacy);
  T.eq(Object.keys(seen).sort(), Object.keys(CSO.DEFAULT_SETTINGS).sort(), 'exactly the setting keys');
  T.eq(seen.steamMethod, 'api');
  T.eq(seen.gogColor, '#000000');
  T.eq(JSON.stringify(seen).includes('SECRET'), false, 'no key in the object');
});

T.runAsync('credentials: separate storage key, defaults for missing/corrupt, never mixed into settings', async () => {
  const { CSO } = boot({ credentials: { steamApiKey: 'K', steamId64: '1', itadApiKey: 'I', junk: true }, settings: { steamMethod: 'api' } });
  T.eq(await CSO.getCredentials(), { steamApiKey: 'K', steamId64: '1', itadApiKey: 'I' }, 'picked, junk dropped');
  T.eq(await CSO.getSettings(), { ...CSO.DEFAULT_SETTINGS, steamMethod: 'api' }, 'settings untouched by credentials');
  const empty = boot();
  T.eq(await empty.CSO.getCredentials(), CSO.DEFAULT_CREDENTIALS);
  T.eq(CSO.withCredentialDefaults('nope'), CSO.DEFAULT_CREDENTIALS);
  T.eq(CSO.withCredentialDefaults({ steamApiKey: 'x' }), { steamApiKey: 'x', steamId64: '', itadApiKey: '' });
});

T.runAsync('getSettings reads storage and never throws', async () => {
  const { CSO } = boot({ settings: { steamMethod: 'api', refreshHours: 3 } });
  const s = await CSO.getSettings();
  T.eq(s.steamMethod, 'api');
  T.eq(s.refreshHours, 3);
  T.eq(s.gogColor, '#7b2fbe', 'default colour');

  const broken = boot();
  broken.shim.browser.storage.local.get = async () => { throw new Error('boom'); };
  const warned = [];
  const origWarn = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    const d = await broken.CSO.getSettings();
    T.eq(d, broken.CSO.DEFAULT_SETTINGS, 'storage failure → defaults');
  } finally { console.warn = origWarn; }
  T.eq(warned.length, 1, 'one warning');
  T.ok(warned[0].startsWith('[cross-store-owned]'), 'prefixed');
});

T.run('refreshHours clamps to [1, 168] and defaults for garbage', () => {
  const { CSO } = boot();
  T.eq(CSO.refreshHours({ refreshHours: 6 }), 6);
  T.eq(CSO.refreshHours({ refreshHours: '12' }), 12, 'numeric string');
  T.eq(CSO.refreshHours({ refreshHours: 0 }), 6, 'zero → default');
  T.eq(CSO.refreshHours({ refreshHours: -3 }), 6, 'negative → default');
  T.eq(CSO.refreshHours({ refreshHours: 999 }), 168, 'clamped high');
  T.eq(CSO.refreshHours({ refreshHours: 2.7 }), 2, 'floored');
  T.eq(CSO.refreshHours({ refreshHours: 'abc' }), 6, 'NaN → default');
  T.eq(CSO.refreshHours({}), 6);
  T.eq(CSO.refreshHours(null), 6);
});

T.run('isMaps accepts the shape the content scripts read and rejects the rest', () => {
  const { CSO } = boot();
  T.ok(CSO.isMaps({ forSteam: { apps: {} }, forGog: { ids: {} } }));
  T.notOk(CSO.isMaps(null));
  T.notOk(CSO.isMaps({}));
  T.notOk(CSO.isMaps({ forSteam: {} }));
  T.notOk(CSO.isMaps({ forSteam: 'x', forGog: {} }));
  T.notOk(CSO.isMaps('maps'));
});

T.run('HOST_ORIGINS matches the manifest host_permissions', () => {
  const { CSO } = boot();
  const manifest = JSON.parse(readFileSync(T.extFile('manifest.json'), 'utf8'));
  T.eq([...CSO.HOST_ORIGINS].sort(), [...manifest.host_permissions].sort());
});

T.run('withDefaults replaces values of the wrong type or outside the allowed choices', () => {
  const { CSO } = boot();
  const s = CSO.withDefaults({ steamMethod: 'magic', badgeText: 'emoji', matchByTitle: 'yes', showOnGog: 0, gogColor: 'red', steamColor: '#ABCDEF', toolbarCount: false, refreshHours: '12' });
  T.eq(s.steamMethod, 'session', 'unknown method');
  T.eq(s.badgeText, 'letter', 'unknown badge text');
  T.eq(s.matchByTitle, true, 'string for a boolean');
  T.eq(s.showOnGog, true, 'number for a boolean');
  T.eq(s.gogColor, '#7b2fbe', 'colour name is not #rrggbb');
  T.eq(s.steamColor, '#ABCDEF', 'valid colour kept');
  T.eq(s.toolbarCount, false, 'valid boolean kept');
  T.eq(s.refreshHours, 6, 'string for a number');
  T.eq(CSO.withDefaults({ badgeText: 'name', steamMethod: 'api' }).badgeText, 'name');
});

T.run('new settings default to the 0.2 behaviour', () => {
  const { CSO } = boot();
  const d = CSO.DEFAULT_SETTINGS;
  T.eq([d.showOnSteam, d.showOnGog, d.badgeText, d.toolbarCount], [true, true, 'letter', true]);
});

T.run('hiddenList keeps valid, unique badge ids only', () => {
  const { CSO } = boot();
  T.eq(CSO.hiddenList(['steam:app/10', 'gog:1001', 'steam:app/10', 'steam:sub/5,app/6', 'gog:abc', 'other:1', 7, null]), ['steam:app/10', 'gog:1001', 'steam:sub/5,app/6']);
  T.eq(CSO.hiddenList('steam:app/10'), []);
  T.eq(CSO.hiddenList(undefined), []);
});

T.runAsync('setHidden adds and removes one id, ignoring junk', async () => {
  const { CSO, shim } = boot({ hidden: ['gog:1', 'junk'] });
  T.eq(await CSO.setHidden('steam:app/55', true), ['gog:1', 'steam:app/55']);
  T.eq(await CSO.setHidden('steam:app/55', true), ['gog:1', 'steam:app/55'], 'no duplicate');
  T.eq(await CSO.setHidden('gog:1', false), ['steam:app/55']);
  T.eq(await CSO.setHidden('<script>', true), ['steam:app/55'], 'invalid id refused');
  T.eq(shim.store.hidden, ['steam:app/55']);
});

T.run('since, formatCount, plural, steamUrl', () => {
  const { CSO } = boot();
  const now = 1_000_000_000_000;
  T.eq(CSO.since(0, now), 'never');
  T.eq(CSO.since(now - 20e3, now), 'just now');
  T.eq(CSO.since(now - 5 * 60e3, now), '5 min ago');
  T.eq(CSO.since(now - 3 * 3600e3, now), '3 h ago');
  T.eq(CSO.since(now - 72 * 3600e3, now), '3 days ago');
  T.eq(CSO.formatCount(1234567), '1,234,567');
  T.eq(CSO.formatCount(NaN), '0');
  T.eq(CSO.plural(1, 'game'), '1 game');
  T.eq(CSO.plural(2500, 'game'), '2,500 games');
  T.eq(CSO.plural(2, 'match', 'matches'), '2 matches');
  T.eq(CSO.steamUrl('app/10'), 'https://store.steampowered.com/app/10/');
  T.eq(CSO.steamUrl('sub/500'), 'https://store.steampowered.com/sub/500/');
});

await T.exit();
