# W1-09 VERIFY - skeptical re-check of "Opening magnet: links in a web loader"

Verification date: 2026-10-17 (fetches stamped 21:37Z to 22:05Z, i.e. 17:37 to 18:05 ET). Host: macOS 27.0.1 arm64, Node v24.22.0, Playwright 1.64.1.
Subject: the eight design-critical claims lifted from `docs/research/w1-09-protocol-handler-magnet.md` (F1 to F9, G14, R2). Each claim below was re-opened against primary sources and, where a browser could be driven, re-run with newly written test code.
Evidence kit: `docs/research/labs/w1-09-verify-lab/` holds the scripts, the raw JSON/text results, `RUN.txt`, and `results/fetch-manifest.tsv` (UTC time, HTTP status, size and sha256 prefix of every URL fetched). The HTML Standard source (8,010,551 bytes) was fetched at 2026-10-17T21:37Z before the manifest helper existed.
Verdict key: **confirmed** = holds as worded. **nuanced** = the core holds but a wording, a scope or a design consequence must change. **refuted** = false. **unverifiable** = could not be checked here.

---

## 0. Result

| # | Claim (short) | Verdict | The correction that matters |
|---|---|---|---|
| 1 | `magnet` is safelisted (HTML 24 schemes, Chromium `kProtocolSafelist`, Firefox `kSafeSchemes`); other names `web+` plus ASCII letters; Chromium 156 and Brave reject `bittorrent`, `https`, `web+magnet2` and accept `magnet`, `MAGNET`, `web+magnetweb` | **confirmed** | Chromium's list is a 10-scheme superset of the spec/Firefox list; scheme matching is case-insensitive. The original's Brave script ran only 5 cases; I ran 57 on Brave and they equal Chromium's. |
| 2 | Handler URL rules (2 args, `%s` required, https/trustworthy and same-origin, `%s` in host/port fails, relative and query templates OK, manifest needs in-scope URL) | **confirmed** | Add: in an insecure context the method does not exist (no SecurityError); relative templates resolve against the document base URL and, in a manifest, against the manifest URL; `%s` in userinfo is accepted; Firefox checks the scheme last. |
| 3 | `%s` replaced once by `encodeURIComponent`-equivalent encoding of the whole serialized URI; receiver decodes exactly once; spec examples misleading | **confirmed** | Equality re-proved against Chromium's own escape table (bytes 0..255). Decode-once returns the engine-normalized magnet (spaces already `%20`), not the raw typed text. |
| 4 | `detectMode()` decodes handler-built fragments correctly but over-decodes literal `#magnet:?...` links with an encoded `&`, `?` or `=` in a tracker URL; instant.io same | **nuanced** | In the project's parser only encoded `&` and encoded `%XX` sequences corrupt; encoded `?` and `=` do not. In the instant.io path (magnet-uri 7.0.10) encoded `=` silently drops the whole tracker. `detectMode` no longer exists; the rewritten `parseFragment` in `app.js` (18:06 ET) already decodes once and passes the matrix. |
| 5 | `/#%s` keeps infohash and trackers out of HTTP requests and host logs; manifest parser accepts it; qBittorrent moved query to hash after review; instant.io uses hash | **nuanced** | HTTP/log/Referer part observed true in Chromium 156 and WebKit 27.2. But a service worker sees the fragment in the navigation request URL, redirects inherit it, and qBittorrent's switch was the author's own preference with no privacy rationale. |
| 6 | Web-handler support matrix as of 2026-10-17 | **nuanced** | Chromium-on-Android has the API compiled out (Blink flag) while Firefox Android has the method but it does nothing; "all iOS browsers" is not strictly true in the EU (alternative engines allowed, none verified); Edge and other Chromium browsers not run. |
| 7 | Safari/WebKit has no `registerProtocolHandler` (IDL, Playwright WebKit 27.2, caniuse, bug 73177) | **confirmed** | Also true of the shipping system WebKit on this Mac (Safari 27.0.1 engine). Minor: caniuse's desktop Safari row is `n` for 3.1 to TP (27.1/27.2 are unreleased); bug 73177 is about content handlers and WebKit deleted its own module on 2019-03-25. |
| 8 | Firefox for Android does not support it (bug 917866, caniuse `and_ff n`); BCD says `mirror` | **nuanced** | Functionally true, but the method exists there (WebIDL is unconditional) and the call is a silent no-op, so `typeof navigator.registerProtocolHandler === 'function'` is true on Firefox Android. BCD is right about the API surface, wrong about behavior. This breaks R4's feature test. |

Net: no claim is refuted. Four need wording changes (4, 5, 6, 8). Three of those also change a design detail: the trigger set behind R2 (claim 4), what a service worker or a redirect can see of the fragment (claim 5), and the R4 feature test (claim 8).

---

## 0.1 Method and limits (read before trusting any verdict)

- **Web search was not available.** Both of my `WebSearch` attempts were refused ("this turn's web search budget is used up"). I did not route around that with search engines, proxies or archive services. Everything below comes from direct fetches of named primary sources (raw GitHub files, Bugzilla and WebKit Bugzilla REST, Searchfox, Chrome Platform Status API, caniuse/BCD data, Apple and WebKit pages, RFC text) and from running code. Anything that would have needed an open-ended search is listed in section 10.
- **Browsers actually driven:** Playwright Chromium 156.0.8078.4; Brave Browser 155.1.97.59 (Chromium 155.0.8059.85, headless, throwaway profile, deleted; `navigator.brave.isBrave()` true); Playwright WebKit 27.2 (a tip-of-tree build, not Safari.app); and the system WebKit (WebKit.framework 22625.1.29.11.28 on macOS 27.0.1, the engine under Safari.app 27.0.1) through a small WKWebView program.
- **Firefox was not run.** Playwright's Firefox build 1555 (Firefox 157.0) exits with "Could not find profile folder." for every `-profile` path and for `-CreateProfile` (headless `ProfileMissingDialog` path in `toolkit/xre/nsAppRunner.cpp`). Every Firefox statement here is from Gecko source.
- Headless runs prove validation and parsing only. They cannot show or accept the consent UI. All `registerProtocolHandler` calls ran in throwaway or ephemeral profiles (deleted). Afterwards I checked LaunchServices: `NSWorkspace.urlForApplication(toOpen:)` returns no application for `magnet:`, `web+magnetweb:` or `web+magnetweb2:`, and `LSHandlers` has no `magnet` or `web+` entry (`scripts/defhandler.swift`), so no run left an OS-level default behind.
- **The project tree is changing under the research.** `src/loader/render.js` was rewritten at 17:53 ET (38,901 bytes, no `detectMode` export) while `src/loader/app.js` (Oct 14) still imports `detectMode`. For claim 4 I therefore tested (a) a verbatim copy of the pointer-detection lines I had read at about 17:44 ET (`labs/w1-09-verify-lab/scripts/old_detect_mode.mjs`) with the live `src/common/magnet.js` (modified 17:41 ET), and (b) afterwards the rewritten `parseFragment` in `src/loader/app.js` (modified 18:06 ET).

