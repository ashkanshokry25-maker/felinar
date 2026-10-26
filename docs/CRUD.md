# Backend-free CRUD on the site ledger

A felinar site can create, read, update and delete shared data from plain static pages: a guestbook,
comments, reactions, polls, profiles, a small board. There is no database or application server for you
to run. The data lives in the **site ledger**: a signed, hash-linked log that every visitor copies and
verifies. No mining, no consensus, no finality. Your pages use it through `mw.db`, a small SDK
([SDK.md](SDK.md) has every method).

What you get, and the condition attached to each:

| You get | On this condition |
|---|---|
| Shared data with no backend to run | everything written is public, and it spreads only while visitors with a copy are online together |
| Every entry signed by its author and checked by every visitor | identities are free to make, so a signature proves "the same key", not "a real person" |
| The same order and the same state on every device that holds the same entries | there's no finality: an entry that arrives late can change what "latest" means |
| Moderation with your own keys: removals, bans, write policies | you moderate what your site makes visitors redistribute |
| A first visitor sees the data even when nobody else is online | the pointer has `cs=` and you refresh the snapshot it names, or you run a pin node |

Everything written with mw.db is public and copied to every visitor. Deleting an entry hides it for
visitors who receive the deletion. Copies on devices that never sync again stay where they are.

## Is it the right tool?

| Good fit | Not a fit |
|---|---|
| guestbooks, comments, reactions, polls, sign-up lists that are public anyway | accounts, passwords, private messages, anything personal |
| small shared state: a notice, feature flags, a team's public task list | payments, inventory, anything that needs a transaction or a unique value |
| data that can be read late and settle later | data that must be the same for everyone at the same moment |
| a few writes per visitor per visit | telemetry, analytics, chat at high rates |

The four feature classes (works now, needs new code, a third party from the browser, stays on a server)
are in [COMPATIBILITY.md](COMPATIBILITY.md) and [MIGRATION.md](MIGRATION.md).

## Concepts

| Term | What it is |
|---|---|
| Ledger id | The ledger's name, `mw1:` plus 27 characters, derived from the owner key and the site's hostname (or `--chain`). It stays the same across every version of the site, so the data survives a new publish. An unsigned magnet link gets an ownerless ledger `btih:<infohash>` instead |
| Entry (block) | One signed record: the author's public key, the hashes of up to 8 entries the author had already seen (`prev`), a time rounded to the minute as the author's clock claims it, the operation, a posting fee and, for data, the value |
| Genesis | The first entry, the ledger's policy, signed by the owner key when you first publish. Visitors need it before they can write, so publish with `--cs` |
| Policy | Who may write (`owner`, `allow` or `open`), the posting fee in bits, the size limits, the moderators and the allow list. Only the owner changes it, offline |
| Deterministic order | Every visitor sorts the entries the same way: by depth in the hash graph, then by hash. The same entries give the same state on every device |
| Tombstone | A deletion entry: every copy that receives it drops the target's value. The target's header stays |
| Ban | A moderator's entry that removes everything one author wrote, for everyone who receives it |
| Cap | The ledger's size limit, 8 MiB by default (`maxChainBytes`). Past it, only the owner, moderators and allow-listed authors can add entries |
| Posting fee | A small proof-of-work carried by every entry from anyone but the owner and moderators, 16 bits by default. It is a spam fee, not security |
| Snapshot (`cs=`) | A file on your host with the ledger's entries. Loaders fetch it after the page renders, so a first visitor gets the data with nobody else online |

The specification is [ARCHITECTURE.md](ARCHITECTURE.md), section 6.

## The data model

There are three kinds of data and one naming rule.

| | Keys (documents) | Lists (streams) | Profiles |
|---|---|---|---|
| Write | `mw.db.set(key, value)`, `mw.db.del(key)` | `mw.db.append(name, value)` | `mw.identity.setName(name)` |
| Read | `mw.db.get(key)`, `snapshot.kv[key]` | `mw.db.list(name)`, `snapshot.lists[name]` | `snapshot.profiles[pub]` |
| Semantics | one current value per key: the last write in ledger order wins | every item stays, in ledger order, until it is tombstoned | one display name per author, the latest wins |
| What a reader learns | the value only, not who wrote it | each item's `h`, `author`, `ts` and value | the name per author key |
| Who may write | any writer the policy allows, over anyone's value | any writer the policy allows; each item belongs to its author | each author, for their own name |
| Size | key at most 256 bytes | list name at most 64 bytes | name at most 48 characters |

- **Values** are plain JSON (objects, arrays, strings, finite numbers, booleans, `null`) of at most
  `maxValueBytes` bytes of canonical JSON: 2,048 by default. The owner can set 0 to 4,096, but a whole
  entry is at most 4,096 bytes and its header takes about 400 to 530, so plan for values well under 3 KiB.
- **Names starting with `_`** (keys and lists) are written only by the owner and moderators. Everyone reads
  them. Use them for the owner's notice, feature flags and poll definitions.
