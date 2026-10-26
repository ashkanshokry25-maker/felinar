// src/idp/psl.js: the Public Suffix List snapshot bundled in the identity origin build (R 2.2.3, 2.17.5;
// MF-13, MF-30). A hub host `<32 base32>.<suffix>` may get the hub label `h|<suffix>` only when <suffix> is
// a rule of this snapshot: the browser then treats every label of the hub as its own site (separate storage,
// separate passkey RP IDs), so one hub key per person is a choice and not an accident of shared storage.
//
// This is a CURATED snapshot written from memory (the build has no network; docs/deviations/idp.md): a few
// dozen entries of the PSL private section that host one site per subdomain. It is not the whole list and it
// has no ICANN section, so a single-label TLD (com, org) is never a hub suffix here. A hub that is not listed
// gets per-origin keys (the safe default) until the snapshot is updated and the IdO rebuilt.
//
// Loopback test builds may add suffixes (tools/build-idp.mjs --test --test-psl <suffix>): esbuild defines
// MW_TEST_PSL as a JSON array; a normal build leaves it undefined and adds nothing.
//
// Hub suffixes (code review v0.3, security 9): the list above says where the browser keeps each label apart; it
// does not say that one operator runs every label. On github.io, pages.dev, netlify.app and the rest of the list
// anyone registers a 32-character name, so a hub label there would hand one person's key to every stranger's
// page of that shape. The hub label is therefore offered only for HUB_SUFFIXES: suffixes of single-operator
// hubs built into this identity origin (a build defines MW_HUB_SUFFIXES as a JSON array of suffixes its
// operator has on the Public Suffix List; the build adds them to the snapshot), plus the loopback suffixes of a
// test build. A normal build has none, so every hub
// gets per-site keys until its operator is added. The same goes for shared-origin hubs (R 2.2.3): which origins
// serve many publishers is decided here (MW_SHARED_ORIGINS), never by the page asking for a key.
//
// Pure: Node >= 22 and browsers.

/* global MW_TEST_PSL, MW_HUB_SUFFIXES, MW_SHARED_ORIGINS, MW_HUB_TEMPLATES */

export const PSL_SNAPSHOT = Object.freeze({
  source: 'curated subset of the Public Suffix List private section, written from memory on 2026-10-20 (not fetched)',
  get rules() { return PSL_RULES.length; },
});

/** The curated rules (lowercase, punycode). '*.' wildcards and '!' exceptions follow the PSL algorithm. */
export const PSL_RULES = Object.freeze([
  'appspot.com',
  'azurestaticapps.net',
  'azurewebsites.net',
  'bitbucket.io',
  'blogspot.com',
  'cloudfront.net',
  'codeberg.page',
  'deno.dev',
  'firebaseapp.com',
  'fly.dev',
  'github.io',
  'gitlab.io',
  'glitch.me',
  'herokuapp.com',
  'neocities.org',
  'netlify.app',
  'ngrok.io',
  'onrender.com',
  'pages.dev',
  'readthedocs.io',
  'repl.co',
  'srht.site',
  'surge.sh',
  'trycloudflare.com',
  'vercel.app',
  'web.app',
  'wixsite.com',
  'workers.dev',
]);

function testRules() {
  try {
    // A test build defines MW_TEST_PSL; everywhere else the identifier does not exist.
    if (typeof MW_TEST_PSL !== 'undefined' && Array.isArray(MW_TEST_PSL)) {
      return MW_TEST_PSL.filter((r) => typeof r === 'string' && /^[a-z0-9.*!-]{1,253}$/.test(r));
    }
  } catch (_) {
    // not defined
  }
  return [];
}

/** True when this bundle was built with --test-psl (the cards then say "Test build"). */
export const PSL_TEST_RULES = Object.freeze(testRules());

function definedList(read) {
  try {
    const v = read();
    if (Array.isArray(v)) return v.filter((r) => typeof r === 'string' && /^[a-z0-9.:/-]{1,253}$/.test(r)).map((r) => r.toLowerCase());
  } catch (_) {
    // not defined in this build
  }
  return [];
}

const BUILD_HUBS = definedList(() => (typeof MW_HUB_SUFFIXES !== 'undefined' ? MW_HUB_SUFFIXES : undefined));

/** The single-operator hub suffixes of this build (MW_HUB_SUFFIXES), plus a test build's loopback suffixes. */
export const HUB_SUFFIXES = Object.freeze(BUILD_HUBS.concat(PSL_TEST_RULES));

/**
 * The hub templates of this build (review round PHISH-1, HUB-3): MW_HUB_TEMPLATES, a JSON array of 40-hex infohashes (the
 * operator's own page code, tools/build-idp.mjs --hub-template, requested of the tools lane). A hub label h|<suffix> goes
 * only to a page whose verified pointer is its own hub address and names one of these infohashes; without a build list the
 * identity origin keeps, per hub, the infohash of the page where the person turned the hub identity on (src/idp/idp.js).
 * The suffix list alone does not say that one operator runs every label: on a social hub every person's page is a label.
 */
export const HUB_TEMPLATES = Object.freeze(definedList(() => (typeof MW_HUB_TEMPLATES !== 'undefined' ? MW_HUB_TEMPLATES : undefined)).filter((b) => /^[0-9a-f]{40}$/.test(b)));

