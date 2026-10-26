# Sign-in on a Node server

Check a felinar sign-in on your own Node server with `@felinar/verify`: your page gets a challenge from your
server, the identity page signs it, and your server verifies the proof and starts its own session. This is the
server-backed flow (c) of the v0.3 design ([review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md), "R", 2.3.1).

| | |
|---|---|
| Roles | a site with a server that mints its own sessions; the button is the [sign-in widget](signin-widget.md) or a page you write |
| Status | **v0.3, built and reviewed.** The verifier, the format ([`packages/verify`](../../packages/verify/README.md), [`mw-signin-v1`](../specs/mw-signin-v1.md)), the identity origin and the page-side client are built; the final integration made real proofs at the identity origin and verified them with the fixture server of `test/fixtures/signin-server` (e2e E-SI-1W, E-SI-1 to E-SI-5, loopback, Chromium). The server code on this page ran on Node 24.22 on 2026-10-20 against the verifier's own vector `si-001-pairwise` with the vector's clock (a valid proof accepted, the same proof refused as a replay, a garbage body and an oversized body refused). Node 22 was not run, and a shared store across instances was not run |
| Needs | Node 22 or later; `@felinar/verify`: one file, no dependencies. Install it with `npm install @felinar/verify`, or copy `packages/verify/verify.js` into your project and compare its SHA-256 with the line in the package's README |

## What your server does

1. **Issue a challenge** for each sign-in attempt: a nonce that only your server can have issued, and the sentence the
   person will see.
2. **Verify the proof** that comes back, once.
3. **Mint your own session** from the verified key. The proof is not a session: it lasts at most 5 minutes (format limit,
   [spec](../specs/mw-signin-v1.md) section 3) and is single use.

The identity page shows your site's address (taken by the browser, not by your page) and your sentence word for word.
Your server learns the person's public key for your site, a time, the IP address and the user agent, and nothing else.

## The code

`server.mjs`, with the widget's two URLs:

```js
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createVerifier, issueChallenge, MemoryNonceStore } from '@felinar/verify';

export function createApp({ origin, statement, allowIdps, nonces = new MemoryNonceStore() }) {
  // origin: your site's exact origin from configuration, for example https://forum.example.
  // Never take it from the Host or Origin header of a request.
  const verifier = createVerifier({ origin, allowIdps, nonces });
  const accounts = new Map(); // pub -> account. Use your database.
  const sessions = new Map(); // session id -> { account, pub, keyMode }. Use your session store.

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  async function readBody(req, max = 8192) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, origin);

      if (req.method === 'GET' && pathname === '/auth/mw/challenge') {
        const challenge = await issueChallenge({ statement, nonces });
        return send(res, 200, challenge); // { nonce, statement, exp, resources }
      }

      if (req.method === 'POST' && pathname === '/auth/mw/verify') {
        const text = await readBody(req);
        let proof;
        try {
          const body = JSON.parse(text); // the widget posts { "proof": { ... } }
          proof = body && typeof body === 'object' && 'proof' in body ? body.proof : body;
        } catch {
          return send(res, 400, { ok: false, reason: 'parse' });
        }
        const r = await verifier.verify(proof);
        if (!r.ok) return send(res, 401, { ok: false, reason: r.reason });

        // From here on use only r. Do not read the request body again.
        let account = accounts.get(r.pub);
        if (!account) {
          account = { id: randomBytes(8).toString('hex'), pub: r.pub, contact: null };
          accounts.set(r.pub, account);
        }
        const sid = randomBytes(24).toString('base64url');
        sessions.set(sid, { account: account.id, pub: r.pub, keyMode: r.keyMode });
        return send(res, 200, { ok: true, account: account.id },
          { 'set-cookie': `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/` });
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, err.status || 500, { error: err.status ? err.message : 'server error' });
    }
  });

  return { server, nonces, accounts, sessions };
}

// createApp({ origin: 'https://forum.example', statement: 'Sign in to Example Forum',
//             allowIdps: ['https://id.example'] }).server.listen(8080, '127.0.0.1');
```

What each part does:

- **`issueChallenge`** returns `{ nonce, statement, exp, resources }`. The statement is 0 to 280 characters, in NFC, with
  no control or bidi characters, and the identity page shows it verbatim. A statement that breaks the rules throws.
- **`createVerifier`** takes the origin and, if you want, the identity origins you accept (`allowIdps`), the key modes
  you accept (`allowKeyModes`) and the clock limits (`maxAgeMs` and `maxSkewMs`, both at most 300,000 ms). Pass an
  `allowIdps` list once you know which identity origin your visitors use; the project's own is chosen at release
  ([PUBLISH-CHECKLIST.md](../PUBLISH-CHECKLIST.md), section 16).
- **`verify`** checks cheap things first (size, version, origin, domain, key mode, identity origin, age), then consumes
  the nonce, then checks the signature, then the statement. It returns the object below or `{ ok: false, reason, at }`.

  ```js
  { ok: true, pub, keyMode, ledger, iat, exp, requestId, statement, idp, build }
  ```

  The reasons are `parse`, `version`, `alg`, `sig`, `origin`, `domain`, `ledger`, `keymode`, `idp`, `nonce`, `replay`,
  `expired`, `not-yet-valid`, `too-long` and `statement`. All of them are a 401 here. The code also returns the
  reason, which helps while you integrate; log it, and return a bare 401 in production if you prefer.