- **Keys do not belong to anyone.** A writer can overwrite any key that doesn't start with `_`, and
  neither `get` nor the snapshot says who wrote the current value. Data that belongs to one author goes in
  a list, where every item carries its `author`, and the reader keeps the latest item per author.
- **Timestamps are claims.** `ts` comes from the author's clock, rounded down to the minute. Show it as
  "posted at, according to the author"; never sort by it, never trust it.

Choosing a shape:

| You are storing | Use | Because |
|---|---|---|
| a page's comments, a guestbook | a list per page | items carry their author and can be removed one by one |
| one value per visitor (a vote, a reaction, a profile) | a list, latest item per author | a key could be overwritten by anyone |
| a shared document anyone allowed may edit | a key | last writer wins is what a shared document wants |
| the owner's settings, a notice, flags | a `_` key | only the owner and moderators can write it |
| anything personal or secret | nothing on the ledger | see "Delete" and "Anti-patterns" below |

## The CRUD mapping

The code on this page runs in a module script on any page of a felinar site:

```html
<script type="module">
  import mw from '/_mw/sdk.js';
  const me = await mw.ready();   // { identity: { pub, short, name }, role, mode, ... }
  // ... the examples below
</script>
```

### Create

```js
// A stream item: belongs to its author, removable on its own
const { h } = await mw.db.append('guestbook', { msg: 'Hello from Lisbon' });

// A document: one current value under a name
await mw.db.set('topic', { title: 'Ideas for the next meetup', by: me.identity.short });
```

The write is signed with this visitor's key, the fee is computed in a worker, the entry is stored in
this browser's copy, and then it goes to every connected visitor, who checks it and passes it on.
`append` and `set` resolve once the entry is stored here, not once others have it.

### Read

```js
// Point reads
const topic = await mw.db.get('topic');                         // value or undefined
const recent = await mw.db.list('guestbook', { limit: 50 });    // newest first, items { h, author, ts, v }

// Live reads: runs now and after every change, whoever made it
const off = mw.db.subscribe((snap) => {
  renderTopic(snap.kv.topic);
  renderGuestbook((snap.lists.guestbook || []).slice().reverse());   // snapshot lists are oldest first
});
```

Use `subscribe` for anything on screen: it fires for this visitor's writes and for entries that arrive
from others. `db.list` returns at most 1,000 items and has no cursor yet, so compute aggregates (counts,
tallies) from the snapshot, which holds every list in full.

### Update

**A key:** write it again. The new value wins over every value this browser had seen.

```js
await mw.db.set('topic', { title: 'Ideas for the December meetup', by: me.identity.short });
```

Two visitors who change the same key at the same time, before either sees the other's write, are both
"latest" for a moment. When their entries meet, the ledger order picks one, the same on every device. It
picks by position in the hash graph, not by clock: the result is deterministic but neither visitor
chooses it. A write made after seeing another one always wins over it.

**A list item:** list items never change. Model an edit as a new item that names the original by its
hash, and let readers apply the latest edit by an allowed editor:

```js
// Edit: a revision that points at the original item
await mw.db.append('guestbook-edits', { of: item.h, msg: 'Hello from Lisbon (and Porto)' });

// Read: the original's text, replaced by its author's latest revision
function current(snap) {
  const edits = new Map();   // original h + author -> latest revision value
  for (const e of snap.lists['guestbook-edits'] || []) {
    if (e.v && typeof e.v.of === 'string' && typeof e.v.msg === 'string') edits.set(e.v.of + '|' + e.author, e.v);
  }
  return (snap.lists.guestbook || []).map((item) => {
    const rev = edits.get(item.h + '|' + item.author);   // only the original author's revisions count
    return rev ? { ...item, v: { msg: rev.msg }, edited: true } : item;
  });
}
```

The revision list keeps the history, and moderators can tombstone revisions like any item. The simpler
alternative is tombstone and post again, which loses the position in the list.

### Delete

| What | How | Who | Effect |
|---|---|---|---|
| A key | `mw.db.del(key)` | any writer | `get` returns `undefined`; the earlier values stay in every copy until tombstoned |
| A list item | `mw.db.tombstone(item.h)` | its author, a moderator, the owner | the item leaves every list that receives the tombstone, and its value's bytes are deleted from those copies |
| A key's old values | `mw.db.tombstone(h)` with the `h` that `set` returned | its author, a moderator, the owner | that value's bytes are deleted; if it was the current value, the previous one comes back, so `del` first |
| Everything one author wrote | `mw.mod.ban(pub)` | a moderator, the owner | every entry by that key is removed for everyone who receives the ban, and the key can't write again |
| The whole site | `node tools/publish.mjs --withdraw` | the owner | loaders stop sharing the site and delete every stored version ([DEPLOY.md](DEPLOY.md)) |

What a tombstone keeps: the target entry's header (the author's public key, the minute timestamp, the
operation and the key or list name) stays in every copy, because later entries name it by hash. The
value is gone, and so is its 16-byte random salt, so the remaining hash can't be used to confirm a guess
about the value. A snapshot written after the tombstone (`tools/snapshot.mjs`) leaves the value out.

