// Shared launch policy for every Playwright browser this project starts (tests, seeder, demo, pin).
// Goal: test browsers must never reach the internet from a developer machine. On macOS with an
// outbound firewall (LuLu, Little Snitch) every remote connection otherwise raises an alert per
// process and per destination; Chrome for Testing also contacts Google services on launch.
//
// Chromium: --host-resolver-rules makes every hostname except localhost fail to resolve, so no
// remote socket is ever opened (no DNS, no TCP, no QUIC). Connections to literal 127.0.0.1 and
// ::1 still work. The mDNS flag is what lets two tabs on one machine complete ICE in headless mode.
// v0.3 final integration: names under .localhost are excluded too (the subdomain hub of the social example
// runs as <label>.localhost on loopback). Chromium answers every *.localhost name with the loopback
// addresses itself and never asks a DNS server for one (RFC 6761 section 6.3), so the rule still lets no
// name reach the network.
// WebKit and Firefox have no equivalent switch: they get the loopback proxy below (localOnlyProxy,
// firefoxLaunchOptions), and they are still run only against 127.0.0.1; any remote URL in a test is a bug.
export const CHROMIUM_LOCAL_ONLY_ARGS = [
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE ::1',
  '--disable-features=WebRtcHideLocalIpsWithMdns,OptimizationHints,MediaRouter,Translate,InterestFeedContentSuggestions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
  '--safebrowsing-disable-auto-update',
]

// For tools that legitimately need the internet (tools/pin.mjs, tools/check-site.mjs --headless)
// pass ALLOW_REMOTE=1; the caller then drops the resolver rule but keeps the rest.
export function chromiumArgs ({ allowRemote = process.env.ALLOW_REMOTE === '1' } = {}) {
  return allowRemote ? CHROMIUM_LOCAL_ONLY_ARGS.filter(a => !a.startsWith('--host-resolver-rules')) : CHROMIUM_LOCAL_ONLY_ARGS
}

// Firefox lane (2026-10-22): WebKit and Firefox have no resolver switch, so they get a proxy instead. Every
// request whose host is not loopback goes to http://127.0.0.1:9, a closed loopback port, and fails there. With an
// HTTP proxy the browser hands the host name to the proxy and never resolves it itself, so no DNS query and no
// remote socket leave the machine. The bypass list keeps loopback direct. Firefox (Juggler) matches bypass entries
// as host suffixes, so 'localhost' also covers <label>.localhost; WebKit reads the list as written.
// MW_LOCAL_PROXY (only an http://127.0.0.1:<port> URL) swaps the closed port for a local recorder, which is how
// docs/deviations/firefox.md checked that nothing tries to leave: any request the recorder sees is a finding.
export const LOCAL_ONLY_PROXY_BYPASS = '127.0.0.1,localhost,*.localhost'

export function localOnlyProxy () {
  const env = process.env.MW_LOCAL_PROXY
  const server = env && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(env) ? env : 'http://127.0.0.1:9'
  return { server, bypass: LOCAL_ONLY_PROXY_BYPASS }
}

