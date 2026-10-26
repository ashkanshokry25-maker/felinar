# W1-09 - Opening `magnet:` links in a web loader (registerProtocolHandler, manifest protocol_handlers)

Research date: 2026-10-17 (all "current" statements are as of this date).
Scope: can the magnet-web loader become the thing that opens `magnet:` links? Safelist, support matrix (desktop and mobile), consent UX, same-origin template rule, `%s` encoding, PWA manifest `protocol_handlers`, Brave's former built-in WebTorrent, iOS and Android behaviour, fallbacks, deep links and QR codes for mobile, and what to change in magnet-web.

Reference versions on 2026-10-17: Chromium 156.0.8078.4 (Playwright build 1248, used for experiments); Firefox 158.0 stable and 160.0a1 Nightly (Firefox 160 is scheduled for 2026-11-10); Safari 27.x (the Playwright WebKit build used here reports `Version/27.2`); Brave Browser 155.1.97.59 (Chromium 155) installed on this Mac; Edge follows Chromium.

Method notes (read these first):
- Primary sources were read raw wherever possible: the HTML and URL Standard source files, Chromium and Firefox source, MDN browser-compat-data JSON, Bugzilla. Quotes from the Chrome Developers and web.dev pages, which first came through the fetch tool's small-model summarizer, were re-checked against the raw page text. Pages that only came through that summarizer (GitHub issues and PRs, the WebKit bug, Brave release pages, Edge docs, Apple Community, AlternativeTo, the seedbox article) are second-hand; findings that rest on them say so and carry MEDIUM or LOW unless raw data confirms them.
- The shared web-search budget ran out after the first round of searches. Everything after that came from direct fetches of specific primary-source URLs (no search engines, no proxies). Items that would have needed more searching are marked and listed in section 6.
- Labels. Confidence HIGH = spec text or engine source I read plus a second source or an experiment. MEDIUM = one primary source, or consistent secondary sources. LOW = inference or a secondary/vendor source. `[EXP]` = reproduced by me on 2026-10-17 (section 7 lists the five experiments; scripts and raw results are in `docs/research/labs/w1-09-lab/`). Source labels S1..S27 are defined in section 8; every URL there was actually fetched.
- Headless automation cannot show or accept the real consent UI, so all consent-UX statements come from source code, bug trackers and docs, not from clicking.

---

## 1. Summary

1. **`magnet` is on the `registerProtocolHandler` safelist, in the standard and in both desktop engines.** HTML Standard (snapshot 2026-10-16), Chromium `kProtocolSafelist` and Firefox `kSafeSchemes` all list it. Chrome added it in Chrome 30 and Firefox in 2 (BCD). Chromium also accepts any `web+[a-z]+` scheme; `bittorrent:` and other names are rejected with a SecurityError [EXP]. A dedicated new scheme is not a realistic route (section 3.6, F21).
2. **Only desktop Chromium-family browsers and desktop Firefox can be told "open `magnet:` links in this site".** Not Safari (macOS or iOS, and therefore no iOS browser), not Chrome/Edge/Samsung/Opera on Android, not Firefox for Android. The WebKit engine has no API at all (source and runtime check [EXP]). So "magnet links open the loader" can never be a universal promise; the `https://<hub>/#...` link is the only universal form.
3. **The manifest route is narrower, not wider.** `protocol_handlers` works only for an installed PWA on desktop Chrome and Edge (96+), registering with Windows (registry), macOS (app shim) and Linux (`.desktop` `x-scheme-handler/...`). It is not supported on Android (BCD, and a 2025 test on Chrome 133), Safari or Firefox. It accepts `magnet`: the manifest parser runs the same safelist check, and Chromium 156 accepted `{protocol:"magnet", url:"/#%s"}` with scope `/` and no errors [EXP]. ARCHITECTURE.md's planned manifest entry is valid.
4. **Template rules.** The handler URL must contain `%s` (SyntaxError otherwise), must be https (http only for localhost-style trustworthy origins) and must be same-origin with the registering page (SecurityError otherwise); in a manifest it must also lie inside `scope`. `%s` is replaced once, with `encodeURIComponent`-equivalent encoding of the whole `magnet:` URI.
5. **The `/#%s` template is the right shape and keeps the infohash away from the static host** (RFC 3986: the fragment is dereferenced solely by the user agent). The loader decodes the handler-built fragment correctly [EXP], but it also decodes literal share links unconditionally, which corrupts a tracker URL that itself contains an encoded `&` [EXP]. Fix: decode once only when the fragment starts with an encoded scheme (P0, S).
6. **Consent and persistence differ and can surprise.** Chrome shows a permission-style prompt, remembers "ignore", and on Windows and macOS also asks the OS to make Chrome the default `magnet` client and **clears the web default again at startup if Chrome is not the OS default** (Chromium source). Firefox shows an info bar; "Add application" does **not** make the site the default (the next click asks); there is no persistent "no" until Firefox 160 adds "Never allow"; private windows ignore the call. Call the API only from an explicit click, never on load.
7. **Brave's built-in WebTorrent no longer exists.** Default-off for new installs in 1.78.94 (2025-05-01), disabled for everyone in 1.81.131 (2025-08-06), code removed in 1.82.161 (2025-09-04). Before that, Brave rewrote `magnet:` navigations to its own extension page (v1.69.153 source). Current Brave (155.1.97.59 here) runs the standard API with identical semantics [EXP]. The older review note that Brave "claims `magnet:` itself" is outdated for current Brave.
8. **Mobile has no web-handler route.** iOS: only installed apps claim schemes (Info.plist); with several claimants "the app the system targets is undefined" (Apple); with none, Safari shows an error. Android: Chrome hands non-http links to apps through intents and does nothing if none resolves. What does work on mobile: (a) `https://<hub>/#btih:<hex>` links and QR codes, (b) a paste box, (c) on Android an installed WebAPK that captures in-scope https links (web.dev, 2022) and can receive `magnet:` text via `share_target`.
9. **Becoming the handler for all `magnet:` links is a product and security decision, not just a feature.** Most public magnets point at ordinary torrents that a WebRTC-only browser swarm usually cannot serve (reasoned, not measured, Q9), and anything clicked anywhere arrives as a drive-by. Combined with hub mode (where `SANDBOX_HUB` includes `allow-same-origin`), a hub-hosted site can itself call the API [EXP]. This makes the existing "never auto-load from a fragment or the protocol handler" rule (docs/review/security.md) mandatory and adds a "this is not a website torrent" path.
10. **QR codes.** Use `https://<hub>/#btih:<40 hex>`: 66 bytes for a short hub name, QR version 5 at ECC M (37x37 modules); a base32 infohash saves 8 bytes (version 4). A link with one wss tracker is version 8 at M; the four default trackers need version 12 at M.
11. **Prior art exists and is mixed.** instant.io registers a `magnet` handler on every page load with the same `#%s` template; the qBittorrent WebUI added a handler in 2019 (query first, then moved to the hash after review) and tells users to authorize it in the browser.

Top actions (details in section 4): reword every "magnet links open the loader" promise (P0), fix the fragment decode (P0), add a paste box (P1), add an opt-in "Open magnet links with this site" control on the hub origin only (P1), add the drive-by/non-site-torrent interstitial (P1), guard the manifest in CI with the CDP parser check (P1), add `share_target` and a QR code (P2).

---

## 2. Support matrix (as of 2026-10-17)

"Web API" = `navigator.registerProtocolHandler('magnet', ...)`. "Manifest" = `protocol_handlers` in an installed PWA. Evidence labels in brackets.