A note on erasure and personal data (not legal advice): a tombstone reaches only the copies that receive
it. A device that never syncs again keeps the value, anyone could have copied it before, and key and list
names are never erased. Treat everything written to the ledger as permanent. The European Data Protection
Board's 2025 guidelines on personal data in replicated public ledgers (Guidelines 02/2025, v2.0 adopted
2026-07-07) say encrypted personal data is still personal data and advise against storing personal data
there at all ([research/w2a-03-dynamic-feature-replacements.md](research/w2a-03-dynamic-feature-replacements.md),
F25). So: no names of real people, email addresses, phone numbers, addresses or IP addresses in values,
keys or list names. Contact forms go to a form relay or `mailto:` instead ([MIGRATION.md](MIGRATION.md)).

## Permissions

The policy is set when you first publish and changed later only with the owner key, offline.

| `writers` | Who can write data | Use it for |
|---|---|---|
| `owner` (default) | the owner and moderators | sites whose visitors only read: the notice, flags, announcements |
| `allow` | the owner, moderators and up to 1,000 listed keys | a team, a class, members you know |
| `open` | anyone, paying the posting fee | guestbooks, comments, reactions, polls |

| Role | Holds | Can | Cannot |
|---|---|---|---|
| Owner | the owner key, offline, never in a browser | everything, through `tools/ledger-admin.mjs`: policy, allow list, moderators, hand-over, bans, tombstones | write from a browser (`mw.owner.policy()` always rejects) |
| Moderator (up to 50) | their own key, imported in the loader's Settings (shell mode) | tombstone any data entry, ban authors, write `_` keys and lists; no fee | change the policy, the allow list or the owner |
| Writer | the visitor's own browser identity | write data under the policy, tombstone their own entries | touch others' entries or `_` names |
| Reader | the same | read everything | write (`E_POLICY`) |

- `ready().role` and `snapshot.role` give the current role; hide the controls a visitor cannot use.
- A policy change applies causally: it governs every entry its signer had not seen when signing it. Close
  writing with `writers: 'owner'` and posts written at the same moment elsewhere disappear once the change
  reaches those copies; posts the owner had already received stay.
- An unsigned magnet link has no owner: its ledger is open to anyone with the default fee, has no
  moderators, and shows a permanent "unmoderated" badge. Authors can still remove their own entries.
- Never import the owner key in a browser, not even as a moderator key. Make a moderator key for yourself
  instead.

### Set it up when you publish

```sh
node tools/keygen.mjs --out ~/keys/moderator-ada.jwk     # one key per moderator
node tools/publish.mjs ./site --name my-site --scope example.com --key ~/keys/my-site-owner.jwk \
  --policy open --bits 16 --moderator p256:BMHGDCSjY46_WgwIoOCH051fGkhI5x7LRhprsRUXJQxjBlSm3Gwrz5kmEAXTrCM42uzpmo9RtE3_0gj-qdjQK5c \
  --ws https://example.com/ws/ --tr public --cs https://example.com/ws/genesis.json \
  --ct mailto:abuse@example.com --shell --out dist-publish
```

`keygen` prints the public key on the line that starts with `owner=`, whatever the key is for; pass that
`p256:...` value to `--moderator` (repeatable) or `--allow` (repeatable). `--ct` names who answers abuse
and legal notices, and `publish` warns when `--policy open` comes without it. The policy flags take
effect on the first publish, which mints the genesis entry into `dist-publish/genesis.json`. Later
publishes into the same `--out` reuse that genesis, and refuse policy flags that contradict it:

```text
Error: the ledger genesis in dist-publish/genesis.json has writers="open", but the flags ask for "owner". Change the policy of a live ledger with tools/ledger-admin.mjs policy, or pass --new-genesis to start a new ledger root.
```

`--new-genesis` starts an empty ledger: every entry so far is left behind.

### Change it later, offline

A change is an entry signed with the owner key, appended to a ledger file and published as a new
snapshot. Visitors pick it up from the snapshot on their next load and pass it to each other.

```sh
# 1. Get the current ledger: Settings > "Export ledger JSON" in the loader (shell mode),
#    or let a local browser read the live site (it contacts the internet):
node tools/snapshot.mjs https://example.com/ --remote --plain --out ledger.json

# 2. Sign the change with the owner key (each command appends one entry to ledger.json)
node tools/ledger-admin.mjs policy --key ~/keys/my-site-owner.jwk --file ledger.json --writers allow --bits 18
node tools/ledger-admin.mjs allow --key ~/keys/my-site-owner.jwk --file ledger.json --add p256:<a member's key>
node tools/ledger-admin.mjs show --file ledger.json

# 3. Write the snapshot and upload it to the URL in the pointer's cs= (here .../ws/genesis.json)
node tools/snapshot.mjs ledger.json --plain --out genesis.json
```

Output of steps 2 and 3 on a test ledger:

