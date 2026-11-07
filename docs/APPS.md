# Apps on the door page

> **Status: built, not yet reviewed (unreleased).** Written on 2026-11-01 for the code that adds the apps ([CHANGELOG](../CHANGELOG.md),
> "Unreleased"). Tested with unit tests on loopback (fakes, the real pairing core, and the Node tracker with real WebSocket clients), in
> two scripted Chromium runs on loopback, one with two visitors and one with a room of four, and, on 2026-11-02, in headless Chromium
> against the public tier: a rendezvous Worker on Cloudflare, a door and an identity page on Cloudflare Pages, harness only, and with one
> Android phone the same day: on home Wi-Fi at a lab door it signed in, accepted a knock and exchanged messages, and on mobile data (5G) at
> the demo door its direct link failed ([What was tested](#what-was-tested)). Not run: an iPhone, a real Safari, pairing in WebKit or Firefox,
> a screen reader, a direct link across two networks that connects. The new cryptographic code has had no outside review, and no
> lawyer has reviewed the privacy sentences ([PRIVACY](PRIVACY.md)). A review of the protocol and the privacy claims on 2026-11-02, which
> wrote 18 adversary tests (`test/unit/apps-adversary.test.mjs`), found one blocker and eight smaller defects; all are fixed, and what
> remains is under "Known limits". Treat the apps as a first build.
>
> **Messages now pass through the rendezvous (relay-first, unreleased).** After the accept, the sealed messages of a conversation or a room go through
> the door's rendezvous by default, and a direct link is something a door turns on ([Messages through the rendezvous](#messages-through-the-rendezvous)).
> This is built and tested on loopback with fakes, the real pairing core and the Node tracker. It has not run on a real network: the test on an office
> Wi-Fi, on mobile data, in Tor Browser and over a VPN is still to do, so this page says what the design does there and does not say that it works.

The bare door page of a door that offers apps shows "Apps" in place of the box that opens a link. People who sign in there for the visit
can message each other one to one, or meet in a small room, by a short code. The messages are sealed on the device (only the people in the
conversation can open them), pass through the door's rendezvous, which cannot read them, unless the door also turns on direct links, and are kept in
memory only, for as long as the page stays open. This page describes what the apps do, how to use them, what they leave out and why. The contracts
are in [ARCHITECTURE](ARCHITECTURE.md) 15.21 and [INTERFACES](INTERFACES.md); who sees what is in [PRIVACY](PRIVACY.md).

## What an owner gets

A door is any host that serves the loader ([DEPLOY](DEPLOY.md), "Doors"). Its bare door page is `/_mw/open.html` (and `/_mw/open` on a
host with clean URLs). When the door's `/_mw/door.json` carries an `apps` block, that page starts the apps. Without the block, or when the
block cannot be used, or when anything in the apps fails to start, or when the page was opened to receive a shared link, the page is the box
for pasting a link, as before.

The home shows six tiles:

| Tile | What it says | Works |
|---|---|---|
| Messages | "Direct messages with one person, by code" | after sign-in |
| Rooms | "A room for a few people, by code" | after sign-in |
| Calls | "Voice and video" | no: "Not yet at this door" |
| Files | "Send a file to someone you know" | no: "Not yet at this door" |
| Media | "Photos, audio and video" | no: "Not yet at this door" |
| Open a link | "Open a site from its link" | always: it opens the box that takes a light link |

Before sign-in the page says "Sign in to use the apps at this door." and Messages and Rooms show a lock and "Sign in first".

What you run for it, and what each piece does:

| Piece | What it does | Where it comes from |
|---|---|---|
| A rendezvous | Passes a request from the person who made a code to the person who typed it, hands out a private lane after the first approves, and, from then on, forwards the sealed messages of the two browsers on that lane (and, when direct links are on, introduces them like any tracker). It cannot read what it forwards, unless it records the boxes and guesses a code's secret offline ("Known limits") | the Worker in [`deploy/rtc-worker`](../deploy/rtc-worker/README.md) (Pairing and Relay), or `tools/tracker.mjs` |
| A STUN server | Only for a door that turns direct links on: lets two browsers on different networks find a path to each other. With none, browsers use host candidates only, which is enough on one machine or one network and does not reach between two homes. A door that keeps the default (direct links off) needs none | your own; the shared public ones are never a fallback |
| An identity origin | The page where the visitor signs in. A door gets a key for this visit only | [DEPLOY](DEPLOY.md), "The identity origin" |

By default the messages go through the rendezvous, so a conversation does not wait for the two browsers to find a path to each other; two
optional keys of the block, `relay` and `direct`, change that ([Messages through the rendezvous](#messages-through-the-rendezvous)). Turning
the apps on is three flags of `publish` (`--tracker`, `--stun`, `--idp`) or three of the dev server, and `--apps-relay` and `--apps-direct`
set the two keys; [DEPLOY](DEPLOY.md), "Apps at a door", has the block, the commands and the checks. Name the rendezvous in your privacy
notice ([PRIVACY](PRIVACY.md)).

What it costs: the apps are part of `_mw/loader.js`, so every page of every site that loads the loader carries them. Measured on
2026-11-02 with `node build.mjs`, on the commit this work is based on (f081737) and on the working tree, as the size of `dist/_mw/loader.js`
and of `gzip -9` of it: 1,204,463 bytes (388,968 gzipped) without the apps and 1,388,377 bytes (442,156 gzipped) with them, so 183,914
bytes more and 53,188 gzipped, 13.7 percent. The figures move a little with every edit. A separate file that only a door with apps loads is
a follow-up.

## Using the apps

The texts in quotation marks below are the ones the page shows in English; it has them in French too.

### Signing in

Press "Sign in". A sign-in card opens the identity page (the `idp` of the door's block); the door gets a key that lasts for this visit
only, and the identity page says "This address is shared by many sites, so you get an identity for this visit only." There is no site
ledger at a door, so there are no profile names: people appear as "Someone" with a short id, `xxxx-xxxx`, unless you give them a
nickname. After sign-in the header shows who you are and "Sign out", and the page says: "You are signed in for this visit only. Reloading
this page signs you out and ends your conversations."

Signing out, reloading and closing the page end everything: the codes, the conversations, the drafts, the snippets and the block list.
Nothing was written to the device.

### Messages

1. **Show your code.** The first time you open Messages, a card says "What this costs your privacy": "Codes and requests pass through this
   door's rendezvous. After the other person accepts, your messages pass through it too, sealed: the rendezvous and whoever hosts it see
   your network address, when you send and roughly how much, never what. The other person does not see your address." A door that turns direct
   links on adds a line: "This door also tries a direct link between you, which shows each side the other's network address." A door that
   sets `relay` to `none` shows the card as it was before messages passed through the rendezvous. On a door that sends usage reports the card adds a line that names their host ("What is stored, and what is seen"). "Continue" shows your code, like `abcd-efgh-2345`, with "Copy" and "New code". "Not now" leaves a "Show my
   code" button. A code works while this page is open, and for 24 hours at the most. Read it to the person you want to message.
2. **Or knock.** Under "Message someone" type "Their code" and press "Knock" (if you have not seen the card yet, it comes first). The
   request waits for their approval for 10 minutes. If no open code starts with the first four characters you typed, the page says "No one
   has this code right now. Check it and try again."
3. **Accept.** The owner sees "<name> (<short>) wants to message you" with "Accept" and "Reject". The accept card repeats the price and
   adds "Check: read your codes to each other." Until the owner accepts, the rendezvous has handed out nothing: no connection offer has
   moved, and neither person has learned the other's network address. Reject, or ignore the request, and nothing joins.
4. **Connect.** After the accept both browsers join the conversation's private lane at the rendezvous. The line under the name changes from
   "Connecting..." to "Connected through the rendezvous"; on a door that turns direct links on, it reads "Connected to you now" while a
   direct link is the way the messages go. The conversation shows "Compare: 1234 5678", eight digits derived from the keys of both
   people. Read them to each other by another route. "If they differ, do not trust this conversation."
5. **Write.** The composer sends with Enter (Shift+Enter makes a new line) or the button. While the other browser is not connected, the page
   says "Messages can wait here while the other side is away. The page has to stay open." A message that gets no answer in 20 seconds
   shows "Not sent" with "Try again", and goes again by itself when a connection returns.
6. **End.** "Leave conversation" tells the other person and removes the conversation (export it first to keep it). A person who left needs
   a new code to talk again.

The rendezvous serves the conversation's lane for 24 hours after the accept. A connection to the rendezvous that drops within that time is
made again by the page, which joins the lane again and sends what the other side did not confirm; after the 24 hours the lane is gone and you
need a new code. "Conversation tools" shows how the conversation travels now and the door's two keys ("Connection: through the rendezvous.
This door: relay: rendezvous, direct: off.").

**Disappearing messages are each person's own.** "Your messages disappear" sets the timer of what you write, and nothing else: the other
person's setting never changes what you write, and yours never changes what they write. Each message carries its author's timer, and the
author's timer wins: when it runs out the message goes from both screens, a copy that the reader pinned or saved too, and the reader sees
a "Disappears" mark on it from the start. A timer on a message you receive counts for at least 10 seconds, the shortest choice the page
offers. A settings frame from the other person whose time is more than 5 minutes from your clock is dropped.

A code is 12 letters and digits, shown in three groups of four, without 0, 1, l or o. You may type it with or without hyphens, in any case;
Persian and Arabic-Indic digits are folded to the digits a code uses. Anyone who knows the code can ask; only you decide. A person who
knows the first four characters can send wrong requests: after five requests that your page cannot open it closes the code and shows a new
one with the notice "Your code was replaced by a new one because several requests did not match it."

### Rooms

1. **Create a room.** "Create a room" gives a code, the way Messages does: "Each person who knocks needs your approval before anything
   connects." The accept card says the same as for Messages, in terms of members.
2. **Join a room.** Type the room code under "Join a room". The owner approves you; then you connect.
3. **Talk.** Everyone sees who is in the room ("Members (n)", with "owner" and "you") and each message with its sender. Messages are
   encrypted with a secret that the owner sends, sealed, to each accepted member. The list of members travels sealed under the same
   secret, so a connection to the room's lane that was never accepted sees boxes it cannot open: no name and no key. A message that
   arrives before the secret or the list waits up to 30 seconds and is shown when it can be checked.
4. **Leave.** A member who leaves just goes. When the owner leaves, the room closes for everyone ("Closed").

A room has up to 16 people, the owner included; one person can own up to 4 rooms at a time. A room message has up to 2,000 characters. The
rendezvous serves a room's lane for 24 hours from the moment the room is opened: after that nobody new can join, and a member whose connection
drops cannot get back. Rooms have text (with the same marks as Messages), the emoji picker, Enter to send, unread counters and a "New
messages" jump. They have no edits, deletions, reactions, receipts, typing marks or search, and no way to remove a member: the room secret
never changes, so a person who leaves still holds it. Make a new room instead.

### When something does not work

| You see | Why | What to do |
|---|---|---|
| "Connecting to this door..." | the page has not reached the rendezvous yet; it tries again after 1 second, then 2, 4, 8, 15 and every 30 seconds | wait, or check the door |
| "The connection to this door was lost. This page keeps trying." | the rendezvous socket dropped after it had been open | wait: a knock that was lost is made again, up to 3 times |
| "No one has this code right now. Check it and try again." | no open code starts with the first four characters, or the code is older than 24 hours | ask for the code again |
| "Waiting for approval" that does not end | the owner has not looked yet, or a typo in the last eight characters: the owner's page says nothing to a request it cannot open | after 10 minutes it shows "Rejected"; press "Cancel request" and check the code |
| "A code has twelve characters, letters and numbers, like abcd-efgh-2345." | the text is not a code | check the length |
| "Too many tries. Wait a minute and try again." | 10 requests a minute from this page, 8 waiting at once | wait |
| "Rejected" | the owner said no, closed the code or left, or the request ran out after 10 minutes | ask again |
| "Connecting..." for a long time after an accept | the other person's page has not joined the lane yet (closed, asleep or offline), or the page that replaced a lost connection met `lane full` while the rendezvous still holds the old one (up to 25 minutes), or the rendezvous is busy, off or out of reach. On a door that turns direct links on, a direct link may also be failing, which does not stop the messages through the rendezvous | wait, or ask the other person to keep the page open; the door's owner can look at the counts of the rendezvous ([Messages through the rendezvous](#messages-through-the-rendezvous)) |
| "That message is too long." | more than 3,500 characters (2,000 in a room), or the sealed body does not fit one frame | shorten it; text in scripts with 2- or 3-byte letters reaches the frame limit earlier |

## Messages through the rendezvous

**What changed.** Until now the messages of a conversation went straight from one browser to the other, and a conversation whose two browsers could
not reach each other stayed at "Connecting...". Now, from the accept on, both pages join the conversation's lane at the rendezvous they already
use for pairing, and every sealed message goes through it. A door says so in its apps block (`relay`, below); without the key this is the default.

**Why.** A direct link needs a path between two browsers, and on some networks there is none. The direct links in the tests below connected between
browsers on one computer or one home network, and the one run across two networks, with a phone on mobile data, did not connect. A direct link
also shows each side the other's network address. The rendezvous is a connection both pages already hold, so the messages can use it.

**What the design does, and what has not been measured.** The messages use the secure WebSocket (`wss:`) that pairing already needs, and a
visitor whose browser has no `RTCPeerConnection` can use the apps, because with direct links off the page does not need one. The design is meant to carry
conversations on networks that block or change direct links, such as an office Wi-Fi or mobile data. That has not been tested on those networks, in
Tor Browser or over a VPN yet, so this page does not say that it works there.

**Who sees what, by default (relay `rendezvous`, direct `off`).**

| Who | Sees | Cannot see |
|---|---|---|
| The other person | the messages, the keys of the conversation, when you send | your network address, unless the door turns direct links on and one connects |
| The rendezvous and whoever hosts it | your network address, the id of the lane, when each message is sent and one of three size classes of the sealed message | what a message says, names, keys |
| The door's owner | counts: the lanes open, the frames and characters forwarded today, the frames refused (`/stats.json`), and, if the door sends usage reports, the counts and words of the reports | content; addresses, unless the owner adds code that logs them |
| The network you are on (an office, a provider) | a secure connection to the rendezvous's host, its timing and volume | the other person's address, content |
| A STUN server | nothing: with direct links off the page makes no `RTCPeerConnection` and asks no STUN server | |

Relays carry sealed messages of three fixed sizes and cannot read them. A host can be ordered to record the addresses that connect to it and
can be barred from saying so; that is a risk of any hosted server, and the card says that the rendezvous and whoever hosts it see the address. What the
rendezvous sees beyond the pairing it already did is the lane id with the time and size class of each message; it never receives a name, a key or a text.

**The two keys of the block.**

| Key | Value | What it does |
|---|---|---|
| `relay` | `"rendezvous"` (the default when the key is absent) | after the accept both pages join the lane at the rendezvous and every sealed message goes through it |
| | `"none"` | the page does not join a lane at the rendezvous; the apps behave as they did before this change, with direct links only |
| `direct` | `"off"` (the default when the key is absent) | the page makes no `RTCPeerConnection` for the apps, loads no torrent manager and announces no lane; the card has no line about direct links |
| | `"on"` | the page also tries a direct link, as before; when one is ready it is used in place of the relay, and the card adds the line about both addresses |

`relay` `"none"` with no `direct` key means direct `"on"`, which is how a door behaved before this change, so a door.json with `relay` `"none"`
restores that behaviour. A block that says `relay` `"none"` and `direct` `"off"` leaves no way to connect and is refused by the tools and by
the page. Per-contact opt-in to a direct link, in place of the door-wide key, is not built.

**The off switch.** The operator of a rendezvous can turn the relay off on its own: `RELAY_LANE` set to `"0"` on the Worker, or `--no-relay-lane` on
the Node tracker. Every join and relay then answers `relay is off on this rendezvous`; pairing keeps working, and conversations need direct
links to connect. The door's owner can set `relay` to `"none"`. Neither takes a deploy of the apps.

**The caps.** They keep the relay to the sealed messages of conversations and rooms that were accepted, and they keep pairing alive:

| What | Limit | When it is hit |
|---|---|---|
| Relayed frames from one socket | 120 a minute | `too many relays` |
| Messages of any kind from one socket | 150 a minute | the rendezvous closes the socket and the page connects again |
| Relayed frames forwarded by one rendezvous object | 20,000 a UTC day, counted in memory (a redeploy resets it) | `relay is busy` until 00:00 UTC |
| Lanes joined by one socket | 8 | `too many lanes` |
| Members of a lane | 2 for a conversation, 16 for a room | `lane full` |
| One frame | at most 7,700 characters of base64url (the largest sealed message is 7,512) | `invalid frame` |

A page sends a small keepalive once every 50 seconds. The Worker is set to have the platform answer it without waking the rendezvous's object, and
the relay's caps do not count it; how the Free plan counts that answer has not been measured. A page
that stops answering is closed after 20 minutes and joins its lanes again when it wakes. The day cap is set below the 100,000 requests a day of the
Workers Free plan so that pairing itself does not meet that limit; how the plan counts WebSocket messages has not been measured either, and the cap
may change when it has.

**What is and is not built.** Built: the relay through the rendezvous, the two keys, the card and the status line, the tools line, the counts. Not built:
a second carrier for when this rendezvous is busy or gone, a list of rendezvous copies, any carrier on another host, and a direct link per contact.

## Limits

| What | Limit | Where it is set |
|---|---|---|
| Text in a conversation | 3,500 characters, and the sealed body must fit 4,064 bytes of JSON: about 2,000 Persian letters, or many line breaks, reach that first | `src/loader/apps-format.js`, `src/loader/apps-crypto.js` |
| Text in a room | 2,000 characters, and 3,935 bytes of JSON | the same |
| A frame over a lane | 16,384 bytes | `src/loader/apps-crypto.js` |
| Messages kept in memory | 5,000 per conversation, 2,000 per room; the other person's oldest go first, and what you wrote, pinned or saved goes last | `src/loader/apps.js` |
| Earlier texts of an edited message | the last 20 | `src/loader/apps.js` |
| A connection that has not said it speaks the apps' protocol | closed after 30 seconds; at most 8 of them at once on a lane (a conversation takes 4 that do, a room 24) | `src/loader/apps.js` |
| Frames over a lane | a conversation sends 60 queued frames a minute and accepts 120 (a room accepts 600); three bad frames close the wire | `src/loader/apps.js` |
| Requests from a page | 10 a minute; at most 8 waiting | `src/loader/apps.js`, `deploy/rtc-worker/pair.js` |
| Frames relayed through the rendezvous | 120 a minute and 150 messages of any kind a minute from one socket; 20,000 a UTC day for one object; 8 lanes per socket; 2 members in a conversation's lane, 16 in a room's | `deploy/rtc-worker/pair.js` |
| Lanes a page holds at the rendezvous | 8 on its socket at once, the newest first when the socket opens again; a conversation or room that did not fit joins when one of the others ends | `src/loader/apps.js` (`LIMITS.relayLanesMax`) |
| A request waits | 10 minutes | `deploy/rtc-worker/pair.js` |
| A code stays open | until its owner closes it, leaves, or 24 hours pass | `deploy/rtc-worker/pair.js` |
| A lane is served | 24 hours from the accept (from the opening, for a room) | `deploy/rtc-worker/pair.js` |
| Send later | up to 7 days ahead; the page must stay open | `src/loader/apps.js` |
| Disappearing messages | Off, 10 seconds, 1 minute, 1 hour, 1 day or 1 week in the page; 1 second to 30 days in the service for what you write; a timer on a message you receive counts for at least 10 seconds | `src/loader/apps-ui.js`, `src/loader/apps.js` |
| Snippets, notes, names | 50 snippets of 500 characters; a note of 2,000 characters; a name or nickname of 32 characters | `src/loader/apps.js`, `src/loader/apps-ui.js` |
| Rooms | 16 people, 4 owned rooms per person | `src/loader/apps.js` |

## Feature matrix

The owner's list of direct-message features, sorted. **built** means it is in the code and the unit tests exercise it. **next** means it needs a piece that
exists elsewhere in felinar, or a decision, and is planned. **not planned** means the web does not allow it or it goes against the
project's rules; it is recorded so that the question is not asked twice.

### Text and sending

| Feature | Status | Note |
|---|---|---|
| Plain text | built | |
| Bold, italic, underline, strikethrough, monospace | built | the marks `*bold*`, `_italic_`, `__underline__`, `~strike~` and `` `mono` ``, in Messages and Rooms; other text stays text, and nothing a person writes becomes markup |
| Links | built | `http` and `https` only, with no user name in the address; they open in a new tab with `noopener noreferrer` |
| Emoji | built | a picker of 32 emoji, plain Unicode, no images |
| Saved snippets | built | in memory for the visit; Messages only |
| Drafts per conversation | built | kept while the page is open |
| Spell checking and auto-correction | built | the browser's own: the composer sets `spellcheck` and `autocorrect` |
| Send with Enter and with the button | built | Messages and Rooms; Shift+Enter makes a new line |
| Send later, and cancel before it goes | built | up to 7 days; the page must stay open; Messages only |
| Resend a failed message | built | "Try again" |
| Retry when the connection returns | built | what the other browser did not confirm goes again on the next connection |
| Waiting while the other side is away | built | queued in memory on your side while this page stays open; nothing is held anywhere else |
| Send with priority | built | the "Mark as important" button; the other side sees "Important" |
| Edit, with the history | built | any number of times; the last 20 earlier texts are listed in the message details on both sides; Messages only |
| Delete for me | built | removes the message here only |
| Delete for both | built | the message is shown as "This message was deleted"; a copy that was already read may exist elsewhere |
| Select several and delete | built | removes them from your screen only |
| Clear conversation | built | removes the messages here; the other person keeps theirs |
| Delete conversation | built | it is "Leave conversation": the other side is told and the conversation goes |
| Disappearing messages and message expiration | built | one setting per person per conversation, the default timer of what that person writes: your setting never changes what the other person writes, and theirs never changes yours. A message carries its author's timer, so it goes from both screens, a pinned or saved copy too; the timer counts from sending on the author's side and from receipt on the reader's, and the reader sees a "Disappears" mark on such a message |

### Reading, finding and organising

| Feature | Status | Note |
|---|---|---|
| Delivery ticks | built | queued, sent, delivered, read |
| Sent time and read time in the message details | built | |
| Delivered time in the message details | next | the view has the line; the service does not record the time yet |
| Failed and pending indicators | built | "Waiting to send", "Not sent" |
| Sender information | built | the short id, the name if there is one, and the nickname you give |
| Unread indicator and counter | built | on the tile, in the list, in the tab title ("(2) Apps") and, in a conversation, a "New messages" jump |
| Reply and quote | built | Messages only |
| React, change a reaction, remove it | built | one reaction per person per message; Messages only |
| Copy | built | |
| Pin a message, save a message | built | your own marks; the other side does not see them |
| Mark a message important | built | your own mark |
| Mark a conversation read or unread | built | opening a conversation reads it; "Mark unread" is in its tools |
| Message details | built | sent, read, expiry, the list of edits |
| Day headings, jump to the oldest and the latest | built | "Today", "Yesterday", dates; the buttons "Oldest" and "Latest" |
| Search a conversation | built | words, an exact phrase, a date or a range, sent or received, with links, saved, pinned, edited, deleted, important, with reactions; results with "Previous" and "Next" and a jump to the message |
| Received, edited, deleted, pinned and saved views | built | the same search with one filter |
| Pin, archive, mute, favorite, hide a conversation | built | your own marks; a hidden conversation shows when you filter for it |
| Sorting and filtering the list | built | pinned first, then the newest; a filter on name or text; "Favorites only"; an "Archived" section |
| Nickname and conversation notes | built | only you see them |
| Font size | built | Small, Normal, Large |
| Export a conversation | built | a JSON file named `felinar-chat-<short id>-<date>.json`; it holds the text and both public keys, unencrypted |

### People and trust

| Feature | Status | Note |
|---|---|---|
| Read receipts, with a switch | built | on by default; both sides need them on to show "Read" |
| Typing indicator, with a switch | built | at most one mark every 3 seconds, never stored |
| Presence | built | "Connected to you now" (a direct link), "Connected through the rendezvous" (the relay) and "Not connected, last connected <time>" |
| Block and unblock | built | by the person's key for this visit, until the page is reloaded (see "Known limits"); a blocked person's request is turned away after a random wait of 3 to 12 seconds, and you are never shown it |
| Identity check | built | the short ids and the eight-digit compare code, "Compare: 1234 5678" |
| Notifications | built | a tab-title counter and a short line ("New message from <name>") that never shows the text; a muted conversation stays quiet |

### Rooms

| Feature | Status | Note |
|---|---|---|
| Create a room, share its code, approve each person | built | up to 16 people, 4 rooms per owner |
| Join a room by code | built | |
| Roster | built | sealed under the room secret by the owner; a member takes it only from the owner it met, and a connection that was never accepted cannot read it |
| Text, marks, emoji, Enter to send | built | 2,000 characters |
| Unread counter and the "New messages" jump | built | |
| Leave; the owner closes the room | built | |
| Remove a member, change the room secret | next | needs a new secret for the people who stay (see the notes below) |
| Edits, deletions, reactions, receipts, typing, search in rooms | next | rooms carry text only |

### Needs a piece that exists elsewhere in felinar

| Feature | Status | Note |
|---|---|---|
| Images, video, audio, voice notes | next | the private media pipeline ([ARCHITECTURE](ARCHITECTURE.md) 15.7) is bound to a site today |
| Files and documents, galleries | next | the same, for the files pipeline |
| Messages for a person who is away, and the same conversations on two devices | next | a door stores nothing by design; the pieces are the chat service's held mail and the identity origin's vault |
| Contact cards | next | needs contacts, which need storage |
| Link previews | next | fetching a preview tells the preview host the link; a later opt-in |
| Forward and share to another conversation | next | trivial once history persists |
| Notifications with previews and sounds | next | the page has no push |
| Reminders, follow-ups, snooze | next | local timers; low value before persistence |
| Custom themes, wallpapers, bubble colors, chat names | next | cosmetic; after persistence |
| Report a user | next | a door has nobody to report to; a later ledger moderation item |
| A password or lock on a conversation | next | nothing persists at a door |
| Secret conversation | next | every conversation is already end to end encrypted, so this only matters once conversations persist |
| Voice and video calls at a door | next | the Calls tile says so; calls exist for sites ([ARCHITECTURE](ARCHITECTURE.md) 15.14) |
| A relay for people who cannot connect directly or want to hide their address from the other person | built | the sealed messages go through the door's rendezvous by default ([Messages through the rendezvous](#messages-through-the-rendezvous)); the rendezvous and its host still see the address |
| A relay through a TURN server, or on a host other than the door's rendezvous | next | not built: a second carrier is a later change |
| A password-authenticated key exchange for the code | next | see "Prior art and design notes" |

### Not planned

| Feature | Status | Note |
|---|---|---|
| Stickers and GIF search | not planned | a third-party source would learn the visitor's address and searches; a bundled pack is a later asset decision |
| Translation while composing, predictive text, smart compose | not planned | a model or a service would have to read the text |
| Screenshot notifications | not planned | browsers do not expose screenshots |
| A biometric lock on the chat | not planned | a page has no API for it |
| Custom vibration and sounds | not planned | nothing is stored to hold the choice |
| Live location and location sharing | not planned | privacy |
| "Last seen" as a time beyond the connection itself | not planned | presence is only "Connected to you now" |
| "Online" as a word for presence | not planned | the wording rule |

## What is stored, and what is seen

The apps write nothing to the device: their code calls no storage API, so there is no `localStorage`, no IndexedDB and no cache entry. The
messages, codes, keys, drafts, nicknames and notes live in the page's memory. The one file is the one a person chooses to save with
"Export", which holds the conversation's text and both public keys in the clear.

The rendezvous sees, for a pairing: the first four characters of each code (the channel), when requests and answers arrive, the random
lane it hands out, the network addresses of the sockets (as any relay does), and sealed boxes it cannot open. After the accept it forwards
the sealed messages of the two browsers on the lane, so it also sees when each is sent and one of three size classes; with direct links on, it
carries their connection offers and answers on the lane, as every tracker does. It never sees names, keys, the last eight characters
of a code, a message, or which identity talks to which, unless it records a box and guesses that code's secret offline ("Known limits"). By
default the other person does not see your network address; once a door that turns direct links on connects two browsers, each sees the
other's (in a room, every member can connect to every other member). A connection to a lane that was never accepted (the rendezvous minted the lane,
so it can join it like a member) sees only sealed frames: it can count the people in a room by the number of key boxes, and it reads no name, no key
and no message. Details: [PRIVACY](PRIVACY.md) and [ARCHITECTURE](ARCHITECTURE.md) 15.21.

**What usage reports add.** If the door's `/_mw/door.json` also has an `obs` block ([OBSERVABILITY](OBSERVABILITY.md)), the page sends usage reports to that endpoint, and only
after the visitor's first yes: "Continue" on a price card that can start something (signing in alone is not one: the loader's sign-in card names no host). The price card then has one more line:
"Besides that, this door sends usage reports to its operator at {host}: what the apps do here (steps, taps and errors), never network addresses, names or messages. Settings turns them off." Until the yes, what the visitor does waits in the page's memory and nothing is sent. The reports say what the apps did, never what was said: which view was opened, which card was
shown and what was pressed on it, the steps of signing in, the first four characters of a code, how requests came in and went, the status of each conversation or room by its local id, how many
messages reached each status, how the lane at the rendezvous went (joined, left, refused, and how many others are on it), whether a conversation is carried by the relay or a direct link, the states of the pair socket, and, with them, the short id of the visit's key, the browser's family and a coarse network type. They carry no message, name,
nickname, key, box, proof, lane, address or last eight characters of a code. Settings has a switch, "Send usage reports to {host}", which stops them at once; the page stores nothing, so
the choice lasts for this visit only. What the endpoint's host sees anyway, and how long it keeps reports (7 days by default), is in [PRIVACY](PRIVACY.md#usage-reports-unreleased).

## What was tested

Everything in the table below was measured on 2026-11-02, between 03:55 and 04:05 ET, in headless Chromium 156 driven by Playwright, against
the public tier: the demo site on a GitHub Pages user site, the demo door and the identity page on Cloudflare Pages projects, and the demo's
own rendezvous on Cloudflare (a Pages front over a Worker with a Durable Object). That is the harness only: it records facts about the code
and makes no release-gate row pass. The rows are G-AP-1 to G-AP-4 in [DEMO-RESULTS](DEMO-RESULTS.md). The demo site and the demo door run
the apps as a test build (loader build bbcb82098cda), not a signed release, until 0.3.1 is released.

| What | What was measured |
|---|---|
| The demo site, republished from the apps build | Its pointer names the demo's own rendezvous first, beside two public trackers, a STUN server (Cloudflare's), the identity page, `org=` naming the site's own address and two signed doors. `check-site` found 0 failures and 1 warning (the GitHub Pages 600 s cache). All three trackers connected: `check-site` now reads a tracker that closes the socket after a scrape as connected. |
| The demo door | It serves the same build with the apps block: rendezvous 1, STUN 1, identity page. `check-site --door` found 0 failures. |
| Pairing at the demo door: one conversation (Messages) between two separate browser processes with fresh profiles | Both visitors signed in for the visit through the identity page. The code was read from the first page's screen, the second page knocked with it, and the first page showed the request. Before the accept, the count of `RTCPeerConnection` objects was 0 in both pages, and the rendezvous had counted the knock and no lane and no peer. After the accept, both sides connected in 0.5 s (`RTCPeerConnection` counts 4 and 3), and the rendezvous counted one lane and two peers. A formatted message with a link crossed each way, the sender saw "delivered" and then "read", and the pages logged no errors. The same pairing ran earlier on the lab tier, a second door and rendezvous with the same build. |
| An operator probe outside this repository | At the demo door with its pairing check, the probe passed 5 of 5 checks: the page loaded in 0.3 s, it rendered in 0.6 s, a tracker was reachable, sign-in took 1.3 s (median), and pairing passed (code 1.4 s, knock 1.7 s, accept 1.3 s, both connected 0.5 s, a message each way 0.1 s). At the demo site it passed 4 of 4: the page loaded, it rendered in 0.7 s, 3 of 3 trackers connected, and peers met in 1 of 1 pairs, the first peer after 0.4 s. |

The counts before the accept are the measured form of one claim of this page: until the owner accepts, no connection offer has moved
("Using the apps", Messages, step 3). They show what this page's code and this rendezvous did in one run in one engine, and they do not
cover a rendezvous that misbehaves ("Known limits").

**One phone, later that day.** The same day one Android phone (Brave (Chromium), Android 16, Samsung Galaxy Z Flip) ran the pairing on two networks; the rows are G-AP-1, G-AP-2 and G-AP-4 in [DEMO-RESULTS](DEMO-RESULTS.md), and G-OB-3 for its usage reports. On home Wi-Fi, at a lab door (a second door and rendezvous, loader build fdd689957ed5), the owner signed in for the visit, got a code and accepted a knock from a headless Chromium on a Mac on the same network: the knock was acknowledged in 28 ms, the owner accepted 4 s after the knock, ICE went from checking to connected in 78 ms with the selected pair `host/udp` to `host/udp`, the conversation connected 2 s after the accept, the greeting was delivered 0.8 s after it connected and read 2 s later, and two messages from the phone arrived with delivered and read receipts. The count of `RTCPeerConnection` objects before the accept (0) is the headless side's, measured by the probe; the phone's side was not instrumented. On mobile data (5G), at the demo door at 07:08 ET, the same phone accepted two knocks, but every WebRTC attempt failed: ICE went from checking to disconnected at 15 s and then to failed, in four attempts that the app offered again every 20 to 35 s, with remote candidates of the kinds `host` and `srflx` only. The pairing itself (the knock and the accept, through the rendezvous) worked across the public internet; the direct link did not connect for a peer on mobile data, and there was no relay to fall back to at the time. Messages through the rendezvous ([above](#messages-through-the-rendezvous)) are the change made for that result; they have not been run on mobile data.

**Not yet run.**

- No iPhone has run the apps. One Android phone has (above): it paired on home Wi-Fi and did not connect on mobile data.
- No conversation has gone through the rendezvous on a real network: not on an office Wi-Fi, not on mobile data, not in Tor Browser, not over a VPN. The path is tested on loopback only.
- No real Safari has run them, on a desktop or on an iPhone.
- No pairing has run in WebKit or Firefox: the harness paired only in Chromium.
- The two harness browsers ran on one computer, and the only run across two networks, with the phone on mobile data (above), did not connect. The door's STUN server has not been tried between two homes.
- No screen reader has been used on the apps.
- The demo runs an unsigned test build until 0.3.1 is released: no signed release carries the apps yet.

## Known limits

What is not fixed, in plain words. Each is a cost the design accepts today, or a gap with an item on the backlog below.

- **The secret half of a code is 40 bits, and a relay can test it offline.** The rendezvous keeps the owner's sealed box for the life of a
  code, and a relay that records the boxes of requests can try secrets against them. Each try costs 100,000 rounds of PBKDF2 (about
  200,000 SHA-256 compressions), and a 40-bit secret has about a million times as many candidates as a 20-bit one. That is arithmetic: no
  attack was run, and nobody has measured what one costs. A password-authenticated key exchange would remove this and is the first backlog
  item.
- **The compare code can be ground by someone who holds the secret.** The eight digits are not hash-committed (the "Matrix and ZRTP" row
  above), so a person in the middle who knows the code can try keys until the digits match. Reading them aloud still catches a key that
  was swapped by someone who does not know the code.
- **The four-character channel can be listed.** An open code answers a request differently from a closed one ("unknown code"), so someone
  who sends requests from many sockets can find out which of the 1,048,576 channels are open. At 10 requests a minute a socket, 1,000
  sockets take about 105 minutes, which is arithmetic from the cap, not a run on a real rendezvous. A channel is not the secret, but five
  requests that your page cannot open close a code: a pair code is replaced by a new one, a room's code is closed for good (new members
  then need a new room).
- **Blocking is by the other person's key for this visit.** A person who reloads their page gets a new key, so the block no longer matches
  them, and your code still works for them: press "New code" to end it.
- **The caps are global.** There is no quota per address: someone with many sockets can fill the 4,096 codes or the 10,000 lanes for up to
  a day, and someone who holds a code can fill its 16 pending places with requests from several sockets (a replayed request is turned away
  at once, a fresh one waits for you).
- **In a room, every member passes on what it receives.** Each frame comes from several members, so one member who sends many valid
  frames spends the others' receive budget (600 a minute) and costs each of them one connection, the flooder's. There is no way to remove a
  member, and no rekey.
- **A person can date a message in the past.** Messages sort by the time their sender gives; a frame older than 7 days is dropped, but one
  dated a day back sorts before what you wrote an hour ago. The time shown is never later than your clock.
- **A connection to a lane that was never accepted can count a room's members**, by the number of key boxes (see above).
- **The rendezvous can sit on a conversation's lane.** It minted the lane, so it can join it and say that it speaks the apps' protocol;
  the page writes each frame to the first direct connection that does, so the other person would get nothing until that one goes, and the
  messages would show "Not sent". It reads and changes nothing (every frame is sealed under a key it lacks), and it can already refuse
  to introduce the two browsers at all. Sending to every connection that speaks would close this gap and is not built.
- **A lane has two places, and whoever knows its id can take one.** The rendezvous mints the lane id and so knows it, and a socket that learns it
  can join before the second person does. The second person then meets `lane full` and no message passes through the rendezvous for that
  conversation; on a door that turns direct links on, a direct link can still connect. The one who took the place reads nothing: every frame is
  sealed under a key it lacks. A new code ends it.
- **A phone that changes network can find its lane full for a while.** A socket that disappears without closing stays a member of its lane until the rendezvous
  closes it as idle, up to 25 minutes (20 minutes of silence, looked at every 5). Until then the page that replaces it can meet `lane full`, and a message written to the
  vanished socket reaches nobody, so it is not acknowledged and goes again. Nothing is stored for the relay: a message sent while the other side is away waits in the
  sender's page, which has to stay open, and goes after the other side has joined.
- **The relay is as available as its host.** Messages through the rendezvous stop when the rendezvous is off (`RELAY_LANE` `"0"`), busy (the day cap of 20,000
  frames, until 00:00 UTC) or unreachable, and the Workers Free plan's own limits apply to it; the conversation waits at "Connecting..." and unsent
  messages stay queued while the page is open. A second carrier is not built.
- **A message that the other person sent and you pinned still goes when their timer says so**, as above.

## Prior art and design notes

**Why the messages are not on the ledger.** The site ledger is felinar's store for durable, replicated, signed records of a site: posts,
names, policy and, if opted into, chat-key records. Every peer of a site replicates it, so it suits what is public by design and does not
suit private traffic between two people. The chat design ([ARCHITECTURE](ARCHITECTURE.md) 15.6) keeps direct messages off the ledger on
purpose: deniable sealed boxes, no sender signature, held by peers for 7 days at most. The apps follow the same rule. A bare door page has
no site and so no ledger; conversation state lives in memory for the visit, and the visitor can export it. When the apps are mounted on a
site later, the durable pieces go where the architecture already puts them: the identity origin's vault for contacts and keys (R 2.9.4,
MF-72), the chat service's held mail for delivery while away, and public profile blocks on the site ledger for names. What the apps write
uses the ledger's conventions anyway (canonical JSON, prefixed signatures, `p256:` keys, base64url, Unix milliseconds), so a later
introduction or roster block is a change of format, not a redesign.

**What was borrowed, and what was left out.**

| Source | Borrowed | Left out |
|---|---|---|
| Magic Wormhole | a short code with a public part (the channel) and a secret part that never reaches the relay | a true password-authenticated key exchange. SPAKE2 needs point addition that WebCrypto lacks ([RFC 9382](https://www.rfc-editor.org/rfc/rfc9382.html)); CPace on P-256 is an IRTF draft and needs hash-to-curve from a small library, a dependency decision for the owner |
| SimpleX | no directory and no lookup by identity: a code per conversation, and a rendezvous that learns channels, timing and lane ids but no names or keys | its queues and routers |
| Signal | safety numbers: here an eight-digit compare code from the pair key, read aloud | sealed-sender certificates and contact discovery; the messages use the deniable box of the chat service |
| Matrix and ZRTP | a short authentication string with a commit before the reveal, so that a man in the middle gets one guess | not built: the compare code is not hash-committed, so a man in the middle who holds the secret could grind it |
| Nostr (gift wrap) | store and forward of sealed envelopes | not built: a seven-day mailbox in the rendezvous for sealed frames is a backlog item |
| MLS ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)) | group keys with forward secrecy for long-lived groups | not used: a room has one epoch of the project's group sealing and a leaver means a new room. The research advises against MLS for short-lived door rooms (a commit needs an ordering authority, and the main library the study found, ts-mls, was 692 KB unpacked and listed no audit on its project page, read on 2026-11-01); it stays a backlog item for rooms that persist |
| WebRTC address hygiene | browsers hide local addresses behind mDNS names; the apps use the site's own STUN only; the first connection offer moves after approval; by default no `RTCPeerConnection` is made at all, and the messages go through the rendezvous | a relay through a TURN server (R 2.7.8): not built |

**What the research advised, and what was built.** A prior-art study written on 2026-11-01 (Magic Wormhole, SimpleX, Signal, Nostr, MLS,
PAKEs, WebRTC privacy, pairing-code design) made recommendations. Where the build differs, it is on purpose or for lack of time:

| Advice | Built |
|---|---|
| A secret of at least 80 bits, independent of the channel | 40 bits (8 characters), drawn separately from the channel. A code must be easy to read aloud; each guess costs 100,000 PBKDF2 rounds. A relay that keeps a sealed box can still test guesses offline, about a million times more slowly than it could for a 20-bit secret. A PAKE would remove this and is the first backlog item |
| A single-use code that lives about 10 minutes and is burned after three bad requests or a second valid one | A code lives while the page is open (24 hours at the most), takes any number of requests, each approved or rejected on its own, and is replaced after five requests the owner cannot open. A request is accepted once (its nonce) and only within 10 minutes of its time |
| Bind the channel and the role into the key derivation and the box, and sign the chat key with the identity key | Done: the channel is in the key derivation, the channel and the role are in the box's associated data and in the signature, and the identity key signs the hello that carries the chat key |
| Open a WebRTC connection only after approval, and send the offer and the DTLS fingerprint sealed | The first half only: no connection exists before the accept, and with the default (direct links off) none exists after it either. Offers and answers, when a door turns direct links on, travel through the rendezvous unsealed, as with any tracker. The messages are sealed under the pair key whatever the path |
| Never ask for the camera or the microphone | Done: the apps never do. In browsers that keep local addresses behind mDNS names unless a page holds that permission, this keeps them hidden; the public address shows to the other person only when a door turns direct links on and one connects |
| Rooms by full mesh of pairwise sealing, or sender keys with a rekey on every join and leave | One room secret, sealed by the owner to each member, and signed group messages. No rekey |
| No stored gift wraps, no messages held by a relay, no ledger for private messages | Done |

**Backlog.** A password-authenticated key exchange for the code (CPace on P-256). A hash-committed short authentication string. A mailbox in
the rendezvous for sealed frames addressed to an inbox tag. A second carrier for when this rendezvous is busy or gone. A direct link per contact, in place
of the door-wide key. Media, files and calls at a door. A rekey for rooms.
A separate `_mw/apps.js` so that only doors with apps load them. A verifier that accepts a door kit whose `door.json` carries the block
(`verify-release.mjs verify --door-kit` names that file today; [DEPLOY](DEPLOY.md), "Apps at a door").