- **Use only the object `verify` returned.** Do not parse the body again with other code: two parsers can disagree about
  the same text.
- **The body.** The proof is JSON of at most 4,096 bytes. `verify` accepts the text or the parsed object. The widget posts
  `{ "proof": { ... } }`, and the code above unwraps it and passes the object. Duplicate object keys are refused only
  when `verify` gets the text, so a page you write yourself may post the proof text alone and pass the text on. The
  difference between the widget's body and the library's README is recorded for the integrator
  (`docs/deviations/docs.md`).
- **The cookie** is yours: `HttpOnly`, `Secure`, `SameSite=Lax`. The page that opens the identity popup must not send
  `Cross-Origin-Opener-Policy: same-origin`; use `same-origin-allow-popups`.

## More than one instance

`MemoryNonceStore` keeps nonces in one process. Behind a load balancer, **every instance must share one store whose
`consume` is atomic**; otherwise one proof can be accepted twice, once at each instance. The store contract is:

```text
put(nonce, expMs, meta)        record an issued nonce with { statement, resources }
consume(nonce, expMs, origin)  the meta (or true) exactly once; 'used' after that; false if never issued or expired
markUsed(nonce, expMs)         true the first time (used by stateless nonces)
```

Two ways to meet it:

- **A database row per nonce** (an untested sketch for PostgreSQL; adapt it to your database). `put` is an `insert`.
  `consume` is one atomic statement, `update mw_nonce set used = true where nonce = $1 and exp > $2 and used = false
  returning meta`: a returned row means this call won; no row means look at the row, and `used` gives `'used'`,
  while no row at all gives `false`. `markUsed` is `insert ... on conflict do nothing`. Delete rows after they expire.
- **A directory on one machine.** `FileNonceStore` in
  [`test/fixtures/signin-server/server.mjs`](../../test/fixtures/signin-server/server.mjs) uses one file per nonce and
  an atomic rename, so exactly one of several processes accepts a proof (its unit test uses 8 concurrent consumers).
  It does not span machines.

A server that cannot store a nonce when it issues one can use `statelessNonce(secret, { used })`: the nonce is a MAC
over your origin and a time, checked before any store is touched. The MAC alone does not stop a replay inside its
lifetime, so `used` must be a shared store too, and `createVerifier` needs the `statement` option because a stateless
nonce does not carry the sentence it was issued for.

```js
import { statelessNonce } from '@felinar/verify';
const nonces = statelessNonce(process.env.MW_NONCE_SECRET, { used: sharedStore });
const challenge = await issueChallenge({ statement, nonces, origin: 'https://forum.example' });
const verifier = createVerifier({ origin: 'https://forum.example', nonces, statement });
```

The planned end-to-end check is two server instances over one store, where a replay fails at the second (E-SI-4).

## Binding accounts to `pub`

A verified `pub` proves that someone holds the key the person uses on your site. It proves nothing else.

- **A new visitor** needs no email: create an account keyed by `pub`, as the code does.
- **An existing account** (an email, a username) joins a `pub` only after you verified the contact data separately, for
  example with a link sent to the address on file and opened in the session of that `pub`. Do not attach a `pub` to an
  existing account because the page says it is that person. Otherwise someone can pre-register a victim's address
  with their own key.
- **Roles and rights** come from your own database. The library returns none, and a requested scope in a proof is a
  request, never a grant.
- **Treat `keyMode` as information.** `pairwise` keys work only on your origin. `linked` and `hub` keys are shared with
  other sites by the person's choice. `ledger` keys belong to the addresses of one felinar site.

## Deduplicate on the nonce, never on the signature

An ECDSA signature can be rewritten into a different byte string that also verifies. The library's vector `si-015` is a
high-S copy that verifies; `si-016` is the same copy refused as a replay. Only the single-use nonce stops the second
use, and the library consumes it for you. Do not remember signatures or proof bodies as a replay check, and do not use
the page-chosen `requestId` as a unique key: it is chosen by the page.

## What your server sees, and what to say

Your server sees the IP address and the user agent at each sign-in, and the library logs nothing. Two servers that join
their logs by IP address and time can link a person whatever the keys say. Name yourself in your privacy notice as a
server-backed relying party ([PRIVACY.md](../PRIVACY.md#the-recipients-register-v03)).

## Limits and known problems

- **A proof stolen inside its 5 minutes** can be used before the real one at the same verifier. Keep `maxAgeMs` at its
  default or lower.
- **Clock skew.** `maxSkewMs` is 120,000 ms by default and at most 300,000. Run NTP on the server.
- **Nonce floods.** With a store, each challenge uses memory; the in-memory store holds at most 100,000 nonces by default
  and then throws. Rate-limit the challenge route by address, or use stateless nonces with a shared `used` store.
- **Local proofs.** A proof that a page made for itself (`purpose: 'site'`) is refused by construction, because its nonce
  was never issued by you.
- **If the identity origin is down,** sessions you already minted keep working and new sign-ins fail.
- **Planned checks:** E-SI-1 (a loopback Node server with the widget), E-SI-2 (replayed, foreign-origin and expired
  proofs refused), E-SI-3 (a local proof refused), E-SI-4 (two instances, one store), E-SI-5 (a reverse proxy with a
  rewritten loader), and the real-host row G-SI-1 ([DEMO-RESULTS.md](../DEMO-RESULTS.md)).

See also [signin-widget.md](signin-widget.md) for the page side and [README.md](README.md) for the other recipes.