// Firefox preferences, set from the first moment of the process (Playwright applies its proxy option only after it
// has connected; these prefs cover the startup window too). Playwright's own Firefox build turns several of these
// off already (playwright.cfg in the bundle); they are repeated here so the policy does not depend on that file.
export function firefoxUserPrefs ({ proxyPort = Number(localOnlyProxy().server.split(':')[2]) } = {}) {
  return {
    // Proxy: every scheme to the closed loopback port, loopback names direct, never a fallback to a direct connection.
    'network.proxy.type': 1, // manual proxy configuration
    'network.proxy.http': '127.0.0.1', // HTTP and WebSocket requests go to the loopback proxy
    'network.proxy.http_port': proxyPort,
    'network.proxy.ssl': '127.0.0.1', // HTTPS and wss requests go to the same proxy (CONNECT)
    'network.proxy.ssl_port': proxyPort,
    'network.proxy.share_proxy_settings': true, // one proxy for every protocol
    'network.proxy.socks_remote_dns': true, // a SOCKS proxy, if one were ever set, resolves names itself
    'network.proxy.no_proxies_on': 'localhost, 127.0.0.1, .localhost', // loopback stays direct
    'network.proxy.failover_direct': false, // a failed proxy is a failed request, never a direct retry
    // DNS and speculative connections.
    'network.trr.mode': 5, // DNS over HTTPS off by choice (no DoH resolver is contacted)
    'network.dns.disablePrefetch': true, // no DNS prefetch of links in a page
    'network.prefetch-next': false, // no link prefetch
    'network.predictor.enabled': false, // no predictive preconnect
    'network.http.speculative-parallel-limit': 0, // no speculative connections on hover
    'network.http.http3.enable': false, // no QUIC (UDP) connections
    // Connectivity probes.
    'network.captive-portal-service.enabled': false, // captive portal detection off
    'captivedetect.canonicalURL': '', // and no URL for it
    'network.connectivity-service.enabled': false, // no connectivity (DNS and HTTP) checks
    // Remote settings, add-ons and blocklists.
    'services.settings.server': 'data:,#remote-settings-dummy/v1', // remote settings point at nothing
    'extensions.update.enabled': false, // no add-on update checks
    'extensions.getAddons.cache.enabled': false, // no add-on metadata fetches
    'extensions.systemAddon.update.enabled': false, // no system add-on updates
    'extensions.blocklist.enabled': false, // no add-on blocklist downloads
    'security.remote_settings.crlite_filters.enabled': false, // no CRLite filter downloads
    'security.remote_settings.intermediates.enabled': false, // no intermediate certificate downloads
    'security.OCSP.enabled': 0, // no OCSP requests for certificates
    'media.gmp-manager.updateEnabled': false, // no media plugin (OpenH264, Widevine) downloads
    'app.update.auto': false, // no browser updates
    'browser.region.network.url': '', // no region lookup
    'browser.region.update.enabled': false, // and no region updates
    'geo.provider.network.url': '', // no network geolocation
    // Safe browsing.
    'browser.safebrowsing.malware.enabled': false, // no malware list downloads
    'browser.safebrowsing.phishing.enabled': false, // no phishing list downloads
    'browser.safebrowsing.downloads.enabled': false, // no download checks
    'browser.safebrowsing.downloads.remote.enabled': false, // no remote download lookups
    'browser.safebrowsing.blockedURIs.enabled': false, // no blocked-URI list downloads
    // Telemetry, data reporting, studies.
    'toolkit.telemetry.enabled': false, // telemetry off
    'toolkit.telemetry.unified': false, // unified telemetry off
    'toolkit.telemetry.archive.enabled': false, // no telemetry archive
    'toolkit.telemetry.server': '', // and no server to send it to
    'datareporting.healthreport.uploadEnabled': false, // no health report upload
    'datareporting.policy.dataSubmissionEnabled': false, // no data submission
    'app.normandy.enabled': false, // no Normandy recipes
    'app.normandy.api_url': '', // and no Normandy server
    'app.shield.optoutstudies.enabled': false, // no studies
    // Search, push.
    'browser.search.suggest.enabled': false, // no search suggestions
    'browser.urlbar.suggest.searches': false, // none in the address bar either
    'browser.search.update': false, // no search engine updates
    'dom.push.enabled': false, // Web Push off
    'dom.push.connection.enabled': false, // no push server connection
    'dom.push.serverURL': '', // and no push server
    // WebRTC between browsers on one machine, and media without devices.
    'media.peerconnection.ice.loopback': true, // offer 127.0.0.1 host candidates
    'media.peerconnection.ice.obfuscate_host_addresses': false, // plain host candidates, no mDNS names (no multicast)
    'media.navigator.streams.fake': true, // getUserMedia returns a generated stream, not the camera or microphone
    'media.navigator.permission.disabled': true, // no permission prompt for the generated stream
  }
}

// home: a throwaway directory used as the process's home. Firefox on macOS keeps its profile list in
// ~/Library/Application Support/Firefox even when it is given a profile folder, and on this machine creating that
// folder is refused (kernel "System Policy: deny file-write-create"; Firefox then exits with "Could not find profile
// folder"). A throwaway home also keeps the test browser out of the real Library.
export function firefoxLaunchOptions ({ headless = true, home = null } = {}) {
  const proxy = localOnlyProxy()
  const options = { headless, proxy, firefoxUserPrefs: firefoxUserPrefs({ proxyPort: Number(proxy.server.split(':')[2]) }) }
  if (home) options.env = Object.assign({}, process.env, { HOME: home, CFFIXED_USER_HOME: home })
  return options
}
