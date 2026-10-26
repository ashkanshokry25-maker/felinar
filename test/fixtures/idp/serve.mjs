#!/usr/bin/env node
// test/fixtures/idp/serve.mjs: serves the identity origin (IdO) on its own loopback origin for the end-to-end
// tests (R Part 4: "The identity origin is served on a second loopback origin (a different port) so origin
// separation is real"). It applies the bundle's _headers (CSP, frame-ancestors, Referrer-Policy) to every
// response, like the static hosts the IdO is published to.
//
//   node test/fixtures/idp/serve.mjs [--port 0] [--host 127.0.0.1] [--dir <dist-idp>] [--src]
//   import { startIdpServer } from './serve.mjs'; const s = await startIdpServer({ dir }); s.url ... await s.close()
//
// --dir serves a build of tools/build-idp.mjs (use --test --test-psl localhost for hub tests); --src serves the
// unbundled src/idp modules from this checkout (development: no build step, same headers, a classic copy of
// sw.js). It binds a loopback address only. Open it as http://localhost:<port> in Chromium (WebAuthn needs a
// domain RP ID; localhost resolves with chromiumArgs()), and only http://127.0.0.1 URLs in WebKit
// (docs/DEV-NETWORK.md).

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

/** parseHeadersFile(text) -> [{ pattern, headers: [[name, value]] }] in the Netlify / Cloudflare Pages _headers format. */
export function parseHeadersFile(text) {
  const rules = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = { pattern: raw.trim(), headers: [] };
      rules.push(cur);
      continue;
    }
    const i = raw.indexOf(':');
    if (cur && i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
  }
  return rules;
}

function matches(pattern, path) {
  if (pattern === path) return true;
  if (pattern.endsWith('/*')) return path.startsWith(pattern.slice(0, -1));
  return false;
}

/** headersFor(rules, path) -> { name: value } merged in file order. */
export function headersFor(rules, path) {
  const out = {};
  for (const r of rules) if (matches(r.pattern, path)) for (const [k, v] of r.headers) out[k] = v;
  return out;
}

function srcPage(html) {
  return html.replace('href="./idp.css"', 'href="/src/idp/idp.css"').replace('src="./idp.js"', 'src="/src/idp/idp.js"');
}

/**
 * startIdpServer({ port = 0, host = '127.0.0.1', dir, src = false }) -> { url, port, close() }
 * Exactly one of dir (a build) and src (this checkout's modules).
 */
export async function startIdpServer({ port = 0, host = '127.0.0.1', dir = null, src = false } = {}) {
  if (!src && !dir) throw new TypeError('startIdpServer needs dir (a dist-idp build) or src: true');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new TypeError('loopback hosts only');
  const base = src ? join(ROOT, 'src', 'idp') : resolve(dir);
  const rules = parseHeadersFile(await fs.readFile(join(base, '_headers'), 'utf8'));
  const server = http.createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (_) {
      res.writeHead(400).end();
      return;
    }
    const send = (status, body, type) => {
      const h = Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, headersFor(rules, path));
      res.writeHead(status, h);
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
    if (path.includes('..') || path.includes('\0')) return send(404, 'not found');
    try {
      if (src) {
        if (path === '/' || path === '/index.html' || path === '/signin' || path === '/signin/') {
          return send(200, srcPage(await fs.readFile(join(base, 'index.html'), 'utf8')), TYPES['.html']);
        }
        if (path === '/sw.js') {
          // A classic-script copy: the build bundles sw.js as an IIFE; here its exports are dropped.
          const code = (await fs.readFile(join(base, 'sw.js'), 'utf8')).replace(/^export /gm, '');
          return send(200, code, TYPES['.js']);
        }
        if (path.startsWith('/src/')) {
          const file = resolve(ROOT, '.' + path);
          if (!file.startsWith(join(ROOT, 'src') + sep)) return send(404, 'not found');
          return send(200, await fs.readFile(file), TYPES[extname(file)] || 'application/octet-stream');
        }
        return send(404, 'not found');
      }
      let rel = path === '/' ? '/index.html' : path === '/signin' || path === '/signin/' ? '/signin/index.html' : path;
      if (rel.endsWith('/')) rel += 'index.html';
      const file = resolve(base, '.' + rel);
      if (!file.startsWith(base + sep)) return send(404, 'not found');
      return send(200, await fs.readFile(file), TYPES[extname(file)] || 'application/octet-stream');
    } catch (_) {
      return send(404, 'not found');
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, ok);
  });
  const p = server.address().port;
  return {
    port: p,
    url: 'http://' + (host === '::1' ? '[::1]' : host) + ':' + p,
    async close() {
      await new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
    },
  };
}

async function main(argv) {
  const opts = { port: 0, host: '127.0.0.1', dir: null, src: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--src') opts.src = true;
    else throw new Error('unknown option ' + a);
  }
  const s = await startIdpServer(opts);
  process.stdout.write('identity origin on ' + s.url + (opts.src ? ' (src)' : ' (' + opts.dir + ')') + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write('error: ' + err.message + '\n');
    process.exitCode = 1;
  });
}
