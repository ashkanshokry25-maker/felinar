# Add "Sign in with felinar" to an existing site

Put one button on a page of an existing site. A click opens the person's identity page in a window; the person
approves; your server gets a signed proof it can check. The button is a custom element, `<mw-signin>`, that you host
yourself. This is flow (b) of the v0.3 design ([review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md), "R", 2.3.1
and 2.3.6).

| | |
|---|---|
| Roles | an existing site, static or with a server, that wants a sign-in without running accounts of its own; the checking side is [signin-server-node.md](signin-server-node.md) |
| Status | **v0.3, built and reviewed.** The widget, `publish --signin-widget`, the page-side identity client and the identity origin are built. The final integration ran this flow end to end on loopback in Chromium (e2e E-SI-1W: the Example Forum of `examples/existing-site-dropin`, published with `--dropin --signin-widget --idp`, the identity origin's popup, the proof posted to the forum's server, a session; and E-SI-2 to E-SI-5). The widget finds the identity origin in `<meta name="mw-idp">` or in the `idp=` of the page's stamped pointer (`publish --idp`). Real devices, Safari's popup rules and Firefox: not run |
| Needs | the site's own origin to serve one script file with a Subresource Integrity hash, two URLs on your server, and a page that does not send `Cross-Origin-Opener-Policy: same-origin` |

## Steps

1. **Copy the widget to your site and get the tag.** `publish --signin-widget` copies the widget to `/_mw/signin.js`
   in your published output and prints the script tag with its hash. By hand, serve `signin.js` from your own origin
   and compute the hash yourself:

   ```sh
   openssl dgst -sha384 -binary signin.js | openssl base64 -A
   ```

   The widget is **self-hosted on your origin with a hash, and nowhere else**. A shared widget host would see every site
   that uses it, and a script loaded from another host could be swapped without your knowing (R 2.3.6; the review's
   supply-chain and stalking findings SC-7 and STALK A7).

2. **Add the tag and the element** to the page that should have the button:

   ```html
   <script type="module" src="/_mw/signin.js" integrity="sha384-..." crossorigin></script>
   <mw-signin statement="Sign in to Example Forum" challenge-url="/auth/mw/challenge" proof-url="/auth/mw/verify"></mw-signin>
   ```

   Both URLs must be on the page's own origin; the widget refuses any other. The `statement` attribute is a fallback: the
   sentence your server sends with the challenge wins.

3. **Let the popup talk back.** Send `Cross-Origin-Opener-Policy: same-origin-allow-popups` (never `same-origin`) on pages
   that have the button, or the identity page cannot reach the page that opened it. Where a popup cannot open (some
   in-app browsers), the design falls back to a redirect round trip that returns to `/_mw/idp-return` on your origin
   (R 2.3.1); `publish --signin-widget` is meant to include what that needs.

4. **Write the two routes.** `challenge-url` answers a GET with `{ nonce, statement, exp?, nbf?, resources? }`;
   `proof-url` receives a POST of `{ "proof": { ... } }` and answers with a status that is 2xx on success. The Node code
   in [signin-server-node.md](signin-server-node.md) does both.

5. **React to the result,** if your page wants to:

   ```js
   document.querySelector('mw-signin').addEventListener('mw-signin', (e) => {
     // e.detail is { state: 'pending' | 'signed-in' | 'error', code?, status?, body? }
     if (e.detail.state === 'signed-in') location.reload();
   });
   ```

   A second click within 10 seconds (chosen, R 2.3.9) of the first is refused by the widget and reported as an error event.

## What the person sees

One button inside a closed shadow root, and this sentence under it: "Scripts on this page can act as you on this site
while you are signed in. They cannot reach your other sites." The window that opens is the identity page, whose
address the browser shows. It names your site's address (taken by the browser, not by your page) and shows your
sentence word for word. The person approves with a passkey or the passphrase; the first approval for a new origin needs
that verification, so a reverse proxy cannot get a silent one.

The widget never holds, asks for or shows a phrase, a passphrase or a file. If a button on your site, or a page that
looks like it, asks for the 12 words, it is not this widget: felinar never asks for them on the site you are signing in to.

## What you can and cannot promise

- **A different key on every site.** Unless the person chooses "Use the same identity" for your site, the key they sign
  in with is unique to your origin, and nothing links it to their other sites except what they and you disclose.
- **Your server still sees** the IP address and the user agent at each sign-in. Say so in your privacy notice
  ([PRIVACY.md](../PRIVACY.md#the-recipients-register-v03)).
- **The widget is a speed bump against overlays, not a lock.** It checks at click time that nothing covers the button
  (topmost element, opacity, geometry); a hostile page that can run script on your origin can still act as the person
  on your site while they are signed in.
- **A static site with no server has nobody to check a proof.** The widget is for sites that mint their own sessions. For
  chat and ledger features on a static site, use the drop-in engine: `publish --dropin --chain forum-chat
  --signin-widget --chat-panel --tracker wss://... --stun stun:...` prints the two tags and the CSP lines to add
  (`connect-src` for the tracker and `worker-src 'self'`). The chat panel needs the engine (`/_mw/mw.js`) and a site
  ledger, and is not available without them (R 3.8).

## Checking it

Planned checks: E-SI-1 (the widget against a loopback Node server), E-ID-10 (a scan that finds no phrase or file
field outside the identity page, the widget included), E-ID-11 (a blocked popup falls back to the redirect), E-ID-15 (an
overlay over an in-page card is refused), and the real-host row G-SI-1 ([DEMO-RESULTS.md](../DEMO-RESULTS.md)).

See [README.md](README.md) for the other recipes.
