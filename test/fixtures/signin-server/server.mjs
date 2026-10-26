#!/usr/bin/env node
// A loopback-only server-backed site for the sign-in tests (R 2.3.1 flow (c), E-SI-1 to E-SI-5):
// it issues mw-signin-v1 challenges and verifies proofs with packages/verify/verify.js.
//
//   node test/fixtures/signin-server/server.mjs --port 8790 [--origin http://127.0.0.1:8790]
//        [--nonce-dir <dir>] [--statement "Sign in to Example Forum"] [--allow-idp <origin>]...
//        [--key-mode pairwise] [--static <dir>]
//
//   POST|GET /auth/mw/challenge -> 200 { nonce, statement, exp, resources }
//   POST     /auth/mw/verify    (body: the proof JSON text) -> 200 { ok: true, pub, keyMode, ... }
//                                 and a session cookie, or 401 { ok: false, reason, at }
//   GET      /healthz           -> 200 ok
//   GET      /*                 -> files under --static, when given
//
// Binds 127.0.0.1 only. --nonce-dir gives a nonce store shared by several instances (one file per
// nonce; consume is an atomic rename, so exactly one instance accepts a proof: E-SI-4). Without
// it each instance keeps its nonces in memory. --origin is the site origin the verifier expects
// (default http://127.0.0.1:<port>); it is never read from request headers.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createVerifier, issueChallenge, MemoryNonceStore } from '../../../packages/verify/verify.js';

const NONCE_RE = /^[A-Za-z0-9_-]{22,88}$/;
const MAX_BODY = 8192;

/** FileNonceStore(dir): the MemoryNonceStore contract over a directory, safe across processes. */
export class FileNonceStore {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
  }

  async put(nonce, expMs, meta = null) {
    if (!NONCE_RE.test(nonce)) throw new Error('bad nonce');
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(join(this.dir, nonce + '.issued'), JSON.stringify({ exp: expMs, meta }), { flag: 'wx' });
  }

  async consume(nonce) {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return false;
    const issued = join(this.dir, nonce + '.issued');
    const used = join(this.dir, nonce + '.used');
    try {
      await fs.rename(issued, used); // atomic: one caller wins
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      try {
        await fs.access(used);
        return 'used';
      } catch (_) {
        return false;
      }
    }
    const rec = JSON.parse(await fs.readFile(used, 'utf8'));
    if (rec.exp <= this.now()) return false;
    return rec.meta || true;
  }

  async markUsed(nonce, expMs) {
    if (!NONCE_RE.test(nonce)) return false;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      await fs.writeFile(join(this.dir, nonce + '.used'), JSON.stringify({ exp: expMs }), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  }
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c); // past the cap: drain without keeping
    });
    req.on('end', () => {
      if (size > MAX_BODY) reject(Object.assign(new Error('body too large'), { status: 413 }));
      else resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };

/**
 * startSigninServer({ port = 0, origin, statement, nonceDir, allowIdps, allowKeyModes, staticDir, now })
 *   -> Promise<{ server, url, origin, verifier, nonces, close() }>
 */
export async function startSigninServer({ port = 0, origin, statement = 'Sign in to Example Forum', nonceDir, allowIdps, allowKeyModes, staticDir, now = () => Date.now() } = {}) {
  const nonces = nonceDir ? new FileNonceStore(nonceDir, { now }) : new MemoryNonceStore({ now });
  const sessions = new Map();
  let verifier = null;
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers));
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
      if (path === '/auth/mw/challenge' && (req.method === 'POST' || req.method === 'GET')) {
        const ch = await issueChallenge({ statement, nonces, now: now() });
        return send(res, 200, ch);
      }
      if (path === '/auth/mw/verify' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await verifier.verify(body);
        if (!r.ok) return send(res, 401, r);
        const sid = randomBytes(16).toString('base64url');
        sessions.set(sid, { pub: r.pub, keyMode: r.keyMode, t: now() });
        return send(res, 200, r, { 'Set-Cookie': 'mw_session=' + sid + '; HttpOnly; SameSite=Lax; Path=/' });
      }
      if (staticDir && req.method === 'GET') {
        const root = resolve(staticDir);
        const file = resolve(root, '.' + (path.endsWith('/') ? path + 'index.html' : path));
        if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'forbidden' });
        try {
          const data = await fs.readFile(file);
          res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' });
          return res.end(data);
        } catch (_) {
          return send(res, 404, { error: 'not found' });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, err.status || 500, { error: err.status ? err.message : 'server error' });
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  const actual = server.address().port;
  const siteOrigin = origin || 'http://127.0.0.1:' + actual;
  verifier = createVerifier({ origin: siteOrigin, nonces, now, allowIdps, allowKeyModes: allowKeyModes || undefined });
  return {
    server, url: 'http://127.0.0.1:' + actual, origin: siteOrigin, verifier, nonces, sessions,
    close: () => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}

function parseArgs(argv) {
  const out = { allowIdps: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      return argv[++i];
    };
    if (a === '--port') out.port = Number(next());
    else if (a === '--origin') out.origin = next();
    else if (a === '--nonce-dir') out.nonceDir = next();
    else if (a === '--statement') out.statement = next();
    else if (a === '--allow-idp') out.allowIdps.push(next());
    else if (a === '--key-mode') (out.allowKeyModes = out.allowKeyModes || []).push(next());
    else if (a === '--static') out.staticDir = next();
    else throw new Error('unknown argument ' + a);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port <number> is required');
  if (out.allowIdps.length === 0) delete out.allowIdps;
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const s = await startSigninServer(opts);
  process.stdout.write('signin-server listening on ' + s.url + ' (origin ' + s.origin + (opts.nonceDir ? ', nonce dir ' + opts.nonceDir : '') + ')\n');
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
