# Red team: phishing and account takeover against the v0.3 identity and sign-in design

- **Date:** 2026-10-20. **Attacker class:** phishing and account takeover. **Scope:** IDENTITY-AUTH-DESIGN.md (sections 3 to 9, 11), REALTIME-AND-FILES-DESIGN.md (chat and file lanes as phishing surface), and the 2026-10-20 08:25 ET addition (one root identity as a sign-in for any site: magnet-web sites, drop-in widget on existing sites, a published SIWE-shaped challenge plus a Node and browser verification library for server-backed sites).
- **Attacker model:** motivated, has the public code and the design, can host a static page, can run a site, can pay for ads, can join a public ledger as a writer, can send links and QR codes. No browser exploit, no malware on the victim device, except where an attack says so.
- **Labels:** `works today` (against 0.2.1 code, file:line cited), `works against the proposal` (the design as written permits it), `blocked by` (a named control stops it), `needs measurement` (cannot be settled from the text).
- **Status of the addition:** the cross-site parts (b) drop-in sign-in and (c) server-backed sign-in are NOT in IDENTITY-AUTH-DESIGN.md as written (no SIWE-shaped challenge, no server library, no statement of where the root lives on a drop-in origin). Attacks on them below are against the stated requirements plus the design's own primitives (4.1 proofs, 3.3 storage, 3.5 hand-off). Where the design is silent I say so and treat the silence as an attack surface.
- **Wording:** "no backend", "site ledger". No numbers without a source; figures quoted from the design are cited to it.

## 0. Verdict in six lines

1. The design's anti-phishing story is "the phrase is only typed in loader UI". An attacker hosts the loader (it is open, static, copyable) or ships a modified `mw.js` on any page, so "loader UI" is attacker UI. Nothing in the browser tells the person which one they are looking at. Passkeys work because the browser binds the credential to the real origin; the proposal has no equivalent for the phrase, the file, or the hand-off. (A1, A2)
2. One root per person plus a root that must be unwrapped on whichever origin the person signs in on means one hostile or compromised site origin yields every site identity, every sealed record and every chat key. The cross-site feature turns the documented same-origin limit (SECURITY-MODEL "Same-origin site code") from a per-site loss into a total loss. (A3, A4)
3. The loader-owned cards are not protected from the same-origin site frame in shell mode: the sandbox is `allow-scripts allow-same-origin` (src/loader/render.js:30), so the site can restyle or cover the real card and pass a genuine `isTrusted` click through. This works today for the consent card and will work for sign-in, "use the same identity here", "Link a device" and "Let this site read your private record". (A5)
4. The server-side story is under-specified in ways that make a correct-looking integration replayable or cross-site usable: optional nonce, bearer mode, `ledger` or origin either-or, caller-supplied expected origin, ECDSA malleability, parser differentials. (A8)
5. QR hand-off defends against a man in the middle, not against the person scanning an attacker's QR; the SAS (short authentication string) is computed honestly by the attacker's device. (A6)
6. "Locked" and "signed out" do not lock the per-site signing key: 3.3 stores it unwrapped as a non-extractable CryptoKey in IndexedDB. A shared computer keeps a usable identity after "Sign out". (A9)

## 1. Summary table

| # | Attack | Label | Severity | Cheapest effective defence | Cost to honest users |
|---|---|---|---|---|---|
| A1 | Fake loader (lookalike site) asks for the phrase, file, or QR | works against the proposal | blocker | phrase and file entry only at one canonical identity origin, reached by top-level navigation; everything else hands off to it; passkey assertion gates approvals there | one hop to another origin; one canonical host to run and trust |
| A2 | Hostile or compromised host page paints a fake card over the drop-in panel, or ships a modified `mw.js` | works today (overlay), works against the proposal (phrase theft) | blocker | same as A1: no secret entry in any widget; widget only launches a popup or redirect to the identity origin | "Continue at <identity origin>" step on drop-in sites |
| A3 | One hostile same-origin script takes the root, not just one site key | works against the proposal | blocker | root exists only at the identity origin; other origins get a site-scoped, revocable delegate, never the root or the portable siteSeed | delegate refresh per site and device |
| A4 | Passkey prompt abuse by same-origin script (PRF) | works against the proposal | major | rpId = identity origin only; PRF salt not derivable by other origins; per-origin passkeys never wrap the root | none for honest users |
| A5 | UI redress of the real card from the same-origin site frame | works today (consent card) | blocker for v0.3 cards | move high-risk cards to a separate origin; interim: visibility checks plus a non-click confirmation for high-risk cards | an extra gesture on rare, high-risk cards |
| A6 | Malicious "device B" QR hand-off (quishing) and cross-device login relay | works against the proposal | blocker | siteSeed never leaves the root holder; hand-off sends a revocable device delegate; high-friction "this is my own device" step; no QR login relay without proximity | slower device linking |
| A7 | Proxy phishing (reverse proxy of a real site plus rewritten loader) | works against the proposal | major | only the identity origin signs; passkey with rpId = identity origin approves each new origin; proofs carry the origin the browser reports to the identity origin | a passkey tap per new site |
| A8 | Verification library and server misuse (replay, cross-site, malleability, parser differential, pre-hijack) | works against the proposal | major | the library refuses bearer proofs, requires a server nonce and an expected origin argument, returns only verified fields, dedups on nonce | server author reads one page of rules |
| A9 | Shared browser: "Sign out" leaves a usable key; proof copy in sessionStorage | works against the proposal (works today: no lock exists) | major | persist only wrapped material; unlock derives the key into memory; "shared computer" mode with nothing persisted | one passkey tap per visit on private devices; a passphrase on devices without PRF |
| A10 | Key-selection spoofing: a page names another site's ledger id and gets a proof or a signature under that pseudonym | works against the proposal (unsigned ledgers) | major | derive siteSeed from origin and ledger id for unsigned ledgers; widget ignores page-chosen ledger ids for key selection | mirrors of unsigned sites do not share an identity |
| A11 | Rotate and recovery races; moderator social engineering to re-admit a key | works against the proposal (unspecified) | major | recover-key rotation beats self rotation inside a time lock; moderators never act on a chat request | a waiting period after a lost key |
| A12 | Phishing inside the site: chat, guestbook, display-name impersonation, fake "support" | works today (names), works against the proposal (chat) | major | role badges from the ledger, key short id beside every name, link warnings, no card text from site or peers | small UI clutter |
| A13 | "Use the same identity here" dark pattern and link statements | works against the proposal | major | no SDK parameter can request linking; loader-only, names both sites, states permanence | one extra read |
| A14 | Offline guessing of the identity file; the existing 0.2.1 export | works today (8 character floor), works against the proposal (v2 file holds the root) | major | do not put the root in the file by default; generated passphrase; Argon2id parameters measured on target devices | no portable file unless the person accepts a longer secret |
| A15 | Passkey sync provider or SIM-swap recovery becomes the identity recovery | needs measurement | major | phrase-only mode offered; document the provider as a trust root; no cross-device unwrap through a provider until the lab passes | none by default |
| A16 | Malicious browser extension | needs measurement | minor (stated out of scope) | reduce secret exposure in the DOM and clipboard; dedicated profile advice | none |
| A17 | Hostile host or loader update | works against the proposal (stated limit) | minor | known trust root; note larger blast radius with one root | none |
| A18 | Design contradiction: "never accept a nonce from site code" versus server sign-in | works against the proposal | major | state the exception: site-relayed server nonce allowed only with origin forced by the browser-reported origin | none |