```text
appended policy block 1e195105f35251a7bf38d6418403b4d315773ad2d93c0ee2be9a6bde37fd9763 to ledger.json
ledger    mw1:kg166yEUTGpK0992FC45llLPOMA
blocks    2
bytes     850
owner     p256:BMINwovK50fOaGmPEb4I19RjFbHd2OvjPmDGeSOjZ4qXN8yiHDttLSR8GTqTa7HMUgi9yVfCYs4QRQUwvmk3hNg (5666dca3)
policy    writers=allow bits=18 maxValueBytes=2048 maxChainBytes=8388608 moderators=1 allow=1 banned=0
...
ledger   mw1:kg166yEUTGpK0992FC45llLPOMA
blocks   2 (850 B of blocks), root c9a3339fb49ccb43...
state    writers=allow, 0 list(s), 0 key(s), 0 tombstoned, 0 value(s) removed from the file
wrote    genesis.json (1.2 KiB, plain JSON)
```

The other `ledger-admin` commands (`ban`, `tombstone`, `owner`, `accept`) work the same way; run
`node tools/ledger-admin.mjs --help` for every flag. `policy` keeps the fields you don't pass, but
`--moderator` and `--allow` replace the whole list, so repeat every key you keep (`--clear-moderators`
and `--clear-allow` empty them). The `allow` command adds and removes single keys (`--add`, `--remove`).
Work on a plain `.json` file: `ledger-admin` reads gzip but writes plain JSON back.

To collect members' keys for an allow list, show each visitor their own key with a copy button
(`me.identity.pub`) and have them send it to you.

## Consistency model

Each browser holds its own copy and computes the state from the entries it has. There's no server that
decides, so think of every screen as "what this visitor has received so far".

| Situation | What happens |
|---|---|
| A visitor writes | the entry is stored in their browser first, then sent to every connected visitor, who checks and relays it |
| Two visitors are connected | the entry goes out as soon as it is stored, and every visitor who receives it passes it on; on loopback the end-to-end test measured 469 ms from clicking Post (fee included) to the entry on the other screen, and it allows 10 s |
| "In sync with 3 peers" | three connected peers hold exactly the same set of entries (the same root hash) |
| Nobody else is online | the entry waits in the writer's browser and goes out the next time they are online with the page open alongside someone else |
| The visitor chose "Load from host only" | they see the snapshot's entries, and their own writes stay on their device |
| A visitor was offline for a week | when they connect, both sides exchange what the other lacks; each of their writes takes the place its position in the hash graph gives it, so one of them can still become a key's current value over a newer write by someone else: the order follows what each writer had seen, not the clock |
| Two writes to one key at the same time | both are kept; the ledger order picks the current value, the same on every device |
| A policy change, ban or tombstone | it applies on every copy that receives it; a visitor may see an entry and then see it disappear |
| Drop-in pages | the ledger syncs while a page with the script tag is open; every navigation closes the connections and the next page reopens them |
| Shell mode on phones | iOS stops peer connections within seconds of switching apps or locking the screen; syncing resumes when the page is back on screen |

What the ledger does not give you: transactions, uniqueness (two visitors can both claim the same name or
the first place), counters (count items instead), an "everyone has seen it" moment, or protection against
someone who makes many identities. Design for "eventually, on the copies that meet".

## Limits and quotas

| Limit | Default | Notes |
|---|---|---|
| Value | 2,048 bytes | the owner can set 0 to 4,096 (`--max-value-bytes` at publish, or `ledger-admin policy`) |
| Entry | 4,096 bytes | header, value and salt together |
| Key, list name, display name | 256 bytes, 64 bytes, 48 characters | |
| Writes from one page | 20 a minute | `E_RATE`: "too many writes, try again in a minute" |
| Entries from one identity | 30 in 10 minutes | `E_RATE`; every peer applies the same limit to each author's entries, so a burst spreads slowly. The owner and moderators are exempt |
| Ledger size | 8 MiB | up to 64 MiB (`--max-chain-bytes`); small entries take about 570 to 1,039 bytes each, so 8 MiB holds roughly 8,000 to 14,700 of them ([research/MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), section 8) |
| At the cap | | only the owner, moderators and allow-listed authors are added (`E_CAP`); the loader says "The ledger is full on this device" |
| Posting fee | 16 bits | the owner and moderators pay none; the owner can raise it during an attack (`ledger-admin policy --bits 18`) |
| `db.list` | 1,000 items | read the snapshot for the rest |

