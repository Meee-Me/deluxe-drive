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
//   adds     other apps' data this site may add new items to (never read or change):
//            Drive file records, or Deluxe Mail messages (inbox/ and sent/ only)
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
    url: 'https://deluxe-docs-qtp5.vercel.app',
    origins: ['https://deluxe-docs-qtp5.vercel.app', 'https://deluxe-docs.deluxelordd.workers.dev', 'https://deluxe-docs-iota.vercel.app', 'https://deluxe-docs.netlify.app'],
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
    // Convert can open files from Deluxe Drive, and save converted files into
    // it (new files only: it never changes or deletes anything there).
    reads: ['drive'],
    adds: ['drive'],
  },
  translate: {
    name: 'Deluxe Translate',
    about: 'Translate text and photos',
    url: 'https://deluxe-translate-app.vercel.app',
    origins: [
      'https://deluxe-translate-app.vercel.app',
      'https://deluxe-translate-8m27.netlify.app',
      'https://*--deluxe-translate-8m27.netlify.app',
    ],
    reads: [],
  },
  youtube: {
    name: 'YouTube Guider AI',
    about: 'Channel stats and estimates',
    url: 'https://deluxe-youtube-guider.vercel.app',
    origins: [
      'https://deluxe-youtube-guider.vercel.app',
      'https://youtube-guide-ai.netlify.app',
      'https://*--youtube-guide-ai.netlify.app',
    ],
    reads: [],
  },
  max: {
    name: 'Max Tutor',
    about: 'Your AI tutor',
    url: 'https://learning-ai-lilac.vercel.app',
    origins: ['https://learning-ai-lilac.vercel.app'],
    reads: [],
  },
  meet: {
    name: 'Deluxe Meet',
    about: 'Video calls in your browser',
    url: 'https://deluxe-meet.vercel.app',
    origins: ['https://deluxe-meet.vercel.app'],
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
  edit: {
    name: 'Fast Edit',
    about: 'Edit photos and videos with AI',
    url: 'https://fast-edit-nine.vercel.app',
    origins: ['https://fast-edit-nine.vercel.app', 'https://fastedit.vercel.app'],
    // Saves its own data only (your saved looks); never reads or adds to other websites.
    reads: [],
  },
  transfer: {
    name: 'Deluxe Transfer',
    about: 'Send files with a code',
    url: 'https://deluxe-transfer.vercel.app',
    origins: ['https://deluxe-transfer.vercel.app'],
    reads: [],
    // Sends a Deluxe Mail message (with the transfer's link) to the people
    // files are shared with, and a copy to the sender's Sent; and saves
    // received files into the person's own Deluxe Drive ("Save to Deluxe
    // Drive"). It can only add: it never reads, changes or deletes anyone's
    // mail or files.
    adds: ['mail', 'drive'],
    // SHA-256 of the key Deluxe Transfer's server sends (MAIN_APP_KEY on Vercel).
    keyHash: 'ac9a67e79f364e9c5984d9c3b1ba3f9493e036a2f2766d9c1f22f09ea734a60c',
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
