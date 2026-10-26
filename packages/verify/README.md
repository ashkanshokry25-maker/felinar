# @felinar/verify

Verifies `mw-signin-v1` sign-in proofs made by a felinar identity origin, on a server (Node 22
or later) or in a browser. One ES module, zero dependencies, WebCrypto only. The format is
specified in `docs/specs/mw-signin-v1.md` of the felinar repository.

The library tells you which public key signed in, for which origin and with which key mode. It
never returns roles or any site state: **scope is a request, never a grant.**

## Vendoring

You can copy `verify.js` into your project instead of installing it. Check the file before you
use it:

```
sha256(verify.js) = eda60c70d9607fd02b8a4869c00b4c69327149892d1b65a53965622744b42bbf
```

(`shasum -a 256 verify.js` or `sha256sum verify.js`.) The hash changes with every release; the
repository's test suite checks that this line matches the file.

## Use

```js
import { createVerifier, issueChallenge, MemoryNonceStore } from '@felinar/verify';

const nonces = new MemoryNonceStore();               // one process only (see below)
const verifier = createVerifier({
  origin: 'https://forum.example',                   // exact, from configuration
  ledger: null,                                      // or the ledger id of a felinar site
  allowKeyModes: ['pairwise', 'linked', 'hub', 'ledger'],
  allowIdps: ['https://id.example-project.org'],     // optional
  maxAgeMs: 300000, maxSkewMs: 120000,               // both at most 300000
  nonces,
});

// GET or POST /auth/mw/challenge
const challenge = await issueChallenge({ statement: 'Sign in to Example Forum', nonces });
// -> { nonce, statement, exp, resources }: give it to the page, which passes it to the sign-in popup.

// POST /auth/mw/verify, body = the proof JSON text exactly as received
const r = await verifier.verify(bodyText);
// -> { ok: true, pub, keyMode, ledger, iat, exp, requestId, statement, idp, build }
// -> { ok: false, reason, at }
// reason: 'parse' | 'version' | 'alg' | 'sig' | 'origin' | 'domain' | 'ledger' | 'keymode' | 'idp'
//       | 'nonce' | 'replay' | 'store-full' | 'expired' | 'not-yet-valid' | 'too-long' | 'statement'
if (r.ok) startYourOwnSession(r.pub);
```

Pass the raw request body text to `verify`, not a parsed object: duplicate JSON keys can only be
refused in text, and the 4 KiB cap is measured on it.

### Nonce stores

A nonce is issued by your server and accepted once. `MemoryNonceStore` keeps nonces in one
process. **Behind a load balancer, every instance must share one store whose `consume` is atomic**
(for example one row per nonce removed by a conditional delete). The store contract:

```
put(nonce, expMs, meta)        record an issued nonce with { statement, resources }
consume(nonce, expMs, origin)  -> meta (or true) exactly once, 'used' after that, false if never issued or expired
markUsed(nonce, expMs)         -> true the first time, false after that, 'full' when it cannot hold one more (stateless nonces)
```

`statelessNonce(secret, { ttlMs, used })` issues HMAC nonces bound to your origin, for servers that
cannot store a nonce when they issue it. The MAC is checked before any store is touched. The MAC
alone does not stop a replay inside the TTL: pass a shared `used` store, and pass `statement` to
`createVerifier`, because a stateless nonce does not carry the statement it was issued for.

Issuing a stateless nonce costs you nothing, so anyone can send forged proofs that each burn a fresh nonce into `used`. When
that store is full of unexpired entries, `verify` answers `store-full` (not `replay`): rate-limit `issueChallenge` and failed
verifications per client, and size `MemoryNonceStore({ max })` for your peak sign-ins within the TTL.

```js
const nonces = statelessNonce(process.env.MW_NONCE_SECRET, { used: sharedStore });
const challenge = await issueChallenge({ statement, nonces, origin: 'https://forum.example' });
const verifier = createVerifier({ origin: 'https://forum.example', nonces, statement });
```

## Order of checks

Cheap first: parse and size (4 KiB) -> version and type -> origin, domain, ledger, key mode,
identity origin -> age and skew -> nonce consumption (stateless MAC first) -> signature ->
statement and resources against the issued challenge. The nonce is consumed before the
signature is checked, so a forged proof that carries a stolen nonce burns it.

## Guidance

- **Bind accounts carefully.** Link an existing account to a `pub` only after contact data you
  verified separately; otherwise someone can pre-register a victim's address.
- **Deduplicate on the nonce, never on the signature.** ECDSA signatures are malleable: a second,
  different signature over the same proof also verifies.
- **Use only the object `verify` returned.** Do not parse the body again with other code.
- **Treat `keyMode` as information.** `'pairwise'` keys work only on your origin; `'linked'` and
  `'hub'` keys are shared with other sites by the person's choice; `'ledger'` keys belong to the
  ledger's listed addresses.
- **A verified proof shows possession of a key, nothing more.** `keyMode`, `idp` and `build` are
  fields the signer writes: `allowIdps` and `allowKeyModes` filter honest identity pages, and they do
  not stop someone who holds the key (a key a person shared by "Same as on", a leaked key, or a key
  taken by a look-alike identity page). Give accounts your own re-bind and revoke path (verified
  contact data), because this version of the format carries no recovery commitment and no rotation:
  after "Replace my keys" the person arrives with an unrelated new `pub` (a later format version may
  add a rotation the verifier can check; see the spec, section 9).
- **What you still see.** Your server sees the IP address and user agent at sign-in. Two servers
  that join their logs by IP and time can link a person whatever the keys say.
- **Proofs for the page itself** (`purpose: 'site'`, a nonce the identity origin chose) are
  refused by construction: their nonce was never issued by you.
- The library logs nothing.

## License

MIT