| Platform / browser | Web API | Manifest `protocol_handlers` | Notes |
|---|---|---|---|
| Chrome desktop (Win, macOS, Linux, ChromeOS) | Yes (method since 13; `magnet` since 30; `unregisterProtocolHandler` since 38; no `isProtocolHandlerRegistered`) [S3, S8, EXP-1] | Yes since 96, installed PWA only [S3, S6, S8, EXP-2] | Prompt is a permission request; OS-default sync on Win/macOS (F6) |
| Edge desktop | Yes (79+, Chromium code) [S3] | Yes (96, BCD "mirror"; Edge docs describe it) [S3, S16] | Same prompts as Chrome (inferred from shared code) |
| Brave desktop 155.1.97.59 | API present, same validation and errors [EXP-4]; prompt UI not tested | Not tested (PWA install in Brave not exercised) | Built-in WebTorrent gone since 1.82.161 (F14) |
| Opera, Vivaldi desktop | Chromium engine; not tested | Chromium engine; not tested | BCD lists Opera by mirroring Chrome |
| Firefox desktop 158 | Yes (since 2; safelist incl. `magnet`) [S9, S3]; private windows silently ignore; no `unregisterProtocolHandler` (bug 1631477 NEW) | No [S3] | Info bar; Add is not default; "Never allow" arrives in 160 (F7) |
| Firefox for Android | **No.** GeckoView bug 917866 "doesn't support navigator.registerProtocolHandler" is NEW since 2013; caniuse `and_ff 157 = n` [S10, S4] | No | MDN BCD marks it "mirror" of desktop, which conflicts; treat as unsupported (G14) |
| Chrome for Android, Edge Android, Samsung Internet, Opera Mobile, UC | **No** (BCD `version_added:false`, crbug 40964464 open; caniuse `n`) [S3, S4] | **No** (BCD false; tested Chrome 133 and Edge Android 2025-03) [S3, S14] | Android dispatches `magnet:` to apps via intents (F16) |
| Safari macOS 27.x | **No** (API absent: Playwright WebKit 27.2 `typeof` = `undefined` [EXP-1]; WebKit `Navigator.idl` has no mixin; caniuse `n` for 3.2..27.2) [S12, S4] | No [S3] | WebKit bug 73177 closed INVALID 2023-04-03 |
| Safari iOS/iPadOS, every iOS browser, WKWebView | **No** (same engine; caniuse `ios_saf n` through 27.2) [S4, S12] | No | Home Screen web apps cannot capture URLs (web.dev 2022) |

---

## 3. Findings

### 3.1 The API, the safelist and the template rules

**F1. `magnet` is safelisted by the HTML Standard, Chromium and Firefox; the scheme set a page can claim is closed.** Confidence HIGH. Design-critical: yes (the whole handler idea depends on it).
- HTML Standard, "normalize protocol handler parameters": a scheme is allowed if it is a safelisted scheme or `web+` followed by one or more ASCII lower alphas. The 24 safelisted schemes are bitcoin, ftp, ftps, geo, im, irc, ircs, **magnet**, mailto, matrix, mms, news, nntp, openpgp4fpr, sftp, sip, sms, smsto, ssh, tel, urn, webcal, wtai, xmpp. The spec note says "This list can be changed" (S1).
- Chromium `kProtocolSafelist` (protocol_handler_utils.cc) has **magnet** plus extra decentralized-web schemes (cabal, dat, did, doi, dweb, ethereum, hyper, ipfs, ipns, ssb), ftp/ftps/sftp, and `payto` behind a feature flag. The component README says the extras are "additional decentralized schemes" from whatwg/html#5482 (S8).
- Firefox `kSafeSchemes` in Navigator.cpp equals the spec's 24, with the comment "This list should be kept up-to-date with the spec" (S9).
- MDN BCD per-scheme data: `magnet` Chrome 30, Firefox 2, Safari false (S3). Chrome's own PWA doc lists `magnet` as an example safelisted scheme (S6).
- [EXP-1, EXP-4] Chromium 156 and Brave 155.1.97.59 accept `magnet`, `MAGNET`, `web+magnetweb`, and throw SecurityError for `bittorrent`, `https`, `magnet:` (trailing colon), `web+` and `web+magnet2` (digits are not allowed after `web+`).
- Source dates: S1 snapshot 2026-10-16 (commit de953a7); S8 and S9 main branch 2026-10-17.

**F2. Template URL rules (spec, engine code and experiment agree).** Confidence HIGH. Design-critical: yes.
- The method is `[SecureContext]` and takes two arguments. The old `title` argument was removed from the spec; Chromium still accepts a third argument silently [EXP-1]; Firefox removed it (bug 1631464) (S1, S10).
- `url` must contain `%s` (else SyntaxError); `%s` in the host or port makes URL parsing fail (SyntaxError) [EXP-1]; the URL must be HTTP(S) and **same-origin** with the calling page (else SecurityError). Chromium's message: "Can only register custom handler in the document's origin." [EXP-1]. Chromium also requires the URL to be potentially trustworthy, so `http://127.0.0.1` works for tests while `http://example.org` is rejected ("The scheme of the url provided must be HTTP(S)") [EXP-1].
- Firefox checks http/https for both document and handler, equal scheme and host:port, then the safelist, and honours the prefs `network.protocol-handler.external-default` and `network.protocol-handler.external.<scheme>` (S9).
- A relative template (`/#%s`) and a query template (`/?m=%s`) are both accepted [EXP-1].
- Source dates: S1 2026-10-16; S8, S9 2026-10-17; EXP 2026-10-17.

**F3. `%s` is replaced once, with encodeURIComponent-equivalent encoding of the whole serialized URL; the receiver must decode exactly once.** Confidence HIGH. Design-critical: yes.
- Spec: strip username and password, serialize, "UTF-8 percent-encode ... using the component percent-encode set", replace the first instance of `%s`, navigate (S1). URL Standard: using that set "gives identical results to JavaScript's `encodeURIComponent()`" (S2). I rebuilt the sets from url.bs and compared them with `encodeURIComponent` for U+0000..U+007F: zero differences; unescaped characters are `A-Za-z0-9 ! ' ( ) * - . _ ~` [EXP-5].
- Chromium: `ReplaceFirstSubstringAfterOffset(&spec, 0, "%s", EscapeQueryParamValue(url_spec, false))` (components/custom_handlers/protocol_handler.cc). Firefox: `encodeURIComponent(aURI.spec)` then `uriTemplate.replace("%s", ...)` (WebHandlerApp.sys.mjs) (S8, S9).
- Consequence: `magnet:?xt=urn:btih:H&dn=My%20Site` arrives as `#magnet%3A%3Fxt%3Durn%3Abtih%3AH%26dn%3DMy%2520Site` (the `%` of the original becomes `%25`). One `decodeURIComponent` restores it exactly.
- Trap: the illustrative examples in the HTML Standard (`.../soup?url=web+soup:chicken-k%C3%AFwi`) and in the WICG spec (`songId=web+music://%231234`) show the scheme separator unencoded, which contradicts the algorithm and both engines. Do not write a parser from those examples (S1, S7).

**F4. The loader decodes the handler-built fragment correctly but corrupts literal share links whose tracker URLs contain encoded `&`, `?` or `=`.** Confidence HIGH (real project code run). Design-critical: yes (it sits in pointer discovery).
- `src/loader/render.js detectMode()` always runs `decodeURIComponent` on the whole fragment. [EXP-3] (A) a hash built the way browsers build it round-trips byte for byte and `parseMagnet` returns the right tracker; (B) a hand-built `#magnet:?xt=...&tr=wss%3A%2F%2Ftracker.example%3A443%2Fannounce%3Fkey%3Da%26b%3Dc` is decoded once too often, the tracker becomes `wss://tracker.example:443/announce?key=a` and `&b=c` is lost; (C) `#btih:<hex>` is fine.
- instant.io uses the same pattern (`decodeURIComponent(window.location.hash.substring(1))`) so it shares the flaw for literal links (S21).
- Source: S23 (project code), EXP-3, 2026-10-17.

**F5. `#%s` keeps the magnet out of the HTTP request; both prior-art web handlers ended up on the hash.** Confidence HIGH for acceptance and prior art, MEDIUM for the privacy consequence (follows from RFC 3986, not separately tested against CloudFront logs).
- RFC 3986 section 3.5: "the fragment identifier is separated from the rest of the URI prior to a dereference, and thus the identifying information within the fragment itself is dereferenced solely by the user agent" (S27). With `?m=%s` the infohash and trackers would appear in static-host access logs and in the SW's navigation request URL.
- Chromium's manifest parser accepts `/#%s`, `/?m=%s` and `/open#%s` alike [EXP-2]. qBittorrent's WebUI PR #10552 first used a query parameter, then "moved the value into the URL hash" after review (S21). instant.io registers `window.location.origin + '#%s'` (S21).
- Source dates: RFC 3986 2005-01; PR 2019-04-30 (merged 2019-05-07); instant.io master 2026-10-17.