---

## 1. Claim 1 - safelist and scheme naming

**Verdict: confirmed.**

What holds (all fetched 2026-10-17):
- **HTML Standard.** `normalize protocol handler parameters` lowercases the scheme, then throws SecurityError unless it is a safelisted scheme or "a string starting with `web+` followed by one or more ASCII lower alphas". The safelist has exactly 24 entries and includes `magnet`: bitcoin ftp ftps geo im irc ircs magnet mailto matrix mms news nntp openpgp4fpr sftp sip sms smsto ssh tel urn webcal wtai xmpp. Rendered page https://html.spec.whatwg.org/multipage/system-state.html#custom-handlers shows "Last Updated 16 October 2026"; source https://raw.githubusercontent.com/whatwg/html/main/source (section "Custom scheme handlers", line 131988 of the file I fetched).
- **Firefox.** `dom/base/Navigator.cpp` `kSafeSchemes[]` is the same 24 (set comparison in `results/safelists.txt`: identical), with the comment "This list should be kept up-to-date with the spec". The scheme is lowercased; after `web+` the suffix must be non-empty and every character `a` to `z`.
- **Chromium.** `third_party/blink/common/custom_handlers/protocol_handler_utils.cc`: `kProtocolSafelist[]` has 31 names including `magnet`; `ftp`, `ftps`, `sftp` are accepted by a separate branch; `payto` only behind `features::kSafelistPaytoToRegisterProtocolHandler`. The `web+` prefix is matched with `base::CompareCase::INSENSITIVE_ASCII` and the remainder must be at least one `base::IsAsciiAlpha` character. A bad scheme throws SecurityError (`VerifyCustomHandlerScheme` then `ThrowSecurityError`).
- **Runtime, 57 cases, Chromium 156.0.8078.4 and Brave 155.1.97.59 give identical results** (`results/val_chromium.json`, `results/val_brave.json`). Accepted: `magnet`, `MAGNET`, `Magnet`, `web+magnetweb`, `WEB+MagnetWeb`, `web+a`, `mailto`, `tel`, `ftp`, and the Chromium-only `ipfs`. SecurityError: `bittorrent`, `https`, `http`, `javascript`, `data`, `file`, `blob`, `x-magnet`, `ext+magnet`, `web`, `web+magnet2`, `web+`, `web+magnet-x`, `web+magnet_x`, `web+mägnet`, `magnet:`, empty string, `" magnet"`, `"magnet "`, `payto`. Messages: "The scheme 'bittorrent' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'." for names outside the list; "The scheme name 'web+magnet2' is not allowed. Schemes starting with 'web+magnet2' must be followed by one or more ASCII letters." for bad `web+` suffixes; "... is not allowed by URI syntax (RFC3986)." for `magnet:`, empty and padded names.

Corrections and nuances:
1. **The scheme set is not identical across engines.** Chromium's is the spec's 24 plus ten more: cabal, dat, did, doi, dweb, ethereum, hyper, ipfs, ipns, ssb (`ipfs` accepted at runtime). Firefox equals the spec. "Closed set" is right; "the same set everywhere" would be wrong.
2. **Matching is case-insensitive.** The spec's "ASCII lower alphas" applies after lowercasing, so `WEB+MagnetWeb` is valid. "web+ plus ASCII letters" is the correct short form.
3. **Brave evidence was thinner than the sentence.** The original `exp_brave.mjs` ran five cases (magnet, web+magnetweb, bittorrent, missing `%s`, cross-origin). F1 also reports Brave results for `MAGNET`, `https`, `magnet:`, `web+`, `web+magnet2`; those were never run on Brave in the original. I ran them. The sentence is true, but it was not earned until now.
4. **"Chromium 156" label.** The Playwright binary is 156.0.8078.4, an early M156 build: Chromium Dash lists Beta 156.0.8078.12 (2026-10-07) with `previous_version` 156.0.8078.4, and a Mac Stable entry 156.0.8078.36 dated 2026-10-14. Same validation code; I did not diff the builds.
5. **The list still moves.** Chrome Platform Status entry 5199727026503680 says `payto` is "Enabled by default", but both 156.0.8078.4 and Brave 155 reject `payto`. Irrelevant to `magnet`, but do not hard-code the Chromium list.

Not verified: Firefox at runtime (source only); Edge, Opera, Vivaldi.

Sources: https://raw.githubusercontent.com/whatwg/html/main/source ; https://html.spec.whatwg.org/multipage/system-state.html ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/common/custom_handlers/protocol_handler_utils.cc ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/navigatorcontentutils/navigator_content_utils.cc ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/base/Navigator.cpp ; https://chromiumdash.appspot.com/fetch_releases?channel=Beta&platform=Mac&num=2 ; https://chromestatus.com/api/v0/features?q=registerProtocolHandler ; lab: `results/val_chromium.json`, `results/val_brave.json`, `results/safelists.txt`.

---

## 2. Claim 2 - handler URL rules

**Verdict: confirmed, with six refinements.**

| Rule | Spec / manifest spec | Chromium 156 and Brave 155 (run) | Firefox (source only) |
|---|---|---|---|
| Two arguments | IDL `registerProtocolHandler(DOMString scheme, USVString url)` | `navigator.registerProtocolHandler.length === 2`; a third `title` argument returns normally (WebIDL ignores extra arguments) | IDL `(DOMString scheme, DOMString url)` |
| `%s` required | "If url does not contain `%s`, then throw a SyntaxError" | SyntaxError "The url provided ('...') does not contain '%s'." (also for `''`) | `ThrowSyntaxError("Handler URI does not contain \"%s\".")` |
| https/trustworthy, same-origin | non-HTTP(S) scheme or origin not same origin: SecurityError; then an assert that the URL is potentially trustworthy ("implied by the same origin condition" inside a secure context) | SecurityError "Can only register custom handler in the document's origin." for other origin, other port, `localhost` vs `127.0.0.1`; SecurityError "The scheme of the url provided must be HTTP(S)." for `http://example.org`, `ftp:`, `javascript:`, `data:`, `blob:` | both document and handler must be http/https, same scheme and host:port, else SecurityError "Permission denied to add %s as a protocol handler" |
| `%s` in host or port | note: "This is forcibly the case if the `%s` placeholder is in the host or port of the URL" (SyntaxError) | SyntaxError for `http://%s.<host>/`, `http://127.0.0.1:%s/`, and `%s` inside the port digits of the same origin | not run |
| Relative and query templates | URL parsed "relative to environment" | ok: `/#%s`, `#%s`, bare `%s`, `?m=%s`, `/open#%s`, `//host/#%s`, two `%s` | n/a |
| Manifest: URL within scope | WICG Manifest Incubations: normalize with the manifest URL as base, then "If normalizedUrl is not within scope of manifest, continue" | 19 `protocol_handlers` cases through CDP `Page.getAppManifest`, identical in Chromium and Brave: `/#%s` accepted; scope `/app/` with url `/#%s` rejected ("property 'url' ignored, should be within scope of the manifest."); scope `/app/` with `/app/#%s` accepted; cross-origin rejected with the same scope message; `%s` in host rejected ("URL is invalid") | no `protocol_handlers` support |