The posting fee in practice: measured on a desktop (Apple M3, one worker), a 16-bit fee takes 174 to 283 ms
on average in Chromium 156 and 201 to 234 ms in WebKit 27.2 ([research/_w1-part-a.md](research/_w1-part-a.md),
section 4.2, row 10). Phones haven't been measured. Published rates for simple phone solvers put 65,536
hashes at about 0.55 to 1.6 s ([research/06-browser-chain-vs-crdt.md](research/06-browser-chain-vs-crdt.md),
F37), an order of magnitude rather than a figure for this miner. Every 2 bits more is four times the
work. It slows casual scripts, not a determined attacker with a GPU, which is why moderation and the
write policy are the real tools. Show progress with `onProgress` ([SDK.md](SDK.md), "Writes and the
posting fee").

## Recipes

Each recipe is complete: publish flags, the page code, and what to watch. They share one pattern: render
from `db.subscribe`, write with `append` or `set`, set text with `textContent` (never `innerHTML`: values
come from strangers), and turn error codes into sentences.

```js
// errors.js: one place for the sentences
export const SENTENCES = {
  E_RATE: 'You are posting too fast. Wait a moment and try again.',
  E_POLICY: 'The site owner does not allow that here.',
  E_LIMIT: 'That is empty or too long.',
  E_NOT_MODERATOR: 'Only moderators can do that.',
  E_BANNED: 'This identity was banned on this site.',
  E_CAP: 'The site ledger is full. Only moderators can add entries now.',
  E_IDENTITY: 'Shared data is not available in this browser.',
  E_POW_ABORTED: 'Cancelled. Nothing was posted.',
  E_NO_HOST: 'Open this site through its felinar loader to post.',
};
export const explain = (err) => SENTENCES[err && err.code] || (err && err.message) || String(err);
```

### Guestbook and per-page comments

Publish with `--policy open --bits 16`, at least one `--moderator`, `--cs` and `--ct`.

```html
<section id="comments">
  <form>
    <label>Your comment <textarea name="text" maxlength="500" required></textarea></label>
    <button>Post</button> <span class="note" aria-live="polite"></span>
  </form>
  <ol></ol>
</section>
<script type="module">
  import mw from '/_mw/sdk.js';
  import { explain } from '/js/errors.js';

  const me = await mw.ready();
  const root = document.querySelector('#comments');
  const form = root.querySelector('form');
  const note = root.querySelector('.note');

  // One list per page. List names are at most 64 bytes, so use a short hash of the path.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.pathname)));
  const LIST = 'c:' + Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');

  mw.db.subscribe((snap) => {
    const mod = snap.role === 'owner' || snap.role === 'moderator';
    const items = (snap.lists[LIST] || []).slice().reverse();          // newest first
    root.querySelector('ol').replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      const who = document.createElement('strong');
      who.textContent = snap.profiles[item.author] || 'Visitor ' + item.author.slice(5, 13);
      const text = document.createElement('p');
      text.textContent = item.v && typeof item.v.text === 'string' ? item.v.text : '';
      li.append(who, text);
      if (item.author === me.identity.pub || mod) {
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = item.author === me.identity.pub ? 'Delete' : 'Remove';
        del.onclick = () => mw.db.tombstone(item.h).catch((err) => { note.textContent = explain(err); });
        li.append(del);
      }
      return li;
    }));
    form.hidden = snap.role === 'reader';
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    const text = form.elements.text.value.trim();
    if (!text) return;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await mw.db.append(LIST, { text }, {
        onProgress: ({ hashes }) => { note.textContent = 'Signing (' + hashes.toLocaleString() + ' tries)...'; },
      });
      form.reset();
      note.textContent = 'Posted. Other visitors see it as their copies sync.';
    } catch (err) {
      note.textContent = explain(err);
    } finally {
      button.disabled = false;
    }
  };
</script>
```

- Tell visitors before they post: "Everything you post here is public and copied to every visitor."
- Names come from `identity.setName` and prove nothing; the short id beside them tells keys apart.
- Moving from WordPress: `publish --from-wxr <export.xml>` imports approved comments as static JSON
  files (`comments/<slug>.json`) without email or IP addresses, and prints what it dropped. Render those
  as static text and take new comments on the ledger.
- The complete, tested version of this pattern is [examples/peer-guestbook/](../examples/peer-guestbook/).

### Reactions: one per author per target

Publish with `--policy open`. Each reaction is an item; the latest item of each author for a target
counts, and `r: null` takes it back.

```js
import mw from '/_mw/sdk.js';
const me = await mw.ready();
const ALLOWED = ['+1', 'heart', 'idea'];

export function react(target, r) {                 // r: one of ALLOWED, or null to take it back
  return mw.db.append('reactions', { to: target, r });
}

export function tally(snap, target) {
  const latest = new Map();                        // author -> reaction
  for (const item of snap.lists.reactions || []) { // oldest first, so later items win
    const v = item.v;
    if (v && v.to === target && (v.r === null || ALLOWED.includes(v.r))) latest.set(item.author, v.r);
  }
  const counts = {};
  for (const r of latest.values()) if (r !== null) counts[r] = (counts[r] || 0) + 1;
  return { counts, mine: latest.get(me.identity.pub) ?? null };
}

// mw.db.subscribe((snap) => showCounts(tally(snap, postHash)));
```

- A count is a count of identities (browsers), not of people: label it "reactions", never "people".
- Every change is an entry of roughly 570 to 1,039 bytes; 8 MiB holds about 8,000 to 14,700 of them
  ([research/MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), section 8). On a busy site, raise the cap
  or keep reactions for important items.
- Ignore values you didn't define (`ALLOWED`): anyone can write anything into an open list.

### Polls

A moderator defines the poll in a `_` key; visitors vote in a list; the latest vote per author counts.

```js
import mw from '/_mw/sdk.js';
const me = await mw.ready();

// A moderator, from an admin page (shell mode, moderator key imported in the loader's Settings):
await mw.db.set('_poll:lunch', { q: 'Where do we eat on Friday?', options: ['Ramen', 'Tacos', 'Salad'], open: true });

// Every visitor:
export const vote = (pollId, option) => mw.db.append('vote:' + pollId, { o: option });

export function results(snap, pollId) {
  const poll = snap.kv['_poll:' + pollId];
  if (!poll || !Array.isArray(poll.options)) return null;
  const latest = new Map();
  for (const item of snap.lists['vote:' + pollId] || []) {
    const o = item.v && item.v.o;
    if (Number.isInteger(o) && o >= 0 && o < poll.options.length) latest.set(item.author, o);
  }
  const counts = poll.options.map(() => 0);
  for (const o of latest.values()) counts[o] += 1;
  return { poll, counts, mine: latest.has(me.identity.pub) ? latest.get(me.identity.pub) : null };
}
```

- To close a poll, the moderator writes `open: false`; your page stops offering the vote button. Votes
  from visitors who were offline can still arrive later and count. To freeze the result, the moderator
  also writes it into the key (`{ ..., open: false, final: [12, 30, 7] }`) and the page shows that.
- One vote per identity, and identities are free: a poll on an open ledger is an opinion sample, not an
  election. For members only, publish with `--policy allow`.

### Profiles

The display name is built in. Richer profiles go in a list, latest item per author.

```js
import mw from '/_mw/sdk.js';
const me = await mw.ready();

await mw.identity.setName('Ada');                                   // shown as snapshot.profiles[pub]
await mw.db.append('profile', { bio: 'I run the Tuesday group.', site: 'https://ada.example' });

export function profileOf(snap, pub) {
  let latest = null;
  for (const item of snap.lists.profile || []) if (item.author === pub) latest = item.v;
  const site = latest && typeof latest.site === 'string' && latest.site.startsWith('https://') ? latest.site : null;
  return { name: snap.profiles[pub] || null, bio: latest && typeof latest.bio === 'string' ? latest.bio.slice(0, 280) : '', site };
}
```

- A profile is public and permanent. Ask for a handle and a short bio, never a real name, an email
  address, a phone number or a photo of a person.
- Render links with `rel="ugc nofollow noopener"` and only `https:` URLs.

### Feature flags and owner notices in `_` keys

```js
import mw from '/_mw/sdk.js';
await mw.ready();

const banner = document.querySelector('#banner');
mw.db.subscribe((snap) => {
  const flags = snap.kv._flags || {};
  banner.hidden = typeof flags.banner !== 'string';
  banner.textContent = flags.banner || '';
  document.body.classList.toggle('new-editor', flags.newEditor === true);
});

// A moderator, from an admin page:
await mw.db.set('_flags', { banner: 'Read-only on Sunday for maintenance.', newEditor: false });
```

- Only the owner and moderators can write `_` names; everyone else gets `E_NOT_MODERATOR`.
- A flag reaches a visitor only when their copy syncs (or on their next load, from your snapshot). It is
  not a kill switch: for anything urgent, publish a new version, a withdrawal or the kill switch
  ([RUNBOOK.md](RUNBOOK.md), section 11).
- Moderators write from a browser in shell mode (Settings, "Import moderator key"). The drop-in panel has
  no moderator import yet, so on a drop-in site `_` names cannot be written from a browser in 0.3.0.

### A task list with edits

For a public board, keep each task as an item and each change as a revision that names it; the task's
author and moderators may edit it.

```js
import mw from '/_mw/sdk.js';
const me = await mw.ready();

export const addTask = (title) => mw.db.append('tasks', { title });
export const editTask = (task, change) => mw.db.append('task-edits', { of: task.h, ...change });   // { title } or { done }
export const removeTask = (task) => mw.db.tombstone(task.h);                                       // author or moderator

export function tasks(snap) {
  const mods = new Set(snap.policy.moderators);
  const byH = new Map();
  for (const t of snap.lists.tasks || []) {
    byH.set(t.h, { h: t.h, author: t.author, title: String(t.v && t.v.title || ''), done: false });
  }
  for (const e of snap.lists['task-edits'] || []) {               // oldest first: later edits win
    const task = byH.get(e.v && e.v.of);
    if (!task || (e.author !== task.author && !mods.has(e.author))) continue;   // only the author or a moderator
    if (typeof e.v.title === 'string') task.title = e.v.title;
    if (typeof e.v.done === 'boolean') task.done = e.v.done;
  }
  return Array.from(byH.values());
}
```

- A removed task disappears with its edits (they point at a hash nobody lists any more).
- For a small team that trusts each other, publish with `--policy allow --allow <key>...` and keep each
  task under its own key (`task:<id>` set to `{ title, done }`): anyone on the list may change any task,
  and the last write wins.

### Drafts that stay on this device

Unfinished text belongs in the browser, not on the ledger.

```js
const KEY = 'draft:' + location.pathname;
const area = document.querySelector('textarea');
const read = () => { try { return localStorage.getItem(KEY); } catch (_) { return null; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch (_) { /* private mode, full disk */ } };

area.value = read() || '';
area.addEventListener('input', () => write(area.value));
// after a successful append: try { localStorage.removeItem(KEY); } catch (_) {}
```

- Local storage works in both modes (the site runs on its own origin). Safari may clear it after 7 days
  without a visit.
- The loader keeps its own data in IndexedDB databases named `mw-sites` and `mw-chain-...` on the same
  origin. Don't open, delete or clear them, and don't clear the origin's storage from your code: the
  visitor would lose their copy and their posting identity.

## Anti-patterns

| Don't | Why | Instead |
|---|---|---|
| store secrets, tokens or API keys | every value is public and copied to every visitor | keep them on a server, or in the build environment only |
| store personal data, even encrypted | permanent, replicated, and erasure reaches only the copies that sync | a form relay or `mailto:`; a handle instead of a name |
| put user content in key or list names | names are never erased, not even by a tombstone | use fixed names or hashes; put content in values |
| use a key for per-user data | anyone allowed can overwrite it, and readers can't see who wrote it | a list, latest item per author |
| write at high rates (telemetry, typing indicators, chat) | 20 writes a minute per page, 30 entries per identity per 10 minutes, and every entry is stored by every visitor | batch into fewer values; count with tracker scrapes or not at all |
| store large payloads | 2 KiB per value, 8 MiB for the whole ledger | put files in the site and publish a new version; store a path or hash in the ledger |
| sort or decide by `ts` | it is the author's claim | ledger order, or your own fields |
| count identities as people | a new identity costs nothing | say "reactions" or "votes", and use `--policy allow` when it matters |
| expect one value everywhere at once | there's no finality | show "as of what this browser has received" |
| poll `db.list` in a loop | wasted work, and it misses nothing that `subscribe` would catch | `db.subscribe` |
| trust `v` because it was signed | a signature proves the key, not the content | validate shape and length, render as text |

## Testing locally

```sh
npm run demo -- --site ./my-site --name my-site
```

The demo publishes your folder with `--policy open --bits 16`, starts a local tracker, the dev server and the identity
page (`http://localhost:8081/`, where a write signs in first), and prints `http://localhost:8080/`. Open it in two
different browsers (or a normal and a private window):
two tabs of one browser profile share one identity and one engine, so they are one visitor. Post in one,
watch it arrive in the other, then check the ledger line: after one post it reads "Ledger: 2 entries, in
sync with 1 peer" (the genesis entry and the post). The folder has a ledger of its own in the demo (a chain label
the demo keeps in `.tools/demo/sites.json`), so posts from the guestbook demo don't show up here; running the same
folder again keeps its posts.

