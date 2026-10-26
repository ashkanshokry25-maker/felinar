// Device-local state: theme, drafts, notices received, what is hidden, a cache of private follows and blocks, and the pointer
// of this page. Everything is per origin (each person's page is its own origin), lives in localStorage and is read through
// try/catch, because localStorage can be missing or throw (private windows, blocked site data); then the values live in memory
// for this page view only and the page works the same. Nothing secret goes here: the private record is mw.me, not this.

const PREFIX = 'social.';

export function createStore(backing) {
  let ls = null;
  try { ls = backing === undefined ? window.localStorage : backing; if (ls) ls.getItem(PREFIX + 'probe'); } catch (err) { ls = null; }
  const mem = new Map();
  const read = (key, fallback) => {
    try {
      const stored = ls ? ls.getItem(PREFIX + key) : null;
      const raw = stored !== null && stored !== undefined ? stored : mem.has(key) ? mem.get(key) : null;
      return raw === null || raw === undefined ? fallback : JSON.parse(raw);
    } catch (err) { return fallback; }
  };
  const write = (key, value) => {
    const raw = JSON.stringify(value);
    if (!ls) { mem.set(key, raw); return false; } // nowhere to persist: this page view only
    try { ls.setItem(PREFIX + key, raw); return true; } catch (err) { mem.set(key, raw); return false; }
  };
  const remove = (key) => { try { if (ls) ls.removeItem(PREFIX + key); } catch (err) { /* nothing to remove */ } mem.delete(key); };
  const listeners = new Set();
  const notify = (key) => { for (const fn of listeners) fn(key); };
  return {
    persistent: !!ls,
    get: read,
    set(key, value) { const ok = write(key, value); notify(key); return ok; },
    remove(key) { remove(key); notify(key); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    clearAll() {
      try { if (ls) for (const k of Object.keys(ls)) if (k.startsWith(PREFIX)) ls.removeItem(k); } catch (err) { /* ignore */ }
      mem.clear(); notify('*');
    },
  };
}

// Typed accessors, so the key names live in one place.
export const KEYS = Object.freeze({
  theme: 'theme', drafts: 'drafts', notices: 'notices', hidden: 'hidden', blocked: 'blocked', privateFollows: 'privateFollows',
  home: 'home', pointer: 'pointer', prefs: 'prefs', lastUpdated: 'lastUpdated', groups: 'groups', okQueue: 'okQueue', wallQueue: 'wallQueue', dirPins: 'dirPins', verified: 'verified',
});
export const DEFAULT_PREFS = Object.freeze({ autoPictures: false, followsPublic: true, notifyReplies: true, notifyMentions: true, notifyFollows: true, notifyShares: true });