## 2. Attack scenarios

### A1. Fake loader asks for the recovery phrase (blocker, works against the proposal)

**Preconditions.** Attacker hosts any static page at a lookalike address. The loader is static, open and copyable; nothing about "loader UI" is secret. Victim has a root and a habit of typing the phrase to "Restore" on a new device (the design asks them to, 3.5, 4.3).

**Steps.**
1. Attacker copies the loader, restyles nothing, and serves it at `magnet-web-example.com` (or any address a search ad, a link in a chat room, a DM, or a QR poster points to).
2. The page shows the genuine looking first-run card, then the genuine looking "I already have one" with a 12 word field (4.3). The card text "No one will ever ask you for these words" is part of the copied UI.
3. Victim types the phrase. The attacker's script has it in plain memory.
4. Attacker derives `siteSeed` for any ledger id (3.1 is public and has golden vectors), signs as the victim on every site they use, decrypts every sealed record (K_rec), reads the chat keys, and can run D-10 `rotate` where it exists.

**Gain.** Every site identity, every sealed record, chat history keys, file keys, in one step. Phrase recovery is also how the victim would regain access, so the attacker can lock them out first (A11).

**Who and how it scales.** Any visitor who restores on a new device; an ad campaign or a link seeded into any public room scales it. One victim is a total loss across all sites (design 13 admits the phrase opens everything and that nothing resets a lost phrase).

**What the design already does.** "Phrase only in loader UI; loader never asks unprompted; card text" (9, row 1). The residual column says "a visitor who types the words elsewhere loses every site identity". That is true, and the mitigation does not distinguish the real loader from a copy. Compare passkeys: the browser, not the page, enforces the relying party id, so a copy of the page cannot ask for the credential.

**Cheapest effective defence.**
- One canonical identity origin (the design already sketches `id.<site>` for a different reason, 6.5). Phrase, file, passphrase and QR entry exist only there. Every other context (shell page, drop-in, server-backed site) can only start a top-level navigation or a popup to it. The person is taught one thing: "words are typed only at this address". The address bar is the only unforgeable indicator the web offers.
- Make the phrase rare: passkey-first unlock where PRF works (3.4), QR hand-off from an existing device, and the phrase shown for backup once, entered only on loss.
- Gate every first approval for a new origin with a WebAuthn assertion at the identity origin (user verification required). A copied loader cannot obtain that assertion because the rpId does not match.

**Cost to honest users.** One extra navigation on restore; the identity origin must be hosted by someone (a static page; a trust root and a naming target). It conflicts with the idea that the loader can be self-hosted anywhere: self-hosters would need their own identity origin, which splits the identity, or accept the canonical one. The owner must decide this explicitly (it is a new trust object, see A17).

### A2. Hostile or compromised page on a drop-in site paints a fake panel (blocker for phrase entry; works today for overlay)

**Preconditions.** Victim is on a page that includes the drop-in script. The page is hostile, or a third-party script on it is.

**Steps (overlay, works today).**
1. The page, which controls its whole document, appends its own element to `document.body` with `z-index: 2147483647`, or uses the top layer (`<dialog>.showModal()`), above the panel host the loader places at `z-index: 2147483000` (src/dropin/panel.js:150). A later top-layer element is drawn over an earlier one.
2. It draws a pixel copy of the loader card (the CSS is public: cardStyle and buttonStyle at src/dropin/panel.js:109 to 135 area) and its own buttons. The closed shadow root protects the real card's internals from the page's scripts (src/dropin/panel.js:154) but does nothing about a second, fake card.
3. Today the fake card can only imitate a consent choice, which has low value. In v0.3 the same fake can be a "Sign in", "Restore", "Link a device" or "Confirm with your passphrase" card.