/** The shared-origin hubs of this build (MW_SHARED_ORIGINS, serialised origins): "this visit only" there. */
export const SHARED_ORIGINS = Object.freeze(definedList(() => (typeof MW_SHARED_ORIGINS !== 'undefined' ? MW_SHARED_ORIGINS : undefined)));

function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h || h.length > 253 || !/^[a-z0-9.-]+$/.test(h) || h.indexOf('..') >= 0 || h.startsWith('.')) return null;
  return h;
}

function ruleSet(rules) {
  const exact = new Set();
  const wild = new Set();
  const except = new Set();
  for (const raw of rules) {
    const r = String(raw).trim().toLowerCase();
    if (!r) continue;
    if (r.startsWith('!')) except.add(r.slice(1));
    else if (r.startsWith('*.')) wild.add(r.slice(2));
    else exact.add(r);
  }
  return { exact, wild, except };
}

/**
 * createPsl({ rules = PSL_RULES, extra = [], hubs = HUB_SUFFIXES }) -> { publicSuffixOf(host), isPublicSuffix(suffix),
 * isHubSuffix(suffix), hubSuffixOf(host) }. A checker over a rule list; the default export functions use the bundled
 * snapshot plus any test rules. hubs: the suffixes that may carry the hub label (each must also be a public suffix).
 */
export function createPsl({ rules = PSL_RULES, extra = [], hubs = HUB_SUFFIXES } = {}) {
  // A hub suffix of this build is a public suffix by its operator's statement (the snapshot may not hold it).
  const set = ruleSet(Array.from(rules).concat(Array.from(extra || []), Array.from(hubs || [])));
  const hubSet = new Set(Array.from(hubs || []).map((h) => String(h).toLowerCase()));

  /** The longest listed suffix of host, or null when no rule matches (the implicit '*' rule is not used). */
  function publicSuffixOf(host) {
    const h = normalizeHost(host);
    if (!h) return null;
    const labels = h.split('.');
    let best = null;
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      if (set.except.has(candidate)) {
        const s = labels.slice(i + 1).join('.');
        if (s && (best === null || s.length > best.length)) best = s;
        continue;
      }
      const parent = labels.slice(i + 1).join('.');
      const matches = set.exact.has(candidate) || (parent && set.wild.has(parent));
      if (matches && (best === null || candidate.length > best.length)) best = candidate;
    }
    return best;
  }

  /** True when suffix itself is a public suffix under the rules (exact rule or a wildcard child). */
  function isPublicSuffix(suffix) {
    const s = normalizeHost(suffix);
    if (!s) return false;
    return publicSuffixOf(s) === s;
  }

  /** True when suffix is a single-operator hub of this build and a public suffix (the hub label may be offered). */
  function isHubSuffix(suffix) {
    const s = normalizeHost(suffix);
    return Boolean(s) && hubSet.has(s) && isPublicSuffix(s);
  }

  /**
   * hubSuffixOf(host) -> { label, suffix } when host is exactly `<32 base32>.<hub suffix>`, else null.
   * This is the hub shape of ARCHITECTURE 3.2 (a hub label is 32 characters [a-z2-7]); the suffix must be one of
   * the build's hub suffixes, not merely on the Public Suffix List (security 9).
   */
  function hubSuffixOf(host) {
    const shape = hubShapeOf(host);
    return shape && isHubSuffix(shape.suffix) ? shape : null;
  }

  return { publicSuffixOf, isPublicSuffix, isHubSuffix, hubSuffixOf };
}

/**
 * hubShapeOf(host) -> { label, suffix } when host is `<32 base32>.<anything>`, else null: the shape only, for
 * display decisions (a personal site's address derived from its own pointer), never for a key decision.
 */
export function hubShapeOf(host) {
  const h = normalizeHost(host);
  if (!h) return null;
  const dot = h.indexOf('.');
  if (dot !== 32) return null;
  const label = h.slice(0, 32);
  const suffix = h.slice(33);
  if (!/^[a-z2-7]{32}$/.test(label) || !suffix) return null;
  return { label, suffix };
}

/** isSharedOrigin(origin, list = SHARED_ORIGINS) -> true for a shared-origin hub of this build (R 2.2.3). */
export function isSharedOrigin(origin, list = SHARED_ORIGINS) {
  if (typeof origin !== 'string') return false;
  const o = origin.toLowerCase();
  return Array.from(list || []).some((x) => String(x).toLowerCase() === o);
}

const DEFAULT = createPsl({ extra: PSL_TEST_RULES, hubs: HUB_SUFFIXES });

/** publicSuffixOf(host) against the bundled snapshot. */
export function publicSuffixOf(host) {
  return DEFAULT.publicSuffixOf(host);
}

/** isPublicSuffix(suffix): what derive.js labelFor takes as its injected PSL check. */
export function isPublicSuffix(suffix) {
  return DEFAULT.isPublicSuffix(suffix);
}

/** isHubSuffix(suffix): what derive.js labelFor takes as its hub check (a single-operator hub of this build). */
export function isHubSuffix(suffix) {
  return DEFAULT.isHubSuffix(suffix);
}

/** hubSuffixOf(host) -> { label, suffix } | null against the bundled snapshot and this build's hub suffixes. */
export function hubSuffixOf(host) {
  return DEFAULT.hubSuffixOf(host);
}