- The loader's Settings (shell mode) has "Export ledger JSON": inspect it, or run
  `node tools/ledger-admin.mjs show --file <export.json>` on it.
- To try moderation, run the pieces the demo runs yourself (after `npm run build`), with a moderator named
  in the policy, in three terminals; every address stays on this computer:

  ```sh
  mkdir -p .tools/local
  node tools/keygen.mjs --out .tools/local/owner.jwk
  node tools/keygen.mjs --out .tools/local/mod.jwk     # its owner= line is the moderator's public key
  node tools/publish.mjs ./my-site --name my-site --scope localhost --key .tools/local/owner.jwk \
    --policy open --bits 16 --moderator p256:<the moderator key> \
    --ws http://localhost:8080/ws/ --cs http://localhost:8080/ws/genesis.json --tr ws://localhost:8000 \
    --exp 30 --out .tools/local/publish
  node tools/tracker.mjs --port 8000 --allow .tools/local/publish/summary.json
  node tools/dev-server.mjs --root dist --webseed .tools/local/publish \
    --pointer @.tools/local/publish/pointer.txt --dev --port 8080
  ```

  Open `http://localhost:8080/`, then paste the contents of `.tools/local/mod.jwk` into Settings, "Import
  moderator key". `.tools/` is ignored by git, and the keys never leave this computer.