**Steps (modified loader).** The drop-in module is served by the page's own host (`/_mw/mw.js`, src/dropin/mw.js header). A hostile page serves a changed copy. There is nothing to compare it against (SECURITY-MODEL: "A page can't verify itself").

**Gain.** Whatever the person types into any card the page owns: phrase, passphrase, a QR reply, a "recovery kit" file. Also approval clicks for actions on their behalf if the root or a delegate is on that origin (A3).

**Already stops.** `isTrusted` filtering stops scripted clicks on the real card (src/dropin/panel.js:77 to 82, src/loader/ui.js:32 to 40); this is irrelevant to a fake card.

**Does not stop.** Overlay, fake card, modified loader.

**Cheapest effective defence.** No secret is ever typed, pasted or scanned inside a widget. The widget's only job is a button that opens the identity origin (A1), which also owns the passkey. The panel can still show non-secret state. Cost: the "one tap in a loader-owned card" experience becomes "one tap, then a popup", or no popup at all where the passkey prompt is native browser UI at the identity origin. Honest users lose nothing they could have safely had.

### A3. One hostile same-origin script takes the root, not one site key (blocker, works against the proposal)

**Preconditions.** Person signs in on origin X (their own magnet-web site, a drop-in site, any site with the loader). X contains a script the person does not control: a comment widget, a compromised analytics tag, an XSS in a guestbook that renders HTML, a malicious update pushed by whoever controls the host.

**What is true today.** The posting key is created extractable (src/loader/app.js:546, src/dropin/identity.js:143) and kept in IndexedDB of the site's own origin; the site frame is same-origin with the shell (`allow-scripts allow-same-origin`, src/loader/render.js:30 and :652). SECURITY-MODEL states the consequence: "same-origin code can still read IndexedDB: it has the identity key". Scope today is one ledger key on one origin. Works today: a script on the origin opens the keys store and calls `exportKey('jwk')`.

**What the proposal changes.**
1. The root, or something derived from it that opens other sites, has to be present on whichever origin the person signs in on, unless the design adds the identity origin (A1). The design keeps `root` wrapped under PRF, passphrase or session and unwraps it "in loader code" (3.3), but in shell mode the loader code and the site frame share an origin and a browser agent cluster. The site frame can reach `window.parent`, patch `SubtleCrypto.prototype.decrypt`, `importKey` or `deriveBits` in the parent realm, and read the plaintext root the next time the loader unwraps it. "Root dropped after use" and "no SDK path to the root" (9, row 4) assume the attacker uses the SDK; it does not need to.
2. In drop-in mode "the page is the loader's realm" (6.5), so there is no separation at all.
3. Non-extractable derived keys (3.3) do not help: a script that holds a CryptoKey reference from IndexedDB signs anything with it. It can sign `mw-login-v1` proofs and blocks for the full lifetime of the browser state.

**Steps.** Victim unlocks on X (passkey tap, or phrase). Hostile script on X captures the root at unwrap. Attacker then derives every `siteSeed`, reads every sealed record, and can sign in to any site (A8) or open the victim's chat lanes.

**Gain and scale.** A single compromised third-party tag across many sites that offer sign-in yields the roots of everyone who unlocks on them. The advertised property "sites cannot link you by key" (R3 F21) does not survive an attacker who gets the root.

**Cheapest effective defence.**
- The root never leaves the identity origin. Other origins receive, per site and per device, a delegate: a site-scoped signing capability with an expiry that the identity origin can stop honouring (see A11 for what "honour" means on a ledger with no revocation op). Do not use the portable `siteSeed` for this (A6).
- Where the design keeps `siteSeed` derivation on the site origin, the loss is bounded to that site but is permanent (a seed cannot be rotated without D-10 and the recover key).
- Until the identity origin exists: say in the sign-in card and in SECURITY-MODEL that on a site with third-party script, unlocking exposes every site (not only this one). The current wording (9 row 4, 13) frames this as "can act as the visitor while the page is open"; the cross-site root makes that incomplete.

**Cost.** A delegate protocol (new object, new tests), refresh per site and device. No change for the person beyond A1's hop.

### A4. Passkey prompt abuse by a same-origin script (major, works against the proposal)

**Preconditions.** Person has a PRF-wrapped root (3.4). A hostile script runs on the origin. The wrapped root blob is in IndexedDB on that origin.

**Steps.**
1. Script waits for any user gesture (the person clicks anything).
2. Script calls `navigator.credentials.get` with the credential id from the stored record and the public PRF salt `"mw/wrap/v1|" + ledgerId`. The browser shows its own prompt naming the site, a prompt the person has been trained to approve (the card told them to).
3. PRF output returns to the script; it HKDFs with the public info string `"mw-prf-wrap-v1"` and decrypts the wrapped root copy it read from IndexedDB.

The design admits the first half (3.4 "Honest limit"). It does not state the consequence for the cross-site root: if each origin has its own passkey wrapping its own copy of the root, then the root is copied to every origin the person signs in on, and one tap on a hostile origin releases it (A3).

**Defence.** One passkey, rpId = identity origin (A1). Origins other than the identity origin never receive a wrapped root, only delegates. If ROR (related origins, 3.4) is used for mirrors, the allowed list is part of the trust root and must be short; do not list user-contributed origins.

**Cost.** None for honest users. Mirrors lose a per-mirror passkey.

### A5. UI redress of the real card from the same-origin site frame (blocker for the v0.3 cards; works today for the consent card)

**Preconditions.** Shell mode (the common mode). The site (or any script in it) can call `mw.consent.request()` or, in v0.3, `mw.auth.signIn()`, `mw.identity.openLink()`, `mw.me.get()` from a click it induced (transient activation is forwarded, design 7).