### 3.2 Browser behaviour and consent UX of the web API

**F6. Desktop Chrome and Edge: permission-style prompt, remembered "ignore", replace semantics and OS-default synchronisation.** Confidence HIGH for the code facts, MEDIUM for the exact on-screen wording (the English strings file was not located). Design-critical: yes (it decides whether a registration persists).
- A call becomes a `RegisterProtocolHandlerPermissionRequest` (permission type `kRegisterProtocolHandler`). Its message fragments (IDS_REGISTER_PROTOCOL_HANDLER_CONFIRM_FRAGMENT and a REPLACE variant) name the protocol and, if a handler already exists, the host it would replace. Accept -> registered and made default (`OnAcceptRegisterProtocolHandler`); deny or ignore -> stored in an ignored list (`OnIgnoreRegisterProtocolHandler`).
- Silent paths in `SilentlyHandleRegisterHandlerRequest`: no prompt if handler handling is disabled, the same handler is already registered, an equivalent handler was previously ignored, or the call merely replaces an older registration from the same origin. So after an "ignore" a second call does nothing and the page cannot tell. The registry source names `chrome://settings/handlers` as the page where the user manages handlers.
- `CanSchemeBeOverridden` only refuses the browser's built-in schemes: `ProfileIOData::IsHandledProtocol` lists http, https, ws, wss, file, data, blob, about, filesystem, chrome, chrome-untrusted, chrome-search, chrome-devtools, extension, dom-distiller and isolated-app (plus content on Android and external-file on ChromeOS), so `magnet` is overridable and an installed torrent client does not block registration (`chrome/browser/profiles/profile_io_data.cc`, main 2026-10-17).
- OS-default sync. `SetDefault()` for a scheme without a default calls `RegisterWithOSAsDefaultClient`. macOS: `SET_DEFAULT_UNATTENDED` -> `setDefaultApplicationAtURL:toOpenURLsWithScheme:` (silent). Windows: `SET_DEFAULT_INTERACTIVE` -> system settings. If Chrome is then not the OS default client, `OnSetAsDefaultProtocolClientFinished` calls `ClearDefault(protocol)` when `ShouldRemoveHandlersNotInOS()` is true (Windows and macOS when setting is permitted; false on Linux and ChromeOS). The registry repeats the OS check for every default handler at startup. Net effect: on Windows/macOS the web default for `magnet` lasts only while Chrome is the OS default `magnet` client; choosing qBittorrent as the OS default later silently removes it.
- Handlers are per profile; a handler accepted in a normal window is not used in Incognito unless accepted there.
- There is no user-activation check in Blink's `registerProtocolHandler` (a use counter separates cross-origin subframes; crbug 977083 is only a proposal), and the permission request is created with `user_gesture=false`.
- Edge shares this code (Edge docs only describe the PWA side).
- Source dates: Chromium main, fetched 2026-10-17 (S8).

**F7. Firefox desktop: info bar, "Add application" is not "make default", "Never allow" arrives in Firefox 160.** Confidence HIGH (source and bug tracker). Design-critical: no.
- UI: a notification bar with value `Protocol Registration: magnet`, text `Add “{host}” as an application for {protocol} links?`, buttons `Add application` and (new) `Never allow`; closing with the x blocks that site temporarily.
- Adding appends the web app to the possible handlers and sets `alwaysAskBeforeHandling = true` with the code comment "Reset the handlerInfo to ask before the next use": the next `magnet:` click shows a chooser; it is not the default.
- Before 160 the bar returns on every call: bug 668577 ("should provide a don't ask me again button", opened 2011-06-30) collected years of reports about Outlook and Yahoo re-prompting on every load. It was fixed on mozilla-central on 2026-10-15/16 with a new `register-protocol-handler` site permission keyed on the top-level site; target milestone 160. Firefox 160.0 is scheduled for 2026-11-10 (Mozilla release-schedule API), so Firefox 158 users get the old behaviour until then.
- Private windows: silent no-op with a console warning. Telemetry splits calls by top-level or iframe and by user activation, but nothing enforces activation (bug 1311940 NEW). `unregisterProtocolHandler` is not implemented (bug 1631477 NEW).
- Source dates: Navigator.cpp, WebProtocolHandlerRegistrar.sys.mjs, webProtocolHandler.ftl, WebHandlerApp.sys.mjs at main 2026-10-17; bug 668577 last change 2026-10-16 (S9, S10, S11).

**F8. Safari and WebKit have no `registerProtocolHandler`.** Confidence HIGH. Design-critical: yes.
- caniuse data fetched 2026-10-17: Safari 3.2..27.2 `n`, iOS Safari through 27.2 `n`; BCD: Safari false. WebKit main `Source/WebCore/page/Navigator.idl` has fourteen `Navigator includes ...` lines and none is a content-utils mixin. [EXP-1] Playwright's WebKit build (UA `Version/27.2 Safari/605.1.15`): `typeof navigator.registerProtocolHandler` is `"undefined"`, in the top frame and in iframes.
- WebKit bug 73177 ("Add Custom Content Handler", opened 2011-11-27) was closed RESOLVED INVALID on 2023-04-03 by Anne van Kesteren: "If there is an initiative to add this API again it would benefit from a clean approach so let's close this." whatwg/html#5482 links it as the Safari tracking bug. WebKit/standards-positions has no issue mentioning registerProtocolHandler. (The bug page and the standards-positions search were read through the summarizer, so the date and quote are second-hand; the source-tree and runtime evidence above does not depend on them.)
- Caveat: the runtime check used Playwright's WebKit build on macOS, not Safari.app or an iPhone.

**F9. No mobile browser can register a web handler.** Confidence HIGH for Chrome/Edge/Samsung/iOS; MEDIUM-HIGH for Firefox Android. Design-critical: yes.
- Chrome for Android: BCD `version_added:false` with `impl_url` crbug 40964464 (title in a search listing: "Implement registerProtocolHandler on Android"; the tracker page needs a sign-in and was not read). caniuse: `and_chr 154 n`, Samsung Internet 25..30 `n`, Opera Mobile `n`, UC `n`.
- Firefox for Android: GeckoView bug 917866 ("GeckoView doesn't support navigator.registerProtocolHandler") has been NEW since 2013-09-18; the 2020-09-17 triage note says it "could be really hard to impossible to do since protocol handling needs to be specified at install time in the manifest for Android". The desktop registrar is declared under `browser/components/protocolhandler/components.conf` with the contract `@mozilla.org/embeddor.implemented/web-protocol-handler-registrar;1`, main process only, and `Navigator::RegisterProtocolHandler` silently skips registration when no such service exists (that no Android implementer exists is inferred, not grepped). caniuse: `and_ff 157 n`. BCD marks `firefox_android` as "mirror" of desktop (supported), which conflicts; three agreeing sources outweigh it (G14).
- web.dev (2022-04-15): the URL protocol handler API is "available only on desktop devices"; "You can only allow custom protocols for mobile devices by distributing your PWA on app stores."

### 3.3 Installed-PWA `protocol_handlers`

**F10. Support and spec status.** Confidence HIGH. Design-critical: yes.
- Spec: WICG Manifest Incubations (Community Group draft, "an unofficial proposal"; repo last pushed 2026-08-25). `protocol_handlers` is an array of `{protocol, url}`; `protocol` and `url` are "equivalent to" `registerProtocolHandler()`'s `scheme` and `url` with "the same restrictions"; `url` must be within the manifest scope; entries that fail normalization or scope are skipped; user agents SHOULD register with the OS and SHOULD ask permission before making a handler the OS default (privacy note: a handler could become the default "without the explicit knowledge of the user") (S7).
- Support: BCD `chrome 96`, `edge` mirror, `chrome_android false`, `firefox false`, `safari false`, status experimental (S3). Chrome's doc: "available from Chrome 96" (last updated 2021-05-11) (S6). BCD issue #26107 (opened 2025-03-03): the Chrome demo PWA's protocol links "would just reload" on Chrome Android 133.0.6943.137 and on Edge Android, while desktop Edge worked; fixed by BCD PR #26147 (issue closed 2025-03-11) setting `chrome_android` to false (S14; issue page read through the summarizer, but the current BCD JSON confirms `chrome_android: false`). web.dev: desktop only (S15). Edge's docs describe the same API (S16).

