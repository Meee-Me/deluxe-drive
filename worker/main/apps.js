// Every Deluxe website that signs in with Deluxe Main.
//
// A site may only receive a sign-in if its address is listed here: Main sends
// people back only to these origins, and the app a sign-in is for is taken from
// the origin, never from what the site asks for.
//
//   origins  where the site is served. "*" stands for one name part and is
//            only used for Netlify deploy previews ("*--site.netlify.app"),
//            which only that site's owner can create. Never use it for
//            vercel.app names: anyone can make "deluxe-docs-anything".
//   reads    other apps' data this site may read (never write)
//   url      where the site lives, for the list on Deluxe Main's home page
//   keyHash  SHA-256 (hex) of the key that site's own server uses to save data
//            for its users (Authorization: App <key>). A Worker secret
//            APP_KEY_<APP> works too.
//
// More origins can be added without editing this file: set the Worker variable
// APP_ORIGINS to JSON such as {"mail": ["https://my-mail.netlify.app"]}.

export const APPS = {
  main: {
    name: 'Deluxe Main',
    about: 'Your Deluxe account',
    origins: [],
    reads: [],
  },
  drive: {
    name: 'Deluxe Drive',
    about: 'Keep and share your files',
    url: 'https://deluxe-drive-xi.vercel.app',
    origins: [
      'https://deluxe-drive.deluxelordd.workers.dev',
      'https://deluxe-drive-xi.vercel.app',
      'https://deluxe-drive.netlify.app',
      'https://depuxe-drive.netlify.app',
      'https://tbr-deluxe-drive.netlify.app',
    ],
    reads: [],
  },
  docs: {
    name: 'Deluxe Docs',
    about: 'Open PDFs, Word, Excel and slides',
    url: 'https://deluxe-docs-iota.vercel.app',
    origins: ['https://deluxe-docs.deluxelordd.workers.dev', 'https://deluxe-docs-iota.vercel.app', 'https://deluxe-docs.netlify.app'],
    // Docs lists and opens the files kept in Deluxe Drive.
    reads: ['drive'],
  },
  convert: {
    name: 'Deluxe Convert',
    about: 'Convert files in your browser',
    url: 'https://deluxe-convert.vercel.app',
    origins: [
      'https://deluxe-convert.vercel.app',
      'https://deluxe-convert-cloud.deluxelordd.workers.dev',
      'https://deluxe-convert.deluxelordd.workers.dev',
      'https://deluxe-convert.netlify.app',
    ],
    reads: [],
  },
  translate: {
    name: 'Deluxe Translate',
    about: 'Translate text and photos',
    url: 'https://deluxe-translate-8m27.netlify.app',
    origins: ['https://deluxe-translate-8m27.netlify.app', 'https://*--deluxe-translate-8m27.netlify.app'],
    reads: [],
  },
  youtube: {
    name: 'YouTube Guider AI',
    about: 'Channel stats and estimates',
    url: 'https://youtube-guide-ai.netlify.app',
    origins: ['https://youtube-guide-ai.netlify.app', 'https://*--youtube-guide-ai.netlify.app'],
    reads: [],
  },
  mail: {
    name: 'Deluxe Mail',
    about: 'Your @deluxemail.com inbox',
    url: 'https://deluxe-mail.vercel.app',
    origins: ['https://deluxe-mail.vercel.app'],
    reads: [],
    // SHA-256 of the key Deluxe Mail's server sends (MAIN_APP_KEY on Vercel).
    // Only this fingerprint is here; the key itself is only on Vercel.
    keyHash: 'f76bda7a47eb72da8133d8fda903e4334b9503644d254439cea483789e0ea976',
  },
};

export const APP_IDS = Object.keys(APPS);

function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/\*/g, '[a-z0-9-]+');
  return new RegExp(`^${escaped}$`);
}

// The origins of every app, with APP_ORIGINS added on top.
export function appOrigins(env = {}) {
  const table = {};
  for (const id of APP_IDS) table[id] = [...APPS[id].origins];
  let extra = env.APP_ORIGINS;
  if (typeof extra === 'string' && extra.trim()) {
    try {
      extra = JSON.parse(extra);
    } catch (error) {
      extra = null;
    }
  }
  if (extra && typeof extra === 'object') {
    for (const [id, list] of Object.entries(extra)) {
      if (!table[id] || id === 'main') continue;
      for (const origin of [].concat(list)) if (typeof origin === 'string' && origin) table[id].push(origin.replace(/\/+$/, ''));
    }
  }
  return table;
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Which app an origin belongs to, or null. "http://localhost:*" is accepted
// only when ALLOW_LOCALHOST is "1", and then the app the page names is used.
export function appForOrigin(origin, env = {}, asked = '') {
  const clean = String(origin || '').toLowerCase().replace(/\/+$/, '');
  if (!clean) return null;
  const table = appOrigins(env);
  for (const id of APP_IDS) {
    if (id === 'main') continue;
    if (table[id].some((pattern) => patternToRegExp(pattern).test(clean))) return id;
  }
  if (env.ALLOW_LOCALHOST === '1' && LOCAL.test(clean) && APPS[asked] && asked !== 'main') return asked;
  return null;
}

export function publicApps(env = {}) {
  const table = appOrigins(env);
  return APP_IDS.filter((id) => id !== 'main').map((id) => ({
    id,
    name: APPS[id].name,
    about: APPS[id].about,
    url: APPS[id].url || (table[id][0] && !table[id][0].includes('*') ? table[id][0] : ''),
  }));
}
