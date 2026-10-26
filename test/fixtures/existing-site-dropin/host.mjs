// A small static host for the fixture, standing in for GitHub Pages / Netlify / Cloudflare Pages in
// end-to-end tests (127.0.0.1 only). It does what drop-in mode must leave alone: _redirects (rewrites
// such as /app/* -> app.html with 200, and 301s), _headers, 404.html with status 404, and files kept
// from an earlier deploy. dev-server.mjs serves files but does not read _redirects, which the
// History-API router page needs.
//
//   const host = await createHost({ root })     root: the publish output's site/ directory (or a staged copy)
//   host.url, host.port, host.requests          requests: [{ method, path, status, range }]
//   host.redeploy(dir, { keepOld })             copy a newer deploy over the root; keepOld keeps the old
//                                               non-HTML files (hosts keep the previous deploy for days)
//   host.down(true|false)                       outage: connections are dropped
//   await host.close()
//
// Response headers: Cache-Control: no-cache unless _headers says otherwise (so tests are not at the
// mercy of the HTTP cache), Accept-Ranges and Range support, nosniff, Content-Type from sw/lib.js.

import http from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, sep, relative } from 'node:path';
import { normalizeManifest, applyRouting, mimeFor, parseRange } from '../../../src/sw/lib.js';

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (_) {
    return false;
  }
}

function readOptional(path) {
  return isFile(path) ? readFileSync(path, 'utf8') : '';
}

function loadRouting(root) {
  return normalizeManifest({
    redirects: readOptional(join(root, '_redirects')),
    headers: readOptional(join(root, '_headers')),
    index: 'index.html',
    notFound: '404.html',
    cleanUrls: false,
  });
}

function walkHtml(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkHtml(abs, base, out);
    else if (/\.html?$/i.test(name)) out.push(relative(base, abs));
  }
  return out;
}

export async function createHost({ root, port = 0, host = '127.0.0.1' } = {}) {
  const dir = resolve(root);
  if (!existsSync(dir)) throw new Error('createHost: no such directory ' + dir);
  let routing = loadRouting(dir);
  const requests = [];
  let outage = false;

  const server = http.createServer((req, res) => {
    if (outage) {
      req.socket.destroy();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://host.invalid').pathname);
    } catch (_) {
      res.writeHead(400).end('Bad request');
      return;
    }
    const entry = { method: req.method, path: pathname, status: 0, range: req.headers.range || null };
    requests.push(entry);
    const finish = (status, headers, body) => {
      entry.status = status;
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || body === undefined) res.end();
      else res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return finish(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed');
    const safe = (rel) => {
      const abs = resolve(dir, rel);
      return abs === dir || abs.startsWith(dir + sep) ? abs : null;
    };
    const r = applyRouting(routing, pathname, (p) => {
      const abs = safe(p);
      return abs !== null && isFile(abs);
    }, { navigate: true });
    const headers = Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' }, r.headers);
    if (r.redirect) return finish(r.status, Object.assign(headers, { Location: r.redirect, 'Content-Type': 'text/plain; charset=utf-8' }), 'Moved');
    const abs = r.path ? safe(r.path) : null;
    if (!abs || !isFile(abs)) return finish(404, Object.assign(headers, { 'Content-Type': 'text/plain; charset=utf-8' }), 'Not found');
    const size = statSync(abs).size;
    headers['Content-Type'] = mimeFor(abs);
    const range = r.status === 200 ? parseRange(req.headers.range, size) : null;
    if (range === 416) return finish(416, Object.assign(headers, { 'Content-Range': 'bytes */' + size }), '');
    if (range) {
      headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + size;
      headers['Content-Length'] = String(range.end - range.start + 1);
      entry.status = 206;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
    }
    headers['Content-Length'] = String(size);
    entry.status = r.status;
    res.writeHead(r.status, headers);
    if (req.method === 'HEAD') return res.end();
    return createReadStream(abs).pipe(res);
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const boundPort = server.address().port;

  return {
    server,
    port: boundPort,
    url: 'http://' + host + ':' + boundPort + '/',
    requests,
    clearLog() { requests.length = 0; },
    down(on = true) { outage = Boolean(on); },
    redeploy(newDir, { keepOld = true } = {}) {
      const src = resolve(newDir);
      if (keepOld) {
        const keep = new Set(walkHtml(src));
        for (const page of walkHtml(dir)) if (!keep.has(page)) rmSync(join(dir, page), { force: true });
        cpSync(src, dir, { recursive: true, force: true });
      } else {
        for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        cpSync(src, dir, { recursive: true });
      }
      routing = loadRouting(dir);
    },
    close() {
      return new Promise((resolveClose) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolveClose());
      });
    },
  };
}