**F11. Chromium's manifest parser accepts `magnet` with `/#%s` and rejects what we expect it to reject.** Confidence HIGH (parser source read, plus experiment). Design-critical: yes (ARCHITECTURE.md section 10 plans exactly this entry).
- `ParseProtocolHandler` runs `VerifyCustomHandlerScheme(protocol, ..., kStrict)` (the same safelist as the JS API), parses `url` with `ParseURLRestrictions::kWithinScope`, and checks the `%s` token. [EXP-2] Verdicts from Chromium 156.0.8078.4 via CDP `Page.getAppManifest` (scope `/` unless noted):

| Manifest entry | Verdict |
|---|---|
| `{protocol:"magnet", url:"/#%s"}` | accepted, no errors |
| `{protocol:"magnet", url:"/?m=%s"}` and `"/open#%s"` | accepted |
| `{protocol:"web+magnetweb", url:"/#%s"}` | accepted |
| `{protocol:"MAGNET", url:"/#%s"}` | accepted (no error) |
| `{protocol:"bittorrent", url:"/#%s"}` | rejected: "The scheme 'bittorrent' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'." and "protocol_handlers entry ignored, required property 'protocol' is invalid." |
| `{protocol:"magnet", url:"/"}` | rejected: "The url provided ('...') does not contain '%s'." |
| `{protocol:"magnet", url:"https://other.example/#%s"}` | rejected: "property 'url' ignored, should be within scope of the manifest." |
| scope `/app/`, `{protocol:"magnet", url:"/#%s"}` | rejected with the same scope message |
| two entries, one with a bad scheme | the good entry is kept; only the bad one is ignored |

- Consequence for sub-path deployments (m2 in the requirements review): the manifest `scope` and the handler `url` must both be derived from the deploy base path, or the entry is silently dropped.

**F12. OS integration, consent and limits of the installed-PWA route.** Confidence HIGH (Chromium source and Chrome docs). Design-critical: no.
- Windows registers in the registry (`web_app_protocol_handler_registration_win.cc`); macOS stores the handler list in `AppShimRegistry` for the per-app shim (`mac/web_app_protocol_handler_registration_mac.cc`); Linux adds `x-scheme-handler/<protocol>` MIME types to the generated `.desktop` file (`web_app_shortcut_linux.cc`). The generic `RegisterProtocolHandlersWithOs` is a no-op stub elsewhere ("Currently, Windows and MacOSX have their own implementations"). ChromeOS uses its own picker dialog (strings under `is_chromeos`), not examined further. Registration needs the app installed (`INSTALLED_WITH_OS_INTEGRATION`).
- Consent (Chrome doc): "On the first launch of the PWA due to an invoked protocol, the user will be presented with a permission dialog" showing app name and origin; if rejected, "the registered protocol handler will be ignored by the operating system"; choosing "Remember my choice" and "Disallow" unregisters it; otherwise the user must uninstall the PWA. With several apps for one scheme "the operating system will show the user a picker and let them decide". The source skips protocols listed in `disallowed_launch_protocols`.
- Limits (Chrome doc): "Navigation attempts that are not initiated by the user, but that are programmatic, may not open apps. The custom protocol URL may only be used in top-level browsing contexts, but not, for example, as the URL of an iframe." The registered list "is not exposed to the web in any way".
- A manifest update that adds or removes handlers adds or removes registrations without reinstalling.
- Edge DevTools: Application > Manifest > Protocol Handlers reports "Found valid protocol handler registration in the manifest" and has a "Test protocol" button (the PWA must be installed first) (S16).

**F13. What the launched app sees.** Confidence MEDIUM (spec text and MDN; real launches were not run). Design-critical: no.
- The spec's launch step navigates the app window to the translated URL ("launch a web application passing manifest and resultURL"). `launch_handler.client_mode` (`auto`, `navigate-new`, `navigate-existing`, `focus-existing`; Chrome 110) controls window reuse, and `window.launchQueue.setConsumer(p => p.targetURL)` exposes the launch URL (MDN). The service worker only ever sees the path (`/`); the fragment is never in the request. Open: whether an installed PWA launch preserves the `#...` part (Q1).

### 3.4 Brave