- `test/example/mock-sdk.js` stands in for `/_mw/sdk.js` in UI tests without a loader.
- `node test/e2e/run.mjs --only 1,2,3,4` runs the guestbook end to end: render, a post from a second
  visitor reaching the first, a reload from the device copy, and a moderator removal from a browser that
  never held the owner key. Every browser it starts stays on 127.0.0.1 ([DEV-NETWORK.md](DEV-NETWORK.md)).

## Moderation workflow

1. **Before launch.** Name at least one moderator (`--moderator`), publish `--ct` (who answers notices)
   and `--lg` (your privacy and terms page), and write down who moderates and how fast
   ([DEPLOY.md](DEPLOY.md), "Owner duties"; [OPERATIONS.md](OPERATIONS.md)).
2. **In the browser (shell mode).** Each moderator imports their key in the loader's Settings ("Import
   moderator key"). Your site shows "Remove" (`mw.db.tombstone`) and "Ban author" (`mw.mod.ban`) when
   `snapshot.role` is `moderator`. The example guestbook does exactly this.
3. **Offline, with the owner key** (drop-in sites, or when no moderator is around): export the ledger,
   find the entry's hash, sign the removal, publish a snapshot.

```sh
node tools/snapshot.mjs https://example.com/ --remote --plain --out ledger.json
node -e 'for (const b of JSON.parse(require("fs").readFileSync("ledger.json", "utf8"))) if (b.e.op.t === "append" && b.e.op.l === "guestbook") console.log(b.h, b.e.author.slice(0, 13), JSON.stringify(b.v))'
node tools/ledger-admin.mjs tombstone --key ~/keys/my-site-owner.jwk --file ledger.json --h <hash>
node tools/ledger-admin.mjs ban --key ~/keys/my-site-owner.jwk --file ledger.json --author p256:<key>
node tools/snapshot.mjs ledger.json --plain --out genesis.json     # then upload it to the cs= URL
```

