# SDK reference (v0.3)

The SDK is how a site's own JavaScript reads and writes the site ledger, signs people in, sends messages, shares
files and private media, and follows what the loader is doing. It is one ES module, `/_mw/sdk.js`, which the loader
serves at the root of every felinar origin. This page lists every method with its parameters, results, events and
error codes, and says where the modes differ. It is written from `src/sdk/sdk.js`, `src/loader/api.js` (the method
table), `src/loader/bridge.js`, `src/loader/mod.js`, `src/loader/personal-site.js`, `src/dropin/binding.js` and
`src/dropin/mw.js` as built for v0.3, against R 2.11 and R 2.9.11 of
[review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md). How to model data with it is in [CRUD.md](CRUD.md).

Everything written with mw.db is public and copied to every visitor. Deleting an entry hides it for visitors who
receive the deletion. Copies on devices that never sync again stay where they are.

v0.3 adds sign-in (`mw.auth`), the person's record (`mw.me`), messages (`mw.chat`), files (`mw.files`), private media
(`mw.media`), reports and moderation actions, author-scoped keys, and, as an amendment documented below, followed
ledgers on a hub (`mw.hub`). A site written for 0.2.1 keeps working: the 0.2.1 methods keep their names, parameters
and results, except that `mw.mod.ban` now needs a click ([The A4 rule and gating](#the-a4-rule-and-gating)).

v0.3 C2 (status: built by lane wire-ui against the contracts of lanes calls, seed-policy and seed-engine, not yet
integrated; [deviations/wire-ui.md](deviations/wire-ui.md)) adds calls between signed-in contacts (`mw.calls`), the
seeding counters and controls of `mw.net` (`seeding()`, `dock()`, `keep()`), and availability evidence and labels on the
items of `mw.files` and `mw.media` ([Calls: mw.calls](#calls-mwcalls), [Seeding: mw.net.seeding, dock and
keep](#seeding-mwnetseeding-dock-and-keep)). The design is
[research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), sections 3.1 and 3.5.

## Load the SDK

```html
<script type="module">
  import mw from '/_mw/sdk.js';
  const info = await mw.ready();
  console.log(info.mode, info.auth, info.role);
</script>
```

A page that must also work on a plain static host (a preview, a mirror, a crawler's view) imports it dynamically and
keeps its static content when that fails:

```js
async function loadMw() {
  try {
    const mw = (await import('/_mw/sdk.js')).default;
    const info = await mw.ready();              // rejects with E_NO_HOST outside felinar
    return info.mode === 'static' ? null : mw;  // the static stub: no shared data on this copy
  } catch (err) {
    return null;                                // no SDK here, or not inside the loader
  }
}
```

- The default export is the `mw` object. The module also makes it `globalThis.mw` (in drop-in mode it re-exports the
  object the runtime bound there), and exports `SDK_VERSION` (`'0.3.0'`), `ERROR_CODES`, `createSdk` and
  `looksLikeApi`.
- Always use the root path `/_mw/sdk.js`. Both `publish --shell` and `publish --dropin` lay it out there.
- In drop-in mode `/_mw/mw.js` binds `window.mw` to the page's engine and `/_mw/sdk.js` re-exports that object, so
  the import order of the two scripts does not matter. Import the SDK anyway: `window.mw` appears only once the async
  runtime has run.
- The SDK is plain JavaScript with no dependencies and no top-level await, and it uses nothing past the browser floor
  (Safari and iOS 15.4, Chromium 110, Firefox 115).

## Modes

| Where the page runs | How `mw` reaches the loader | `ready().mode` |
|---|---|---|
| Shell mode: the site in the loader's same-URL frame | a `MessagePort` to the loader's Bridge in the parent page | `'shell'` |
| Drop-in mode: `/_mw/mw.js` on the host's own pages | direct calls into the page's engine | `'dropin'` |
| A subdomain hub | as shell mode | `'hub'` |
| A shared-origin hub (demos and one publisher only) | as shell mode | `'hub-shared'` |
| A static copy that serves `sdk-static.js` as `/_mw/sdk.js` | nothing to reach | `'static'` |
| Anywhere else (a plain page, a test page) | nothing to reach | `ready()` rejects with `E_NO_HOST` |

Shell mode and drop-in mode share one method table (`src/loader/api.js`), so validation, gating, limits, results and
error codes are the same. The differences:

| | Shell and hubs | Drop-in | Static stub |
|---|---|---|---|
| `consent.state()` | a Promise of the state | the state, as a string | `'host-only'`, as a string |
| `net.on()` with an unknown event name | accepted, never fires | throws `E_LIMIT` | accepted, never fires |
| `pow` event data | `{ id, hashes, bits }`, `id` = the write request's id | `{ hashes, bits }` | never fires |
| A request that gets no answer | `E_TIMEOUT` after 30 s; extended by each fee report and each `wait` push, at most 10 minutes | no timeout of its own | answers at once |
| A consent change | a `status` event `{ code: 'consent', state }` | read `consent.state()` again | never changes |
| Where UI methods look for the click | the site frame | the page | nowhere: they reject with `E_NO_HOST` |
| `files.fetch(ref).blob()` | the Blob that crossed the port | the files service's own Blob | none |
| Moderator key import | the loader's Settings, "Import moderator key" | not available yet | none |
| Identity | the identity page (Settings: "Open identity page") | the identity page (the panel's "Open identity page") | none |
| `net.peers()` | the last count the loader pushed | the live count | `0` |
| `mw.calls` (C2) | calls, with the loader's own call panel | every method rejects with `E_UNSUPPORTED` (a page load would end the call); `calls.on()` never fires | `state()` is `null`, `list()` is `[]`, the rest `E_NO_HOST` |
| `net.seeding()`, `net.dock()`, `net.keep()` (C2) | this browser's counters and controls | `E_UNSUPPORTED` until the drop-in engine has a seeding control | nothing shared and nothing counted; `dock()` and `keep()` reject with `E_NO_HOST` |

Write `await mw.consent.state()` and the same code works in every mode.

What the standalone SDK does (a page outside felinar):

- With no same-origin parent frame and no `/_mw/mw.js` tag on the page, every call rejects at once with `E_NO_HOST`;
  `owner.policy()` rejects with `E_NOT_OWNER` (no owner key can run on such a page).
- Inside a same-origin frame, or on a page that carries the `/_mw/mw.js` tag, it waits up to 20 s for the loader or
  the drop-in runtime, then rejects with `E_NO_HOST`.
- `db.subscribe()`, `net.on()`, `auth.onChange()` and the `.on()` of chat, files and media never call back,
  `net.peers()` returns `0` and `auth.state()` returns `'guest'`.

The static stub (`src/sdk/sdk-static.js`, written by `publish` as `sdk-static.js`) is for a plain copy of the site or a
site after the runtime was removed: serve it as `/_mw/sdk.js` and pages get `mw.ready()` with `mode: 'static'`,
`auth: 'guest'` and every feature off, instead of a missing file. It has every method of this page. Reads resolve
empty (`db.get` gives `undefined`, `db.list` and the other lists give `[]`), writes and UI methods reject with
`E_NO_HOST`, subscriptions and events stay quiet. `node tools/dev-server.mjs` answers `/_mw/sdk.js` with it when the
directory it serves has none.

## Conventions

- Every method returns a Promise, except `db.subscribe()`, `net.peers()`, `net.on()`, `auth.state()`,
  `auth.onChange()`, `chat.on()`, `files.on()`, `media.on()`, `calls.on()` and, in drop-in mode, `consent.state()`.
- Errors are `Error` objects with a `code` string ([Error codes](#error-codes)). Branch on `err.code`, never on the
  message. Each code has an English and a French sentence for visitors in `src/loader/strings.js`.
- Values are plain JSON: `null`, booleans, finite numbers, strings, arrays and plain objects, nested at most 64 levels.
  `undefined`, functions, `Date`, `Map`, typed arrays, `NaN` and `Infinity` are refused with `E_LIMIT`. Sizes are
  counted on the value's canonical JSON (RFC 8785) in UTF-8 bytes. The only exception: `files.share` and
  `media.upload` take a `File` or `Blob`.
- Public keys (`identity.pub`, `owner`, an item's `author`, moderators, banned keys, contacts) are strings: `'p256:'`
  followed by 87 base64url characters.
- Entry hashes (`h`) are 64 lowercase hex characters. Ledger ids are `'mw1:'` and 27 base64url characters, or
  `'btih:'` and 40 hex characters for an unsigned link.
- Positional arguments become named parameters: `mw.chat.dm.send(pub, { text })` is the request
  `chat.dm.send { pub, text }`. The names are the ones on this page (`METHOD_ARGS` in `src/loader/api.js`, the same
  table in the SDK and the drop-in binding). A trailing options object merges into the parameters, except
  `onProgress` and `signal`, which stay in the page.
- Results are copies in shell mode. In drop-in mode some results (list items) are the engine's own objects. Treat
  every result as read-only.

## The A4 rule and gating

Site code shares its origin with the loader's code on that origin, so the SDK keeps a few things out of a site's
reach entirely (R 2.11.1). A site can never export or read a private key, a seed, the identity root, the 12 words, a
file or playback key or the vault; grant consent; accept a "same identity" link; choose the domain, origin, ledger or
key mode of a sign-in proof; or open a high-risk card without a click. The methods that would do these
(`identity.export`, `identity.import`, `identity.root`, `consent.accept`, `link.accept`, `keys.export`, `media.key`)
do not exist: over the Bridge, through the drop-in binding, and in the static stub they are unknown methods
(`E_BAD_REQUEST`), whoever calls them and with whatever parameters.

Every method has one class:

- **read**: answers from what this browser holds; never limited, never needs a click.
- **write**: changes state (a ledger entry, a message, a setting). Ledger writes count against 20 a minute per page.
- **UI**: opens a loader card, the identity page or a file dialog, so it must be called from a click on the page
  (shell mode: in the site frame). The loader's own card, or the identity page, then takes the person's input.

UI methods need the person's click. The loader watches the site frame (shell) or the page (drop-in) for trusted
input events in the capture phase, so a site's `stopPropagation` cannot hide a click and a script's
`element.click()` or `dispatchEvent` does not count (`isTrusted` is false). A click counts for 5 s (chosen; the
browser's own transient activation counts too where the floor browsers report it). A flag a site puts in the
parameters (`activation`, `isTrusted`, `trusted`, `gesture`, `userActivation`, `userGesture`) is removed before any
service sees the parameters and proves nothing. Call UI methods directly in your click handler:

```js
signInButton.onclick = () => mw.auth.signIn();           // a click: the identity page opens
setTimeout(() => mw.auth.signIn(), 10000);                // no click: rejects with E_NEEDS_GESTURE
```

Some methods are UI only under a condition (R 2.11.2):

| Method | Needs a click when |
|---|---|
| `me.get`, `chat.contacts.list`, `chat.dm.history` | the first successful call of each sign-in session (a card asks the person); later calls in that session are reads |
| `chat.presence.set` | `public: true` |
| `net.keep` (C2) | `on: true` (turning keeping off needs no click) |
| `auth.signOut` | `forget: true` |
| `db.tombstone` | the entry is another author's (a moderator action, MF-27: a click, then the loader's card) |

`consent.request()` keeps its 0.2.1 behaviour: it needs no click at the SDK boundary because the consent card itself
takes the person's click, and a card closed without a choice is not reopened for 10 s.

The SDK boundary checks, in this order, before any service runs:

1. an unknown or loader-only method: `E_BAD_REQUEST`; in drop-in mode (C2), any `mw.calls` method: `E_UNSUPPORTED`;
2. the parameters' shape and size: `E_LIMIT` (or `E_BAD_REQUEST`);
3. host-only mode, for every method that would reach peers: `E_HOST_ONLY`, before any card, prompt or network
   request;
4. a UI method without a click: `E_NEEDS_GESTURE`;
5. a ledger write to a hub ledger that has no owner on this hub (read only there): `E_POLICY`;
6. the ledger write rate (20 a minute per page): `E_RATE`.

Then the service applies its own rules (`E_POLICY`, `E_NOT_SIGNED_IN`, `E_NOT_MODERATOR` and the rest). A call that
fails both the click and a service rule reports `E_NEEDS_GESTURE`: a reader's `mod.ban` without a click is
`E_NEEDS_GESTURE`, with a click `E_NOT_MODERATOR`.

**Never gate a security decision on `_roles/`: any moderator can overwrite them.** The `_roles/<id>` keys are display
hints (D-8). The ledger policy is the only source of truth for who may do what: `ready().role` and `snapshot.role`
come from it.

## Methods at a glance

| Method | Resolves with | Class |
|---|---|---|
| `mw.ready()` | the ready info | read |
| `mw.auth.signIn({ scope, stay })` | `{ state: 'signed-in', identity, role }` | UI |
| `mw.auth.signOut({ forget })` | `{ state: 'guest' }` | write; UI with `forget: true` |
| `mw.auth.state()` | `'guest'` or `'signed-in'`, at once | read |
| `mw.auth.onChange(fn)` | returns `unsubscribe()` at once | events |
| `mw.auth.prove({ ttlMs })` | a local proof | write |
| `mw.auth.verify(proof)` | `{ ok, pub, role, exp, kind }` or `{ ok: false, reason }` | read |
| `mw.auth.signInServer({ challenge })` | an `mw-signin-v1` proof | UI |
| `mw.identity.current()` | `{ pub, short, name, mode, did }` or `null` | read |
| `mw.identity.setName(name, opts)` | `{ h }` | write |
| `mw.identity.backupStatus()` | `{ kitSaved, fileSaved, passkey, persisted, legacy }` | read |
| `mw.identity.openIdentity()` | `'done'` or `'cancelled'` | UI |
| `mw.me.get(field)` | a value, or the whole record | UI on the first call of a session, then read |
| `mw.me.set(field, value)` | `{ stored: 'local' or 'synced', h }` | write |
| `mw.me.del(field)` | `{ stored }` | write |
| `mw.me.sync({ on })` | `{ on }` | UI |
| `mw.me.erase()` | `{ tombstoned, shredded: true }` | UI |
| `mw.db.get(key, { ledger })` | the value, or `undefined` | read |
| `mw.db.set(key, value, opts)` | `{ h }` | write |
| `mw.db.del(key, opts)` | `{ h }` | write |
| `mw.db.list(name, { limit, newestFirst, ledger })` | an array of items | read |
| `mw.db.append(name, value, opts)` | `{ h }` | write |
| `mw.db.tombstone(h, opts)` | `{ h }` | write; UI for another author's entry |
| `mw.db.subscribe(fn, { ledger })` | returns `unsubscribe()` at once | live read |
| `mw.db.setMine(name, value)` | `{ h, key }` | write |
| `mw.db.getMine(name, { ledger })` | the value, or `undefined` | read |
| `mw.db.listBy(name, author, { ledger })` | an array of `{ key, v, h, ts, author }` | read |
| `mw.db.snapshot({ ledger })` (Bridge method `db.snapshot`, used by `db.subscribe`) | a snapshot | read |
| `mw.hub.follow(target, { private })` | `{ ledger, following, cap }` | write |
| `mw.hub.unfollow(ledger)` | `{ ledger, following, removed }` | write |
| `mw.hub.list()` | an array of followed ledgers | read |
| `mw.hub.createPage(options)` | `{ ledgerId, label, url, pointer }` | UI |
| `mw.mod.ban(pub, { until })` | `{ h }` | UI, moderators |
| `mw.mod.unban(pub)` | `{ h }` | UI, moderators |
| `mw.mod.tombstoneMany(authors, { before })` | `{ h }` | UI, moderators |
| `mw.mod.queue()` | an array of queue items | read, moderators |
| `mw.mod.decide(id, decision, { reason })` | `{ id, decision, h }` | UI, moderators |
| `mw.chat.enable()` | the chat state | UI |
| `mw.chat.disable()` | the chat state | write |
| `mw.chat.state()` | the chat state | read |
| `mw.chat.presence.set({ on, public })` | the presence | write; UI with `public: true` |
| `mw.chat.presence.list()` | `[{ pub, status, since }]` | read |
| `mw.chat.contacts.list()` | the contacts | UI on the first call of a session, then read |
| `mw.chat.contacts.add(pub, { nick })` | the contact | write |
| `mw.chat.contacts.remove(pub)` | | write |
| `mw.chat.contacts.block(pub)` | | write |
| `mw.chat.contacts.unblock(pub)` | | write |
| `mw.chat.contacts.verify(pub)` | `{ code }` | read |
| `mw.chat.requests.list()` | the message requests | read |
| `mw.chat.requests.accept(id)` | | write |
| `mw.chat.requests.decline(id)` | | write |
| `mw.chat.requests.setOpen(open)` | | UI |
| `mw.chat.dm.send(pub, { text } or { grant })` | `{ id, state }` | write |
| `mw.chat.dm.history(pub, { limit, before })` | the messages kept on this device | UI on the first call of a session, then read |
| `mw.chat.dm.keepHistory(pub, on)` | | write |
| `mw.chat.room.join(name)` | | write |
| `mw.chat.room.leave(name)` | | write |
| `mw.chat.room.send(name, { text })` | | write |
| `mw.chat.group.create({ name, members })` | the group | write |
| `mw.chat.group.invite(groupId, pub)` | | write |
| `mw.chat.group.remove(groupId, pub)` | | write |
| `mw.chat.group.leave(groupId)` | | write |
| `mw.chat.group.send(groupId, { text })` | | write |
| `mw.chat.holder.set(on)` | | UI |
| `mw.chat.direct.connect(pub)` | | UI |
| `mw.chat.on(event, fn)` | returns `unsubscribe()` at once | events |
| `mw.files.enable()` | | UI |
| `mw.files.list()` | the public files listed on this site | read |
| `mw.files.received()` | the files shared with this person | read |
| `mw.files.share(file, { public, to, name })` | `{ ref, ih, listed }` | UI |
| `mw.files.fetch(ref, { onProgress, signal })` | `{ handle, name, size, mime, stream(), blob() }` | write |
| `mw.files.preview(ref)` | `{ kind: 'text', text }`, `{ kind: 'image', url, w, h }` or `{ kind: 'none' }` | read |
| `mw.files.save(ref)` | | UI |
| `mw.files.keepSharing(ref, on)` | | UI |
| `mw.files.stopSharing(ref)` | | write |
| `mw.files.remove(ref)` | | UI |
| `mw.files.pinRequest(ref)` | `{ requested }` | write |
| `mw.files.on(event, fn)` | returns `unsubscribe()` at once | events |
| `mw.media.upload(file, { onProgress, signal, keepOriginal })` | `{ id, kind, mime, len, duration, w, h }` | UI |
| `mw.media.list({ from })` | the media items | read |
| `mw.media.open(id, { part })` | `{ url, mime, duration, w, h }` | write |
| `mw.media.close(id)` | | write |
| `mw.media.share(id, { to, durable })` | `{ granted, held }` | UI |
| `mw.media.revoke(id, { from, reencrypt })` | `{ revoked, reencrypted }` | UI |
| `mw.media.delete(id)` | `{ deleted: true }` | UI |
| `mw.media.keepAvailable(id, on)` | `{ on }` | UI |
| `mw.media.pinRequest(id)` | `{ requested }` | write |
| `mw.media.on(event, fn)` | returns `unsubscribe()` at once | events |
| `mw.report.send({ target, reason, note })` | `{ sent }` | UI |
| `mw.net.peers()` | returns a number at once | read |
| `mw.net.on(event, fn)` | returns `unsubscribe()` at once | events |
| `mw.site.info()` | the site info | read |
| `mw.consent.request()` | the consent state, after the visitor chose | opens the loader's card |
| `mw.consent.state()` | the consent state | read |
| `mw.owner.policy(fields)` | `{ h }` on a personal site; `E_NOT_OWNER` elsewhere | write; the identity page confirms |
| `mw.calls.start({ to, video })` (C2) | the call state | UI |
| `mw.calls.accept(id, { video })` (C2) | the call state | UI |
| `mw.calls.decline(id)` (C2) | `{ id, state: 'ended' }` | write |
| `mw.calls.hangup(id)` (C2) | `{ id, state: 'ended' }` | write |
| `mw.calls.mute(id, on)` (C2) | `{ id, mute }` | write |
| `mw.calls.camera(id, on)` (C2) | `{ id, camera }` | write |
| `mw.calls.screen(id, on)` (C2) | `{ id, screen }` | UI |
| `mw.calls.state(id)` (C2) | the call state, or `null` | read |
| `mw.calls.list()` (C2) | the calls in progress | read |
| `mw.calls.on(event, fn)` (C2) | returns `unsubscribe()` at once | events |
| `mw.net.seeding()` (C2) | `{ lanes, month, dock, keeper }` | read |
| `mw.net.dock({ hours })` (C2) | `{ on, until, reason, declared }` | UI, phones |
| `mw.net.keep(on)` (C2) | `{ on }` | UI with `on: true`, computers |

`opts` is the optional last argument of every ledger write: `{ onProgress, signal }` (see
[Writes and the posting fee](#writes-and-the-posting-fee)).

Methods that reach peers answer `E_HOST_ONLY` when the visitor chose "Load from host only" (or the browser has no
WebRTC), before any card or request: every `mw.chat` method except `chat.state`, `files.enable`, `files.share`,
`files.fetch`, `files.keepSharing`, `files.pinRequest`, `media.upload`, `media.share`, `media.revoke`,
`media.keepAvailable`, `media.pinRequest`, `report.send`, and (C2) `calls.start`, `calls.accept`, `calls.decline`,
`calls.camera`, `calls.screen`, `net.dock` and `net.keep`. Reads of what this device holds, and the ledger, keep
working; so do `calls.hangup` and `calls.mute`, so a call can always end.

## mw.ready()

Connects to the loader, waits until the site ledger is open (at most 15 s) and resolves with (R 2.11.2):

```js
{
  siteId: 'mw1:kg166yEUTGpK0992FC45llLPOMA',  // the ledger id
  btih: 'bdc1ee0895adb4416d08e37e0c563b779d07dff4',  // the infohash of the site version on screen
  mode: 'shell',            // 'shell' | 'dropin' | 'hub' | 'hub-shared' | 'static'
  auth: 'signed-in',        // 'guest' | 'signed-in'
  identity: { pub: 'p256:BMIN...', short: '5666dca3', name: null, mode: 'private' },  // null for a guest
  role: 'writer',           // 'owner' | 'moderator' | 'writer' | 'reader'
  peers: 0,                 // peer connections right now
  height: 1,                // entries in this browser's copy of the ledger
  owner: 'p256:BMIN...',    // the owner key from the pointer; null for an unsigned magnet link
  unmoderated: false,       // true for an unsigned link: no owner, no moderators
  features: { chat: false, files: false, media: false, records: false, requests: false, calls: false }
}
```

- `auth` and `identity` follow the sign-in. A guest reads everything public; the first write opens the sign-in prompt
  ([Signing in](#signing-in-mwauth)).
- `identity.mode` says which key the site sees: `'private'` (a key for this site only, the default), `'same'` (the
  person linked this site to another one), `'hub'` (one identity on a hub), `'visit'` (this visit only), or
  `'legacy'` (a 0.2.1 per-site key, in a build without the identity service).
- `role` comes from the ledger policy for `identity.pub` (`'reader'` for a guest). A `reader` cannot write: show a
  read-only page. The role can change later (a policy change, a ban); the current one is in every snapshot.
- `features` comes from the site's `_mw.cfg` key (R 2.5.5): the owner's advisory settings, every one off by default.
  `records` is `true` when `_mw.cfg.records` is `'sealed'`; `calls` (C2) is `true` only when `_mw.cfg.calls` is
  `'contacts'`. A feature that is off still answers its methods with the service's own `E_POLICY` where the service
  enforces it; show its controls only when it is on.
- In shell mode, after a moderator imported their key in the loader's Settings, `identity` is that key and `role` is
  `'moderator'`.
- It resolves after 15 s even when no ledger could be opened (no IndexedDB, or a drop-in engine that is off): `role`
  is then `'reader'`, `siteId` can be `null` (a drop-in page without a stamped pointer) and writes reject with
  `E_IDENTITY`.
- Errors: `E_NO_HOST` (not inside felinar), `E_TIMEOUT` (shell mode, no answer).

## Signing in: mw.auth

A person signs in once on the identity page of their identity origin and gets **working keys** for this site: a key
that signs ledger entries, a chat key and a few sealing keys. The keys stay in this tab's memory (or, with "Stay
signed in on this device", non-extractable in this origin's IndexedDB). No SDK method returns them, but code on this
site, including scripts you include, can use and copy the keys for this site while the person is signed in (R 2.1
rule 2, MF-15: in shell mode the site's frame shares the loader's origin, and in drop-in mode the page is the loader's
realm). They never reach the person's other sites. Signing out deletes them from this origin. The identity origin
keeps the root, so signing in again is one tap.

### mw.auth.signIn({ scope, stay })

```js
signInButton.onclick = async () => {
  try {
    const { identity, role } = await mw.auth.signIn();
    hello.textContent = 'Signed in as ' + (identity.name || identity.short);
  } catch (err) {
    if (err.code !== 'E_USER_CANCELLED') note.textContent = err.code;
  }
};
```

- UI: call it from a click. It opens the identity page in a popup; where a popup cannot open (some in-app browsers),
  the page goes to the identity page and comes back to `/_mw/idp-return` on this origin, and the loader finishes the
  sign-in when this page loads again.
- When the browser blocks the popup although the call came from a click, the loader shows its own "Sign in" card;
  its button opens the popup inside the person's click there, and the call resolves when that sign-in ends.
- `scope`: names the site may ask the identity page to show (a request shown to the person, never a grant). `stay`:
  whether to offer "Stay signed in on this device" (the person decides on the identity page).
- A 0.2.1 per-site key of this ledger moves into the person's identity at the first sign-in (R 2.2.7); the move is
  written once to the ledger as an `mw.link` item signed by the old key.
- Errors: `E_USER_CANCELLED`, `E_POPUP_BLOCKED` (no loader card could take over), `E_HOST_ONLY_IDENTITY` (a
  shared-origin hub: this visit only), `E_UNSUPPORTED` (no WebCrypto P-256), `E_IDP_UNREACHABLE`, `E_RATE` (a second
  sign-in within 10 s), `E_NEEDS_GESTURE`.

### The implicit sign-in

A guest's first write (`db.set`, `db.del`, `db.append`, `db.tombstone`, `db.setMine`, `identity.setName`) opens the
loader's sign-in prompt instead of failing. When the person signs in there, the write goes on; when they close it,
the write rejects with `E_NOT_SIGNED_IN` and nothing is written, and writes in the next 10 s reject the same way
without a new prompt. Writes from several places at once share one prompt.

### mw.auth.signOut({ forget })

Deletes this origin's working keys and tells the other tabs of this site, which drop their signed-in state at once.
With `forget: true` (UI) it also removes "Stay signed in" and what this device keeps for the identity. Resolves with
`{ state: 'guest' }`.

### mw.auth.state() and mw.auth.onChange(fn)

`state()` returns `'guest'` or `'signed-in'` synchronously (in shell mode: the last state the loader reported, so
`'guest'` until `ready()` resolves). `onChange(fn)` calls `fn({ state, identity, role })` on every change and
returns `unsubscribe()`.

### mw.auth.prove({ ttlMs }) and mw.auth.verify(proof)

`prove()` makes a local proof that this tab holds the signed-in key, for code on this page that wants to check it
later (at most 15 minutes, `ttlMs` from 1 to 900000). `verify(proof)` checks a local proof of this tab and epoch only:
`{ ok: true, pub, role, exp, kind }` or `{ ok: false, reason }`. Proofs are never written to `sessionStorage`.

### mw.auth.signInServer({ challenge })

For a site's own server: `challenge` is `{ nonce, statement, exp, nbf, resources }`, with a `nonce` your server
issued. The identity page shows the card every time; the result is an `mw-signin-v1` proof your server verifies.
Errors: `E_NONCE_REQUIRED` (no nonce), `E_USER_CANCELLED`, `E_NEEDS_GESTURE`, `E_NOT_SIGNED_IN`.

## mw.identity

- `mw.identity.current()` resolves with `{ pub, short, name, mode, did }` for a signed-in person, `null` for a guest.
- `mw.identity.setName(name, opts)` sets the display name every visitor sees in `snapshot.profiles[pub]` (the latest
  name per author wins). `name`: 1 to 48 characters after trimming, with no control characters and no bidirectional
  override characters. Names are not unique and prove nothing: show the short id next to it ("Ada (5666dca3)").
  Resolves with `{ h }`. Errors as for `db.set`.
- `mw.identity.backupStatus()` resolves with `{ kitSaved, fileSaved, passkey, persisted, legacy }`, as the identity
  page reported it at sign-in.
- `mw.identity.openIdentity()` (UI) opens the identity page's settings window, where the person backs up, links
  devices and manages sites. Resolves with `'done'` or `'cancelled'`.

## mw.me: the person's record

A small record the person keeps for this site (preferences, a profile), stored in their identity vault, with a copy
sealed for this device. A site never reads it without the person's consent.

- `mw.me.get(field)`: UI on the first call of a sign-in session (a card asks the person), a read afterwards. Without a
  field it resolves with the whole record. Errors: `E_NEEDS_GESTURE`, `E_NOT_SIGNED_IN`, `E_USER_CANCELLED`.
- `mw.me.set(field, value)`: resolves with `{ stored: 'local' }`, or `{ stored: 'synced', h }` when sync is on. Field
  names are `[a-zA-Z][a-zA-Z0-9_.-]{0,31}`; a record never holds contact, legal name, birth date, document or health
  data (`E_FIELD` for such names). Errors: `E_LIMIT` (over the item budget), `E_FIELD`, `E_NOT_SIGNED_IN`.
- `mw.me.del(field)`: resolves with `{ stored }`.
- `mw.me.sync({ on })` (UI): with `on: true`, an encrypted copy goes to the site ledger as sealed `mw.s` items, which
  every visitor copies and nobody without the person's keys can read; at most one synced update per hour. `E_POLICY`
  when `_mw.cfg.records` is not `'sealed'` or the person may not write.
- `mw.me.erase()` (UI): tombstones the synced items and destroys the key for this site, so remaining copies can no
  longer be opened with the identity as it is after the call. A backup file made before it, or an earlier copy of the
  identity's vault that a site keeps for the identity page (R 2.2.5), still holds the key, and a restore from one brings
  it back ([PRIVACY.md](PRIVACY.md#your-rights-and-what-removal-reaches)). Resolves with `{ tombstoned, shredded: true }`.

## mw.db

### mw.db.get(key, { ledger })

```js
const topic = await mw.db.get('topic');   // 'Ideas', or undefined
```

- `key`: a non-empty string of at most 256 characters (and at most 256 bytes in UTF-8).
- Resolves with the key's current value: the last write to it in ledger order. `undefined` when the key was never
  written, was deleted with `del`, or every write to it was removed.
- It does not say who wrote the value. Any writer the policy allows can overwrite a key that does not start with `_`
  or `@`, so a plain key is not a safe place for data that belongs to one author: use `setMine` ([CRUD.md](CRUD.md)).
- `ledger`: read a ledger this page follows instead of its own ([Amendment to R 2.11.2: followed
  ledgers](#amendment-to-r-2112-followed-ledgers)).
- Errors: `E_LIMIT` (a bad key), `E_BAD_REQUEST` (a bad ledger id), `E_POLICY` (a ledger this page does not follow).

### mw.db.set(key, value, opts)

```js
const { h } = await mw.db.set('topic', 'Ideas for the next meetup');
```

- Writes `value` under `key`. The new value wins over every value of that key this browser has seen; between writes
  made at the same time on two devices, the ledger order picks one winner, the same on every device
  ([CRUD.md](CRUD.md), "Consistency model").
- `value`: plain JSON, at most `policy.maxValueBytes` bytes (2,048 by default). `set(key, null)` deletes the key,
  exactly like `del(key)`.
- Keys that start with `_` are written only by the owner and moderators (`E_NOT_MODERATOR` for anyone else). Keys that
  start with `@` are author-scoped: only the author whose key hash they carry writes them (`E_POLICY` otherwise; use
  `setMine`).
- A guest's first write opens the sign-in prompt ([The implicit sign-in](#the-implicit-sign-in)).
- Resolves with `{ h }`, the hash of the new entry. Keep it if you may need to remove this value's bytes later with
  `db.tombstone(h)`.
- Errors: `E_LIMIT`, `E_POLICY`, `E_NOT_MODERATOR`, `E_BANNED`, `E_CAP`, `E_LEDGER_FULL`, `E_RATE`, `E_IDENTITY`,
  `E_NOT_SIGNED_IN`, `E_POW_ABORTED`, `E_TIMEOUT`.

### mw.db.del(key, opts)

Writes a deletion for `key` (the same as `set(key, null)`): `get` resolves with `undefined` and the key leaves
`snapshot.kv` for every visitor who receives the deletion. The earlier values stay in every copy of the ledger, and in
exports, until their own entries are tombstoned. `del` hides a key; `tombstone` removes bytes. Resolves with `{ h }`.
Errors as for `set`.

### mw.db.list(name, { limit, newestFirst, ledger })

```js
const latest = await mw.db.list('guestbook', { limit: 20 });          // newest first
const oldest = await mw.db.list('guestbook', { newestFirst: false });  // oldest first, at most 100
```

- `name`: a non-empty string of at most 64 characters (and 64 bytes).
- `limit`: an integer from 1 to 1,000, default 100. `newestFirst`: default `true`. `ledger`: a followed ledger.
- Resolves with items `{ h, author, ts, v }`:

| Field | What it is |
|---|---|
| `h` | the item's hash; pass it to `db.tombstone(h)` |
| `author` | the public key that signed the item |
| `ts` | Unix milliseconds rounded down to the minute, as claimed by the author's clock: display it, never sort or trust it |
| `v` | the value |

- Order is ledger order, which every visitor computes the same way from the same entries: by depth in the hash graph,
  then by hash. It follows causality but it is not sorted by `ts`.
- Items that were tombstoned, and items by banned authors, are left out.
- There is no cursor yet ([ROADMAP.md](ROADMAP.md), "Paging for mw.db.list"). For the whole list, read
  `snapshot.lists[name]` from `db.subscribe`.
- Errors: `E_LIMIT`, `E_BAD_REQUEST`, `E_POLICY`.

### mw.db.append(name, value, opts)

Adds an item to the end of list `name`. `value`: plain JSON, at most `policy.maxValueBytes` bytes. Lists whose name
starts with `_` are written only by the owner and moderators. Resolves with `{ h }`: the same `h` the item carries in
`list` results and in snapshots. Errors as for `set`.

### mw.db.tombstone(h, opts)

- Removes the entry `h` for every visitor who receives the tombstone: each copy deletes the value and its salt. The
  entry's header stays in the ledger: the author's key, the minute timestamp, the operation and the key or list name.
- Who may: the entry's author, moderators and the owner. Anyone else gets `E_NOT_MODERATOR`. Control entries cannot be
  tombstoned: `E_POLICY`.
- Removing **another author's** entry is a moderator action (MF-27): it needs a click on the page and the person's
  yes in the loader's card ("Remove this entry for everyone?"), or it rejects with `E_NEEDS_GESTURE` or
  `E_USER_CANCELLED`. Removing one's own entry is a plain write.
- Tombstoning the entry that holds a key's current value makes the key's previous value current again, if it has
  one. To make a key absent, `del` it, then tombstone the older entries whose bytes must go.
- Resolves with `{ h }` of the tombstone itself.
- Errors: `E_LIMIT` (not a 64-character lowercase hex hash), `E_NOT_MODERATOR`, `E_POLICY`, `E_NEEDS_GESTURE`,
  `E_USER_CANCELLED` and the write errors listed under `set`.

### mw.db.subscribe(fn, { ledger })

```js
const unsubscribe = mw.db.subscribe((snap) => {
  render(snap.lists.guestbook || [], snap.profiles);
  ledgerLine.textContent = 'Ledger: ' + snap.height + ' entries, in sync with ' + snap.inSync + ' peers';
});
```

- Calls `fn` with a snapshot of the whole ledger state, and again after every change (at most every 250 ms). A new
  subscriber first gets the latest snapshot the page already has, if it has one.
- With `{ ledger }`: the snapshots of a ledger this page follows, once at subscribe time and after each change the hub
  service reports (the `hub` push).
- Returns `unsubscribe()` at once. Throws `E_LIMIT` when `fn` is not a function. An error thrown by `fn` is reported in
  the console and does not stop delivery to other subscribers.

The snapshot:

```js
{
  height: 42,          // entries in this copy (every kind, control entries and tombstones included)
  depth: 17,           // the deepest level of the hash graph
  bytes: 21504,        // bytes this copy stores (headers and values)
  capReached: false,   // true at policy.maxChainBytes: only the owner, moderators and allow-listed authors are added
  kv: { topic: 'Ideas', _notice: 'Closed on Sunday' },   // key -> current value
  lists: { guestbook: [{ h: '...', author: 'p256:...', ts: 1792454760000, v: { msg: 'Hi' } }] },  // OLDEST FIRST
  profiles: { 'p256:...': 'Ada' },   // author -> display name
  policy: { writers: 'open', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608,
            moderators: ['p256:...'], banned: [], allowCount: 0 },
  owner: 'p256:...',   // the owner key in effect; null for an unmoderated ledger
  authors: 7,          // distinct authors with an entry in effect
  unmoderated: false,
  peers: 3,            // peer connections
  inSync: 2,           // connected peers holding exactly the same entries ("in sync")
  role: 'writer'       // this visitor's role now
}
```

Lists in a snapshot are oldest first (ledger order), the reverse of the `list()` default.

### Author-scoped keys: mw.db.setMine, getMine, listBy

A key that starts with `@` and the author's key hash (`'@' + 16 base64url characters of sha256(pub) + '/'`) can be
written only by that author, so it is safe for data that belongs to one person: a reaction, a vote, a profile field.

- `mw.db.setMine(name, value)` writes `@<your hash>/<name>` and resolves with `{ h, key }`. `name`: 1 to 238
  characters. A guest's call opens the sign-in prompt first.
- `mw.db.getMine(name, { ledger })` reads your own `@<your hash>/<name>`; `undefined` for a guest.
- `mw.db.listBy(name, author, { ledger })` lists every `@<author hash>/<name...>` key of one author:
  `[{ key, v, h, ts, author }]`, sorted by key. `author` must be a `'p256:...'` key (`E_LIMIT` otherwise).

## Amendment to R 2.11.2: followed ledgers

R 2.11.2 lists no method for following another person's ledger on a hub, which Part 3 of the review needs (a
member's feed is merged in the browser from the ledgers they follow). This build adds them; they are an amendment to
R 2.11.2, recorded in `docs/deviations/sdk.md`, and exist only where the loader runs a hub service (subdomain hubs).
Elsewhere they reject with `E_UNSUPPORTED` (drop-in pages) or `E_POLICY` (no hub).

- `mw.hub.follow(target)` (write): `target` is a pointer (`v=mw1; ...`), a link to the page (the pointer is in its
  fragment), or the ledger id of a ledger you already follow. The first follow must carry the signed pointer: it
  pins the ledger's owner. The pointer's signature is checked for the hub scope (`E_BAD_REQUEST` when it does not
  verify). Resolves with `{ ledger, following, cap }`, or `{ ledger, following, already: true }`. The ledger is
  opened read only with its own storage and joins the hub follow lane. Caps (R 3.2.3, chosen): 250 follows on a
  phone, 1,000 on a computer; one more rejects with `E_LIMIT` ("You follow 250 of 250 on this phone"). Follows are
  kept for this origin across visits.
  `mw.hub.follow(target, { private: true })` makes a private follow (review round STALK-3): the ledger is pulled
  like any other but never named in this tab's HAVE, so neighbours on the hub lane do not learn whom you follow from
  it (`src/loader/personal-site.js:340` to `:349`, passed to `multi.follow(ledger, { private })`). Only `private: true`
  counts. Following an already-followed ledger with `{ private: true }` makes that follow private and resolves with
  `already: true` (`:419` to `:427`); a later follow without the option does not make it public again (unfollow and
  follow again for that). The flag is kept with the follow across visits; `mw.hub.list()` does not report it.
- `mw.hub.unfollow(ledger)` (write): resolves with `{ ledger, following, removed }`.
- `mw.hub.list()` (read): `[{ ledger, owner, since, height, pointer }]`.
- `mw.hub.createPage(options)` (UI, R 3.3): "Create my page". The identity page confirms ("Create your page on <hub>.
  Its address is public."); then the person's hub key mints the genesis of their own ledger in the browser (a policy
  block with `writers: 'owner'`, `bits: 16`, `maxChainBytes` 8 MiB, and a `keyinfo` block with the recovery
  commitment) and signs the pointer `v=mw1; btih=<template>; owner=<key>; chain=<random>; gen=<hash>;
  nx=<next key commitment>; seq; exp`. Resolves with `{ ledgerId, label, url, pointer }`: `url` opens the new page at
  `<label>.<hub>` and carries the genesis in its fragment, which the loader there checks block by block before it
  keeps it. Errors: `E_NEEDS_GESTURE`, `E_NOT_SIGNED_IN`, `E_USER_CANCELLED`, `E_UNSUPPORTED` (the key bundle has no
  recovery or next-key commitment, or the identity page cannot open), `E_POLICY` (the person signed in with a key private to
  this label or this visit, not their one identity for the hub: the page could never be signed in at; code review v0.3).
- Reads take `{ ledger }`: `db.get`, `db.list`, `db.subscribe`, `db.getMine`, `db.listBy` and the Bridge method
  `db.snapshot`. They answer from the followed ledger's recent window (the newest 200 posts and every control block,
  R 3.2.2), read only. A ledger this page does not follow is `E_POLICY` ("follow this ledger first"); a write with a
  `ledger` other than the page's own is `E_POLICY` ("writes go to your own ledger only").
- Push event `hub`: `{ type: 'change' | 'follow' | 'unfollow' | 'state', data: { ledger, height } }`.

## Moderation: mw.mod

Every moderation action is a UI method (MF-27): it needs a click on the page and the moderator's yes in the
loader's own card, whose button takes only the person's input. Moderators and the owner only (`E_NOT_MODERATOR`
otherwise, after the click check).

- `mw.mod.ban(pub, { until })`: bans an author. Every entry they wrote (before `until`, in ms, when it is given;
  every one otherwise) is removed for every visitor who receives it, and their role becomes `reader`. The owner's own
  entries are never removed by a ban. A banned visitor can make a new identity, so a ban stops casual abuse, not a
  determined person ([CRUD.md](CRUD.md), "Moderation workflow"). Resolves with `{ h }`. Errors: `E_LIMIT` (not a
  `'p256:...'` key), `E_NEEDS_GESTURE`, `E_NOT_MODERATOR`, `E_USER_CANCELLED`, `E_RATE`.
- `mw.mod.unban(pub)`: lifts a ban (an owner's ban only by the owner). Values redacted by the ban stay dropped.
- `mw.mod.tombstoneMany(authors, { before })`: hides every payload of up to 64 authors that is not in the causal
  future of the entry `before` (its hash). For cleaning up a flood.
- `mw.mod.queue()` (read): the items waiting for a moderator: join requests, reports, pin requests and listings,
  `[{ id, kind: 'pin' | 'report' | 'join' | 'listing', ... }]`.
- `mw.mod.decide(id, decision, { reason })`: `decision` is `'accept'`, `'decline'` or `'deny'`. Accepting a join adds
  the key to the allow list; denying a file or media item writes `_deny/<sha256 of its id>`, which every visitor checks
  before fetching or seeding it. Resolves with `{ id, decision, h }`.
- Push event `mod`: `{ type: 'queue' | 'report' | 'decided', data }`.

## mw.report.send({ target, reason, note })

UI. Sends a report about an entry (`{ h }`), a message envelope (`{ envelope }`), a media item (`{ media }`) or a key
(`{ key }`) to the site's moderators and owner, as signed messages over chat (so messages must be on). It carries
metadata only (what this device saw: keys, ids, size, time) and the person's note (at most 500 characters), never the
file or its content (`E_BAD_REQUEST` for a `file`, `blob`, `bytes`, `fk`, `key64`, `name`, `data` or `content`
field). `reason`: `'spam'`, `'harassment'`, `'illegal'`, `'malware'`, `'P0'`, `'impersonation'` or `'other'`. A card
asks before anything is signed. Resolves with `{ sent }`, the number of moderators it went to. Errors:
`E_NEEDS_GESTURE`, `E_NOT_SIGNED_IN`, `E_POLICY` (messages are off), `E_HOST_ONLY`, `E_USER_CANCELLED`.

## Messages: mw.chat

Messages are encrypted between people's chat keys and travel over this site's own connections to other visitors. The
site's own code, which includes the code you write, can read them while the page is open, so do not tell your users
that you cannot read them. Nothing is written to the ledger unless the person publishes their chat key there. Turning chat on connects
to other visitors through the site's own tracker: a site without one answers `E_NO_OWN_TRACKER`.

- `mw.chat.enable()` (UI): the loader's card says what turning on chat shares ("They see your IP address and when you
  are active"). `mw.chat.disable()` turns it off. `mw.chat.state()` resolves with `{ state: 'on' | 'off', hostOnly,
  peers, lane, holder, presence, requestsOpen, chatKey }`.
- `mw.chat.presence.set({ on, public })`: who sees that you are connected. `public: true` (UI) shows it to everyone
  on this site. `mw.chat.presence.list()`: `[{ pub, status, since }]`, "Connected to you now".
- `mw.chat.contacts.list()` (UI on the first call of a session), `add(pub, { nick })`, `remove(pub)`, `block(pub)`,
  `unblock(pub)`, `verify(pub)` (resolves with `{ code }`, a short code both people compare).
- `mw.chat.requests.list()`, `accept(id)`, `decline(id)`, `setOpen(open)` (UI): message requests from strangers are
  off by default.
- `mw.chat.dm.send(pub, { text })` resolves with `{ id, state }`; `state` is `'delivered'`, `'handed'`, `'outbox'`,
  `'sent-unknown'` or `'not-delivered'`. Errors: `E_NO_CHAT_KEY` (that person has not turned on messages here),
  `E_SYNCING` (the ledger is still catching up), `E_BLOCKED`, `E_LIMIT`, `E_STAMP`, `E_RATE`, `E_NOT_SIGNED_IN`.
- `mw.chat.dm.history(pub, { limit, before })` (UI on the first call of a session) reads the messages this device
  kept; `keepHistory(pub, on)` chooses whether to keep them.
- `mw.chat.room.join(name)` (default `'Lobby'`), `leave(name)`, `send(name, { text })`: public, signed rooms.
  Errors: `E_POLICY`, `E_BANNED`.
- `mw.chat.group.create({ name, members })`, `invite(groupId, pub)`, `remove(groupId, pub)`, `leave(groupId)`,
  `send(groupId, { text })`. Errors: `E_LIMIT` (32 members), `E_NOT_MEMBER`, `E_NOT_ADMIN`.
- `mw.chat.holder.set(on)` (UI): hold encrypted messages for others while they are away (refused on phones).
- `mw.chat.direct.connect(pub)` (UI): a direct connection to a contact, which shows your IP address to them.
  Errors: `E_PEER_UNREACHABLE`, `E_NOT_CONTACT`.
- `mw.chat.on(event, fn)`: `'message' | 'delivery' | 'request' | 'presence' | 'room' | 'group' | 'state' |
  'keychange'`.

A message that carries a grant (a file or media key, a report, a join request) is handled by the loader: the site's
code sees only the grant's type (`{ grant: { t: 'media' } }`), never the key it carries, in events and in
`dm.history` alike.

## Files: mw.files

Public files are listed on the site (`mw.files` list items) and travel between visitors; private files are encrypted
before they leave the device. Every file is checked against the site's deny list before it is fetched or seeded.

- `mw.files.enable()` (UI): fetching also shares a file with others while the page is open, and they see the
  person's IP address next to it; the card says so.
- `mw.files.list()`: the public files listed on this site. `mw.files.received()`: files shared with this person.
  Each item also carries `available`, and in C2 `evidence`, `label`, `labelParams` and, for the person's own uploads,
  `handoff` ([Availability labels](#availability-labels-on-files-and-media-items)). Premoderation (R 2.17.1): a public
  file by a key that is not the owner's, a moderator's or on the `allow` list, whose author has no accepted listing yet,
  waits for a moderator. Until one accepts it, only its author lists it, with `pending: true`, and nobody else lists it.
- `mw.files.share(file, { public, to, name })` (UI): `file` is a `File` or `Blob`. The upload card shows the name,
  size, sniffed type and the result of removing location and camera details. Resolves with `{ ref, ih, listed }`.
  Errors: `E_LIMIT`, `E_POLICY`, `E_MEDIA_STRIP`, `E_USER_CANCELLED`.
- `mw.files.fetch(ref, { onProgress, signal })` resolves with `{ handle, name, size, mime, stream(), blob() }`. The
  Blob is typed `application/octet-stream`, always. Errors: `E_FILE_UNAVAILABLE` (nobody who has it is online),
  `E_FILE_TOMBSTONED`, `E_FILE_HASH`, `E_DECRYPT`, `E_DENIED`, `E_POLICY` (the file waits for a moderator).
- `mw.files.preview(ref)`, after `mw.files.fetch(ref)`, resolves with `{ kind: 'text', text }` (the first 64 KiB, read
  by the loader and decoded as UTF-8: show it with `textContent`), `{ kind: 'image', url, w, h }` (the loader draws the
  picture again at most 1,024 px on its longest side; `url` is a `blob:` address of that PNG) or `{ kind: 'none' }` (SVG,
  PDF, HTML and everything else never preview): the only way to show a file in the page. (v0.3 final integration: this
  line said every kind came with a `/_mw/f/` address; `/_mw/f/` is the address `files.save` downloads through.)
- `mw.files.save(ref)` (UI) downloads it through `/_mw/f/`. `keepSharing(ref, on)` (UI), `stopSharing(ref)`,
  `remove(ref)` (UI), `pinRequest(ref)` (only when the owner runs a pin node).
- `mw.files.on(event, fn)`: `'progress' | 'shared' | 'received' | 'removed'`.

Never pass a Blob from mw.files to createObjectURL in a frame or a navigation. A `blob:` URL of this origin runs as
this origin when it is opened as a document, so a file someone sent could act as the site and as the signed-in
person. Show files with `files.preview()`, save them with `files.save()`.

## Private media: mw.media (R 2.9.11)

Photos, audio and video encrypted on the device before they leave it; only the person and the people they share an
item with can open it.

- `mw.media.upload(file, { onProgress, signal, keepOriginal })` (UI) resolves with `{ id, kind, mime, len, duration,
  w, h }`. The upload card shows the metadata removal result, the size and who can see it. Progress:
  `{ phase: 'strip' | 'poster' | 'encrypt' | 'seed', done, total }`. Errors: `E_NOT_SIGNED_IN`, `E_POLICY`
  (`_mw.cfg.media` off), `E_HOST_ONLY`, `E_MEDIA_TYPE`, `E_MEDIA_STRIP`, `E_LIMIT`, `E_USER_CANCELLED`,
  `E_POW_ABORTED`.
- `mw.media.list({ from: 'mine' | 'received' | 'all' })`: `[{ id, kind, mime, len, duration, w, h, from, t,
  available: 'kept' | 'online' | 'unknown', evidence, label, labelParams, handoff }]` (the last four are C2: see
  [Availability labels](#availability-labels-on-files-and-media-items)).
- `mw.media.open(id, { part: 'media' | 'poster' })` resolves with `{ url, mime, duration, w, h }`; `url` is
  `/_mw/media/<session>`, valid for the session. Errors: `E_NOT_SIGNED_IN`, `E_DECRYPT`, `E_REVOKED`,
  `E_FILE_UNAVAILABLE`, `E_MEDIA_UNPLAYABLE`, `E_LIMIT`. `mw.media.close(id)` ends the session early.
- `mw.media.share(id, { to: [pub] | groupId, durable })` (UI) resolves with `{ granted, held }`; the card names each
  recipient, and a group id stands for that group's members (read from the chat service). In this build every grant
  travels as a sealed message: `durable: true` adds no ledger copy yet, because nothing reads such copies back (the
  v0.3 reconciliation, docs/deviations/integration-v03.md). Errors: `E_NO_CHAT_KEY`, `E_BLOCKED`, `E_POLICY`,
  `E_NOT_MEMBER` (a group this browser is not in), `E_USER_CANCELLED`.
- `mw.media.revoke(id, { from, reencrypt })` (UI) resolves with `{ revoked, reencrypted }`. People who already
  opened an item may have kept a copy.
- `mw.media.delete(id)` (UI), `keepAvailable(id, on)` (UI: seeding, which shows the person's IP address),
  `pinRequest(id)`.
- `mw.media.on(event, fn)`: `'progress' | 'received' | 'shared' | 'revoked' | 'unavailable'`.

## Calls: mw.calls

Status: v0.3 C2, built against the calls service of lane calls (`src/calls/service.js`) and not yet integrated. The rules
are those of [research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), section
3.5.

Calls are audio, video and screen sharing between signed-in people who are contacts on this site (or members of one
chat group), 1:1 or a mesh of at most 6 people with audio only, 4 with video (chosen; a call above that needs a mixing
server, which v0.3 does not have). The site turns them on with `_mw.cfg.calls = 'contacts'` (default `'off'`); they need
messages on (`mw.chat.enable()`) and the site's own tracker and STUN server (MF-44). Check `(await mw.ready()).features.calls`
before you show call buttons: it is advisory, and the service itself answers `E_POLICY` when calls are off.

What a call shows, said plainly:

- **Peers see each other's IP address.** The browsers connect directly, so everyone in a call learns the IP address of
  everyone else once they accept. A ring carries no address: the person who is called creates no connection before
  accepting, and the caller sends no network candidate before an accept, so a declined or ignored call shows nobody's
  address. If the owner runs a relay (TURN, R 2.7.8), it sees both IP addresses, sizes and times, never what is said.
- **The loader asks, not the site.** `start`, `accept` and `screen` are UI methods: call them from a click on the page.
  The loader's own call panel then shows its card (who will see the IP address, the relay if there is one, mobile
  data), and only the person's click there starts anything. The same panel shows the incoming card (the caller's name
  and short id, Accept with audio, Accept with video, Decline), the people in the call (ringing, connecting, Direct,
  Relayed by the operator, reconnecting, left), Mute, Camera, Share screen and Hang up. It lives in the loader's own
  page, so a call survives the site's navigations in shell mode.
- **No method returns a MediaStream.** The loader's panel plays the media in its own closed root; results and events
  are plain data. (Code on the same origin can still call `getUserMedia` itself, R 2.1 rule 2: the browser asks the
  person then.)
- **Phones.** On iPhone, video stops when the person leaves the page, a Home Screen app loses the microphone as soon as it
  goes to the background or the screen locks (reported in WebKit bug 239602), and a phone call pauses capture. Android
  may cut the connection when the screen is off. Android browsers cannot share the screen, so the panel offers Share
  screen only where the browser has `getDisplayMedia`. None of this is measured on a device yet (gate rows G-CL-2, G-CL-3).
- **A call rings only while the other person has this site open.** There is no push in v0.3 (`call.notHere`).
- **Drop-in mode** answers every `mw.calls` method with `E_UNSUPPORTED` in C2: the host's next page load would end the call.

Methods:

- `mw.calls.start({ to, video })` (UI) starts a call. `to` is a contact's key, an array of keys, or a chat group id;
  `video` asks for video (on mobile data the call starts with audio only after the `call.metered` card). Resolves with the
  call state. Errors: `E_NEEDS_GESTURE`, `E_NOT_SIGNED_IN`, `E_POLICY` (calls off, messages off, no own STUN), `E_BUSY`
  (already in a call), `E_LIMIT` (too many people, or too many rings to one person: 10 an hour), `E_NOT_CONTACT`,
  `E_PEER_UNREACHABLE` (not connected now), `E_MEDIA_DENIED`, `E_NO_DEVICE`, `E_USER_CANCELLED`, `E_HOST_ONLY`.
- `mw.calls.accept(id, { video })` (UI) answers a ring through the incoming card (the person's choice there wins).
  `mw.calls.decline(id)`, `mw.calls.hangup(id)`.
- `mw.calls.mute(id, on)`, `mw.calls.camera(id, on)`, `mw.calls.screen(id, on)` (UI: the `call.screen` card, then the
  browser's own picker).
- `mw.calls.state(id)` resolves with the call state or `null`; `mw.calls.list()` with the calls in progress. A call state is
  `{ id, role: 'caller' | 'callee', state: 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended', kind: 'audio' |
  'video', caller, group, startedAt, connectedAt, endedAt, expiresAt, local: { mute, camera, screen }, participants: [{ pub,
  name, state, path: 'direct' | 'relayed' | null, mute, camera, screen }], relay, operator, error, reason }`.
- `mw.calls.on(event, fn)` returns `unsubscribe()`: `'ring'` `{ id, from, name, kind, group, roster, expiresAt }` (rings
  expire after 45 s), `'state'` (a call state), `'peer'` `{ id, pub, state, path, ... }`, `'ended'` `{ id, reason, code,
  duration }`. They arrive as the `calls` push.
- Errors added in C2: `E_BUSY`, `E_DECLINED`, `E_NO_ANSWER`, `E_MEDIA_DENIED`, `E_NO_DEVICE`, `E_CALL_FAILED` (the call
  could not be set up, or the connection's certificate did not match the one sent over the sealed chat lane, so it could
  not be checked); reused `E_NOT_SIGNED_IN`, `E_HOST_ONLY`, `E_POLICY`, `E_NOT_CONTACT`, `E_PEER_UNREACHABLE`, `E_LIMIT`,
  `E_UNSUPPORTED`.

```js
callButton.onclick = async () => {
  try {
    await mw.calls.start({ to: contactKey });   // the loader's card says who will see the IP address
  } catch (err) {
    if (err.code === 'E_PEER_UNREACHABLE') note.textContent = 'They are not on this site right now.';
    else if (err.code !== 'E_USER_CANCELLED') note.textContent = 'No call: ' + err.code;
  }
};
mw.calls.on('ended', (e) => { note.textContent = 'Call ended (' + e.reason + ')'; });
```

## Seeding: mw.net.seeding, dock and keep

Status: v0.3 C2, built against lanes seed-policy (`seed-budget.js`, `seed-meters.js`, `dock.js`) and seed-engine
(`torrent.js`); not yet integrated. The budgets are chosen figures, not measurements (gate rows G-PS-1 to G-PS-14).

This browser shares what it holds in three lanes, in spending order: **H** (hand-off: the person's own new uploads, until
the site's pin node has them or two other complete copies exist), **K** (keep: what the person chose to share, and the
site while sharing is on) and **E** (echo: other items already held, by copy deficit). Each lane has a rate, and K and E
share a monthly cap, chosen by device, network, power and visibility (ARCHITECTURE 8.1.3). Phones share K and E only
after "Share on this network" or while dock mode runs. Sharing shows other visitors this browser's IP address and which
files it shares.

- `mw.net.seeding()` (read) resolves with `{ lanes: { H, K, E: { rate, used } }, month: { used, cap }, dock: { on, until },
  keeper }`. `rate` is bytes per second (`0`: the lane is off); `used` is the bytes this page sent in that lane on wires
  that count toward the caps (a host-to-host wire on the local network does not); `month.used` is K plus E this UTC month;
  `month.cap` is bytes, or `null` for no cap (the value is the same over the Bridge, in drop-in mode and in JSON, which
  has no Infinity); `dock.until` is a time in ms; `keeper` says whether this tab keeps the site. **The counters stay on
  this device**: nothing sends them anywhere, and they are never a score, a ranking or a reward (ARCHITECTURE 8). In a
  second tab of the site this answers `E_POLICY` (the first tab runs the engine).
- `mw.net.dock({ hours })` (UI, phones) opens the loader's card "Keep this screen on and share for 2 hours" (`hours`
  from 0 to 8, default 2; `0` stops it). The card's button takes a Screen Wake Lock inside the person's click and dims
  the page. On iPhone and Firefox, which give a page no battery or network information, the card first asks "I am on
  Wi-Fi" and "My phone is plugged in". Dock mode ends when the page is hidden, the phone is unplugged, the battery falls
  under 20% (where the browser can read it) or at the time limit; it uses no audio or other keep-alive. Resolves with
  `{ on, until, reason, declared }`; a start the browser refused resolves with `on: false` and the reason (`'hidden'`,
  `'unplugged'`, `'battery'`, `'declare'`, `'denied'`), and closing the card is `E_USER_CANCELLED`. On a computer it
  answers `E_UNSUPPORTED`: use `keep()`.
- `mw.net.keep(on)` (computers) turns on "Keep this site": this tab keeps sharing the site while it is open, also in the
  background, and shows what it keeps and its month counter. `keep(true)` needs a click and the loader's card; `keep(false)`
  needs neither. Resolves with `{ on }`. Errors: `E_UNSUPPORTED` on a phone (use `dock()`), `E_POLICY` when sharing is off
  in this browser, `E_LIMIT` when `on` is not a boolean, `E_USER_CANCELLED`.

A closed or suspended page shares nothing: no browser lets a page seed in the background once it is hidden or the screen
is locked (iPhone: about 20 s after the page is left).

### Availability labels on files and media items

Items of `mw.files.list()`, `mw.files.received()` and `mw.media.list()` keep `available` (`'kept'`, `'online'`,
`'unknown'`) for compatibility and gain (lane seed-engine, C2):

- `evidence: { tier, count, atLeast, reported, checkedAt }`: the strongest evidence this browser has that a copy exists.
  `E0` this device holds every piece; `E1` complete copies reported by connected visitors in the last 60 s (`reported`,
  because a visitor can claim pieces it does not have, and `atLeast` when the connection cap limits what this browser can
  see); `E3` the host answered a probe in the last 10 minutes; `E4` the site's pin node sent a signed receipt, or a signed
  pin heartbeat at most 15 minutes old lists the item. A count is never above its evidence.
- `label`: the key of the sentence to show (`avail.onlyHere`, `avail.heldBy`, `avail.keptBySite`, `avail.nobody`,
  `avail.noPin`, `handoff.waiting`, `handoff.sending`; English and French in `src/loader/strings.js`, SEED_TEXT), with its
  placeholders in `labelParams` (`n` a count, `age` ms since the check, `pct` a percentage).
- `handoff` (the person's own uploads): `{ state: 'onlyHere' | 'waiting' | 'sending' | 'kept' | 'sent' | 'nobody', ... }`.
  The loader shows the same sentence on its own upload card. "Kept by the site" is never "forever": it holds while the
  pin node does.

## mw.net, mw.site, mw.consent

### mw.net.peers() and mw.net.on(event, fn)

`peers()` returns the number of peer connections at once (in shell mode, the last count the loader pushed; `0` before
the first push). `on(event, fn)` returns `unsubscribe()`:

| Event | Data | When |
|---|---|---|
| `peers` | `{ count }` | the number of peer connections changed |
| `progress` | `{ downloaded, total, progress, peers, webseeds, downloadSpeed, uploadSpeed, uploaded, peerBytes, webseedBytes, source }` | while the site's files download or seed, every 250 ms at most |
| `status` | `{ code, ... }` | the torrent engine changed state; in shell mode also `{ code: 'consent', state }` and `{ code: 'title', title }` |
| `sync` | `{ height, peers, inSync }` | the ledger changed (the same moment a snapshot goes to `db.subscribe`) |
| `pow` | `{ hashes, bits }`, plus `id` in shell mode | while this page computes a write's posting fee |

In `progress`, `peerBytes` and `webseedBytes` are the file bytes this page received from other visitors and from the
web seed, and `uploaded` is the file data it sent to other visitors. `uploadSpeed` is WebTorrent's own rate and counts
protocol messages, so it can be above 0 while nothing is passed on. The `status` codes come from the torrent engine and
can change between versions: use them for display, and build logic only on `consent`.

### mw.site.info()

```js
const site = await mw.site.info();
// { name: 'my-site', files: [{ path: 'index.html', length: 6697 }, ...], btih: 'bdc1...', source: 'webseed', mode: 'shell' }
```

`name` is the torrent name or the pointer's `dn=`; `files` the files of this version (in drop-in mode the non-HTML
files only, empty until the browser has a copy); `btih` the version's infohash; `source` where this copy came from
(`'peers'`, `'webseed'`, `'mixed'`, `'cache'`, or `null` before any byte arrived); `mode` as in `ready()`.

### mw.consent.request() and mw.consent.state()

- `request()`: when the state is `'pending'`, it opens the loader's own consent card and resolves with the visitor's
  choice there: `'accepted'` ("Share and load"), `'host-only'` ("Load from host only"), or `'pending'` when the card was
  closed without a choice. A decided state resolves at once and opens nothing. Calls made while a card is open share
  it; after a card closes without a choice, calls in the next 10 s resolve with `'pending'` and open nothing.
- A site never decides for the visitor: there is no `consent.accept()`, and the card's buttons ignore clicks made by
  scripts. In drop-in mode, `data-mw-consent="site"` on the script tag stops the automatic card; the site then
  explains sharing in its own words and calls `request()`. Errors: `E_NO_HOST` (in drop-in mode: the engine is off).
- `state()`: `'pending'` until the visitor chose, `'accepted'` or `'host-only'` (no peer connections). In drop-in mode
  it returns the string directly; `await` works on both.

## mw.owner.policy(fields)

On a personal site (R 3.3) the owner is the person signed in with the page's owner key, and can change its policy in
the browser: `fields` from `writers`, `bits`, `maxValueBytes`, `maxChainBytes`, `moderators`, `allow`,
`modAllowPerDay`, `modActionsPerHour` and `reservedPool`. The identity page confirms every owner action (never an
in-page card); resolves with `{ h }`. Errors: `E_NOT_OWNER` (not the owner of a personal site: on other sites the
owner key never enters a browser, and the owner uses `tools/ledger-admin.mjs`, [CRUD.md](CRUD.md), "Permissions"),
`E_BAD_REQUEST` (an unknown field), `E_NEEDS_GESTURE`, `E_UNSUPPORTED` (the identity page cannot open),
`E_USER_CANCELLED`.

## Push events

What the loader pushes to the page (shell mode: `{ event, data }` on the port; drop-in mode: straight to the
listeners). Sites use the listeners, not the raw pushes:

| Push | Listener | Data |
|---|---|---|
| `state` | `db.subscribe(fn)` | the snapshot |
| `peers`, `progress`, `status`, `sync`, `pow` | `net.on(event, fn)` | as in the `net.on` table |
| `auth` | `auth.onChange(fn)` | `{ type: 'change', data: { state, identity, role } }`; the listener gets the `data` |
| `chat`, `files`, `media` | `chat.on`, `files.on`, `media.on` | `{ type: <event>, data }`; the listener of `type` gets `data` |
| `mod` | (moderator pages read `mod.queue()` again) | `{ type: 'queue' | 'report' | 'decided', data }` |
| `keychange` | `chat.on('keychange', fn)` for a contact's key | `{ source, data }`; the chat service's key changes also arrive as `chat` pushes of type `keychange`. The person's own new key shows as a new `identity.pub` in `auth.onChange` |
| `hub` | `db.subscribe(fn, { ledger })` | `{ type, data: { ledger, height } }` |
| `calls` (C2) | `calls.on(event, fn)` | `{ type: 'ring' \| 'state' \| 'peer' \| 'ended', data }`; plain data only, never a stream |

The Bridge also pushes `{ event: 'wait', data: { id } }` every 20 s while a request is waiting for the person (a
card, the identity page, the sign-in prompt of a guest's first write). It is a transport message, not a site event:
the SDK restarts that request's 30 s answer timer on each one, for at most 10 minutes.

## Writes and the posting fee

Every ledger write (`db.set`, `db.del`, `db.append`, `db.tombstone`, `db.setMine`, `identity.setName`, the `mod`
actions, `owner.policy`) takes an optional last argument `{ onProgress, signal }`:

```js
const ctl = new AbortController();
cancelButton.onclick = () => ctl.abort();
try {
  await mw.db.append('guestbook', { msg }, {
    signal: ctl.signal,
    onProgress: ({ hashes, bits }) => {
      note.textContent = 'Working out the spam fee (' + hashes.toLocaleString() + ' tries)';
    },
  });
  note.textContent = 'Posted.';
} catch (err) {
  if (err.code === 'E_POW_ABORTED') note.textContent = 'Cancelled. Nothing was posted.';
  else note.textContent = 'Not posted: ' + err.code;
}
```

- Before a write is stored, the browser computes a small proof-of-work, a spam fee, in a worker: about 2^bits hashes
  on average (65,536 at the default 16 bits). The owner and moderators pay no fee.
- Measured on a desktop (Apple M3, one worker): a 16-bit fee takes 174 to 283 ms on average in Chromium 156 and 201
  to 234 ms in WebKit 27.2 ([research/_w1-part-a.md](research/_w1-part-a.md), section 4.2, row 10). Phones are not
  measured yet. Published rates for simple phone solvers, 40,000 to 120,000 hashes a second, put 65,536 hashes at
  about 0.55 to 1.6 s ([research/06-browser-chain-vs-crdt.md](research/06-browser-chain-vs-crdt.md), F37); those
  solvers hash shorter inputs than an entry's header, so take it as an order of magnitude. Show progress for every
  write.
- `onProgress({ hashes, bits })` follows the work. Every report is also a `pow` event, and the shell loader's status
  line says "Posting: working out the spam fee for this post". `media.upload` and `files.fetch` use `onProgress` for
  their own progress instead.
- When `signal` aborts, the write rejects with `E_POW_ABORTED` and is never stored or sent, even if the work had
  finished.
- Shell mode: a write that gets no answer within 30 s rejects with `E_TIMEOUT`; every progress report restarts that
  timer, for at most 10 minutes. When the SDK gives up it cancels the write, so a write your page saw fail does not
  appear later.
- Writes run one at a time per browser. In a second tab, writes go through the tab that runs the engine.

## Tabs

One tab per site runs the engine and holds the keys; the other tabs of that site follow it (ARCHITECTURE 5.9).

- A follower tab never holds keys. It shows the engine tab's sign-in (`auth.state()`, `ready().identity`) and sends
  its ledger writes to the engine tab, which signs them.
- Methods that need the keys or the peers (chat, files, media, the record, and in C2 calls and `net.seeding`, `net.dock`,
  `net.keep`) reject with `E_POLICY` in a follower tab ("use the first tab you opened it in"); a guest's write there
  rejects with `E_NOT_SIGNED_IN` without a prompt. Calls ring and play only in the first tab.
- When the engine tab signs out, every follower drops the signed-in state at once (a `signed-out` message on the tab
  channel and on `BroadcastChannel('mw-identity')`).
- When the engine tab closes, a follower takes over: it mounts the services, and the person signs in there again (or
  their "Stay signed in" keys come back).

## Error codes

`ERROR_CODES` in `/_mw/sdk.js` lists every code below, in this order: the 0.2.1 codes, `E_BAD_REQUEST`,
`E_INTERNAL`, `E_TIMEOUT`, then the codes R 2.11.2 adds, then the six call codes of C2 (`E_BUSY` to `E_CALL_FAILED`).
The loader's `ERROR_STRING_KEYS` (`src/loader/api.js:238`; `/_mw/sdk.js` does not export it) maps every error code to
itself: since the review round (UX-11) each code has a sentence of its own in `ERROR_TEXT` (`src/loader/strings.js`,
English and French), and no code borrows a nearby code's sentence any more.

| Code | Meaning | Typical causes |
|---|---|---|
| `E_POLICY` | the policy or a setting refused it | `writers` is `owner` or `allow` and this identity is not allowed; a key of another author's `@` space; a feature the site turned off; a follower tab; a ledger this page does not follow |
| `E_LIMIT` | bad or oversized input | an empty or long key or name, a value that is not plain JSON or is over `maxValueBytes`, a bad hash or key, the follow cap |
| `E_RATE` | too many requests | more than 20 ledger writes a minute from this page, more than 30 entries in 10 minutes from this identity, a second sign-in within 10 s |
| `E_NOT_OWNER` | an owner-only operation | `owner.policy()` by someone who is not the owner of a personal site |
| `E_NOT_MODERATOR` | a moderator-only operation | a `mod` action, a tombstone of someone else's entry, a key or list name starting with `_` |
| `E_POW_ABORTED` | the write was cancelled | your `signal` aborted, or the SDK cancelled after a timeout |
| `E_IDENTITY` | no ledger or posting key in this browser | IndexedDB unavailable, a drop-in engine that is off, a key that could not be stored |
| `E_NO_HOST` | no loader to talk to | the page is not inside felinar, a static copy, a drop-in engine that is off |
| `E_CAP` | the ledger is full | `policy.maxChainBytes` reached: only the owner, moderators and allow-listed authors are added |
| `E_BANNED` | this identity is banned | a moderator banned this key, here or in a room |
| `E_BAD_REQUEST` | unknown method or malformed request | a method that does not exist (the loader-only ones included), a bad ledger id, a report that carries content |
| `E_INTERNAL` | anything else | a bug: please report it with the console output |
| `E_TIMEOUT` | no answer | shell mode only: 30 s without an answer, a fee report or a `wait` push |
| `E_NOT_SIGNED_IN` | needs a sign-in | a guest closed the sign-in prompt of a write; a follower tab of a guest |
| `E_USER_CANCELLED` | the person said no | a card or the identity page was closed or declined |
| `E_UNSUPPORTED` | not possible here | no WebCrypto P-256; a service this build or page does not have; no identity page for an owner action |
| `E_FIELD` | a reserved record field | `me.set` with a contact, legal, birth, document or health field name |
| `E_DECRYPT` | cannot be opened with these keys | a file or media item for another person, or a changed key |
| `E_HOST_ONLY_IDENTITY` | this visit only | a shared-origin hub: identities there last for the visit |
| `E_POPUP_BLOCKED` | the browser blocked the identity window | no click reached it and no loader card could take over |
| `E_IDP_UNREACHABLE` | the identity page could not be reached | offline, or the identity origin is down |
| `E_NEEDS_GESTURE` | call it from a click | a UI method outside a click on the page |
| `E_NONCE_REQUIRED` | a server sign-in without a nonce | `auth.signInServer` without `challenge.nonce` |
| `E_LEDGER_FULL` | this site cannot take more entries now | the reserved pools of the ledger are full |
| `E_SYNCING` | still catching up | the ledger is syncing; try again in a moment |
| `E_HOST_ONLY` | needs peers, and the visitor chose host only | chat, file sharing and media in host-only mode |
| `E_NO_OWN_TRACKER` | no own tracker | the site's pointer names no tracker of its own, so chat is off |
| `E_NO_CHAT_KEY` | that person has not turned on messages here | `chat.dm.send`, `media.share` |
| `E_BLOCKED` | cannot send to that person | a block, either way |
| `E_STAMP` | the message stamp did not finish | the anti-spam stamp of a message |
| `E_NOT_MEMBER` | not a member of this group | `chat.group.*` |
| `E_NOT_ADMIN` | only a group admin can do this | `chat.group.invite`, `chat.group.remove` |
| `E_NOT_CONTACT` | direct connections are for contacts | `chat.direct.connect` |
| `E_PEER_UNREACHABLE` | that person could not be reached directly | `chat.direct.connect` |
| `E_FILE_UNAVAILABLE` | nobody who has it is online | `files.fetch`, `media.open` |
| `E_FILE_TOMBSTONED` | the file was removed | `files.fetch` |
| `E_FILE_HASH` | the file did not match its checksum | `files.fetch` (the bytes were dropped) |
| `E_DENIED` | no access | a `_deny/` entry, or not shared with this person |
| `E_MEDIA_TYPE` | this kind of file is not accepted | `media.upload` |
| `E_MEDIA_STRIP` | location and camera details could not be removed | `files.share`, `media.upload` (nothing was sent) |
| `E_MEDIA_UNPLAYABLE` | this browser cannot play it | `media.open` |
| `E_REVOKED` | access was taken back | `media.open` after `media.revoke` |
| `E_BUSY` | that person is in another call, or this tab is | `calls.start` |
| `E_DECLINED` | the person declined the call | `calls.start` (the call state and `'ended'` say so too) |
| `E_NO_ANSWER` | nobody answered within 45 s | `calls.start` |
| `E_MEDIA_DENIED` | the browser did not allow the microphone or the camera | `calls.start`, `calls.accept`, `calls.camera`, `calls.screen` |
| `E_NO_DEVICE` | no microphone or camera was found | `calls.start`, `calls.accept`, `calls.camera` |
| `E_CALL_FAILED` | the call could not be set up, or its connection could not be checked | any call; also when the certificate did not match the sealed offer or answer |

## Limits

| What | Limit | Set by |
|---|---|---|
| A value | 2,048 bytes of canonical JSON by default; the owner can set 0 to 4,096 | `policy.maxValueBytes` |
| A whole entry (header, value and salt) | 4,096 bytes; the header alone is about 400 to 530 bytes | fixed |
| A key | 256 bytes | fixed |
| A list name | 64 bytes | fixed |
| An author-scoped name (`setMine`) | 238 characters (the key minus its 18-character scope) | fixed |
| A display name | 48 characters | fixed |
| Ledger writes from one page | 20 a minute | the loader |
| Entries from one identity | 30 in 10 minutes, here and at every peer (the owner and moderators are exempt) | the ledger node |
| `db.list` | 1 to 1,000 items | the loader |
| One request | 64 KiB (a `File` or `Blob` parameter is sized by its service) | the loader |
| A click counts for | 5 s | the loader (chosen) |
| A sign-in prompt after a cancelled one | not before 10 s | the loader |
| Followed ledgers (hub) | 250 on a phone, 1,000 on a computer | the hub service (chosen, R 3.2.3) |
| A report note | 500 characters | the moderation service |
| `mod.tombstoneMany` | 64 authors | the ledger |
| The whole ledger | 8 MiB by default, at most 64 MiB | `policy.maxChainBytes` |
| The posting fee | 16 bits by default, 0 to 32 | `policy.bits` |
| Moderators | 50 keys | fixed |
| The allow list | 1,000 keys | fixed |

## The visitor's identity

- In v0.3 a person has one identity, kept by their identity origin (the identity page), and a separate key for each
  site by default, so sites cannot match them. Signing in gives this origin working keys for the site; the root and
  the 12 words never leave the identity origin, and no site page ever asks for the words.
- A guest can read everything public. Nothing is created for a guest: there is no key until the person signs in.
- A 0.2.1 visitor's per-site key (made by 0.2.1 the first time it opened the ledger) moves into the identity at the
  first sign-in and keeps its posts linked (R 2.2.7). A build without the identity service keeps using that key
  (`identity.mode` `'legacy'`); its export and import stay in the loader's Settings.
- A moderator key imported in the loader's Settings (MF-27) signs every write of that browser while it is there, so
  the site sees it: `ready()` and `mw.auth.state()` say `'signed-in'` with `identity.mode` `'legacy'` and that key,
  and a write opens no sign-in.
- Safari may delete a site origin's data after 7 days without a visit; the identity origin keeps the identity, so the
  person signs in again. A Home Screen app has its own storage.
- Code on the site's origin shares that origin with the loader's code, so the SDK's limits stop accidents, not a
  hostile script the site itself includes ([SECURITY-MODEL.md](SECURITY-MODEL.md)): while the person is signed in,
  code on the site can act as them on this site, which the sign-in card says.

## Diagnostics (not part of the API)

These exist for debugging, tests and support. They can change in any version.

- Shell mode: `window.__mwShell.inspect()` in the console of the top page (not the site frame) shows the mode,
  infohash, ledger id, pointer source, consent, peers, the ledger's height and root, and the log.
  `window.__mwShell.rectOf(label)` gives the rectangle of a button of the open loader card (its root is closed), as
  `window.__mwDropin.rectOf` does, so a test can click it with a real mouse event.
- Drop-in mode: `window.__mwDropin.inspect()` shows the engine state and why it is off, the copy, its source,
  consent, the Service Worker mode, the policy and the log, including which v0.3 services were mounted.
  `window.__mwDropin.openSettings()` opens the visitor's settings, for a site that wants a "peer-to-peer settings"
  link in its footer.

## Versions and stability

`SDK_VERSION` is `'0.3.0'`. The `window.mw` surface changes only through an RFC ([GOVERNANCE.md](../GOVERNANCE.md)),
and every change is listed in [CHANGELOG.md](../CHANGELOG.md). v0.3 added the namespaces `auth`, `me`, `chat`,
`files`, `media`, `report` and (amendment) `hub`; `identity.current`, `identity.backupStatus` and
`identity.openIdentity`; `db.setMine`, `db.getMine`, `db.listBy` and the `ledger` option; `mod.unban`,
`mod.tombstoneMany`, `mod.queue` and `mod.decide`; the push events `auth`, `chat`, `files`, `media`, `mod`,
`keychange` and `hub`; and 29 error codes. `mod.ban` became a UI method, and `ready()` gained `auth` and `features`
and an `identity.mode`. v0.3 C2 adds the namespace `calls`, `net.seeding`, `net.dock` and `net.keep`, the push event
`calls`, `features.calls`, the six call error codes, and `evidence`, `label`, `labelParams` and `handoff` on file and
media items.

## Testing against the SDK

- `npm run demo -- --site <your folder> --name <name>` publishes your folder with an open ledger and serves it on
  `http://localhost:8080/`, with the identity page that writes sign in at on `http://localhost:8081/`
  ([QUICKSTART.md](QUICKSTART.md)).
- `test/example/mock-sdk.js` is an in-memory stand-in for `/_mw/sdk.js` that the example's browser test serves in its
  place; copy it for UI tests that need no loader.
- In tests that click, use a real (trusted) click: a script's `element.click()` does not count for UI methods.
- `node test/e2e/run.mjs --only FMT-SDK` runs the end-to-end check of this surface in a real shell page (local-only
  browsers, [DEV-NETWORK.md](DEV-NETWORK.md)).
