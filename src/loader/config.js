// src/loader/config.js: every tunable the loader uses, in one place (INTERFACES "src/loader/config.js").
// No imports, no DOM: shared by app.js, torrent.js, policy.js, render.js, bridge.js, ui.js and the
// drop-in runtime. Keys listed in INTERFACES are binding; extra keys below them are additive.

function deepFreeze (obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v)
  }
  return Object.freeze(obj)
}

export const CONFIG = deepFreeze({
  version: '0.3.0', // v0.3 (INTERFACES v0.3: SDK_VERSION = '0.3.0', which this matches; integration I-6); v0.2.1 changed the formats
  // Declared browser floor with the boot.js polyfills (ARCHITECTURE §5.1, DESIGN-REVIEW item 16).
  floor: { safari: '15.4', chromium: 110, firefox: 115 },
  // Live public WebSocket trackers on 2026-10-14 (research 02, DESIGN-REVIEW item 15). Used only for
  // unsigned pointers and bare magnets: a signed pointer's tr= list is used exactly (item 12).
  trackers: ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com', 'wss://tracker.novage.com.ua', 'wss://open.ftorrent.com'],
  // STUN from two operators with published terms (research 03); no TURN in v1 (v0.2.1 B7: probe-gated,
  // never an empty list, see ice below).
  stun: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }],
  // Empty = use RESOLVERS from doh.js (Cloudflare JSON, dns.sb, Google with edns_client_subnet=0.0.0.0/0).
  doh: [],
  limits: {
    maxSiteBytesDesktop: 134217728, // 128 MiB
    maxSiteBytesMobile: 50331648, // 48 MiB
    maxSiteBytesCellular: 25165824, // 24 MiB
    storageBudgetDesktop: 536870912, // 512 MiB
    storageBudgetMobile: 134217728 // 128 MiB
  },
  timeouts: {
    swReadyMs: 15000, // navigator.serviceWorker.ready cap (item 17)
    metadataMs: 45000, // peers connected but no metadata
    noPeersMs: 60000, // no peer and no web seed at all
    dohMs: 4000, // per resolver
    xsMs: 10000 // .torrent fetch and web-seed probe
  },
  chain: { minBits: 0 },
  // v0.2.1 B1: keepaliveScrapeMs (a scrape every 90 s) is gone: tracker.openwebtorrent.com closes the socket on
  // scrape. The keepalive is an offer-free announce (numwant 0) on a socket silent for keepaliveAnnounceMs.
  wire: { maxMessageBytes: 262144, keepaliveAnnounceMs: 55000, timeoutMs: 60000 },
  paths: { sw: '/mw-sw.js', assets: '/_mw/', hubSite: '/_mw/s/', webseedRewrite: '/_mw/ws/', torrents: '/_mw/t/' },
  proto: 1,

  // ---- additive keys (not in INTERFACES; safe to ignore elsewhere) -------------------------------
  assets: {
    loader: '/_mw/loader.js',
    webtorrent: '/_mw/webtorrent.min.js',
    powWorker: '/_mw/pow-worker.js',
    sdk: '/_mw/sdk.js'
  },
  policy: {
    // v0.2.1 (DIGEST-AMENDMENTS C2; research digest 2.4, w1-08 Mobile policy v1): four classes. Bytes per
    // second; 0 = uploads off (choke lock, never throttleUpload(0)). Every mobile class is download-only until
    // the visitor turns on "Share on this network" for this origin (then mobileOptInUploadLimit). A metered
    // network (cellular or Save-Data) is mobileMetered on any device. numwant = offers per announce.
    desktop: { maxConns: 30, uploadLimit: 1048576, numwant: 3 },
    mobileUnmetered: { maxConns: 8, uploadLimit: 0, numwant: 3 },
    mobileUnknown: { maxConns: 6, uploadLimit: 0, numwant: 3 },
    mobileMetered: { maxConns: 4, uploadLimit: 0, numwant: 2 },
    mobileOptInUploadLimit: 131072, // 128 KiB/s after the per-origin opt-in
    minShapingBytes: 32768, // shaping only at 32 KiB/s or more
    hiddenBatteryMs: 600000, // desktop on battery: destroy the client after 10 min hidden
    rebuildAfterHiddenMs: 60000, // desktop (and the drop-in runtime): visible after more than 60 s hidden
    rebuildAfterHiddenMobileMs: 10000, // v0.2.1 C2: phones, visible after more than 10 s hidden
    gossipWireFloor: 2, // v0.2: kept for callers that read it; per-swarm caps below replace its use
    // v0.2.1 B6: per-swarm caps after the extended handshake. Content: soft = maxConns, hard = soft +
    // ceil(soft * contentHardExtra). Rendezvous (ledger) swarm: fixed budgets.
    contentHardExtra: 0.5,
    rendezvous: { desktop: { soft: 6, hard: 9 }, mobile: { soft: 3, hard: 5 } },
    capGraceMs: 10000 // a wire that never sends its extended handshake is counted after this long
  },
  pointer: {
    txtPrefix: '_magnet.',
    minTtlMs: 300000, // DNS answers cached per TTL, minimum 5 min (§4)
    maxTtlMs: 86400000, // v0.3 (MF-30): and at most 1 day (doh.js clampTtlSeconds)
    focusRecheckMinMs: 60000, // at most one focus-triggered re-check per minute
    expiryWarnDays: 14,
    maxLifetimeDays: 400
  },
  ledger: {
    // v0.2.1 B2: the rendezvous swarm is the bare infohash sha1hex(rendezvousPrefix + ledgerId); it is
    // announced with left: 1 and never seeded (the one-piece anchor torrent of v0.2 is gone).
    rendezvousPrefix: 'mw-ledger/1/',
    joinJitterMs: 1500, // random 0 to 1.5 s before the first rendezvous announce
    glareWatchMs: 20000, // peers reported but no rendezvous wire after this long: re-announce
    glareRetries: 3,
    glareJitterMs: 3000,
    ingressRate: { n: 30, perMs: 600000 },
    nodeOpenMs: 5000, // wait this long for the ledger before adding torrents (gossip attaches synchronously)
    snapshotMaxBytes: 67108864, // cs= download ceiling (maxChainBytesCeiling)
    // Code review round 1: an inflated (gzip) snapshot is capped too, and the fetch has a timeout.
    snapshotMaxInflatedBytes: 134217728, // 2 x the download ceiling
    snapshotTimeoutMs: 30000,
    verifierPoolSize: 2
  },
  bridge: { writesPerMinute: 20, maxRequestBytes: 65536, maxListLimit: 1000, readyWaitMs: 15000 },
  identity: { pbkdf2Iterations: 600000 },
  ui: { progressIntervalMs: 250, maxDebugLines: 300, collapseAfterRenderMs: 4000, diagnoseAfterMs: 5000 },
  // followerSiteMs (code review round 1): a follower tab waits this long for the engine tab's copy of
  // the version it renders, then downloads it itself.
  timeoutsExtra: { stallMs: 120000, swPingMs: 1500, swAckMs: 5000, controllerWaitMs: 1500, trackerPollMs: 2000, followerSiteMs: 20000 },

  // ---- v0.2.1 additions (DIGEST-AMENDMENTS B1, B4, B5, B7, C1) ------------------------------------
  // B1: tracker connection shim (research w2b-01 F7, R4). Reconnect after 500 ms + U(0, min(60 s, 1 s x 2^n))
  // instead of the stock 10 s x 2^n + U(0, 5 min); kick() reopens now and re-announces at most every
  // kickMinIntervalMs.
  tracker: { reconnectBaseMs: 500, reconnectJitterMs: 1000, reconnectMaxMs: 60000, kickMinIntervalMs: 15000, keepaliveCheckMs: 5000 },
  // B5 (research digest 4.1 row 29): the length cap above destroys a wire before buffering; this watchdog
  // destroys any wire whose private _bufferSize passes bufferWatchdogBytes (checked every bufferWatchdogMs).
  // B6 (w1-12 R3): reqq advertised in our extended handshake.
  wireGuard: { bufferWatchdogBytes: 524288, bufferWatchdogMs: 2000, reqqMin: 4, reqqMax: 32, reqqUnlimited: 32, reqqRendezvous: 8 },
  // B4 (migration digest M08): 3 failures from one web seed within 30 s stop it for 5 minutes.
  webseed: { failureLimit: 3, failureWindowMs: 30000, backoffMs: 300000 },
  // B7 (production digest P0-6, P0-7; research w2b-03 R-02, R-04): TURN off; STUN probed before use.
  ice: { turn: [], probeBudgetMs: 2500, probeSettleMs: 150, probeConfirmMs: 600, offerTimeoutMs: 1500 },
  // C1 (production digest D18, P0-17): the consent record is { v, choice, dns, day, scope, rcpt }; a record
  // with another version or other recipients is asked again. aud= values that make consent=gate the default.
  // aud= tokens that make the consent gate the default (code review round 1: the one table; ARCHITECTURE
  // §4 and §8 and src/common/pointer.js say the same). 'general' is the only token without that effect.
  consent: { version: 2, gateAudiences: ['personal', 'eea', 'eu', 'uk', 'qc', 'quebec', 'sensitive', 'kids'] },

  // ---- v0.3 hardening (harden-loader; V03-DESIGN-REVIEW 2.7.1, 2.8.8, 2.16.4, MF-30, MF-39, MF-74 to MF-76;
  // ARCHITECTURE 15.10). "chosen" = a design parameter a gate row confirms or tunes. -------------------------
  // MF-39: one wire budget per tab across every swarm (desktop 40, phones 8, chosen; G-SC-2 measures). Over
  // budget, wires go from the lowest priority swarm first; each swarm keeps its floor while the budget allows.
  wireBudget: {
    desktop: 40,
    phone: 8,
    priority: ['site', 'rendezvous', 'chat', 'group', 'file'],
    floors: { site: 2, rendezvous: 2, chat: 1, group: 1, file: 1 },
    // Per-swarm caps of the new swarm kinds (chosen); site and rendezvous keep policy.content / policy.rendezvous.
    swarmCaps: { chat: { soft: 4, hard: 6 }, group: { soft: 3, hard: 4 }, file: { soft: 4, hard: 6 } }
  },
  // MF-74, MF-75: wires idle 2 min after the handshake close; "peers but no progress" after noProgressMs (chosen,
  // backing off to noProgressMaxMs); up to anchorShare of a swarm's hard cap is kept for wires that delivered
  // valid data; ut_metadata requests beyond utMetadataPerMinute per wire per minute are dropped once the
  // metadata is complete. A wire closed as ignored is only closed: its self-declared peer id is never banned
  // (another swarm member could claim an honest visitor's id to get it banned).
  wireLimits: { idleMs: 120000, checkMs: 5000, noProgressMs: 60000, noProgressMaxMs: 900000, anchorShare: 0.5, utMetadataPerMinute: 4 },
  // R 2.8.8 and 3.2.3: ledgers count in the storage budget (64 MiB phones, 256 MiB desktop, chosen); files get at
  // most filesShare of what remains after the site and its ledger.
  storageBudget: { ledgerPhone: 67108864, ledgerDesktop: 268435456, filesShare: 0.5 },
  // MF-76: unsigned records use at most 4 ws= and 2 xs= (src/common/magnet.js filterWebseeds).
  webseedFilter: { maxWs: 4, maxXs: 2 },
  // R 2.8 file torrents (addFileTorrent): the .torrent is at most 256 KiB.
  fileTorrent: { maxTorrentFileBytes: 262144 },
  // MF-28, MF-30 (src/loader/harden.js): refusals expire after 7 days; withdrawals bind at most 30 days after
  // signing and are re-signed within resignMarginMs of that; a rotation first seen by a visitor without a pin is
  // delayed rotationDelayMs (chosen) unless nx= matches; every timer is clamped to 2^31 - 1 ms.
  harden: { refusalTtlMs: 604800000, withdrawalMaxMs: 2592000000, withdrawalResignMarginMs: 604800000, rotationDelayMs: 86400000, maxTimerMs: 2147483647 },

  // ---- v0.3 C2 smart seeding (seed-policy lane; docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.2 to
  // 3.1.4, S1 D1 to D3). Three lanes in spending order: H hand-off (the member's own new items), K keep (chosen
  // items and the site), E echo (held items by copy deficit). Rates are bytes per second and caps are bytes; 0 =
  // the lane is off; session null = none. rows is the SZ 3.1.3 table (chosen: the G-PS gate rows confirm or tune
  // it); src/loader/seed-budget.js picks the row. The two owner decisions not yet signed ship as flags whose
  // defaults keep the v0.3 behaviour.
  seed: {
    phoneDefaultOn: false, // SZ-1 (not signed): phones run K and E by default in row 2, the one provable case
    handoffWhileHidden: false, // SZ-2 (not signed): a hidden phone keeps sending H until the browser suspends it
    superSeed: false, // S1 D4: the super-seeded hand-off (src/loader/superseed.js) stays off until G-PS-8
    echoTargetCopies: 3, // E aims for 3 complete online copies of an item (chosen; for speed, not durability)
    dockDefaultMs: 7200000, // dock mode: "Keep this screen on and share for 2 hours"
    dockCapMs: 28800000, // dock mode: at most 8 hours (chosen)
    dockMinBattery: 0.2, // dock mode ends below 20% where the Battery Status API exists (Chromium)
    rows: {
      // Row 1: desktop, not metered. 20 GB = 20,000,000,000 bytes (the Delivery Optimization default the row cites).
      desktop: { H: 1048576, K: 1048576, E: 262144, session: null, month: 20000000000 },
      // Row 2: phone, Chromium, Wi-Fi by connection.type, charging, battery 50% or more (dock mode: on the
      // person's word "plugged in, on Wi-Fi" where the browser cannot tell).
      phoneCharging: { H: 1048576, K: 262144, E: 262144, session: 67108864, month: 1073741824 },
      // Row 3: phone, Wi-Fi proven, unplugged, battery 50% or more.
      phoneWifi: { H: 524288, K: 131072, E: 0, session: 33554432, month: 268435456 },
      // Row 4: phone, battery 20% to 49%, or nothing provable (iOS, Firefox); a charging phone under 20% lands
      // here too (the table has no row for it). wifi: the rates after "I am on Wi-Fi" (or Wi-Fi by connection.type).
      phoneLimited: { H: 131072, K: 0, E: 0, session: 33554432, month: 268435456, wifi: { H: 524288, K: 131072, E: 0 } },
      // Row 5: cellular, Save-Data, or battery under 20% unplugged; a metered network puts a desktop here too.
      // H runs only for items with the per-upload card (MF-45).
      metered: { H: 131072, K: 0, E: 0, session: 16777216, month: 0 },
      // Row 6: any phone, local wire (a host-to-host candidate pair, src/loader/localwire.js): outside the month cap.
      local: { H: 1048576, K: 524288, E: 262144, session: 134217728 },
      // Row 7: during a call (SZ 3.5): phones H at most 128 KiB/s, K and E 0; a desktop halves K while the call is
      // bandwidth-limited and stops E. Session and month caps stay those of the row underneath.
      call: { phoneH: 131072, phoneK: 0, phoneE: 0, desktopKFactor: 0.5, desktopE: 0 }
    }
  }
})

export default CONFIG