Refinements to the wording:
1. **In an insecure context the method is absent, not rejecting.** On `http://hub.test:PORT` (not loopback) Chromium reports `isSecureContext: false`, `typeof navigator.registerProtocolHandler === 'undefined'` (`results/insecure.json`). The IDL has `[SecureContext]` in the spec, Chromium and Firefox. Feature detection is therefore false, and no SecurityError path exists.
2. **Chromium's message "created by removing '%s' and prepending ..." is misleading.** The code parses the template with `%s` still in it (`window.CompleteURL(user_url)`), like the spec, which is why `%s` buried in the port digits of the same origin also fails.
3. **`%s` in userinfo is accepted** by Chromium (`http://%s@host/` returned normally). The spec note names only host and port.
4. **Check order.** Spec and Chromium check the scheme first (bad scheme plus missing `%s` gives SecurityError). Firefox checks missing `%s`, then http(s) and same host:port, and only then the scheme. It matters only when two things are wrong.
5. **Relative templates depend on the base.** A `<base href="https://example.org/">` turned a relative `/#%s` into a SecurityError. In a manifest, relative templates resolve against the manifest URL: `#%s`, `./#%s` and bare `%s` were accepted (manifest in scope) but point at the manifest file, not at `start_url`. Only root-relative (`/x#%s`) or absolute templates are safe in `protocol_handlers`.
6. **"Trustworthy" is its own check in Chromium** (`IsUrlPotentiallyTrustworthy`), surfaced with the same "must be HTTP(S)" text even when the scheme is `http`.

