// Reference parser for `_headers` (research spike for w2a-09; not wired into src/).
//
// Netlify's official parser (netlify/build packages/headers-parser/src/line_parser.ts), re-implemented:
//   - a "path line" is any trimmed line that STARTS WITH "/"
//   - a header line is "Name: value", split at the FIRST ":"; a line with no ":" is silently ignored
//   - "#" lines and blank lines are skipped
//   - a header line before any path line is an error ("Path should come before header")
//   - the same header name repeated inside one block is joined with ", "
// Cloudflare Pages / Workers static assets add two constructs that Netlify's parser does NOT understand:
//   - absolute-URL path lines ("https://example.pages.dev/*"): they contain ":" and do not start with "/", so the
//     Netlify rules turn them into a bogus header named "https"
//   - "! Name" detach lines (no ":" so Netlify ignores them silently)
// `parseHeaders(text, {flavor})` therefore reports those constructs instead of guessing.

// Header names a static host (and a Service Worker) must not let a _headers file override.
// Union of Netlify's documented "not applied" list and the names whose value the SW computes itself.
export const NEVER_FROM_HEADERS_FILE = Object.freeze([
  'accept-ranges', 'age', 'allow', 'alt-svc', 'connection', 'content-encoding', 'content-length', 'content-range',
  'date', 'location', 'server', 'set-cookie', 'set-cookie2', 'trailer', 'transfer-encoding', 'upgrade',
]);

export function parseHeaders(text, { flavor = 'mw' } = {}) {
  const diagnostics = [];
  const rules = [];
  let cur = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (line === '' || line.startsWith('#')) return;

    const isAbsUrl = /^https?:\/\//i.test(line);
    if (isAbsUrl) {
      if (flavor === 'netlify') {
        // what Netlify's parser really does: "https" becomes the header name
        const idx = line.indexOf(':');
        diagnostics.push({ line: n, level: 'error', message: `Netlify would read this as header "${line.slice(0, idx)}": absolute-URL rules are Cloudflare-only` });
        if (!cur) diagnostics.push({ line: n, level: 'error', message: `Path should come before header "${line.slice(0, idx)}"` });
        return;
      }
      diagnostics.push({ line: n, level: 'unsupported', message: 'absolute-URL path rule (Cloudflare-only host/preview scoping): skipped, a single-origin SW has no use for it' });
      cur = { for: null, values: {}, unset: [] };       // swallow its headers
      return;
    }
    if (line.startsWith('/')) {
      cur = { for: line, values: {}, unset: [] };
      rules.push(cur);
      return;
    }
    if (line.startsWith('! ')) {
      if (!cur) { diagnostics.push({ line: n, level: 'error', message: 'detach before any path' }); return; }
      if (flavor === 'netlify') { diagnostics.push({ line: n, level: 'info', message: 'ignored by Netlify (no ":"); "! Name" detach is Cloudflare-only' }); return; }
      cur.unset.push(line.slice(2).trim().toLowerCase());
      return;
    }
    const idx = line.indexOf(':');
    if (idx < 0) return;                                   // Netlify: silently ignored
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) { diagnostics.push({ line: n, level: 'error', message: 'Missing header name' }); return; }
    if (!value) { diagnostics.push({ line: n, level: 'error', message: 'Missing header value' }); return; }
    if (!cur) { diagnostics.push({ line: n, level: 'error', message: `Path should come before header "${name}"` }); return; }
    if (!cur.for) return;                                  // swallowed (absolute-URL block)
    const key = name.toLowerCase();
    if (NEVER_FROM_HEADERS_FILE.includes(key)) {
      diagnostics.push({ line: n, level: 'unsupported', message: `header "${name}" is computed by the host/SW and cannot be set from a headers file` });
      return;
    }
    cur.values[key] = key in cur.values ? `${cur.values[key]}, ${value}` : value;
  });
  return { rules: rules.filter((r) => Object.keys(r.values).length || r.unset.length), diagnostics };
}

// Path pattern: Netlify "wildcards (*) anywhere in a segment, :placeholders only at the start of a segment, not both in
// one segment"; Cloudflare "single splat, :placeholders". We implement the common subset used by real files.
export function headerPatternToRegExp(pat) {
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const segs = pat.split('/');
  const out = segs.map((seg) => {
    if (seg.startsWith(':')) return '[^/]+';
    return esc(seg).replace(/\*/g, '.*');
  });
  return new RegExp('^' + out.join('/') + '$');
}

// All matching rules contribute; same name from several rules is joined with ", " (Cloudflare documented behaviour),
// "! Name" removes a header added by an earlier rule (Cloudflare "Detach a header").
export function headersFor(rules, pathname) {
  const merged = {};
  for (const r of rules) {
    if (!headerPatternToRegExp(r.for).test(pathname)) continue;
    for (const [k, v] of Object.entries(r.values)) merged[k] = k in merged ? `${merged[k]}, ${v}` : v;
    for (const k of r.unset) delete merged[k];
  }
  return merged;
}