**Steps.**
1. Site shows a bait button ("Claim your prize", "Continue") and on click calls the SDK method that opens the loader card. The card is a `role="dialog"` in the shell document (src/loader/ui.js:127), outside the site iframe.
2. Because the frame is same-origin with the shell, site script reaches `window.parent.document`. It sets the real dialog's `opacity` to 0 (or moves it under bait) and appends its own bait text element to the shell document with `pointer-events: none`, placed exactly over the real "Approve" button.
3. Victim clicks the bait text. The click lands on the real button underneath. It is a genuine hardware click: `isTrusted` is true, so `trustedOnly` (src/loader/ui.js:32 to 40) accepts it.

**Gain.** Today: the consent decision ("Share and load", exposes the visitor's IP to trackers and peers, SECURITY-MODEL) given without informed intent. In v0.3: sign-in to the attacker's origin, "use the same identity here" (A13), "Let this site read your private record" (6.5 gate), "Link a device" step, passkey prompt launch. The `isTrusted` and closed-shadow-root controls in the Threat table address scripted clicks, not redress.

**Already stops.** Scripted `el.click()` and `dispatchEvent` (E2E PEER-CONSENT). The drop-in panel's closed shadow root stops the page from reaching card internals, though not from covering the host (A2).

**Cheapest effective defence.**
- Real fix: the card runs where the site cannot touch it, the identity origin (popup or top-level), or the frame sandbox drops `allow-same-origin` (breaks a lot; it is why SECURITY-MODEL calls the sandbox "not a security boundary").
- Interim, same origin: before accepting a click on a high-risk button, verify it is the topmost element at the click point (`elementFromPoint`), computed `opacity` and `visibility` are normal, the dialog's computed style is unmodified, and the dialog has not been mutated since open (MutationObserver on the shell root); refuse and close on any anomaly. Require a gesture that cannot be redirected by transparent overlays for high-risk actions: type a short displayed word, or press and hold. Chromium's IntersectionObserver `trackVisibility` is not cross-browser (needs measurement).
- Interim limit: a determined script in the same origin can still patch the checks. This is a speed bump, not a boundary; say so.

**Cost.** High-risk cards (link a device, same identity, read private record, first sign-in at a new origin) need one extra deliberate gesture. Low-risk cards unchanged.

### A6. Malicious "device B": QR hand-off phishing and cross-device login relay (blocker, works against the proposal)

**Preconditions.** QR hand-off as designed (3.5): device B shows `mwlink:1:<eB pub>:<ledgerId>`; the unlocked device A scans, shows a SAS, shows a reply QR containing `siteSeed` (default) or the root ("link everything"); B scans the reply.

**Steps (quishing).**
1. Attacker prints or displays a QR "Scan to sign in on this kiosk/TV/screen" or "Scan to verify" on a poster, in a video call share, in a chat room image. It encodes the attacker's `eB` and a ledger id of the target site.
2. Victim opens "Link a device" (or follows the page's link into it) and scans. The loader on A derives the key and shows a 6 digit SAS and the reply QR.
3. Attacker's device B is the other end of the protocol: it computes the same SAS, displays it, and scans the reply (the attacker's camera is on the victim's phone, on the video call, or the attacker is physically there).
4. The SAS matches because there is no man in the middle. The attacker is the other party. The attacker decrypts `siteSeed`.

**Gain.** `siteSeed` is permanent. It yields the sign key, chat key, K_rec (sealed record), K_vault (local vault key, but the vault itself stays on A), K_name. There is no rotation without D-10 and without the recover key (derived from the root, not from siteSeed, 3.1), so the victim can still rotate; the attacker can also rotate first (A11). The root variant is A1's total loss.

**Gain (login relay).** If the feature set includes sign-in on another device by QR (a natural reading of "cross-device ... QR hand-off"), the same shape appears: attacker starts a login on the real bank-like site on their own browser, gets the site's "scan with your phone" QR, shows it to the victim, who approves a card that correctly reads the real site's name. Attacker's session is now logged in as the victim. Well known from QR login on messaging apps; passkey cross-device flows add Bluetooth proximity for this reason (needs source before quoting; not fetched in this review).

**Already stops.** A man in the middle between two honest devices: the SAS design is sound for that case.

**Does not stop.** A malicious counterpart; a victim who cannot tell their own device from someone else's.

**Cheapest effective defence.**
- Hand-off never carries `siteSeed` or the root. Device B generates its own key; A signs a delegate (site, device key, expiry) and the site-level role/permission check honours delegates with an expiry. This needs a ledger-side way to prove a delegate (a new op or a signed link item, 3.7 style) and revocation (D-10 family); until then, a time-limited server-style session token is the only expiring thing (4.1).
- Make the step say what it does: "This gives the device that shows this code full control of <site name>. Only continue if that device is in your hand right now." Require the same gesture class as A5 and, for the root variant, remove it from the UI (explicit "link everything" is the A1 failure delivered by QR).
- Do not offer remote login relays without a proximity proof; if a QR login is wanted, the approving device must show the requesting browser's approximate location/user agent (weak) or require proximity (BLE; not available to a web page, needs measurement).
- Camera scanning of arbitrary QR codes: the loader should refuse any `mwlink:` code that was not requested within the last N seconds by a "Link a device" screen the person opened on purpose (stops scans that arrive through links and shared images).

**Cost.** Slower linking; a delegate protocol. Honest users lose "link everything".

### A7. Reverse-proxy phishing against the cross-site sign-in (major, works against the proposal)

**Preconditions.** The real site's origin S serves the loader and widget. The attacker runs a reverse proxy at `evil.example` that fetches S and rewrites it (a standard phishing kit).

**Steps.**
1. Victim reaches `evil.example` (ad, link). The page and the drop-in script are S's, passed through the proxy, with one change: the loader's notion of "my origin" (the `aud` it builds from `location.origin`, 4.1) is patched to S, and the ledger id selection is S's.
2. The card says "Sign in to S". The loader's code is attacker-controlled, so the proof it produces can carry `aud: S`. If the root, a delegate or a seed is available on `evil.example` (A3), the signature is valid for S.
3. If keys are on the identity origin only (A1), the proxy can also proxy the identity origin. The one thing it cannot proxy is a WebAuthn assertion bound to the identity origin's rpId.

**Why `aud` binding alone does not stop it.** The binding is computed by JavaScript that the page owns. WebAuthn's origin binding is computed by the browser. SIWE-style `aud` checks stop a hostile site that uses the real loader unmodified (the loader writes the page's real origin), which is the case that is blocked today (see section 3). They do not stop a modified loader that has the secrets.

**Defence.** Same as A1: only the identity origin signs, and approval of a new site origin requires a passkey assertion with rpId = identity origin, which the browser refuses on the proxy host. The identity origin must send the origin it saw (`postMessage` `event.origin`, or the redirect/popup opener origin) in the signed challenge, not an origin the page supplies.

**Cost.** One passkey tap when a site is approved for the first time; later sign-ins at that site on that device can be silent under the delegate (A3).

### A8. Verification library and server misuse (major, works against the proposal)

The design's `verifyLogin` is browser-oriented (`c.aud === location.origin`, 4.1) and has no server story. For (c), each item below is a way a reasonable integration becomes account takeover or replay.

1. **Optional nonce.** "if `expectNonce` is given, `c.nonce === expectNonce`" (4.1). A server that forgets the argument accepts any self-issued, loader-nonce proof for 12 hours by default and up to 7 days (`exp - iat <= 7 d`). A proof leaked through a log, an error report, a `Referer` header, a URL parameter, an extension, or a script on the page replays for that long. 4.1 itself says a stolen bearer proof "works until `exp`". For a server, bearer mode should not exist.
2. **Expected origin comes from the caller.** In Node there is no `location`. If the server takes `Host`, `X-Forwarded-Host` or `Origin` from the request to fill the expected `aud`, the attacker supplies it. Sites that hold several origins (path-based tenancy on one origin, `example.com/~alice` and `~bob`) cannot separate tenants by `aud` at all: any page on the origin mints proofs valid for all of them.
3. **"Ledger id or origin" either-or.** The addition says the challenge carries "ledger id or origin". A verifier that checks only `ledger` accepts a proof minted on any origin that serves the same ledger id. Unsigned ledgers use `btih:<btih>` as the id (src/common/pointer.js:698 to 711) and any page can claim a btih (A10), so ledger-only checks accept an attacker origin. Check both always; for server-backed sites with no ledger, `ledger` must be absent and `aud` mandatory.
4. **ECDSA malleability.** For P-256 both `(r, s)` and `(r, n - s)` verify unless a low-S rule is enforced; WebCrypto and noble differ in what they emit and accept. A server that deduplicates replays by signature or proof hash is bypassed by flipping `s`. Deduplicate on the server-issued nonce, not on the proof bytes.
5. **Parser differential.** The signature covers `canonical(c)` (4.1). A server that verifies, then reads fields from a separately parsed copy of the request body (duplicate keys, key order, number or Unicode normalisation differences) can verify one object and use another. The library should return the verified object and the docs must say "use only the return value".
6. **Self-asserted scope.** `scope: ['post','chat','files','read-profile']` is chosen by the prover. A server that grants rights from `c.scope` rather than from its own policy hands out rights the person never held. Scope is a request, never a grant.
7. **Role from a caller-supplied state.** "`c.pub` not banned and its role in the current state permits each scope" (4.1) needs ledger state. For a server-backed site there is none. If the library takes a state object or snapshot from the request, it is forgeable. The server library should omit role and ban checks and leave authorisation to the server.
8. **Pre-hijack by key.** A server that links a first-seen `pub` to an account by an unverified email or username lets an attacker register the victim's identifier with the attacker's per-site key first (classic account pre-hijacking). Per-site keys do not remove this; they make it harder to detect because the key cannot be recomputed by the site. Server docs: bind accounts to `pub` only after separately verified contact data, and treat first sign-in as registration, not recognition.
9. **Clock.** Verification uses the server clock; browsers with wrong clocks produce `iat` far in the past or future, 2 minutes of tolerance (4.1) will reject honest users and invite sloppy servers to widen it. Use a server-issued `iat` and expiry in the challenge and verify those, not the prover's.
10. **Library drift between Node and browser.** Two implementations of `canonical()` are two chances for a mismatch. Golden vectors (3.1 has them for derivation, U-4 for verify) must include hostile cases: duplicate keys, nested Unicode, large integers.

**Cheapest effective defence.** Server library exports one function `verifyServerLogin(proof, { expectedOrigin, nonce, now })` (all three required; no defaults), refuses `kind: 'bearer'`, enforces `aud === expectedOrigin` and absence of a `ledger` mismatch, rejects any `exp - iat` above the server's own limit, returns `{ pub, c }` as the only trusted output, and has a documented "replay store keyed by nonce" interface. Ship a test server and the ten cases as vectors. Cost: server authors write three lines more.

### A9. Shared browser and "locked" that does not lock (major, works against the proposal; no lock exists today)

**Preconditions.** Library, internet cafe, a family tablet, or a work PC. Victim signed in and then "Sign out" (4.2).

**Facts from the design.** "Derived keys at rest: for each ledger, store `keys:<ledgerId>`: `{ sign: CryptoKey (non-extractable), ... }`" and only the symmetric keys are not stored (3.3). `lock` "forget unwrapped root and derived symmetric keys, clear the session proof" (4.2). The sign CryptoKey is not in that list: it stays in IndexedDB, usable, with no wrap.

**Steps.**
1. Next person opens the browser on the same profile, goes to the same site (state: `locked`).
2. Opens the console on the origin and reads the CryptoKey from IndexedDB; `crypto.subtle.sign` works on non-extractable keys. They can post, ban (if moderator), sign login proofs for any server that trusts that site key, or send chat messages as the victim.
3. Optional `sessionStorage` copy of the bearer proof (4.2) stays valid up to `exp`, and some browsers restore sessionStorage on "reopen closed tab". A duplicated tab copies it.

**Today.** The key is always usable, extractable and has no lock at all (src/loader/app.js:546); "Sign out" does not exist.

**Defence.** Persist no unwrapped signing key by default. Persist the wrapped root (or wrapped site seed) only; derive and import the sign key into memory at unlock and drop it at lock. "Remember on this device" is an explicit choice that stores the unwrapped key and says so; "This is a shared computer" is offered at the first card and also forces session-only. Do not use `sessionStorage` for the proof on shared-computer mode. Honest cost: a passkey tap or a passphrase per visit on private devices without the explicit remember choice; none for people who choose to remember.

### A10. Key-selection spoofing: a page names another site's ledger (major, works against the proposal for unsigned ledgers)

**Preconditions.** Per-site derivation by ledger id (3.1). On a drop-in page the ledger id comes from the page's own `<meta name="mw-pointer">` (src/dropin/stamp.js:3 and :136 to 143). An unsigned record (a bare btih) is accepted and gives `ledgerId = "btih:" + btih` (src/common/pointer.js:698 to 711). The btih is whatever the page says.

**Steps.**
1. Hostile page stamps the btih of a popular unsigned site (a forum, a support group) as its pointer.
2. Visitor signs in on the hostile page. The root is present (A1 aside) and the loader derives the visitor's key for that btih ledger, the same key the visitor uses in the forum.
3. Hostile page calls `mw.auth.prove()` and gets a proof with `pub` = the visitor's forum pseudonym. It learns "this visitor is that forum member" and can read the public ledger of that forum for that key's history (per-site unlinkability, R3 F21, is broken for unsigned ledgers: the site can pick which pseudonym to ask for).
4. It can also append to that ledger as the visitor, subject to the consent and fee prompts (the bridge writes to the page's ledger), producing posts attributed to the real pseudonym.

**Today.** Not exploitable across origins: the key store is per origin, so the hostile origin only ever has its own key for that btih. The proposal's cross-origin derivation introduces it.

**Blocked for signed sites.** A signed pointer's ledger id is `hash(ledgerOwner | chain-or-host-scope)`; the attacker cannot sign a pointer for the victim site's owner key, and the scope is the page's host unless `chain=` is set (src/common/pointer.js:698 to 707).

**Defence.** For unsigned ledgers, include the origin in the derivation info (`seed|` + origin + `|` + ledgerId); for signed ledgers the existing id is unforgeable so keep it. The widget never accepts a ledger id from page JS; it takes the one the stamp verifier produced, and the card shows the id's short form and "signed by <owner short>" or "unsigned site". Cost: a mirrored unsigned site yields a different identity per mirror origin; it matches the shell's current per-origin behaviour.

### A11. Rotate and recovery races; moderator social engineering (major, works against the proposal as unspecified)

**D-10 `rotate`** (5): signed by the old key or by the per-ledger recover key announced at the first write.

1. **Self rotation by a thief.** If a thief holds the sign key (A3, A6, A9), `rotate by: 'self'` moves the account to the thief's key. The victim's remedy is `rotate by: 'recover'`. If both are valid in order of arrival, the thief wins by being first; if recover always wins, a thief with the root wins by rotating the recover key too (A1). The text does not define precedence or a waiting period.
2. **Announced recover key.** "announced at the visitor's first write" means a public, permanent link between the site key and a recover key that only the root can sign for. Fine. If the first write was made before D-10 exists (legacy), there is no recover key at all (3.7 migration) and the only remedy is `allow` by an owner or moderator.
3. **Re-admit by moderator.** 5 says a lost key means "owner or moderator can re-admit a new key (allow)". With D-9 moderators can write `allow`. An attacker claims to be a returning member who lost their key, sends the new pub to a moderator through chat or email, and asks for their old posts or role to be moved (site code may map `author` to "posts of ...", `_roles/`). On a server-backed site the same request goes to support staff. This is the main social-engineering path left after phishing and it bypasses all key hygiene.

**Defence.** Specify before the format freeze: recover-key rotation takes effect after a delay (a time lock) during which any key already in the chain can contest it, and a self rotation takes effect only after the same delay; moderators never act on a request received through the same site (use the ledger to carry the request signed by the recover key, which only the person has); display "key changed N days ago" on the account. Cost: a waiting period before a lost key is replaced.

### A12. Phishing inside the site: chat, guestbook, names (major)

**Works today (names).** Profile names are free text with bidi/control filtering only (src/chain/block.js:185 to 205); there is no uniqueness, no confusable check, and `profiles` maps pub to name (src/chain/state.js:530 to 576). Anyone can be "Admin", "Moderator", "Support", "Owner". Role is shown nowhere next to a name by the loader unless the site code does it.

**Against the proposal (chat).** Chat is live between signed-in visitors with room messages as signed plaintext (REALTIME 5.5), DMs, and a public inbox tag for first contact (REALTIME 5.3). A stranger can DM "Your identity needs verification, restore at <lookalike>" to every online member. DMs from keys the person has never seen arrive in their inbox with a display name chosen by the sender. In 3 clicks the victim is at A1. Files add a delivery path for QR images (A6) and for HTML/PDF with links.

**Defence.** Names carry a role badge computed from the ledger (owner, moderator, writer, reader) and the key short id next to every name in cards the loader draws; the sender's name in a first-contact DM is shown with "never seen before" and without links; links in chat are not clickable by default for first-contact senders; nothing in a loader card is ever filled from site or peer text except a plain-text, length-limited site name (see A18 for the challenge `statement`). Reserve "Owner/Admin/Moderator/Support/Staff" lookalikes for role holders (ledger check at setName). Cost: some clutter; a site that wants "Support" as a name needs the role.

### A13. "Use the same identity here" as a dark pattern; link statements (major)

**Steps.** A site the person visits (or a hostile page) wants to recognise them across sites. It offers a discount or access for "Sign in with your magnet-web identity" and the card's choice is a one-click "Use the same identity here" (the addition describes it as an explicit, visible choice). Accepting means signing with a global (root-derived, site-independent) key or publishing a link statement between two per-site keys (`mw.link`-style, 3.7, 3.6). Link statements on a ledger are permanent and public. Two cooperating sites can then join all activity of the person under one key. There is no consent revocation.

**Defence.** No SDK parameter or server challenge field can request linkage; the choice appears only in loader/identity-origin UI the person opened from Settings, naming both sites, stating "permanent and public to anyone who can read either site" for ledger-published links, and offering a non-public alternative (proof to one server only, not stored on any ledger). Use a distinct global key (never the root, never a site key) so a single mistake exposes only linkage, not control. Default per-site on every sign-in. Cost: slower to opt in, which is the intent.

**Linkability that stays.** Colluding sites still link by IP address, timing and writing style (design 9, row 7), and by any site that makes the person "sign in with the same identity" through a different channel (email). State this next to the choice.

### A14. Offline guessing of the identity file and the existing export (major)

**Works today.** The current export is AES-GCM under PBKDF2-SHA256, 600,000 iterations (src/loader/config.js:98), with a passphrase floor of 8 characters (src/loader/app.js:458, src/dropin/identity.js:48). A copy of the file (email attachment, cloud sync folder, backup tool, malware scan upload) is an offline guessing target. Guessing speed is not measured in this review; the outcome for an 8 character human-chosen passphrase needs measurement before anyone quotes it.

**Against the proposal.** The v2 file "restores everything the phrase does" (3.5), so a weak passphrase on a file is a weak phrase. The design lists "a weak passphrase on an exported file" as a residual (9 row 3).

**Defence.** Do not put the root in the file by default (file = one site's seed and records; the phrase remains the only whole-identity backup); require a generated passphrase (4 to 6 random words from the same list) or a strength gate with a stated minimum; Argon2id memory cost chosen per measured device (G-ID-6) rather than fixed; label the file "Do not email". Cost: no casual "just use my cat's name" file.

### A15. Passkey sync provider and SIM-swap become the recovery path (major, needs measurement)

The addition asks for "cross-device by passkey sync". The design deliberately does not rely on it because PRF equality across synced devices is unproven (3.4, Open question 3, G-ID-3). If it is added, the wrapped root must live somewhere other devices can fetch it (the ledger, a file, a cloud folder). Then:
- The account recovery of the passkey provider (email, SMS, support) becomes the identity recovery. A SIM swap or a phished provider account gives the attacker the synced passkey and, with the public wrapped blob, the root.
- A wrapped root published in the clear on a ledger is an offline target for anyone later able to obtain the PRF output.

**Defence.** Offer phrase-only mode; make passkey sync an opt-in with a plain statement that the provider's recovery is now also yours; never publish the wrapped root on a ledger; keep per-site delegates instead (A3). Cost: none by default.

### A16. Malicious browser extension (needs measurement; the project lists it as out of scope)

SECURITY-MODEL excludes malicious extensions and compromised devices. For a phrase-and-secret product this exclusion is wide: extensions with host permissions can read inputs in the page, read the card's closed shadow root (the extension API has a call that returns closed roots; not verified here), read the clipboard when the card offers "Copy" for the phrase, and call WebAuthn from the page world. A "coupon" or "PDF" extension that is later sold or updated is the realistic source. Nothing in-page fixes this.

**Mitigations that reduce exposure.** Show the phrase once, with no "Copy" button (print or write only), never put the phrase in an `<input>` that autofills; restore via passkey or QR instead of typing; hold the passkey as the main unlock; document a dedicated browser profile for identity use. Cost: restores are more deliberate.

### A17. Hostile host, hostile loader update, and the concentration effect (minor, stated limit)

The host and DNS are the trust root on every visit (SECURITY-MODEL "What is not protected"). With a single root per person, a compromised canonical identity origin, CDN or Service Worker update is a single point for a total takeover, and it targets the highest value secrets on the web of magnet-web. The identity origin (A1) concentrates this trust deliberately; it should be treated like a password manager's web vault: pin the loader build by hash in the card (SW install check already uses SHA-384, SECURITY-MODEL "A mixed deploy"), show a build id, and offer a fully offline identity page that can be saved and opened from disk. Cost: more release discipline; the owner must say who runs it.

### A18. A contradiction that blocks the server sign-in as written (major)

4.1 "What is never done" lists "accepting a challenge whose nonce came from site code". Server-backed sign-in (c) requires exactly that: the site's backend issues the nonce and the site's JavaScript hands it to the loader. Either the rule is relaxed or (c) cannot work. If relaxed, the loader must (1) force `aud` to the origin the browser reports (not a value in the challenge), (2) treat the challenge's `domain`, `statement` and `uri` as untrusted text displayed in a distinct, escaped, length-limited region that cannot be styled as loader prose, and (3) refuse if `domain` is not the page's own host. The `statement` field is attacker-controlled text inside a trusted card ("To keep your account safe, enter your recovery phrase below"): the same content-injection that wallets fight with message text. Strip URLs and imperative second-person text, or show it in a quoted block labelled "from <site>".

## 3. What the design already stops (blocked by)

| Attack | Blocked by | Where | Note |
|---|---|---|---|
| Scripted click on a loader card | `isTrusted` filtering | src/loader/ui.js:32 to 40 (`trustedOnly`), src/dropin/panel.js:77 to 82 | does not stop redress (A5) or fake cards (A2) |
| Site code exporting or importing the identity through the bridge | no such methods; unknown methods are rejected | src/loader/bridge.js:24 to 30 (method sets) | does not stop IndexedDB reads (A3) |
| Another window or frame hijacking the bridge | source and origin check on the hello handshake | src/loader/bridge.js:315 to 317 | same-origin site frame is the intended peer |
| Proof minted on one origin used on another, when the signer is the unmodified loader and the server checks `aud` | `aud` bound to `location.origin` (design 4.1) | design only | not stopped for modified loaders (A7); not stopped if the server skips `aud` (A8) |
| Replay of a sealed record under another ledger or author | AAD binds ledger, author, version | design 6.2, U-5 | fine |
| Shell page framed by a lookalike to phish | `frame-ancestors 'none'`, `X-Frame-Options: DENY` on the shell; boot stops inside a frame | SECURITY-MODEL "Framing and clickjacking"; src/sw/core.js:1286 | a lookalike can still copy the loader (A1) |
| Cross-site key equality for signed ledgers | ledger id includes the owner key and the host scope | src/common/pointer.js:698 to 707 | unsigned ledgers excepted (A10) |
| Visitor re-using one key everywhere by default | per-site derivation | design 3.1 | the root becomes the single point (A3) |
| Drive-by load of a site from a link without a click | arrival rules | SECURITY-MODEL "A drive-by load from a link" | unrelated to credentials, listed for completeness |
| Hostile hub sites reading each other's keys | refuse persistent identity on shared-origin hubs | design 3.3 | holds only if the refusal is implemented; today hubs share an origin |

## 4. Residual exposures to state, whatever is built

1. Typing the phrase, restoring a file or scanning a QR on any address other than the identity origin hands over every identity (A1, A2, A6).
2. Unlocking on an origin that runs hostile same-origin script hands over everything the unlock covers (A3, A4); until an identity origin exists that is every site.
3. A server that integrates sign-in wrongly can be replayed or cross-used; the library cannot enforce its own correct use (A8).
4. A person who approves a card because it looked right has no browser-enforced origin binding for anything but passkey assertions at a fixed rpId (A5, A7).
5. Recovery routes (moderator re-admit, provider account recovery) are weaker than the key and become the attack path (A11, A15).
6. Extensions and compromised devices stay out of reach (A16).
7. Colluding sites link by IP, timing and style regardless of key separation (A13).

## 5. Measurements and decisions the owner needs

- **Decision:** is there one canonical identity origin? Every defence above for A1 to A4, A7 and A15 depends on it, and it is a trust root, a naming target and a host to run. Without it the honest sentence is "this protects against other visitors and against passive observers, not against a lookalike page or a hostile site you sign in on".
- **Decision:** may the roots or siteSeeds ever leave the identity origin? Recommend no; delegates only.
- **Decision (format freeze window):** rotate precedence and time lock (A11), a delegate/grant op (A6), `unban` (D-10). These cannot be changed after any public ledger exists without a version bump.
- **Measurement:** whether a determined same-origin script can defeat the redress checks in A5 (expected yes; confirm in the E2E harness with a hostile fixture site); whether `trackVisibility` is usable on WebKit and Gecko.
- **Measurement:** passphrase guessing cost for the 0.2.1 file and the v2 file on current GPUs, with sources, before any public statement (A14).
- **Measurement:** whether a page can set the ledger id the widget derives from (the stamp path says yes for unsigned pointers: src/dropin/stamp.js:136 to 143); add a hostile fixture to confirm the A10 consequence once derivation exists.
- **Measurement:** passkey cross-device PRF equality (G-ID-3) before offering passkey sync as recovery (A15).
- **Tests to add to the plan (12.1, 12.2):** hostile page overlay; modified loader fixture; reverse proxy fixture; click-through card redress; server-library cases 1 to 10 from A8 as vectors; shared-computer lock test; QR scan of an unrequested `mwlink:` code; rotate race.

## 6. Files read for this review

IDENTITY-AUTH-DESIGN.md, REALTIME-AND-FILES-DESIGN.md (sections 4 to 6, 10), README.md in this folder, SECURITY-MODEL.md (threat table and "What is not protected"), and the code: src/loader/bridge.js, src/loader/render.js (sandbox, frame), src/loader/ui.js, src/dropin/panel.js, src/dropin/identity.js, src/dropin/stamp.js, src/dropin/mw.js, src/loader/app.js (identity), src/loader/consent.js, src/common/pointer.js (ledger id), src/chain/block.js (names). Not read in full: ARCHITECTURE.md sections 4, 6, 8, 9, INTERFACES.md, PRIVACY.md, src/sdk/sdk.js, src/loader/torrent.js, src/chain/wire-ext.js, R1 to R8. Findings about those areas are therefore not made here. No code was run and no browser was launched.
