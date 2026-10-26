# A pin node for a hub: mailbox, file pin and quarantine

Run `tools/pin.mjs` as the always-on part of a hub: it keeps one site's copy and ledger (the URL you give it), writes that
site's `cs=` snapshot, and keeps files that a moderator approves for pinning, at most 2 GiB of them in all by
default (`--max-total <size>` changes it, pass it to `--approve` too, and `--mailbox-bytes` and `--mailbox-source-fraction`
size the mailbox: `tools/pin.mjs:89`, `:90`). An `--approve` made while the node runs is started within one status tick
(`startMissing`, `tools/pin.mjs:1463`, `:1514`), and the pin keeps each item's .torrent in its profile beside the bytes
(`pin-torrent-<infohash>`, `src/loader/app.js:4523`), so a restarted pin seeds with nobody else online. Keeping recent windows of members' ledgers and writing
a snapshot per member is **(proposed)**: the tool takes one URL and has no code that follows a hub's members. Holding encrypted messages for people who are offline (the pin mailbox) and taking
pin requests from members' pages are **(proposed)**: the node has the mailbox store and the request queue, but no
page sends it a mailbox frame or a signed pin request yet (code review v0.3, round 2). It is
central storage that you pay for, and it makes you a party that sees IP addresses, message tags, sizes and times. This
page says what to run, what it holds, what it sees, and how to quarantine a file without opening it.

| | |
|---|---|
| Roles | a hub operator or a site owner with chat or files turned on; not needed for a site with neither |
| Status | **v0.3, built and reviewed.** `tools/pin.mjs` keeps a site's copy and ledger open in Chromium and can write the `cs=` snapshot ([DEPLOY.md](../DEPLOY.md#pin-node)); the tools lane added the v0.3 parts below (unit-tested in `test/unit/tools-v03-pin*.test.mjs`). No end-to-end run of a hub pin with members has been made (the hub's recent-window first screen, E-SO-6, is not built), and where this page and the tool differ, `node tools/pin.mjs --help` is the reference |
| Cost | not measured. The design review gives a price reference for the storage side ([DEPLOY.md](../DEPLOY.md#central-storage-the-hub-pin-and-snapshot-service)); the disk a pinned file or mailbox needs, and the cost of a pinned site in Chromium, are unmeasured |

## What it holds, and what it sees

| It holds | In what form | For how long |
|---|---|---|
| The pinned site's ledger, and the snapshot behind its `cs=`; recent windows of members' ledgers are **(proposed)** | as the ledger carries them | as long as the hub keeps pinning |
| Mail for people who are offline (the pin mailbox, **(proposed)**: no page sends it frames yet) | sealed envelopes it cannot read | at most 7 days, 64 frames per tag and 4 MiB per holder (chosen, R 2.7.5); stranger mail is released only after a proof that the collector holds the chat key |
| Join requests for moderators (**(proposed)**, as the mailbox) | sealed items | up to 7 days (chosen, R 2.5.2) |
| Files members asked it to pin | public files in plain form; private files and media as ciphertext, with a padded size | until a moderator drops them or you quarantine them |

| It sees | Why it matters |
|---|---|
| IP addresses of everyone who deposits, collects, fetches or announces | a hub pin and mailbox is a stated recipient in the privacy notice ([PRIVACY.md](../PRIVACY.md#the-recipients-register-v03)) |
| Message tags, sizes and times | it can link the address that left a message to the address that collected it |
| The plaintext of public files it pins | you are the host of those files |
| The ciphertext, padded size, and fetch times of private files and media | never the content |

It cannot read direct messages, private records or private media. The loader the hub serves for every personal site is
a different question: it runs in visitors' browsers and can read what they can read, and a hostile hub could take a
personal site's owner key (R 3.3; [THREAT-MODEL.md](../THREAT-MODEL.md), "Honest limits").

## Run it

1. **Keep it apart.** A machine or container used for nothing else, a non-root user, a volume for its profile directory,
   no owner key on it (the pin node needs no key; `_mw.cfg.pin` names the node's own key, never yours), and no program
   on it that opens, previews or indexes the files it stores. [`deploy/pin/`](../../deploy/pin/README.md) has the image.
2. **Start it** with the snapshot options and the v0.3 flags:

   ```sh
   npx felinar pin https://hub.example/ --headless --profile /var/lib/mw-pin/hub.example \
     --snapshot /var/lib/mw-pin/ledger.json.gz --snapshot-every 600 \
     --mailbox --files
   ```

   `--mailbox` and `--files` are built and unit-tested, but no page sends mailbox frames or members' pin requests yet
   (proposed; [DEPLOY.md](../DEPLOY.md#pin-node)), so `--files` keeps what an operator enters at the node (`--queue`,
   `--approve`). Files are stored on disk in the profile directory, not in tab memory, so a restart keeps them (R 2.8.6).
3. **Tell the ledger where it is.** Set the pin in `_mw.cfg` (the node's key), as in "Owner settings" of
   [OPERATIONS.md](../OPERATIONS.md#owner-settings). Chat and file lanes also need your own tracker and STUN servers.
4. **Watch it** as any pin node ([OPERATIONS.md](../OPERATIONS.md)): its log, its disk, its peer count.

## Pin requests and the moderator queue

A member is meant to ask for a file to be pinned with `mw.media.pinRequest` or `mw.files.pinRequest` **(proposed)**: in this
release both answer `E_POLICY`, because no page-to-pin request path is built, and the node takes a request only with
its author's signature (`src/pin/frames.js` `makePinRequest`). Until then an operator enters requests at the node
(`--queue`, `--approve`). The request goes to a queue
that your moderators see: the name, the size, the author's key and the declared hash, and nothing else. Pinning is
a moderator action and is never automatic. The node fetches the file only after a moderator accepts it, and it never
opens or renders what it fetched (R 2.8.6, MF-50). A static copy for downloads can be put on plain hosting with
`tools/webseed-file.mjs`, which fills the optional `ws` field of the listing; for private media the copy is
ciphertext.

## Quarantine

When a report or a notice names a pinned file ([OPERATIONS.md](../OPERATIONS.md#the-file-lanes-what-to-block-what-to-preserve-whom-to-call)):

```sh
npx felinar pin --quarantine <infohash> --profile /var/lib/mw-pin/hub.example
```

This is the proposed form. The node moves the file to a quarantine folder apart from the pin store, stops seeding it, and writes a log line with
the time and the infohash. Then:

1. Write the `_deny/` entry in the same moderator step as the tombstone, so no node and no visitor fetches or seeds it
   again.
2. Copy the node's profile directory read-only to where your lawyer says or, if you have none, to a folder only you can
   read. Do not open the files in it, and do not
   forward them to anyone who is not entitled to receive them.
3. Keep the quarantine log and the report as you received them.

Nothing here scans a swarm or recognises near-duplicates; that needs a host that handles whole files, and is not part of
v0.3.

## Limits and known problems

- **It is a party, not a neutral pipe.** A hub pin and mailbox sees IP addresses, tags, sizes and times and can be
  compelled to hand over or empty what it holds. The privacy notice names it ([PRIVACY.md](../PRIVACY.md)).
- **Availability is yours to provide.** Without a pin on disk or a web seed, files have no durability, and the app says
  "Available only while someone who has it is online" on those items.
- **Phones.** Phone-class devices relay and hold nothing by default; the hub mailbox is the offline-delivery path for
  social hubs (R 2.7.5).
- **Unmeasured.** Disk use, memory of the Chromium profile, and the cost per pinned site have not been measured.
