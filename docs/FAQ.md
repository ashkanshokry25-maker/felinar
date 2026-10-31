# Frequently asked questions

Short, honest answers, each with a link to the long one. If your question isn't here, ask in the
repository's Discussions ([ONBOARDING.md](ONBOARDING.md), "Support").

## The idea

### What is felinar, in one paragraph?

A small loader that your HTTPS static host serves. It reads a signed pointer to your site's torrent,
downloads the site's files by infohash over WebTorrent from your host and from other visitors, checks
every piece, and serves the files at your site's own URLs through a Service Worker. Shared data (a
guestbook, comments, polls) lives in the site ledger: a signed, hash-linked log that every visitor copies
and verifies. No mining, no consensus, no finality. The long version is [WHY.md](WHY.md); the
specification is [ARCHITECTURE.md](ARCHITECTURE.md).

### Do I need a server?

Not a backend: there's no application server or database for you to run. You still need an HTTPS static
host, which serves the loader on every visit and keeps the site loading when nobody else is online.
Visitors find each other through WebSocket trackers and STUN servers, public ones or your own. If you
publish the pointer in DNS, a DNS-over-HTTPS service reads it for the browser, and once a visitor chooses to share, a
shell page asks a DNS-over-HTTPS service for a newer pointer whether or not you publish one. You don't need a domain to
start either ([below](#starting-without-a-domain-v03)).

### Is the site ledger a cryptocurrency chain?

No. It is hash-linked and signed, but it has no global agreement, no finality and no mining. The small
proof-of-work on each post is a spam fee, not security. Two visitors can briefly see different states and
catch up when they connect, and the log is reachable only while someone with a copy is online, so your
host's snapshot and a pinned node are the floor. The README's "What it is not" list and its paragraph on
why it isn't one explain the choice ([README](../README.md)).

### Is it production-ready?

Not yet. Version 0.3.0 is a pre-release (0.2.1 was never published): every automated
suite passes on one development machine, loopback only (the counts are in [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md)),
but the release gate on real phones and browsers has not run ([DEMO-RESULTS.md](DEMO-RESULTS.md)). The review round of
the v0.3 design review ran from 2026-10-22 to 2026-10-24. Start with a pilot ([ONBOARDING.md](ONBOARDING.md)).

### What does it cost to run?

Your static host and its egress, which is often a free tier (GitHub Pages, Cloudflare Pages), plus, if you
want them, a small machine for your own tracker and a pin node. Nothing grows per visitor except host
egress. Drop-in mode can raise that egress: each visitor on an unmetered network downloads the whole copy
of your non-HTML files once (in a model, arithmetic rather than a measurement, a 20 MB copy completed after a 1.5 MB
page view costs 13.3 times that view), and `publish --dropin` prints
the figure for your site ([WHY.md](WHY.md), "Honest economics").

### Will peers cut my bandwidth bill?

Rarely, for small sites. In the research model a site under about 16 MiB gets about 0% of its first-load
bytes from peers at any audience size; a 50 MiB site gets about 27% at 100,000 one-minute visits a day.
That is a model, not a measurement. Peers buy resilience, offline revisits and shared data, not a smaller
bill ([WHY.md](WHY.md), "Honest economics").

## Visitors

### Do visitors need to install anything?

No. Any browser at the floor works: Safari and iOS 15.4, Chromium 110 (Chrome, Edge, Samsung Internet,
Brave, Android WebView), Firefox 115.

### What do visitors see the first time?

The site starts loading from your host at once, and a card says "This site is delivered peer-to-peer."
with [Share and load] and [Load from host only]. Nothing connects to a tracker, a peer or a
DNS-over-HTTPS service before the visitor chooses. In shell mode the loader's status bar also shows the
pointer badge and the ledger line; in drop-in mode the card appears at the bottom of your page after 3
seconds on screen ([QUICKSTART.md](QUICKSTART.md), "What visitors see").

### Who can see a visitor's IP address?

Your host and web seed see it on every visit, as with any website. After "Share and load", other visitors,
the trackers and the STUN servers see it too, together with the fact that the visitor is viewing your
site, and anyone who knows the site's infohash can join and see who is online. A shell page on a public
hostname then also asks a DNS-over-HTTPS resolver for a newer pointer, whether or not you publish one in DNS,
and the resolver sees the visitor's IP address and the site's name; drop-in pages never query DNS
([PRIVACY.md](PRIVACY.md)).

### Is there a private or anonymous mode?

No. Anonymity is not a goal of this design ([ROADMAP.md](ROADMAP.md), "Not planned"). "Load from host
only" avoids every peer connection, and the site then loads like an ordinary website. (0.3.0 adds a plain statement
of what identities are and are not: [see below](#is-it-anonymous).)

### What happens on mobile data?

Phones mostly download. A phone passes on other people's items (the Keep and Echo lanes) only after the visitor turns
on "Share on this network" for that site or starts dock mode, and never on mobile data. A file the visitor uploads
from a phone is sent after the upload card, at up to 128 KiB/s on mobile data and up to 1 MiB/s on Wi-Fi while
charging ([ARCHITECTURE.md](ARCHITECTURE.md), 8.1.3, chosen). A shell site on a phone must fit 48 MiB on Wi-Fi and
24 MiB elsewhere. In drop-in mode a phone on mobile data or Save-Data fills its copy from peers only, never
from your host. iOS stops peer connections within seconds of switching apps or locking the screen
([ARCHITECTURE.md](ARCHITECTURE.md), section 8).

### Does it use my visitors' bandwidth and battery?

Only after they choose "Share and load", and only while the page is open. Sharing runs in three lanes: the
visitor's own new items (H), items they chose to keep (K) and items their browser passes on after opening them (E).
A desktop on an unmetered network sends up to 1 MiB/s on H, 1 MiB/s on K and 256 KiB/s on E, so up to 2.25 MiB/s
when all three are busy (arithmetic). The month caps count K and E only: 20,000,000,000 bytes on a desktop and at
most 1 GiB on a phone, which also has a session cap and keeps K and E off as above. A hidden tab on battery stops after
10 minutes, and a phone stops uploading as soon as the page is hidden. Visitors can turn sharing off or choose host
only in Settings at any time. The full table is in [ARCHITECTURE.md](ARCHITECTURE.md), 8.1.3 (chosen).

### Does the site work without JavaScript?

In drop-in mode, yes: your host serves your HTML exactly as before, and the end-to-end tests check that
pages look the same with JavaScript off. In shell mode, no: every URL answers with the loader, which needs
JavaScript.

### Which browsers work?

The floor is Safari and iOS 15.4, Chromium 110 and Firefox 115 ESR; the loader polyfills what WebTorrent
needs. So far everything was tested in Playwright Chromium and WebKit on one machine. Firefox, Safari
itself and real phones wait for the release gate ([COMPATIBILITY.md](COMPATIBILITY.md)). On an older
browser the loader says what is missing, and drop-in pages keep working from your host.

### What about Lockdown Mode and in-app browsers?

Without a Service Worker (Lockdown Mode, many in-app browsers, Firefox private windows before version
140), the loader renders the site in limited mode: no offline copy, and the site's own scripts can't fetch
its files by relative URL. Without WebRTC, the loader runs "Host only, not sharing": the site loads from
your host and shared data won't sync. In Lockdown Mode it suggests "Turn off Lockdown Mode for this
website".

### Does the site work offline?

For returning visitors in shell mode, yes: the browser keeps a verified copy and the Service Worker serves
the whole site from it. On iPhone that lasts until Safari clears it, after 7 days without a visit (a Home
Screen app keeps its own copy). In drop-in mode, pages already visited render offline and other URLs get
an offline page. A first visit always needs the network.

## Publishing and operating

### What happens when nobody else is online?

With `ws=` and `xs=` in the pointer (`publish --ws` adds both), the site loads from your host's web seed.
The ledger loads from your snapshot (`cs=`) as of when you wrote it; new posts reach other visitors only
while two of them are online together, or through a pin node. Without `ws=` and `xs=` the loader says "This
link has no web seed or torrent URL. It only loads while another visitor is online."

### What happens when my host is down?

New visitors can't load the site: the loader itself comes from your host. Returning shell visitors keep
their verified copy and the version they last had. Drop-in visitors can open the pages they already
visited. Your host is the floor of availability, and peers are a bonus on top of it.

### How do updates reach visitors?

Publish again into the same output directory (same files give the same infohash; the new pointer gets a
higher `seq`), upload the files first, then switch the pointer. Shell visitors see "Update available:
reload" and stop sharing the old version at once; drop-in visitors get the new version on their next page
view. Keep the previous version's files for 7 days. Pointers expire after 90 days by default, so publish
again at least that often ([QUICKSTART.md](QUICKSTART.md), "Keep it running").

### How do I take something down?

- A file or page: publish a version without it. Visitors delete the old copy on their next load.
- A post: tombstone it ([CRUD.md](CRUD.md), "Delete").
- The whole site: `node tools/publish.mjs --withdraw --scope example.com --key owner.jwk --why "<reason>"`
  and deploy the record wherever the pointer lives. Loaders stop sharing the site, delete every stored
  version and show your reason.
- The Service Worker itself: the kill switch ([RUNBOOK.md](RUNBOOK.md), section 11).

None of these reaches a device that stays offline or software that ignores the signals.

### What if I lose the owner key, or it's stolen?

Lost: you can't sign new pointers, withdrawals or ledger changes. The last pointer works until it expires.
A new key shows returning visitors "publisher key changed" with both fingerprints, and the ledger starts
over, because keeping it needs the old key (`publish --prev-key`). Keep two offline backups. Stolen:
secure your host and DNS first, then rotate to a new key with `--prev-key` and hand the ledger over with
`tools/ledger-admin.mjs owner` ([OPERATIONS.md](OPERATIONS.md), "The owner key is lost" and "The owner
key is stolen").

### Do I need the DNS TXT record?

No. The pointer is a `<meta>` tag in the shell's `index.html`, or in every page in drop-in mode. A TXT
record at `_magnet.<your host>` is an optional second update channel for shell mode, which the loader
reads over DNS-over-HTTPS after the visitor chose "Share and load". The loader asks whether or not you publish a
record, so skipping the record does not remove the lookup. Drop-in pages never read DNS
([QUICKSTART.md](QUICKSTART.md), step A6).

### Can I run my own tracker?

Yes, and you should for production, next to two public ones. `node tools/tracker.mjs --allow
dist-publish/summary.json` serves only your site and its ledger swarm (it refuses to start without
`--allow` unless you pass `--open`). `deploy/tracker/` has a Docker Compose file with Caddy for `wss://`.
List it in the pointer with `--tr` ([DEPLOY.md](DEPLOY.md)).

### Should I use a hub or my own domain?

Your own domain, in shell or drop-in mode, for your own sites. A hub opens many publishers' sites by
magnet link; a production hub gives each site its own origin (`https://<label>.<hub>/`) and needs a
wildcard certificate, a Public Suffix List entry and an abuse process, and that operating layer is still
on the roadmap. A shared-origin hub never isolates sites: they can read and change each other's data, so
it is for demos and a single publisher only ([DEPLOY.md](DEPLOY.md), "Hubs").

### Can it be blocked?

Yes, in several places. The loader comes from your host and your DNS: block either and new visitors
can't load the site at that address. A network can block the public trackers or WebRTC, and visitors then load from your
host without peers. A DNS-over-HTTPS resolver can be blocked; the page tag still works. Peers make
returning visitors less dependent on your host; they don't make a site impossible to block or take down.
Other addresses (doors) help in the cases the next answer lists, and only in those.

### My domain is blocked: what now?

A link names one address. When that address is blocked or down, someone who never opened your site sees the
browser's own error page: none of our code runs, so the link can't try another address by itself. What helps:

- **Send links to other doors.** A door is any host that serves the loader: another domain, at another provider, in
  another country. `publish --door <host>` signs your site's record for every door at once and writes a card with the
  main link, two fallback links and a QR code ([DEPLOY.md, "Doors"](DEPLOY.md#doors)). Send more than one.
- **People who opened the site before keep it.** Their browser serves its copy from the offline engine while your
  address is blocked, and the page says where else you list the site: "This address is not answering. The owner
  lists: ...". One click opens it there. Nothing switches by itself.
- **At someone else's door the site runs in a limited view.** It can't store anything there, it has no offline
  engine there, and a visitor's identity lasts for that visit only. Your own addresses (`--org`) give the full site.
- **An installed door app** on desktop Chrome or Edge opens `web+felinar:` links. Phones and Safari ignore them.

What doors can't do: they don't beat a whitelist or a shutdown (at least one door has to be reachable), a signed list
of doors can't reach someone who never loaded the site or recall a link already shared, and nobody can tell a good door
from a hostile one on the first visit, because a hostile door can serve a hostile loader. A door sees a visitor's IP
address and the time, not which site (the part of the link after `#` stays in the browser), and anyone watching the
network still sees which door a visitor contacts.

### Does it hurt SEO?

Drop-in mode doesn't change what crawlers see: your host serves the same HTML, and the loader's own
interface is marked `data-nosnippet`. Shell mode does: crawlers that don't run the loader see only the
loader page for every URL, so keep pages that must be indexed or previewed in drop-in mode
([MIGRATION.md](MIGRATION.md)).

### Which frameworks and hosts work?

Anything that builds static files served from the root of an origin. In the research, real builds of 10
site generators (24 variants) rendered, navigated and deep-linked under the shell's same-URL serving in
24 of 24 Chromium runs ([research/MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), verdict 1).
History-API routers work in both modes. Hosts: GitHub Pages, Cloudflare Pages, Netlify, Vercel, S3 behind
CloudFront. Per-tool and per-host notes: [COMPATIBILITY.md](COMPATIBILITY.md) and the [recipes](recipes/).

### How big can a site be?

A shell site downloads whole before it renders: at most 128 MiB on desktops, 48 MiB on phones on Wi-Fi
and 24 MiB on other phone networks. `publish` warns at 5,000 files and stops above 20,000, and refuses a
`.torrent` over 8 MiB. Hosts add their own limits (25 MiB per file on Cloudflare Pages). The ledger holds
8 MiB by default and at most 64 MiB, in values of 2 KiB.

### Can I keep my existing Service Worker?

Yes. felinar never registers over it. Add `importScripts('/_mw/sw-core.js')` as its first line (a module
worker uses `import '/_mw/sw-core.js'`) and `if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))`
at the top of its fetch handler. Without those two lines the ledger and sharing still run; only serving
files from the visitor's copy is off ([RUNBOOK.md](RUNBOOK.md), section 10).

### What are my legal duties?

You publish the site, and with open writing you also distribute what visitors post: "With open writing,
every visitor stores and passes on posts by strangers. You moderate what your site makes visitors
redistribute." Put an abuse and legal contact in the pointer (`--ct`), link your privacy and terms page
(`--lg`), declare audiences that need the consent gate (`--aud`), and set up a notice-and-action process
([DEPLOY.md](DEPLOY.md), "Owner duties"; [OPERATIONS.md](OPERATIONS.md)). Where the laws apply to you, that also
means a privacy notice and an answer to a rights request within one month (30 days in Canada). If visitors can write,
message or share files: in the UK, the risk assessments of the Online Safety Act; in the EU, if the site is offered there,
a point of contact, a legal representative if you are outside the EU, and notice-and-action under the Digital Services
Act; in Canada, PIPEDA when your activity is commercial and Quebec's Act for an organized activity of any kind (a
person accountable, breach records and, in Quebec, French), and the Mandatory Reporting Act if you store other people's
files or posts for the public ([OPERATIONS.md](OPERATIONS.md#positions-by-jurisdiction)). Nothing in these documents is
legal advice, and no lawyer has reviewed them.

## Starting without a domain (v0.3)

> **Status: v0.3 C2, built and reviewed.** Built and integrated on 2026-10-20, in 0.3.0; these answers come from
> [SEEDING-AND-ZERO-SETUP-DESIGN](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), section 3.4, and its research
> ([S1](research/v03/S1-smart-phone-seeding.md), [S2](research/v03/S2-zero-setup-hosting.md)). No phone or rented server has been used yet
> (rows G-PS, G-ZS and G-CL of [DEMO-RESULTS.md](DEMO-RESULTS.md)).

### Can I start without a domain?

Yes. The site lives at its key, and domains are doors: publish with `--chain` and `--door <host>`, hand out the light
link or its QR code, and any door opens it, such as your free `<user>.github.io` site with a door kit or the loader on
your own computer ([DEPLOY.md](DEPLOY.md#doors-without-a-domain)); at a guest door the site runs in a limited view with an identity for that visit only, and a door kit needs the pinned release key. For a server of your own, rent a small one and run `npx felinar ship ./my-site --ip <its address> --to ssh://root@<its address> --ct mailto:you@example.org`:
the site is named after the server's IP address (`203-0-113-7.nip.io`), gets its HTTPS certificate by itself and costs nothing beyond the server.
Add `--dry-run` first to see every host and command. The other ways are a free static host such as GitHub Pages, and the demo on your own
computer or LAN ([QUICKSTART.md](QUICKSTART.md#start-without-a-domain)).

### What are the limits of a site without a domain?

The address record lives in the page and expires; after that date new visitors cannot load the site until you publish again. A name made from the
server's IP address changes with the IP, and visitors start again. nip.io is run by two volunteers with no uptime promise and blocks addresses used in
phishing. An identity page on a bare IP address offers no passkeys, only the passphrase card; identities still work there. Home connections behind carrier-grade NAT cannot be reached. Free hosts can close accounts; tunnels
see everything and rename every run, and the tools never start one ([DEPLOY.md](DEPLOY.md#zero-setup-a-server-without-a-domain)).

### What happens when the signed address record expires?

Returning visitors keep their saved copy and see "Pointer expired on" the date. New visitors can't load the site. `ship` signs for 399 days, the
longest `publish` allows, and prints the date; publish again, with the same command, before it. With a DNS record at your own domain the record is a
second update channel, which these names can't have ([QUICKSTART.md](QUICKSTART.md#keep-it-running)).

### Can I host from my home computer?

Only if the internet can reach it on ports 80 and 443. A router needs a port forward, some providers block port 80, and behind carrier-grade NAT
nothing can connect in, so Caddy can't get a certificate. Tailscale Funnel gives a stable name without inbound ports and is in beta; a quick tunnel
gets a new name on every run and its operator sees everything. A rented server is the simpler route.

### What can't a phone do for my site?

A phone stops sharing, passing on messages and keeping files available seconds after you leave the page or lock the screen (iPhone: about 20
seconds). No website can wake a phone to share: the background tasks browsers allow only make web requests. An iPhone gives web pages no background
sync, no battery or network information, and a notification for every push. Safari deletes a site's saved data after 7 days without use; a Home
Screen app keeps it. Android cuts the network of a phone that is unplugged, still and dark. So phones add availability while their pages are open;
durability needs a pin node ([DEPLOY.md](DEPLOY.md#pin-node)).

### Will my site stay available when nobody is online?

Not without a pin node or a copy on your host: nothing stays available while nobody who has it is online. Peers see your IP address, and sharing a
file shows which file you hold. That openness is the premise of the light web, not a setting ([PRIVACY.md](PRIVACY.md)).

### Do calls work?

Calls (v0.3 C2, in 0.3.0 and tested on loopback only) connect two signed-in contacts directly, or up to 6 people with audio and 4 with video; above that a mixing server is
needed, which v0.3 does not have. A call rings only while the person has the site open. On iPhone, call video stops when you leave the page, a
Home Screen app loses the microphone too, and a phone call pauses it; Android browsers can't share the screen. Without a relay, plan for 10% to
30% of pairs failing to connect (a planning range from vendor estimates, not a measurement). An owner can run a relay
([DEPLOY.md](DEPLOY.md#turn-off-by-default)), and it sees both IP addresses and how much is sent, never what is said.

## Data on the site ledger

### Can visitors post, and how do I stop spam?

Only if you publish with `--policy open` (anyone) or `--policy allow` (listed keys); the default lets
only you and your moderators write. Against spam you have the posting fee (16 bits by default),
moderators who remove posts and ban authors, the allow list, the size cap and per-identity limits (30
entries in 10 minutes). The fee slows scripts, not a determined attacker
([CRUD.md](CRUD.md), "Permissions").

### How does deleting a post work?

Its author, a moderator or the owner writes a tombstone, and every copy that receives it deletes the
post's text. The entry's header (the author's key, the minute it was written, the list's name) stays,
devices that never sync again keep the text, and anyone could have copied it. Treat posts as permanent,
and keep personal data out of them ([CRUD.md](CRUD.md), "Delete").

### Can I have private pages or members-only content?

No. Every file in the torrent and on your host is public to anyone with the address or the infohash, and
everything in the ledger is copied to every visitor. Encrypting pages at build time only puts them behind
a password, and the ciphertext stays public forever. Members-only content belongs on a server with
accounts. (0.3.0 adds private messages and private media between members, not private pages:
[see below](#who-can-read-my-messages).)

### Is anything encrypted?

In transit, yes: HTTPS to your host, secure WebSockets to the trackers, and WebRTC connections between
visitors, which are always encrypted. At rest, no: the site's files and the ledger are public by design
and stored as they are in visitors' browsers. Encrypting personal data doesn't make it safe to put on the
ledger ([CRUD.md](CRUD.md), the note on erasure). (0.3.0 adds encrypted messages, records, files and media, each
with conditions: [see below](#who-can-read-my-messages).)

### Why does posting take a moment?

Each post carries a small proof-of-work, a spam fee: 16 bits by default, which took 174 to 283 ms on a
desktop in the measurements. Phones haven't been measured. The owner and moderators pay no fee, and sites
should show progress ([SDK.md](SDK.md), "Writes and the posting fee").

### Can a visitor use the same identity on two devices?

Yes. In 0.3.0 the identity lives at the identity page, not in the site, and the identity page links a second device or
restores the identity from the 12 words or the backup file ([see below](#what-if-i-lose-my-phone-or-my-browser-clears-its-data));
neither the device link nor a restore from the 12 words has run end to end yet, and nothing has run on a real device. Tabs of one browser share one sign-in; two
browsers are two devices. Safari may delete a site's data after 7 days without a visit; the identity page keeps the
identity, and the person signs in again ([SDK.md](SDK.md), "The visitor's identity"). A build without the identity service
keeps the 0.2.1 export and import in Settings.

### How do I import existing comments?

From WordPress: `publish --from-wxr <export.xml>` writes the approved comments as static JSON files
(`comments/<slug>.json`) without email or IP addresses and lists what it dropped. Show those as static
text, and take new comments on the ledger ([CRUD.md](CRUD.md), the guestbook recipe).

## Identity, sign-in and private content (v0.3)

> **Status: v0.3, built and reviewed.** These answers describe v0.3 as designed in
> [review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md) (cited "R") and built in this tree: the code of 0.3.0. "Reviewed"
> means that the review round of R 5.3 ran (2026-10-22 to 2026-10-24); what it left open is in the CHANGELOG's known gaps. Every answer above stays true in 0.3.0 unless one here says otherwise. Numbers are labelled
> chosen, arithmetic or measured with their source in the pages linked.

### What is the identity page?

The one address where your identity lives. It is a static web page that opens in its own window when a site asks you to
sign in. It holds your root (the 12 words, wrapped by a passkey or a passphrase) and the keys you use on each site, and
it hands a site only that site's keys or a signed proof. By design, the project hosts no identity page (owner decision
N-2): run your own or use one you trust. A site names one with `publish --idp`, anyone can run their own, sites choose
which ones they accept, and a site whose visitors only read needs none
([DEPLOY.md](DEPLOY.md#the-identity-origin-running-your-own-with-toolsbuild-idpmjs)).

### Will a site ask me for my 12 words?

No. **felinar never asks for your 12 words on the site you are signing in to.** You see or type them only at the identity page. If a site,
a widget or a pop-up asks for them, it is not us, and anyone who types them into another page loses every identity.

### Will two sites know I am the same person?

Not by your key, unless you choose it. By default you have a different key on every site. A site that gets a signed
proof sees that key, your IP address and your browser's user agent. Two sites that compare their logs by IP address
and time can still link you, and so can a reused name or your writing style. If you choose to use the same identity as
on another site (the card names it), both sites will know it is you, and that cannot be undone once the site has seen
it. Sites cannot match you by key unless you choose to be recognised, and they can still match you by IP address, a
reused name or timing ([PRIVACY.md](PRIVACY.md#v03-identity-chat-files-and-private-media)).

### Is it anonymous?

No. Identities are pseudonymous by design: a key, not a person. Everyone your browser connects to sees your IP address,
and so do trackers, STUN servers and any relay. Host-only mode connects to nobody but the site's own host, so other
visitors see nothing of you, but chat, file sharing and private media do not work there, and the host still sees your
address. Tor Browser hides your address from the host and the connection servers for what it can carry, but it does not
run WebRTC (to be confirmed from a primary source), so there you can read and sign in but cannot connect to other
visitors. Nothing in felinar proves who you are, your age or that one key is one person. The full statement is in
[WHY.md](WHY.md#pseudonymous-not-anonymous).

### What if I lose my phone, or my browser clears its data?

- The **12 words** restore your public identity on every site. They do not open your older messages, records or media.
- The **backup file** (made at the identity page, protected by a passphrase it generates, and not to be emailed)
  restores everything.
- A **passkey** that your password manager syncs gets you back in on other devices where the provider supports it; the
  provider's own account recovery then becomes a way into your identity.
- On an iPhone, Safari may delete the identity page's data after 7 days without a visit there. A passkey identity
  comes back from the sealed copy a site you signed in to keeps; a passphrase identity comes back only from the 12
  words or the backup file. Adding a site to the Home Screen is not a way to keep the identity, because the identity
  lives at the identity page and not in the site. The identity page shows your recovery kit at sign-in until you save it.
- When a site's **identity page moves to another host name**, passkeys and the passkey copy a site keeps stay behind:
  a passkey belongs to the host name it was made at. The 12 words bring back your public identity at the new host and
  the backup file brings back everything, so make the backup file at your first sign-in when the identity page is on a
  free or short-term host. An identity page on an IP address offers no passkey at all, only the passphrase card
  ([DEPLOY.md](DEPLOY.md#hosting-it-without-buying-a-domain)).

If you forget an extra word that you set, nobody can restore the identity.

### Who can read my messages?

Messages are encrypted before they leave your device. Other visitors and anyone holding a copy of the ledger see only
ciphertext. Conversations are never written to the site ledger, and anyone connected can record the encrypted copies.
The site's own code can read your record while you are signed in, and the owner cannot read private messages from the
ledger or the swarm but can read them through the code visitors run. The people you write to can keep and forward what you
send. There is no forward secrecy: whoever later gets a recipient's chat key can open the envelopes they recorded. A
direct message is not provable to a third party; a group message is provable by any member, and a public room is
signed ([THREAT-MODEL.md](THREAT-MODEL.md), "Honest limits").

### Who can see my photos and videos?

Private photos and videos are encrypted in pieces before they enter the site's swarm, and they play in the page while
they stay encrypted there. Peers, trackers, pin nodes and the owner reading the ledger see only ciphertext, its padded
size and timing. You can see them after you sign in, and so can the people you share them with. The site's own code can
open them while you are signed in. People you share with can keep a copy, and revoking works in honest apps only.
Location and camera details are removed from images and from MP4, MOV and WebM files before they leave your device;
faces and backgrounds stay. A video plays only while someone who holds it is online, unless the hub keeps it ("Kept by
the site").

### Can I remove my data?

"Remove my private data on this site" hides your encrypted record from copies that sync and destroys the key for this
site, so remaining copies can no longer be opened by you or anyone who later gets your 12 words. A backup file made
before the removal, or an earlier copy of your identity that a site keeps for the identity page, still holds the key,
and restoring from it brings the key back. Copies on devices that never sync, and things other people kept, stay. A
deleted public post leaves a stub (who signed it and when) until the site owner writes a checkpoint. We say "hide from copies that sync" and "remove", never "erase" or "delete everywhere"
([PRIVACY.md](PRIVACY.md#your-rights-and-what-removal-reaches)).

### Why is there no global search, trending feed or ranked timeline?

Because they need an index over everyone's data, and the design has no backend to hold one. A chronological feed of the
people you follow works without a backend. The honest table of what needs an index, and what would close each gap, is in
[WHY.md](WHY.md#what-needs-no-backend-and-what-needs-an-index).

### What does a hub's pin cost, and what does it mean?

A hub that pins its members' ledgers and media runs central storage that it pays for and can be compelled to empty.
**(proposed)** Pinning each member's ledger window and media is not built: `tools/pin.mjs` keeps one site's copy and
ledger, writes that site's `cs=` snapshot, and holds at most 2 GiB of approved files in total (the default; `--max-total` changes it). The
reference price is US$0.015 per GB-month on R2 with free egress (list price, read 2026-10-17), and 100,000 members at
1 GiB each would come to about US$1,610 a month (arithmetic) once that is built
([DEPLOY.md](DEPLOY.md#central-storage-the-hub-pin-and-snapshot-service)). Items show "Kept by the hub" or "Available
only while someone who has it is online".

### Can I add "Sign in with felinar" to an existing site?

Yes, with a server that checks the proof: put the self-hosted `<mw-signin>` button on the page
([recipes/signin-widget.md](recipes/signin-widget.md)) and verify with `@felinar/verify` on a Node server
([recipes/signin-server-node.md](recipes/signin-server-node.md)). Bind a key to an existing account only after you
verified the contact data separately.

### Does chat need a relay (TURN)?

No relay is on by default, and chat does not need one. An owner can run one for calls (v0.3 C2) and later for direct channels, which are
not built. Option (a) is static credentials, allowed with quotas and a warning that the relay is open to anyone who loads the
site; option (b) is a credential endpoint, which is a backend and is labelled one ([DEPLOY.md](DEPLOY.md#turn-off-by-default)).

### How do I know the identity page is the real one?

Its address is printed on your recovery kit and shown by the browser's address bar. Your passkey works only at the
identity page's own host name, so a look-alike address cannot use it. Every card shows the page's build id and a hash
that each release will list once releases are published (none is yet). If you want no third party in that position,
run your own identity page.
It is the one central trust point the design adds: altered code there would take the roots of people who unlock
afterwards ([SECURITY-MODEL.md](SECURITY-MODEL.md)).

### Is chat safe for children?

This software cannot check anyone's age, and in 0.3.0 the age method setting (`_mw.cfg.age`) changes nothing: no
code reads it. Chat, uploads, message requests and presence are off until the owner turns them on, whatever the age
setting, and nothing stops an owner from turning them on. Visitors' profiles follow the ledger's writer policy: off
under the default `owner`, on once the owner allows other writers. Do not turn any of them on for a site that children
use unless you have an age method of your own and have completed an assessment ([PRIVACY.md](PRIVACY.md#defaults)).
In the US that is still not enough for children under 13: COPPA needs a parent's verifiable consent before you collect
their personal information, and this software cannot get it. In Quebec a child under 14 cannot consent alone (ss. 4.1
and 14 of the private-sector Act); elsewhere in Canada the OPC says a child under 13 cannot, except in exceptional
circumstances ([PRIVACY.md](PRIVACY.md#children)).

## Trust

### How do visitors know the site is really mine?

A first visit trusts your HTTPS host and your DNS, like any website. The pointer is signed with your owner
key; the loader remembers the key on the first visit ("First time on this device: the publisher key of
this site is remembered from now on.") and later refuses a pointer signed by another key unless the
visitor confirms. Whoever controls your host or your DNS controls what visitors run
([SECURITY-MODEL.md](SECURITY-MODEL.md)).

### Can another visitor tamper with my files?

No. Every piece is checked against the site's infohash before it is served or passed on, and a piece that
fails is refused and fetched again. That protects the files from other visitors, not from your host.

### Can someone else republish my site?

They can copy public files, and the same files with the same name give the same infohash. They can't sign
a pointer with your key, so visitors who remembered your key get a warning for a different one, and a copy
on another domain is a different site with its own, empty ledger.