```text
appended tombstone block cbd1e6faa6708792e7b44c5538c86a0d62a4b75298a2a24978dbb1277dddceb6 to ledger.json
...
state    writers=open, 1 list(s), 0 key(s), 1 tombstoned, 1 value(s) removed from the file
```

4. **Under attack.** Raise the fee (`ledger-admin policy --bits 18`), switch to `--writers allow` or
   `owner`, ban the keys, and refresh the snapshot. A removal reaches visitors as they sync or load the
   snapshot; it can't reach a device that stays offline.

A ban lasts until someone lifts it: a moderator with `mw.mod.unban(pub)` (a UI method, so the loader shows its card;
an owner's ban only the owner lifts), or the owner with `ledger-admin unban --author <pub>` and a new snapshot. A ban
can also end by itself: `ledger-admin ban --until <date>` or `mw.mod.ban(pub, { until })` governs only the entries
written before that time. An unban doesn't bring back the values a ban dropped, and a ban doesn't stop a person from
making a new identity. The notice-and-action process (logging, deadlines, replies) is in
[OPERATIONS.md](OPERATIONS.md).

## Changing your schema

You can't rewrite entries that exist: every copy keeps them. Plan for old and new shapes side by side.

- Put a version in values that may change: `{ s: 2, text, lang }`. Readers accept every version they
  know and skip what they don't.
- For a breaking change, start a new list or key (`comments.v2`) and stop writing the old one. Readers can
  show both during the switch.
- The ledger id stays the same across every publish into the same `--out` (same owner key, same hostname
  or `--chain`), so a new site version keeps its data. A key rotation keeps it too: publish with
  `--prev-key <old key>`, and the pointer names the ledger's original owner (`lo=`).
- `--new-genesis` or a new hostname without `--chain` starts an empty ledger. The old one stays readable
  only through an old copy or an old snapshot.

## Export and backup

Browser storage is a cache, not a backup. Keep a copy of the ledger where you control it.

| How | Command | Notes |
|---|---|---|
| From the loader | Settings, "Export ledger JSON" | shell mode; a JSON array of entries |
| From the live site | `node tools/snapshot.mjs https://example.com/ --remote --out snapshot.json.gz` | opens the site in a local Playwright Chromium like a visitor, waits for the ledger to sync and reads it; contacts the internet |
| From a pin node | `node tools/pin.mjs https://example.com/ --headless --snapshot snapshot.json.gz` | keeps a browser open and writes snapshots on a schedule (`--snapshot-every <seconds>`) |
| From a file | `node tools/snapshot.mjs ledger.json --out snapshot.json.gz` | validates every entry and leaves out removed values |

Upload the snapshot to the URL in the pointer's `cs=` (`publish --cs`; in drop-in mode a relative path such
as `/ledger/genesis.json` works). Loaders fetch it after the page renders and add the entries they lack,
so first visitors start from it when nobody else is online. Refresh it on a schedule, for example from the
CI job that checks your site ([DEPLOY.md](DEPLOY.md)). A snapshot can only add entries that pass every
check (hash, signature, fee, value hash). A snapshot written after a removal leaves the value out, and a
copy that holds the tombstone never takes the value back, even from an older snapshot.

Snapshots are gzip by default and plain JSON with `--plain`. Loaders read both: they recognise gzip by its
first two bytes, also on Safari 15.4 to 16.3, which lack `DecompressionStream`. Use `--plain` when the file
name ends in `.json`, so that nobody mistakes it for a broken file.

## Where to go next

- [SDK.md](SDK.md): every method, event and error code.
- [examples/peer-guestbook/](../examples/peer-guestbook/): a complete, tested site with posts, names,
  moderation and the owner notice.
- [QUICKSTART.md](QUICKSTART.md): publish and deploy a site.
- [SECURITY-MODEL.md](SECURITY-MODEL.md) and [PRIVACY.md](PRIVACY.md): what the ledger protects, and who
  receives what.