Not verified: Firefox behavior at runtime (including whether Gecko's URL parser rejects `%s` in a host or port exactly as the spec note says).

Sources: https://raw.githubusercontent.com/whatwg/html/main/source ; https://raw.githubusercontent.com/WICG/manifest-incubations/gh-pages/index.html ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/navigatorcontentutils/navigator_content_utils.cc ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/navigatorcontentutils/navigator_content_utils.idl ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/manifest/manifest_parser.cc ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/base/Navigator.cpp ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/webidl/Navigator.webidl ; lab: `results/val_chromium.json`, `results/val_brave.json`, `results/man_chromium.json`, `results/man_brave.json`, `results/insecure.json`.

---

## 3. Claim 3 - `%s` substitution and encoding

**Verdict: confirmed.**

What holds:
- **Spec.** On invocation: clear username and password, serialize, "UTF-8 percent-encode on inputURLString using the component percent-encode set", then "Replace the first instance of `%s`" and navigate.
- **URL Standard.** Component set = userinfo set plus `$` to `&`, `+`, `,`. Its own note: "Using it with UTF-8 percent-encode gives identical results to JavaScript's `encodeURIComponent()`". The original rebuilt the sets from `url.bs` and compared them for U+0000 to U+007F; I re-proved the equality a second, independent way: Chromium's actual escape table `kQueryCharmap` in `base/strings/escape.cc` (used by `EscapeQueryParamValue(text, use_plus=false)`) disagrees with `encodeURIComponent` on none of the 256 byte values; unescaped set `!'()*-.0-9A-Za-z_~` (`results/charmap.txt`).
- **Chromium code.** `ProtocolHandler::TranslateUrl` (`components/custom_handlers/protocol_handler.cc`): `ReplaceFirstSubstringAfterOffset(&translatedUrlSpec, 0, "%s", base::EscapeQueryParamValue(url_spec, false))`. A Chromium browser test (`RegisterProtocolHandlerExtensionBrowserTest.Basic`, `chrome/browser/custom_handlers/protocol_handler_registry_browsertest.cc`) registers `geo` as `test.html?%s`, navigates to `geo:test` and asserts the result ends `?geo%3Atest`: the colon is encoded.
- **Firefox code.** `uriloader/exthandler/WebHandlerApp.sys.mjs`: `encodeURIComponent(aURI.spec)` then `this.uriTemplate.replace("%s", escapedUriSpecToHandle)` (first match only).
- **Interop history and tests.** whatwg/html#3377 (2018-01-19, "navigator.registerProtocolHandler specification divergent from both implementations"): both engines already escaped `%` and `+`; on 2020-05-12 Anne van Kesteren wrote "I had not yet realized that the above set I recommended is identical to encodeURIComponent()". The WPT manual tests expect `${encodeURIComponent(scheme)}%3A...` in the result (`html/webappapis/system-state-and-capabilities/the-navigator-object/resources/handler-tools.js`). Chrome's own PWA doc (updated 2021-05-11) shows `web%2Bcoffee%3A%2F%2Flatte-macchiato` and "The search string URL-decoded then reads ?type=web+coffee://latte-macchiato".
- **Spec examples are wrong.** The HTML Standard's example gives `https://example.com/soup?url=web+soup:chicken-k%C3%AFwi`; the algorithm yields `web%2Bsoup%3Achicken-k%25C3%25AFwi`. The WICG example (`https://example.com/play?songId=web+music://%231234`) has the same defect. Both examples are unchanged in the sources I fetched on 2026-10-17 (HTML Standard "Last Updated 16 October 2026"; WICG gh-pages).
- **Observed:** `location.hash` returns the fragment exactly as the engine built it, with no decoding (`pageHashEqualsSecret: true` in Chromium 156 and WebKit 27.2, `results/frag_*.json`), so decode-once is the correct receiver rule.

Nuances (none change the verdict):
1. **Older Chrome encoded U+0020 as `+`.** Chrome Platform Status entry 5678518908223488 (bug 1110842): spaces now become `%20` "consistent with other browsers such as Firefox". The current code passes `use_plus=false`. The status entry reads "No active development", which does not match the code; I did not find which release made the change.
2. **Decode-once returns the engine-normalized magnet, not the typed text.** `a.href` already turns spaces into `%20`, `"` into `%22` and non-ASCII into UTF-8 escapes in both Chromium and WebKit before the `%s` step (`results/serialize.txt`); the `%` of each of those then becomes `%25`. Compare parsed fields, never raw strings.
3. **Credentials.** Chromium strips userinfo only behind `kStripCredentialsForExternalProtocolHandler`; Firefox only for `ftp`, `ftps`, `sftp` (its own code comment says the rest is an XXX). A magnet URI has no authority, so this is moot here.
4. **Installed-PWA launch path not traced.** I did not find the Chromium function that translates a protocol URL for an installed web app. Chrome's PWA doc example shows the same encoding, but the code path is unverified.

Sources: https://raw.githubusercontent.com/whatwg/html/main/source ; https://raw.githubusercontent.com/whatwg/url/main/url.bs ; https://raw.githubusercontent.com/WICG/manifest-incubations/gh-pages/index.html ; https://raw.githubusercontent.com/chromium/chromium/main/components/custom_handlers/protocol_handler.cc ; https://raw.githubusercontent.com/chromium/chromium/main/base/strings/escape.cc ; https://raw.githubusercontent.com/chromium/chromium/main/base/strings/escape.h ; https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/custom_handlers/protocol_handler_registry_browsertest.cc ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/uriloader/exthandler/WebHandlerApp.sys.mjs ; https://github.com/whatwg/html/issues/3377 ; https://raw.githubusercontent.com/web-platform-tests/wpt/master/html/webappapis/system-state-and-capabilities/the-navigator-object/resources/handler-tools.js ; https://developer.chrome.com/docs/web-platform/best-practices/url-protocol-handler ; https://chromestatus.com/api/v0/features?q=protocol%20handler ; lab: `results/charmap.txt`, `results/serialize.txt`, `results/frag_chromium.json`, `results/frag_webkit.json`.


---

## 4. Claim 4 - the loader's fragment decode

**Verdict: nuanced.** The core (handler-built form decodes right, literal share links are over-decoded, instant.io has the same pattern) is true. The list of trigger characters is wrong in a way that matters, and the function no longer exists.

What holds:
- Research-time `detectMode()` (render.js as of Oct 14, read about 17:44 ET) applied `decodeURIComponent` to the whole fragment unconditionally (a `try/catch` only covers malformed escapes), then `isPointerHash` and `normalizePointerText`.
- The handler-built form `#` + `encodeURIComponent(magnet)` round-trips for every character I tried, in both the project parser and magnet-uri.
- The claim's own example, a literal `#magnet:?xt=...&tr=wss%3A%2F%2Ftracker.example%3A443%2Fannounce%3Fkey%3Da%26b%3Dc`, yields `tr = ["wss://tracker.example:443/announce?key=a"]` in the project (the original had `...?key=a&b=c`).
- instant.io `client/index.js` (master): `const hash = decodeURIComponent(window.location.hash.substring(1)).trim()` in `onHashChange`, and `navigator.registerProtocolHandler('magnet', window.location.origin + '#%s', 'Instant.io')` on every load, commented "(will prompt the user)". That file's last commit is 2022-07-05, so it is older than the 2024 to 2026 window.

Correction 1 - which characters corrupt (one special character at a time inside the tracker URL path; `results/decode2.txt`):

| Character (as escaped in the link) | Project `detectMode` + `parseMagnet`, literal link | instant.io path (`decodeURIComponent` + magnet-uri 7.0.10), literal link | Handler-built link, both |
|---|---|---|---|
| `&` (`%26`) | **corrupts**: tracker cut at the `&` (a `dn` of "Q&A Site" becomes "Q") | **corrupts**: tracker dropped, stray parameter created (`announce: []`, `b: "c"` for the claim's example) | ok |
| `=` (`%3D`) | ok (parser keeps `=` inside a value) | **tracker silently dropped**: magnet-uri skips any parameter whose `split('=')` is not exactly two parts | ok |
| `?` (`%3F`) | ok | ok | ok |
| `#`, `+`, `/`, `:`, `@`, space, `é` | ok | ok | ok |
| lone `%` (`%25`) | ok (parser falls back to the raw text) | **throws** `URIError: URI malformed` inside magnet-uri | ok |
| a literal escape such as `%41` (`%2541`) | **corrupts**: double-decoded to `A` | **corrupts** | ok |

So "an encoded `&`, `?`, or `=`" is wrong for `?` (harmless in both), right for `&` (both), and right for `=` only on the WebTorrent/instant.io path. It also misses the encoded-percent case (`%25` followed by two hex digits), which corrupts in both. `formatMagnet()` always emits `%3A%2F%2F`-style escapes for trackers, so every project-generated link that carries a tracker with a query string is exposed.

Correction 2 - the fix holds. The note's R2 function `fragmentToPointerText` (decode once only when the fragment starts with `magnet|btih|host` followed by `%3a`) round-trips all 13 characters in both forms with both parsers (`results/decode_fix.txt`).

Correction 3 - the code moved, and the fix appears to have landed during this session. `src/loader/render.js` was rewritten at 17:53 ET and exports no `detectMode`. `src/loader/app.js` was then rewritten at 18:06 ET with `parseFragment(hash, search)`, whose comment says "The magnet and record texts are left encoded: their own parsers decode values" and which decodes only when the fragment starts with `magnet%3a%3f`. I ran the current `parseFragment` plus `parseMagnet` through the same 13-character matrix: both forms round-trip for every character, and the claim's own example now keeps `&b=c` (`results/decode_current.txt`). So against today's tree the corruption is gone; against the code the research note analysed (Oct 14 `detectMode`) it was real, as measured above. The tree is still being edited (`app.js` changed 18:06:07 ET), so re-run `scripts/exp_decode_current.mjs` before relying on this.

Not verified: any other reader of `location.hash` outside `parseFragment` (`render.js` still passes `hash` through in several path helpers; those only forward it).

Sources: https://raw.githubusercontent.com/webtorrent/instant.io/master/client/index.js ; https://github.com/webtorrent/instant.io/commits/master/client/index.js ; `node_modules/magnet-uri/index.js` (v7.0.10, the parser WebTorrent uses) ; lab: `results/decode2.txt`, `results/decode_fix.txt`, `results/decode_current.txt`, `scripts/old_detect_mode.mjs`, `scripts/exp_decode2.mjs`, `scripts/exp_decode_fix.mjs`, `scripts/exp_decode_current.mjs`.

---

## 5. Claim 5 - `/#%s` keeps the magnet out of HTTP requests and logs

**Verdict: nuanced.** The privacy statement the claim makes is true and now observed. Three nearby assumptions in the original are not.

What holds:
- **Normative text.** RFC 3986 section 3.5: "the fragment identifier is separated from the rest of the URI prior to a dereference, and thus the identifying information within the fragment itself is dereferenced solely by the user agent, regardless of the URI scheme." The HTTP rules are in RFC 9110: section 7.1 "The target URI excludes the reference's fragment component, if any, since fragment identifiers are reserved for client-side processing"; section 10.1.3 "A user agent MUST NOT include the fragment and userinfo components of the URI reference ... when generating the Referer field value."
- **Observed.** I navigated a fresh document to `http://127.0.0.1:P/#` + the exact fragment a handler would build (`encodeURIComponent` of a magnet with an encoded tracker). The server saw `GET /` and a sub-resource `GET /sub.js` with `Referer: http://127.0.0.1:P/`; neither the request lines nor the Referer headers (the two fields my log recorded) contained the fragment. Same result in Chromium 156.0.8078.4 and WebKit 27.2 (`results/frag_chromium.json`, `results/frag_webkit.json`).
- **Manifest.** Chromium 156 and Brave 155 accept `{protocol:"magnet", url:"/#%s"}`, `/?m=%s`, `/open#%s`, and with scope `/app/` the url `/app/#%s` (`results/man_chromium.json`). The parser calls `ParseURL(..., ParseURLRestrictions::kWithinScope)` then re-validates with `%s` removed.
- **instant.io** registers `window.location.origin + '#%s'` (see claim 4).

Corrections:
1. **The fragment is not private from the client side, and one place the original says otherwise is wrong.**
   - A **service worker sees it**: in a controlled navigation, `FetchEvent.request.url` was `http://127.0.0.1:P/other#magnet%3A%3Fxt%3D...` in both Chromium 156 and WebKit 27.2. The original F13 says "The service worker only ever sees the path (`/`); the fragment is never in the request." That is false for the Request object (the network request omits it). A worker that logs, caches by or forwards `request.url` leaks it.
   - **Redirects inherit it** (RFC 9110 section 10.2.2; section 17.11 "Disclosure of Fragment after Redirects" warns this "might have the effect of disclosing one site's fragment to another site"). Observed: a 302 whose `Location` has no fragment, same-origin and cross-origin (127.0.0.1 to localhost), kept the full fragment in `location.hash` in both engines; no server saw it, but any script on the second origin would (`results/redir_chromium.json`, `results/redir_webkit.json`). Any apex-to-www or CDN redirect in front of the hub is such a hop.
   - Scripts and extensions on the page, browser history and sync, and any analytics call that reports `location.href` also see it. Not tested.
2. **"Accepted by the manifest parser" is not "launched with the fragment intact".** The original already lists this as Q1; I did not close it (no installed-PWA run).
3. **qBittorrent.** PR #10552 (opened 2019-04-30 by CoryG89 with the magnet in a query parameter named `magnet`; Chocobo1 reviewed the same day, approved 2019-05-06 and merged commit 412b51f on 2019-05-07; milestone 4.2.0). The move to the hash is in the author's 2019-05-01 comment replying to @Chocobo1's first review: "I'm now passing the param in the URI hash rather than in the query string. I think I would prefer it in the hash, but I can revert this change to use the query string if desired." So it happened in the revision after the first review, framed as the author's own preference; nothing in the visible thread gives a privacy or log rationale. The four inline review threads from 2019-04-30 are collapsed in the page HTML, so I cannot say whether the reviewer asked for the hash. Current master (`src/webui/www/private/scripts/client.js`) still uses `#download=%s`, makes the two-argument call only from a click handler (`registerMagnetHandlerLink`), and decodes once with `decodeURIComponent(location.hash.substring("#download=".length))`.
4. instant.io's version is a counter-example for R4: it registers on every load with a legacy third argument.

Suggested wording: "A `#%s` template keeps the magnet out of HTTP requests, the Referer header and static-host logs (RFC 9110 sections 7.1, 10.1.3; observed in Chromium 156 and WebKit 27.2). It stays visible to page scripts, extensions, history, the service worker (navigation `request.url` includes it) and, through redirects, to the redirect target's scripts."

Not verified: browser-side telemetry paths (history sync, Safe Browsing, UKM), installed-PWA launch with fragment.

Sources: https://www.rfc-editor.org/rfc/rfc3986.txt ; https://www.rfc-editor.org/rfc/rfc9110.txt ; https://github.com/qbittorrent/qBittorrent/pull/10552 (+ `.patch`) ; https://raw.githubusercontent.com/qbittorrent/qBittorrent/master/src/webui/www/private/scripts/client.js ; https://raw.githubusercontent.com/webtorrent/instant.io/master/client/index.js ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/manifest/manifest_parser.cc ; lab: `results/frag_chromium.json`, `results/frag_webkit.json`, `results/redir_chromium.json`, `results/redir_webkit.json`, `results/man_chromium.json`, `results/man_brave.json`.


---

## 6. Claim 6 - web-handler support matrix

**Verdict: nuanced.** Every "yes" and "no" holds for the browsers I could test or read the code of. Three rows need rewording, and two groups are untested.

| Platform | Claim | Fresh evidence | Status |
|---|---|---|---|
| Chrome desktop | yes; method since 13, `magnet` since 30 | BCD (main, 2026-10-17): `registerProtocolHandler` chrome `"13"`, `scheme_parameter_magnet` chrome `"30"`; Chromium 156.0.8078.4 accepts `magnet` (claim 1) | confirmed |
| Edge desktop | yes, 79+ | BCD edge `"79"` (mirrors Chrome); same Chromium code; **not run** | confirmed by data and shared code only |
| Brave desktop | yes | Brave 155.1.97.59 accepts `magnet`, `MAGNET`, `web+magnetweb`, 57 cases identical to Chromium; headless, so prompt UI not seen | confirmed (validation only) |
| Opera, Vivaldi, Arc, other Chromium desktop | yes | **not run**; BCD lists Opera `"11.6"` | unverified |
| Firefox desktop, private windows ignore | yes | BCD firefox `"2"` (caniuse `y` from 3); `Navigator::RegisterProtocolHandler` logs `RegisterProtocolHandlerPrivateBrowsingWarning` and returns when `loadContext->UsePrivateBrowsing()`; **not run** | confirmed from source |
| Safari macOS | no | claim 7 | confirmed |
| Safari iOS and "all iOS browsers" | no | WebKit has no API (claim 7). But Apple's page "Using alternative browser engines in the European Union" says apps with the Web Browser Engine Entitlement may use a non-WebKit engine for EU users on iOS 17.4 / iPadOS 18 and later. I found no evidence that such a browser exists or implements this API. Japan not checked. | nuanced |
| Chrome, Edge, Samsung, Opera on Android | no | BCD `chrome_android: false` with `impl_url` https://crbug.com/40964464; `samsunginternet_android`, `opera_android`, `webview_android` are `"mirror"`; caniuse: `and_chr` 154 n, `samsung` 4 to 30 n, `op_mob` 10 to 80 n. **Code:** Blink `runtime_enabled_features.json5` has `NavigatorContentUtils` with `status: {"Android": "", "default": "stable"}` and the comment "Android does not yet support NavigatorContentUtils."; the IDL methods carry `[RuntimeEnabled=NavigatorContentUtils, ...]`, so the method is absent, not a no-op. Not run on a device. | confirmed (strong) |
| Firefox Android | no | claim 8: unsupported in behavior, but the method exists | nuanced |

Also relevant: secure context is required (BCD `secure_context_required`: Chrome 80, Edge 79, Firefox 62; Chrome Status entry "registerProtocolHandler from non-secure contexts", status Removed, desktop 80). I measured the effect in Chromium: absent on a non-loopback http origin (claim 2).

Wording to change:
1. "all iOS browsers" becomes "every iOS browser that uses WebKit, i.e. all of them outside the EU; EU browsers with an alternative engine are unverified".
2. State the Android difference explicitly: Chromium-on-Android has no method (detection false); Firefox Android has a method that does nothing (detection true).
3. "yes" means the call is accepted. Whether the user can accept it and whether it persists (OS-default sync on Windows and macOS, Firefox "Add application" not being default, "Never allow" only from Firefox 160) rests on source reading in the original, not on anything I could run headless.

Sources: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json ; https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/registerprotocolhandler.json ; https://raw.githubusercontent.com/Fyrd/caniuse/main/fulldata-json/data-2.0.json (updated 2026-10-13 05:12 UTC; release dates) ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/runtime_enabled_features.json5 ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/navigatorcontentutils/navigator_content_utils.idl ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/base/Navigator.cpp ; https://developer.apple.com/support/alternative-browser-engines/ ; https://chromestatus.com/api/v0/features?q=registerProtocolHandler ; lab: `results/val_chromium.json`, `results/val_brave.json`.

---

## 7. Claim 7 - Safari / WebKit has no `registerProtocolHandler`

**Verdict: confirmed.** Two small corrections to the supporting detail.

Evidence:
- **IDL.** WebKit main `Source/WebCore/page/Navigator.idl` has exactly 14 `Navigator includes` lines (Badge, ID, Language, Locks, MaxTouchPoints, OnLine, Cookies, Plugins, ServiceWorker, Share, Storage, GPU, GlobalPrivacyControl, UA); no content-utils mixin.
- **Stronger than the IDL:** WebKit deleted the whole module. The GitHub history of `Source/WebCore/Modules/navigatorcontentutils` ends with "Remove NavigatorContentUtils in WebCore/Modules", 2019-03-25T08:07:14Z; the directory is a 404 on main and only a stale include path remains in `Source/WebCore/CMakeLists.txt`. Before that it existed as a separate module (bug 73177's 2011 to 2014 patches were EFL-port work on it); Safari never exposed it (caniuse `n` throughout).
- **Runtime, Playwright WebKit 27.2 (build 2370):** `typeof navigator.registerProtocolHandler` is `"undefined"`, `'registerProtocolHandler' in navigator` false, the prototype lacks it, and calling it throws `TypeError ... is not a function`; the same inside an `allow-scripts allow-same-origin` iframe and an opaque `allow-scripts` iframe (`results/val_webkit.json`). Caveat: 27.2 is a tip-of-tree engine (Apple lists "Safari 27.2 Beta Release Notes").
- **Runtime, shipping engine (new).** A WKWebView program on this Mac (WebKit.framework 22625.1.29.11.28, macOS 27.0.1; Safari.app is 27.0.1) with a secure `https://example.com/` base URL reports `typeof navigator.registerProtocolHandler` `"undefined"`, `in navigator` false, no handler-like members on `Navigator.prototype` (`results/wkcheck.json`). It is WKWebView, not Safari.app, but both load the same WebKit.framework and the open-source tree has no implementation for Safari to switch on.
- **Release notes.** Zero hits for `registerProtocolHandler`, "protocol handler", `protocol_handlers`, `magnet`, `web+` in Apple's "Safari 27 Release Notes" (about 99,000 characters), "Safari 27.2 Beta Release Notes", "WebKit Features for Safari 27.0" (webkit.org/blog/18325, about 150,000 characters) and Safari Technology Preview 253 and 254 notes. Absence in release notes is supporting, not proof.
- **caniuse** (data updated 2026-10-13): `safari` is `n` for 3.1 through TP; `ios_saf` is `n` for 3.2 through 27.2.
- **Bug 73177** "Add Custom Content Handler": status RESOLVED, resolution INVALID, last change 2023-04-03T11:48:30Z; the closing comment (annevk) reads "If there is an initiative to add this API again it would benefit from a clean approach so let's close this."
- **Position trackers.** WebKit/standards-positions has no issue for `registerProtocolHandler` (GitHub issue search 2026-10-17: 0 results for `registerProtocolHandler`, `custom handlers`, `protocol_handlers`). Chrome Platform Status records the Safari signal "Safari does not support `registerProtocolHandler`" and "there is no such plan in WebKit" citing webkit-dev 2020-04 (the list archive returned 403 to me, so that part is second-hand).

Corrections:
1. **caniuse range.** The original says "n for Safari 3.2..27.2". Desktop Safari is `n` from 3.1 through TP; 3.2 to 27.2 is the iOS Safari row. Caniuse lists Safari 27.1 and 27.2 with no release date (current is 27, released 2026-09-14), so "through 27.2" includes versions that do not exist yet.
2. **Bug 73177 is not a protocol-handler bug in the narrow sense.** Its text is about `registerContentHandler`, `isContentHandlerRegistered` and an EFL-port patch (2011 to 2014). The protocol-handler-specific WebKit bugs are 92726 ("[WK2] WebPage does not provide RegisterProtocolHandlerClient") and 92749 ("[WK2] Add Navigator Content Utils API support for WebKit2"); both were also set RESOLVED INVALID on 2023-04-03. The closures are tracker housekeeping, not a stated engine position; the 2019 code deletion and the absence of the API are the real evidence.

Not verified: Safari.app itself was not driven; no iOS device.

Sources: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/Navigator.idl ; https://github.com/WebKit/WebKit/commits/main/Source/WebCore/Modules/navigatorcontentutils ; https://bugs.webkit.org/rest/bug/73177 (+ /comment, 92726, 92749, 73639, 40829) ; https://developer.apple.com/tutorials/data/documentation/safari-release-notes/safari-27-release-notes.json ; https://developer.apple.com/tutorials/data/documentation/safari-release-notes/safari-27_2-release-notes.json ; https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ ; https://webkit.org/blog/18357/release-notes-for-safari-technology-preview-253/ ; https://webkit.org/blog/18420/release-notes-for-safari-technology-preview-254/ ; https://github.com/WebKit/standards-positions/issues?q=registerProtocolHandler ; https://chromestatus.com/api/v0/features?q=protocol%20handler ; lab: `results/val_webkit.json`, `results/wkcheck.json`, `scripts/wkcheck.swift`.

---

## 8. Claim 8 - Firefox for Android

**Verdict: nuanced.** "Does not support" is right about behavior and wrong, in a way that changes a design decision, about the API surface.

What holds:
- **Bugzilla 917866** (REST): product GeckoView, component General, status NEW, severity S3, priority P3, created 2013-09-18T15:41:39Z, last change 2022-10-11T01:07:43Z, two comments. The 2013 report: "Desktop supports this but Fennec does not. ... when I visit the page with Fennec I don't get any prompt to register the protocol handler. Presumably we need to implement nsIWebContentHandlerRegistrar in Fennec somewhere". The 2020-09-17 triage note: "snorp thinks this could be really hard to impossible to do since protocol handling needs to be specified at install time in the manifest for Android". (The original's "near impossible" paraphrases "really hard to impossible".)
- **caniuse** (data updated 2026-10-13): `and_ff` 157 is `n`.
- **BCD** (main, 2026-10-17): `api.Navigator.registerProtocolHandler.__compat.support.firefox_android` is `"mirror"`. The same file's sub-feature `secure_context_required` has `firefox_android: { "version_added": false }` next to a `"mirror"` parent, so the data disagrees with itself. BCD issue #27215 (open, 2025-07-01, "status is confusing/misleading") concerns other cells.

The correction - the method exists on Firefox for Android and does nothing:
- `dom/webidl/Navigator.webidl` has `Navigator includes NavigatorContentUtils;` with no platform guard, and the mixin declares `[Throws, SecureContext] undefined registerProtocolHandler(DOMString scheme, DOMString url);` (`unregisterProtocolHandler` is commented "NOT IMPLEMENTED").
- `Navigator::RegisterProtocolHandler` validates arguments (so SyntaxError and SecurityError still occur), then either calls the registrar service (parent process) or sends `SendRegisterProtocolHandler` from a content process. `BrowserParent::RecvRegisterProtocolHandler` does `if (registrar) { registrar->RegisterProtocolHandler(...) }` and returns `IPC_OK()` either way. The only implementer of the registrar contract that Searchfox finds is `browser/components/protocolhandler/components.conf` (the desktop browser), so on GeckoView the call is a silent no-op. That is what the 2013 reporter saw.
- Weak extra signal: Mozilla ships a web-compat shim around `navigator.registerProtocolHandler` for Outlook/Office 365 (bug 1709653) and it also appears under `__GENERATED__/mobile/android/...` in Searchfox. The injection list may simply be platform-agnostic, so I do not rely on it.
- Therefore BCD's `"mirror"` is right about the interface and wrong about behavior, and `'registerProtocolHandler' in navigator` / `typeof navigator.registerProtocolHandler === 'function'` should be expected to be **true on Firefox for Android** (source-derived, high confidence; not run on a device). Compare Chromium-on-Android, where the method is absent (claim 6).

Design consequence: R4's gate ("show only when `isSecureContext && typeof navigator.registerProtocolHandler === 'function'`") would show "Open magnet links with this site" on Firefox for Android, where it silently does nothing; it also shows in Firefox desktop private windows, which no-op too. The control needs a mobile exclusion (for example `navigator.userAgentData?.mobile` or a UA test for Android and iPhone/iPad) on top of the feature test, and its copy must never imply success ("Requested. Your browser decides").

Not verified: no device run; Fenix/GeckoView behavior is inferred from the shared Gecko code.

Sources: https://bugzilla.mozilla.org/rest/bug/917866 (+ /comment) ; https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/registerprotocolhandler.json ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json ; https://github.com/mdn/browser-compat-data/issues/27215 ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/webidl/Navigator.webidl ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/base/Navigator.cpp ; https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/ipc/BrowserParent.cpp ; https://searchfox.org/firefox-main/search?q=web-protocol-handler-registrar&case=false&regexp=false&path= ; https://bugzilla.mozilla.org/rest/bug/1709653.


---

## 9. Other findings outside the eight claims (they touch the same design decisions)

1. **Service worker sees the fragment** (original F13 says it never does). Observed in Chromium 156.0.8078.4 and WebKit 27.2: `FetchEvent.request.url` of a navigation includes `#...`. Detail in claim 5.
2. **Manifest relative URLs resolve against the manifest URL.** `#%s`, `./#%s` and bare `%s` pass the parser (when the manifest is in scope) but would open the manifest file. Use root-relative or absolute `protocol_handlers` URLs derived from the deploy base (supports R6 and ARCHITECTURE section 10). Detail in claim 2.
3. **User activation.** F6 says Blink's `registerProtocolHandler` has no user-activation check and the permission request is created with `user_gesture=false`. In the Blink client I read, `NavigatorContentUtilsClient::RegisterProtocolHandler` passes `LocalFrame::HasTransientUserActivation(frame_)` to the browser process as `user_gesture`. Chrome Platform Status entry 5047679389270016 (updated 2025-08-22, status "No longer pursuing") states "The registerProtocolHandler method requires transient activation to consider the request; otherwise it'll be ignored." I did not trace the browser-process side, so treat F6's sentence as unverified. R4 (call only from a click) is correct under either reading.
4. **Original lab coverage versus text.** F1 reports Brave results for five cases the Brave script never ran (claim 1). The results turned out right.
5. **Chromium's list and spec examples move.** `payto` (claim 1), and the spec/WICG examples that still show an unencoded scheme separator (claim 3).
6. **Reproduced unchanged (F19, sandboxed iframes).** `registerProtocolHandler('magnet', origin + '/#%s')` returned normally inside `<iframe sandbox="allow-scripts allow-same-origin">` and threw SecurityError "Can only register custom handler in the document's origin." inside `sandbox="allow-scripts"` (opaque origin), in both Chromium 156.0.8078.4 and Brave 155.1.97.59 (`results/val_chromium.json`, `results/val_brave.json`).
7. **The working tree is moving.** `render.js` (17:53 ET) and `app.js` (18:06 ET) were rewritten while this check ran; `detectMode` is gone and `parseFragment` replaced it (claim 4). Other documents that cite `detectMode()` (including R2 in the note) are now stale references.

---

## 10. Not verified (so nobody treats these as checked)

- Firefox at runtime for any claim (Playwright Firefox 157.0 would not start on this host); every Firefox statement is from Gecko source. A real Firefox 158/160 run is still needed for the info bar, "Add application", "Never allow", and `%s` in host/port.
- Edge, Opera, Vivaldi, Arc, Samsung Internet, Android WebView (data and shared Chromium code only).
- Any real device: iOS, iPadOS, Android (Chrome, Firefox, Samsung). Safari.app UI.
- EU and Japan alternative-engine iOS browsers: whether any ships and whether it implements the API.
- Installed-PWA protocol launch: fragment retention (original Q1) and the translation code path.
- Consent UI wording, persistence and OS-default synchronisation (headless cannot show them).
- Browser-side telemetry or sync paths for URL fragments (history sync, Safe Browsing, UKM).
- Anything that needs an open-ended web search (community reports, post-2026-10-13 release notes). Web search was unavailable for this run.
- WebKit's webkit-dev 2020-04 message and the reviewer's inline comments on qBittorrent PR #10552 (not retrievable here).

---

## 11. Edits I would make to `w1-09-protocol-handler-magnet.md` (not applied; this task only writes the verify note)

1. F1: add the Chromium superset (10 schemes), case-insensitive matching, and say the Brave runs were extended to 57 cases on 2026-10-17.
2. F2: add "absent in insecure contexts", base-URL and manifest-URL resolution, userinfo, Firefox check order.
3. F4: replace "encoded `&`, `?` or `=`" with the measured set (`&` and escaped `%XX` in the project parser; also `=` and lone `%` in magnet-uri); record that `parseFragment` in `app.js` (18:06 ET) now implements R2.
4. F5 and F13: add the service-worker and redirect caveats; correct the qBittorrent sentence (author's preference, no stated privacy reason); delete "the service worker only ever sees the path".
5. F9, G14, R4: Firefox Android has the method and it is a no-op; R4's feature test must be combined with a mobile exclusion.
6. F8 and section 2: iOS row "except EU alternative-engine browsers (unverified)"; caniuse ranges (desktop Safari from 3.1; 27.1 and 27.2 unreleased); bug 73177 scope sentence; add the 2019-03-25 WebKit module removal and the shipping-engine check.
7. F6: re-check the user-activation sentence (section 9 item 3).

---

## 12. Source index (fetched 2026-10-17, 21:37Z to 22:05Z; sizes and hashes in `labs/w1-09-verify-lab/results/fetch-manifest.tsv`)

Specifications and standards: https://raw.githubusercontent.com/whatwg/html/main/source ; https://html.spec.whatwg.org/multipage/system-state.html (Last Updated 16 October 2026) ; https://raw.githubusercontent.com/whatwg/url/main/url.bs ; https://raw.githubusercontent.com/WICG/manifest-incubations/gh-pages/index.html ; https://www.rfc-editor.org/rfc/rfc3986.txt ; https://www.rfc-editor.org/rfc/rfc9110.txt ; https://github.com/whatwg/html/issues/3377 ; WPT `html/webappapis/system-state-and-capabilities/the-navigator-object/` (`protocol-handler-fragment-nosw-manual.https.html`, `resources/handler-tools.js`).

Chromium (main): `third_party/blink/common/custom_handlers/protocol_handler_utils.cc` ; `third_party/blink/renderer/modules/navigatorcontentutils/{navigator_content_utils.cc, navigator_content_utils.idl, navigator_content_utils_client.cc}` ; `third_party/blink/renderer/modules/manifest/manifest_parser.cc` ; `third_party/blink/renderer/platform/runtime_enabled_features.json5` ; `components/custom_handlers/{protocol_handler.cc, protocol_handler_registry.cc, pref_names.cc}` ; `base/strings/escape.{cc,h}` ; `chrome/browser/custom_handlers/protocol_handler_registry_browsertest.cc` ; base https://raw.githubusercontent.com/chromium/chromium/main/ . Release data: https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=4 (and Beta, Dev, Canary) ; Chrome Platform Status API https://chromestatus.com/api/v0/features?q=registerProtocolHandler (also `protocol%20handler`, `custom%20handlers`, `protocol_handlers`) ; https://developer.chrome.com/docs/web-platform/best-practices/url-protocol-handler (last updated 2021-05-11).

Firefox (mozilla-firefox/firefox main): `dom/base/Navigator.cpp` ; `dom/webidl/Navigator.webidl` ; `dom/ipc/BrowserParent.cpp` ; `uriloader/exthandler/WebHandlerApp.sys.mjs` ; `browser/components/protocolhandler/WebProtocolHandlerRegistrar.sys.mjs` ; `toolkit/xre/nsAppRunner.cpp` ; Searchfox queries https://searchfox.org/firefox-main/search?q=web-protocol-handler-registrar and `...q=RegisterProtocolHandler&path=mobile/android` ; Bugzilla REST https://bugzilla.mozilla.org/rest/bug/917866 (and /comment) and https://bugzilla.mozilla.org/rest/bug/1709653.

WebKit / Apple: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/Navigator.idl ; https://github.com/WebKit/WebKit/commits/main/Source/WebCore/Modules/navigatorcontentutils ; https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/CMakeLists.txt ; https://bugs.webkit.org/rest/bug/73177 (and 92726, 92749, 73639, 40829) ; https://github.com/WebKit/standards-positions/issues ; Apple Safari release notes JSON (27, 27.2 Beta, 26.6) ; https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ , /18357/ , /18420/ ; https://developer.apple.com/support/alternative-browser-engines/.

Compatibility data: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json ; https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/registerprotocolhandler.json ; https://raw.githubusercontent.com/Fyrd/caniuse/main/fulldata-json/data-2.0.json (updated 2026-10-13 05:12 UTC) ; https://github.com/mdn/browser-compat-data/issues/27215.

Prior art: https://raw.githubusercontent.com/webtorrent/instant.io/master/client/index.js (last commit 2022-07-05) ; https://github.com/qbittorrent/qBittorrent/pull/10552 ; https://raw.githubusercontent.com/qbittorrent/qBittorrent/master/src/webui/www/private/scripts/client.js ; `node_modules/magnet-uri` 7.0.10.

Local runs (all in `docs/research/labs/w1-09-verify-lab/`): Playwright Chromium 156.0.8078.4 ; Brave Browser 155.1.97.59 (Chromium 155.0.8059.85) ; Playwright WebKit 27.2 ; system WebKit 22625.1.29.11.28 (macOS 27.0.1) ; no Firefox run.
