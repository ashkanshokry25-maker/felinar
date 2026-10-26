// Routes of the social template (R 3.7). The loader answers every path with the app (ARCHITECTURE 3.1), so a deep link works
// on reload and when shared; the app reads location.pathname and keeps the address bar in step with the History API.
// Pure functions: parseRoute(pathname) -> { name, ...params } and hrefFor(name, params) are inverses for every route.

import { SETTINGS_SECTIONS } from './config.js';

const LABEL = '[a-z2-7]{32}';
const HANDLE = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.[a-z]{2,24}';

/** Every route name; 'notfound' is the state for a path that is none of them. */
export const ROUTE_NAMES = Object.freeze(['home', 'profile', 'post', 'group', 'messages', 'thread', 'notifications', 'media', 'settings', 'about', 'notfound']);

export function normalizePath(input) {
  let p = String(input == null ? '/' : input).split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  try { p = decodeURIComponent(p); } catch (err) { return null; }
  if (/[\u0000-\u001f\\]/.test(p) || p.indexOf('//') !== -1 || p.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

const who = (seg) => {
  const m = new RegExp('^@(' + LABEL + '|' + HANDLE + ')$').exec(seg);
  if (!m) return null;
  return new RegExp('^' + LABEL + '$').test(m[1]) ? { label: m[1] } : { handle: m[1] };
};

export function parseRoute(pathname) {
  const p = normalizePath(pathname);
  if (p === null) return { name: 'notfound', path: String(pathname) };
  const parts = p.split('/').slice(1);
  const [a, b, c] = parts;
  const nf = { name: 'notfound', path: p };
  if (p === '/' || p === '/index.html') return { name: 'home' };
  if (a && a.startsWith('@')) {
    const w = who(a);
    if (!w) return nf;
    if (parts.length === 1) return Object.assign({ name: 'profile' }, w);
    if (parts.length === 3 && b === 'p' && /^[0-9a-f]{64}$/.test(c)) return Object.assign({ name: 'post', h: c }, w);
    return nf;
  }
  if (a === 'g' && parts.length === 2 && new RegExp('^' + LABEL + '$').test(b || '')) return { name: 'group', label: b };
  if (a === 'messages' && parts.length === 1) return { name: 'messages' };
  if (a === 'messages' && parts.length === 2 && /^[0-9a-f]{8}$/.test(b)) return { name: 'thread', short: b };
  if (a === 'notifications' && parts.length === 1) return { name: 'notifications' };
  if (a === 'media' && parts.length === 1) return { name: 'media', id: '' };
  if (a === 'media' && parts.length === 2 && /^[A-Za-z0-9_-]{1,64}$/.test(b)) return { name: 'media', id: b };
  if (a === 'settings' && parts.length === 1) return { name: 'settings', section: '' };
  if (a === 'settings' && parts.length === 2 && SETTINGS_SECTIONS.indexOf(b) !== -1) return { name: 'settings', section: b };
  if (a === 'about' && parts.length === 1) return { name: 'about' };
  return nf;
}

/** hrefFor(name, params) -> the path for a route. */
export function hrefFor(name, params = {}) {
  const who2 = params.label ? '@' + params.label : params.handle ? '@' + params.handle : '';
  switch (name) {
    case 'home': return '/';
    case 'profile': return '/' + who2;
    case 'post': return '/' + who2 + '/p/' + params.h;
    case 'group': return '/g/' + params.label;
    case 'messages': return '/messages';
    case 'thread': return '/messages/' + params.short;
    case 'notifications': return '/notifications';
    case 'media': return params.id ? '/media/' + params.id : '/media';
    case 'settings': return params.section ? '/settings/' + params.section : '/settings';
    case 'about': return '/about';
    default: return '/';
  }
}

/** True for a click on a link that stays inside the app (same origin, a path the router knows), so the app can handle it with pushState. */
export function isAppPath(pathname) {
  return parseRoute(pathname).name !== 'notfound';
}