**F14. Brave's built-in WebTorrent was removed in 2025; current Brave behaves like Chromium for this API.** Confidence HIGH for versions and dates, MEDIUM for the historical precedence claim. Design-critical: yes (compatibility promise).
- Issue and release pages were read through the summarizer; versions and entries are confirmed by the raw CHANGELOG_DESKTOP.md and the Chromium milestones. Issue brave-browser#44303 "Disable WebTorrent handling in Brave by default" (opened 2025-02-27, closed 2025-03-03 via brave-core#27876): "Today, Brave assumes handling of .torrent and magnet links through our own WebTorrent UI"; expected: "fallback to default Chromium behavior to download via Downloads or open in supported app (magnet link)".
- Release notes (CHANGELOG_DESKTOP.md and release pages): 1.78.94, released 2025-05-01 (Chromium 136.0.7103.60): "Disabled WebTorrent by default for new installs" (#44303). 1.81.131, 2025-08-06 (Chromium 139.0.7258.66): "Disabled WebTorrent" (#46416). 1.82.161, 2025-09-04 (Chromium 140.0.7339.80): "Removed WebTorrent code now that WebTorrent has been deprecated" (#46430; stated reason: lack of developer resources). The release pages show day and month only; the year follows from the Chromium milestones (136, 139 and 140 are the 2025 stable releases).
- Mechanism before removal (brave-core v1.69.153 source, 2024): `HandleMagnetURLRewrite` turned any `magnet:` navigation into `chrome-extension://<webtorrent id>/extension/brave_webtorrent.html?<escaped magnet>` while `IsWebtorrentEnabled`, and http(s) `.torrent` loads were rewritten too. A browser-side URL rewrite happens before any network-level handler lookup, so a page-registered web handler would not have received the link (inference; the order against the registry's URL-loader throttle was not traced).
- Today: Brave Browser 155.1.97.59 ran every EXP-4 case with the same results as Chromium 156. No Brave override of the protocol-handler files exists in brave-core master (seven paths probed, all 404) and the desktop changelog has no custom-handler entry. The consent UI and PWA protocol registration in Brave were not exercised.
- A Brave Community post (2025-03-02, Brave 1.75.180, Windows 11) reports magnet clicks no longer offering the OS default torrent app and describes editing `excluded_schemes` in Preferences (user report, LOW; no replies) (S26).
- Correction to docs/review/browser-mobile.md m7(b), which says Brave's built-in WebTorrent "claims `magnet:` itself": true only for Brave older than 1.78.94 and for older installs that kept it enabled until 1.81.131.

### 3.5 iOS, Android, deep links and QR codes

**F15. iOS: a website cannot register anything; an unhandled magnet link produces a Safari error.** Confidence MEDIUM (the alert wording comes from a 2022 app listing; the Apple Community, AlternativeTo and seedbox pages were read through the summarizer). Design-critical: yes.
- Apple's custom URL scheme documentation: schemes are declared by apps (Xcode "URL Types"), "Although using a reverse DNS string is a best practice, it doesn't prevent other apps from registering the same scheme and handling the associated links."; "If multiple apps register the same scheme, the app the system targets is undefined. There's no mechanism to change the app or to change the order apps appear in a Share sheet." Apple recommends universal links instead.
- The Safari extension "Magnet Links" (AlternativeTo listing, updated 2022-08-25) describes the error "Safari cannot open the page because the address is invalid." as what appears when opening a magnet link because devices do not natively handle the scheme. An Apple Community thread (2023-03-05, macOS 13.2) reports Safari running a web search for a pasted magnet link; the only reply recommends a Safari extension. A 2026-08-17 seedbox-vendor guide (bias noted, LOW) says Safari is not a torrent client and that iTorrent accepts magnet links from Safari.
- web.dev (2022-04-15): "It's impossible to capture URLs on PWAs installed on iOS and iPadOS from Safari." No newer source could be checked (search budget), so treat Home Screen link capture on iOS as unavailable.
- From doc 04 section 2.9: Safari and the installed Home Screen app do not share storage, so a QR code scanned by the camera lands in Safari, not in the installed app.

**F16. Android: intents, WebAPK link capture and share targets.** Confidence HIGH for the cited docs, MEDIUM for the combination (nothing was run on a device). Design-critical: no.
- Chrome starts external apps through a custom scheme or the `intent:` syntax, and does not launch one when the intent URI is triggered without a user gesture or when "The intent cannot be resolved. In other words, no app can handle the intent." The `intent://...#Intent;scheme=magnet;S.browser_fallback_url=...;end` form can hand off to a torrent app with a web fallback (Chrome docs, 2023-12-12).
- Link capture: web.dev says capture of in-scope links "is automatically available on Android when WebAPK is used, such as when users install a PWA with Chrome", so a shared `https://<hub>/#btih:...` link can open in an installed loader.
- `share_target`: BCD Chrome Android 76, Chrome desktop 89, Firefox false (bug 1476515), Safari false (WebKit bug 194593), Firefox Android "parses, but has no effect". Chrome's doc (2019-11-08): the app must be installed; on Android "the `url` field will be empty... URLs will often appear in the `text` field, or occasionally in the `title` field", so read all three. web.dev (2022): "currently available on Android with WebAPK and ChromeOS".
- `file_handlers` (Chrome 102, not Android per BCD) could receive `.torrent` files on desktop.

**F17. QR payload sizes.** Confidence HIGH on arithmetic (Thonky byte-mode capacity table, which mirrors the ISO table; Denso Wave: version 1 is 21x21, each version adds 4 modules per side, version 40 is 177x177). The `#` and lowercase letters force byte mode. [EXP-5], hub `https://hub.example/`:

| Payload | Bytes | ECC L | ECC M | ECC Q | ECC H |
|---|---|---|---|---|---|
| `https://example.com/` (domain mode) | 20 | v2 25x25 | v2 | v2 | v3 29x29 |
| `<hub>/#btih:<40 hex>` | 66 | v4 33x33 | v5 37x37 | v6 41x41 | v8 49x49 |
| `<hub>/#btih:<32 base32>` | 58 | v4 | v4 33x33 | v5 37x37 | v6 41x41 |
| `<hub>/#magnet:?xt=urn:btih:<hex>` | 81 | v5 37x37 | v5 | v7 45x45 | v8 49x49 |
| same + `dn` + one wss tracker | 136 | v7 45x45 | v8 49x49 | v10 57x57 | v11 61x61 |
| same + `dn` + the four `CONFIG.trackers` | 260 | v10 57x57 | v12 65x65 | v15 77x77 | v17 85x85 |
| bare `magnet:?xt&dn&1 tracker` | 115 | v6 41x41 | v7 45x45 | v9 53x53 | v10 57x57 |

- Whether camera apps open a raw `magnet:` QR depends on an installed handler; an https QR opens everywhere (general behaviour, not separately sourced).

**F18. Link forms and fallbacks.** Confidence MEDIUM (design reasoning on F1-F17). Design-critical: no.
- `https://<hub>/#btih:<hex>`, `#magnet:?...` or `#magnet%3A...`: universal; the infohash stays client-side (F5). Make the loader accept all three (R2).
- `?mw=<pointer>` is already in ARCHITECTURE section 4 (explicit pointer source); it leaks the pointer to host logs, so keep it as a rescue path for contexts that strip fragments (not verified which ones do).
- Path form: `/_mw/s/<btih>/...` is the service worker's internal prefix today and is not a pointer source (`detectMode` ignores it); a path-based public link would also leak the infohash to host logs. No advantage found.
- `web+magnet`-style names are valid (`web+` plus lowercase letters only) but dead links wherever no handler is registered (iOS, Android, Safari, fresh profiles). Not recommended as a primary format.

### 3.6 Hub mode, abuse and ecosystem

**F19. In shared-origin hub mode a hosted site can itself call the API.** Confidence HIGH (experiment plus project code). Design-critical: yes.
- `SANDBOX_HUB` in `src/loader/render.js` is `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation`. [EXP-1] Chromium 156: inside `<iframe sandbox="allow-scripts allow-same-origin">` the call `registerProtocolHandler('magnet', origin + '/#%s')` returned normally; inside `sandbox="allow-scripts"` (opaque origin) it threw SecurityError "Can only register custom handler in the document's origin." Chromium counts but does not forbid subframe registration; Firefox allows same-origin iframes. The W3C Permissions Policy feature list (features.md) has no protocol-handler feature (S25).
- Consequence: any site loaded through a shared-origin hub can prompt the visitor to make the hub the handler for any safelisted scheme (magnet, mailto, tel, ...), the "registration spamming" the HTML spec warns about. One more reason for per-site origins (doc 04 recommendation; docs/review/security.md).

**F20. Registering as the handler for all `magnet:` links changes the product's risk profile.** Confidence MEDIUM (reasoned from the sources and project docs). Design-critical: yes.
- Drive-by: any web page can send the visitor to the hub with an arbitrary torrent. docs/review/security.md already requires "never auto-load from a fragment or the protocol handler".
- Mismatch: the loader is a WebRTC-only client (docs/review R5: desktop torrent clients cannot seed to browsers), while public magnets mostly carry udp/http trackers (general knowledge, not measured, Q9); expect timeouts (CONFIG: `metadataMs` 45 s, `noPeersMs` 60 s) and an unusable page for ordinary torrents.
- No way back: once the loader is the browser's default `magnet` handler, any later navigation to `magnet:` is routed to it again (Chromium registry), so it cannot hand a non-site torrent back to the user's torrent app; it can only offer "Copy magnet link" and instructions to reset the handler.
- On Windows and macOS, Chrome also becomes the OS-level default `magnet` client (F6), which affects links clicked in other applications.

**F21. A new dedicated scheme is not a viable route.** Confidence MEDIUM-HIGH (PR and intent pages read through the summarizer; the Chrome 86 shipping and the Chromium extras are confirmed by BCD and the Chromium source). Design-critical: no.
- whatwg/html#5482 (opened 2020-04-24, still Open): Chromium API owners approved and Chrome 86 shipped the decentralized-web extras (cabal, dat, did, dweb, ethereum, hyper, ipfs, ipns, ssb); Mozilla's position stayed pending and Firefox has not followed (bug 1631446 UNCONFIRMED); Apple has no API. Anne van Kesteren on the PR: "having strings without any additional information seems bad". The only portable custom namespace is `web+[a-z]+`, which still needs the API to exist.

**F22. Prior art: web pages that register as the magnet handler.** Confidence HIGH for instant.io (raw source), MEDIUM for qBittorrent (PR page read through the summarizer). Design-critical: no.
- instant.io (WebTorrent), `client/index.js`: on every load, `if ('registerProtocolHandler' in navigator) navigator.registerProtocolHandler('magnet', window.location.origin + '#%s', 'Instant.io')` with the comment "(will prompt the user)", plus a `hashchange` handler `decodeURIComponent(window.location.hash.substring(1))`. On Firefox before 160 this re-prompts on every load; the third argument is obsolete.
- qBittorrent WebUI (PR #10552, merged 2019-05-07 for 4.2.0): `client.js` registers the WebUI as a handler; the magnet is passed in the URL hash and removed before the dialog opens "so a refresh doesn't reopen the dialog"; "the user must authorize it manually" (Chrome: the handler icon in the address bar); a user later got "Your browser does not support this feature" on Firefox over plain HTTP (secure-context rule).
- Precedent for asking engines to support a P2P scheme: the 2020 blink-dev intent for ipfs, ipns, dat, dweb and ssb (F21).

---

## 4. Concrete recommendations for magnet-web

Priority P0 = do before any public claim; P1 = needed for a credible production release; P2 = worthwhile; P3 = optional. Effort S = under a day, M = a few days, L = a week or more.

**R1 (P0, S). Reword every promise about magnet links.** Put the support matrix (section 2) in README, DEPLOY and the Settings help text, and say: "Opt-in on desktop Chrome, Edge, Brave and Firefox only; never on iOS, Android or Safari. Share `https://<hub>/#btih:...` links; they work everywhere." Update docs/review/browser-mobile.md m7(b): Brave no longer ships a built-in WebTorrent (F14). Keep ARCHITECTURE section 10's manifest entry; it is valid (F11). Why: F8, F9, F10, F14, F15. Acceptance: no user-facing string or doc says "magnet links open this site" without the qualifier.

**R2 (P0, S). Fix the fragment decode in `src/loader/render.js detectMode()`.** Decode exactly once and only for the form a handler produces; leave literal fragments alone (F3, F4). Add unit tests for both forms and a tracker with `?key=a&b=c`.
```js
// Handler-built: #magnet%3A%3Fxt%3D...  (encodeURIComponent of the whole magnet URI)  -> decode once
// Hand-built:    #magnet:?xt=...&tr=wss%3A%2F%2F...                                   -> keep as typed
function fragmentToPointerText (rawHash) {
  const h = String(rawHash || '').replace(/^#/, '')
  if (/^(?:magnet|btih|host)%3a/i.test(h)) { try { return decodeURIComponent(h) } catch (_) { return h } }
  return h
}
```
Then run `isPointerHash` and `normalizePointerText` on that result as today. Test file to extend: `test/unit` (the experiment in `labs/w1-09-lab/fragment_decode_test.mjs` is a ready starting point). Why: F4 [EXP-3].

**R3 (P1, S). Add a "paste a magnet link or hash" box to the hub landing page and a Paste button.** On submit run `parseMagnet` / `normalizeBtih`, then set `location.hash` to `#btih:<hex>` (or the full magnet when it carries `tr`/`ws`). This is the only path that works on iOS Safari and every mobile browser without an installed app, and it is the escape hatch when a handler loop traps a non-site torrent (F20). Use `navigator.clipboard.readText()` only inside the click handler. Why: F8, F9, F15, F18.

**R4 (P1, M). Add an opt-in "Open magnet links with this site" control, hub origin only.**
- Show it only when `isSecureContext && typeof navigator.registerProtocolHandler === 'function'`, only in hub mode at the canonical hub origin, never in domain mode (a customer's own domain must not offer to take over a global scheme), and never inside a hosted site (F19).
- Call it from the click handler, two arguments, inside try/catch; never on load (Firefox before 160 re-prompts every time, F7; instant.io's on-load call is the anti-pattern, F22).
```js
btn.addEventListener('click', () => {
  try { navigator.registerProtocolHandler('magnet', new URL('/#%s', location.origin).href) } // sub-path deploys: use the deploy base
  catch (e) { debugLog('registerProtocolHandler: ' + e.name + ': ' + e.message) }
  showNote('Requested. Your browser decides; look for its prompt.')   // no API reveals the outcome
})
```
- Copy to show before the click: Chrome/Edge show a permission prompt near the address bar and may also ask the OS to make the browser the default for magnet links (Windows/macOS); Firefox shows a bar at the top and, after "Add application", asks which app to use on the next click; a later change of the OS default can silently remove the Chrome setting (F6, F7).
- Also show how to undo: Chrome `chrome://settings/handlers` (named in Chromium source); Edge and Firefox paths are unverified (Q7, Q4), so say "browser settings, Applications / Handlers" until checked.
- Remember only "we asked on <date>" in localStorage (a per-viewer convenience); never claim "enabled". Why: F6, F7, F20, F22.

**R5 (P1, M). Arrival interstitial and a "not a website torrent" path for anything that arrives via fragment, handler, share target or paste.** Matches docs/review/security.md ("never auto-load from a fragment or the protocol handler"). Show name (`dn`), infohash, tracker hosts (and whether any is `wss://`), and, after metadata, size and whether the torrent contains `index.html`; require an explicit "Open as website" click. If it is not a site, show "This looks like an ordinary file torrent" with "Copy magnet link" and the undo instructions from R4; do not try `location = 'magnet:...'` (it loops back through a registered handler, F20). Time budgets already exist in `CONFIG.timeouts`. Why: F19, F20.

**R6 (P1, S). Guard the manifest in CI.** `build.mjs` derives `scope`, `start_url` and the handler `url` from one deploy base path (sub-path deployments, m2); a Playwright test loads the built page and reads `Page.getAppManifest` errors, failing on any `protocol_handlers` error. `labs/w1-09-lab/exp_rph.mjs` already contains the harness and ten cases. Why: F11 (an out-of-scope or malformed entry is silently dropped; only the console and CDP show it).

**R7 (P2, S). Add `share_target` for Android (and ChromeOS), GET, privacy-preserving.**
`"share_target": {"action": "/_mw/share", "method": "GET", "params": {"title": "title", "text": "text", "url": "url"}}`. Reserve the path under `/_mw/` (site routes cannot collide). The service worker answers the navigation from cache without touching the network, so the shared magnet never reaches host logs; the loader scans `text`, `title` and `url` (Android puts links in `text`) for `magnet:`, `btih:` or a loader link, strips the query with `history.replaceState`, then runs R5. Why: F16. Limit: needs the installed app; not iOS, Firefox, Safari.

**R8 (P2, S). Add "Show QR code" next to "Copy magnet link".** Encode `<origin>/#btih:<40 hex>` by default (66 bytes for a short hub name: version 5 at ECC M, 37x37 modules; base32 form is version 4). Warn when the payload needs more than about version 10, which means a link that carries trackers. Generate the code locally with a small MIT encoder (not evaluated here); do not send infohashes to a QR web service. Why: F17.

**R9 (P2, S). Publisher-side companion snippet for "any existing site can migrate".** A tiny `mw-links.js` (served from the hub or inlined) that, for each `a[href^="magnet:"]` on a page the publisher controls, inserts a sibling "Open in browser" link to `https://<hub>/#<btih or magnet>`. Progressive enhancement: native torrent users keep the magnet link, everyone else (including iOS and Android) gets a working https link. Why: F8, F9, F15, F18.

**R10 (P2, M). Handler registration belongs to the hub apex; keep it compatible with per-site origins.** The handler URL must be same-origin with the registering page (F2), so if wildcard per-site origins ship (doc 04, docs/review/security.md), register only from the apex, and make the apex route for `/#%s` a router: parse the pointer, `location.replace('https://<label>.<hub>/#<pointer>')`. Per-site origins also remove the F19 exposure, because hosted site code is then no longer same-origin with the apex. Interim mitigation for shared-origin hubs: document F19 and keep the R5 interstitial. Why: F2, F19.

**R11 (P2, S). Help text and a diagnostics line.** In the debug log print `isSecureContext`, `typeof registerProtocolHandler`, and the exception name/message on failure (the messages are specific, F1, F2). Provide a "Test link" that opens a built-in `magnet:` sample only after the user confirms (it opens the native app, or the loader, depending on their setup). Why: F6, F7.

**R12 (P3, M). `.torrent` file handler for desktop Chromium.** `file_handlers` with `application/x-bittorrent` and `.torrent` (Chrome 102+, desktop only, BCD), read through `launchQueue`, parse with the already-installed `parse-torrent`, then R5. Verify that Chromium's manifest parser accepts the entry with the CDP harness before building. Why: F16.

**R13 (P3, S). `launch_handler`.** Only if a `launchQueue` consumer exists: `{"client_mode": ["focus-existing", "auto"]}` keeps one loader window and lets R5 show the new link without discarding the current site. Without a consumer `focus-existing` silently ignores the link, so do not set it alone (F13).

**R14 (P3, S). Optional marker parameter (my idea; no precedent found).** Publisher tools append `x.mw=1` to the magnets they print; `parseMagnet` already ignores unknown parameters, so old clients are unaffected. The R5 interstitial can then skip metadata timeouts for magnets without the marker and say "probably not a website" immediately. Weigh against the cost of yet another convention.

**R15 (P3, S). Manual QA checklist on real devices, once per release.** The automated suite proves validation only (headless cannot show consent UI). Cover: install the PWA on Chrome or Edge (Windows or macOS) and click a magnet link (does the `#...` survive, Q1); Firefox 160 bar and "Never allow"; Brave prompt; Safari and iOS error; Android Chrome share to the installed loader and link capture; one QR scan with iOS Camera and one with Android.

---

## 5. Gotchas (checklist)

- G1. Registration is per origin and per browser profile; in domain mode every customer domain is its own origin. Offer the control on the hub only (R4).
- G2. After a user "ignores" the Chrome prompt, later calls are silently dropped and nothing tells the page (F6); there is no `isProtocolHandlerRegistered` in Chromium [EXP-1] and `unregisterProtocolHandler` exists only in Chromium (BCD: Chrome 38, Firefox false, Safari false).
- G3. Firefox before 160 re-prompts on every call; "Add application" is not "make default" (F7).
- G4. On Windows and macOS the Chrome web default for `magnet` is removed again if Chrome is not the OS default `magnet` client, including after a later OS change (F6).
- G5. The browser percent-encodes the whole magnet URI once. Decode once for `magnet%3A...` fragments; never decode literal `#magnet:...` links (F3, F4). The examples in the HTML and WICG specs show an unencoded scheme separator and are wrong about the engines.
- G6. The `title` argument is gone from the spec; Chromium ignores a third argument, Firefox removed it. instant.io still passes one.
- G7. `web+` names allow ASCII letters only: `web+magnet2` is rejected [EXP-1]; a hyphen (`web+mw-x`) is rejected by the spec rule and by Chromium's `IsAsciiAlpha` check (code, not run).
- G8. In a manifest the handler `url` must be inside `scope`; a sub-path deployment with `/#%s` is silently dropped (F11).
- G9. PWA handlers are top-level, user-initiated navigations only; `<iframe src="magnet:...">` and programmatic navigations may not open the app (F12).
- G10. Making the loader the default means the user's own torrent client no longer receives in-browser magnet clicks, and the loader cannot hand a non-site torrent back (F20).
- G11. Most public magnets carry no WebRTC-capable peers, so the loader will time out on them (F20).
- G12. A hub-hosted site in a same-origin sandboxed iframe can call `registerProtocolHandler` (F19).
- G13. iOS resolves a custom scheme to an installed app, and "the app the system targets is undefined" when several claim it (F15).
- G14. Source conflicts: MDN BCD marks Firefox for Android as mirroring desktop (supported) while GeckoView bug 917866 and caniuse say unsupported; caniuse's note about which protocols work is stale (it omits `magnet`). BCD "mirror" cells are inferences, not tests.
- G15. Brave older than 1.78.94, and older installs that kept WebTorrent on until 1.81.131, rewrite `magnet:` to their extension page (F14).
- G16. Chromium's extra dweb schemes (ipfs, ipns, dat, ...) are not in the HTML Standard and not in Firefox; do not build on them (F21).
- G17. Playwright's Firefox build could not start in this environment ("Could not find profile folder"), and WebKit here is Playwright's engine build, not Safari.app. Nothing in this note was run on a phone.
- G18. Android share targets deliver links in `text` or `title`, not `url` (F16).
- G19. `#` and lowercase letters force QR byte mode; the base32 infohash saves 8 bytes (F17).
- G20. A QR code opened by the iOS Camera lands in Safari, not in an installed Home Screen web app, and the two do not share storage (F15).

---

## 6. Open questions

- Q1. Does an installed Chrome/Edge PWA launched through a protocol handler keep the `#...` fragment? Needs a real install on Windows, macOS or Linux. If it does not, the only workaround is `?mw=%s`, which leaks the infohash to host logs.
- Q2. Exact current Chrome/Edge consent wording and placement (chip vs bubble), and whether Brave shows the same UI. The English strings file was not located; headless cannot show it.
- Q3. Windows 11 and macOS behaviour when Chrome/Edge tries to become the default `magnet` client, and whether a later OS-default change removes the web default as the source implies.
- Q4. Firefox runtime: confirm the info bar, the chooser after "Add application", the Firefox 160 "Never allow" button, and where users undo it (Settings > General > Applications is expected; not verified here).
- Q5. Safari.app and iOS: confirm `typeof navigator.registerProtocolHandler` is `"undefined"` and the exact alert on an unhandled `magnet:`; confirm that iOS 26/27 Home Screen web apps still cannot capture links (the only source is web.dev, 2022).
- Q6. Android: does tapping an https loader link open the installed WebAPK, does Share deliver `magnet:` text in `text`/`title`, and does Samsung Internet behave like Chrome? Also check the Chromium status entry for Android protocol handlers (not read) and whether any Chrome 150+ release changed it.
- Q7. Edge-specific paths (`edge://settings/...` for handlers), and Edge PWA protocol launch on macOS.
- Q8. Which link wrappers, messengers or email click-trackers drop or re-encode fragments (the reason to keep `?mw=` as a rescue path).
- Q9. What fraction of public magnets contain a `wss://` tracker (sizes the "not a website torrent" problem and decides R14).
- Q10. Does Chromium's `file_handlers` parser accept `application/x-bittorrent` and `.torrent`? Not tested.
- Q11. The ordering of Brave's former URL rewrite against the registry's URL-loader throttle (only matters for old Brave).
- Q12. QR legibility at version 5 versus 12 on typical phones and print sizes; capacities are exact, scanning reliability is not measured.

---

## 7. Experiments I ran (2026-10-17, macOS arm64, Darwin 27.0.0, Node v24.22.0, Playwright 1.64.1)

Scripts and raw results: `docs/research/labs/w1-09-lab/` (see `RUN.txt`). Headless automation cannot show or accept consent UI, so EXP-1/2/4 prove validation and parsing, not UX.
- **EXP-1. `registerProtocolHandler` runtime semantics.** Chromium 156.0.8078.4 (headless shell): `registerProtocolHandler` and `unregisterProtocolHandler` are functions, `isProtocolHandlerRegistered` is undefined; `magnet`, `MAGNET`, `web+magnetweb`, relative `/#%s`, query `?m=%s` and a legacy third argument all return normally; `bittorrent`, `https`, `magnet:`, `web+`, `web+magnet2` throw SecurityError; missing `%s` and `%s` in the host throw SyntaxError; cross-origin https throws SecurityError ("Can only register custom handler in the document's origin."); `http://example.org` throws SecurityError ("The scheme of the url provided must be HTTP(S)."). Sandboxed iframes: `allow-scripts allow-same-origin` succeeds, `allow-scripts` (opaque origin) throws SecurityError. WebKit 27.2 (Playwright build 2370, UA `Version/27.2 Safari/605.1.15`): `typeof navigator.registerProtocolHandler` is `"undefined"` in the top frame and in both iframe types. Firefox (Playwright build 1555): would not start ("Could not find profile folder") with three different profile locations; no result.
- **EXP-2. Manifest parser verdicts.** Ten `protocol_handlers` cases through CDP `Page.getAppManifest` on Chromium 156 (table in F11).
- **EXP-3. Loader fragment decode.** The project's real `detectMode()` and `parseMagnet()` on (A) a handler-built hash, (B) a literal-magnet hash with an encoded `&` in a tracker URL, (C) `#btih:<hex>`, (D) a hypothetical engine that leaves `%XX` unescaped. (A) and (C) correct; (B) and (D) lose `&b=c` from the tracker.
- **EXP-4. Brave.** Brave Browser 155.1.97.59 (installed, throwaway profile deleted afterwards, headless, no clicks, 127.0.0.1 only): `navigator.brave.isBrave()` true; same results as Chromium for `magnet`, `web+magnetweb`, `bittorrent`, missing `%s`, cross-origin.
- **EXP-5. Computations.** URL Standard component percent-encode set rebuilt from `url.bs` versus `encodeURIComponent` for U+0000..U+007F: no differences. QR sizes for seven link shapes from the Thonky capacity table (F17).

---

## 8. Source index (every URL below was actually fetched or executed)

- S1 HTML Standard source, section "Custom scheme handlers" (lines 131988-132275), whatwg/html head `de953a7` committed 2026-10-16T14:26:23Z: https://raw.githubusercontent.com/whatwg/html/main/source
- S2 URL Standard source (percent-encode sets, note about `encodeURIComponent`): https://raw.githubusercontent.com/whatwg/url/main/url.bs
- S3 MDN browser-compat-data (main, 2026-10-17): https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/manifests/webapp/protocol_handlers.json ; .../manifests/webapp/share_target.json ; .../manifests/webapp/file_handlers.json ; .../manifests/webapp/launch_handler.json
- S4 caniuse data (2026-10-17; includes Safari up to 27.2, Chrome up to 157): https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/registerprotocolhandler.json
- S5 MDN: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/registerProtocolHandler (last modified 2025-06-23) ; raw sources https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/navigator/registerprotocolhandler/index.md ; .../web/progressive_web_apps/manifest/reference/protocol_handlers/index.md ; .../web/progressive_web_apps/manifest/reference/launch_handler/index.md ; .../web/api/launchparams/targeturl/index.md
- S6 Chrome for Developers, "URL protocol handler registration for PWAs" (last updated 2021-05-11; quotes re-checked in the raw HTML): https://developer.chrome.com/docs/web-platform/best-practices/url-protocol-handler
- S7 WICG Manifest Incubations (repo pushed 2026-08-25): https://wicg.github.io/manifest-incubations/#protocol_handlers-member ; source https://raw.githubusercontent.com/WICG/manifest-incubations/gh-pages/index.html
- S8 Chromium source, GitHub mirror `main`, fetched 2026-10-17, base https://raw.githubusercontent.com/chromium/chromium/main/ : third_party/blink/renderer/modules/navigatorcontentutils/navigator_content_utils.cc ; third_party/blink/common/custom_handlers/protocol_handler_utils.cc ; third_party/blink/renderer/modules/manifest/manifest_parser.cc ; components/custom_handlers/{README.md, protocol_handler.cc, protocol_handler_registry.cc, register_protocol_handler_permission_request.cc} ; chrome/browser/custom_handlers/chrome_protocol_handler_registry_delegate.cc ; chrome/browser/{shell_integration.cc, shell_integration_mac.mm, shell_integration_linux.cc} ; chrome/browser/web_applications/os_integration/{protocol_handling_sub_manager.cc, web_app_protocol_handler_registration.cc, web_app_protocol_handler_registration_win.cc, web_app_shortcut_linux.cc, mac/web_app_protocol_handler_registration_mac.cc} ; chrome/app/generated_resources.grd (searched; registration-prompt strings not in it) ; directory listings https://github.com/chromium/chromium/tree/main/chrome/browser/web_applications/os_integration and .../os_integration/mac
- S9 Firefox source (mozilla-firefox/firefox `main`, 2026-10-17), base https://raw.githubusercontent.com/mozilla-firefox/firefox/main/ : dom/base/Navigator.cpp ; uriloader/exthandler/WebHandlerApp.sys.mjs ; browser/components/protocolhandler/components.conf ; browser/components/protocolhandler/WebProtocolHandlerRegistrar.sys.mjs ; browser/locales/en-US/browser/webProtocolHandler.ftl ; browser/locales/en-US/chrome/browser/browser.properties
- S10 Bugzilla (public REST): https://bugzilla.mozilla.org/rest/bug?summary=registerProtocolHandler ; https://bugzilla.mozilla.org/rest/bug/917866 and /comment ; https://bugzilla.mozilla.org/rest/bug/668577 and /comment
- S11 Mozilla release data: https://whattrainisitnow.com/api/release/schedule/?version=160 ; https://product-details.mozilla.org/1.0/firefox_versions.json
- S12 WebKit: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/Navigator.idl ; https://bugs.webkit.org/show_bug.cgi?id=73177 ; https://github.com/WebKit/standards-positions/issues?q=registerProtocolHandler (0 results)
- S13 https://github.com/whatwg/html/pull/5482 ; https://groups.google.com/a/chromium.org/g/blink-dev/c/7nHTRUP1EGY (page truncated in the fetch)
- S14 https://github.com/mdn/browser-compat-data/issues/26107
- S15 web.dev "OS integration" (last updated 2022-04-15; quotes re-checked in raw text): https://web.dev/learn/pwa/os-integration/
- S16 Microsoft Edge: https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/handle-protocols (ms.date 2022-01-12, updated 2025-11-26) ; https://learn.microsoft.com/en-us/microsoft-edge/devtools/progressive-web-apps/protocol-handlers (updated 2026-09-02)
- S17 Brave: https://github.com/brave/brave-browser/issues/44303 ; https://github.com/brave/brave-browser/issues/46430 ; https://raw.githubusercontent.com/brave/brave-browser/master/CHANGELOG_DESKTOP.md ; https://github.com/brave/brave-browser/releases/tag/v1.78.94 ; .../v1.81.131 ; .../v1.82.161 ; https://raw.githubusercontent.com/brave/brave-core/v1.69.153/components/brave_webtorrent/browser/magnet_protocol_handler.cc ; https://github.com/brave/brave-browser/releases.atom (latest 10 only)
- S18 https://developer.chrome.com/docs/android/intents (last updated 2023-12-12) ; https://developer.chrome.com/docs/capabilities/web-apis/web-share-target (last updated 2019-11-08)
- S19 Apple, "Defining a custom URL scheme for your app" (read through the documentation JSON): https://developer.apple.com/tutorials/data/documentation/xcode/defining-a-custom-url-scheme-for-your-app.json
- S20 iOS secondary sources: https://discussions.apple.com/thread/254689969 (2023-03-05) ; https://alternativeto.net/software/magnet-links/about (updated 2022-08-25) ; https://www.rapidseedbox.com/blog/how-to-torrent-on-ios (2026-08-17, seedbox vendor)
- S21 Prior art: https://raw.githubusercontent.com/webtorrent/instant.io/master/client/index.js ; https://github.com/qbittorrent/qBittorrent/pull/10552 (opened 2019-04-30, merged 2019-05-07)
- S22 QR: https://www.thonky.com/qr-code-tutorial/character-capacities ; https://www.qrcode.com/en/about/version.html
- S23 Project files read: docs/ARCHITECTURE.md (sections 3, 4, 10), docs/INTERFACES.md (searched), docs/review/{browser-mobile.md m6-m7, requirements-fidelity.md R6/m1, security.md}, docs/research/04-service-worker-serving.md section 2.9, src/loader/{render.js, app.js, config.js, ui.js, index.html}, src/common/magnet.js
- S24 My experiments: section 7, files in docs/research/labs/w1-09-lab/
- S25 https://raw.githubusercontent.com/w3c/webappsec-permissions-policy/main/features.md (no protocol-handler feature)
- S26 https://community.brave.app/t/magnet-links-no-longer-open-in-brave/601704
- S27 https://www.rfc-editor.org/rfc/rfc3986.txt (January 2005)

Referenced but not read: https://issues.chromium.org/issues/40964464 (crbug "Implement registerProtocolHandler on Android"; the tracker page requires a sign-in); the rendered HTML Standard page (the source file S1 was read instead); https://caniuse.com/registerprotocolhandler (the JSON data S4 was read instead); the Chromium status entry for URL protocol handlers. Search results from the first search round were used only to find sources and are not cited.

---

## 9. Artifacts created

- This note: `docs/research/w1-09-protocol-handler-magnet.md`
- `docs/research/labs/w1-09-lab/` : `RUN.txt`, `exp_rph.mjs` (EXP-1, EXP-2), `exp_brave.mjs` (EXP-4), `exp_ff.mjs` (Firefox attempt, fails here), `fragment_decode_test.mjs` (EXP-3), `encode_set_check.mjs` and `qr_sizes.mjs` (EXP-5), `results-2026-10-17.txt`, `results-exp_rph-2026-10-17.json`
- Playwright browser builds `webkit-2370` and `firefox-1555` were installed into `~/Library/Caches/ms-playwright/` (Firefox does not start here; left in place, safe to delete).
