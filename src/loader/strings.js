// src/loader/strings.js: every user-facing string of the shell loader (INTERFACES "strings.js").
// Wording follows DESIGN-REVIEW §4; the texts marked "verbatim" are copied from it unchanged.
// Rules for every entry: no em or en dashes, straight quotes, never "blockchain", never
// "serverless", no isolation claim for a shared-origin hub, no "sub-second" proof-of-work.
// boot.js (a classic script that cannot import this module) repeats the five boot texts; a unit
// test checks that the copies match.

function formatCount (n) {
  const v = Math.max(0, Math.floor(Number(n) || 0))
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function plural (n, one, many) {
  return formatCount(n) + ' ' + (Math.floor(Number(n) || 0) === 1 ? one : many)
}

function isoDate (value) {
  const d = value instanceof Date ? value : new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toISOString().slice(0, 10)
}

const RESOLVER_NAMES = { cloudflare: 'Cloudflare', 'dns.sb': 'dns.sb', google: 'Google' }
// The loader's DNS-over-HTTPS resolvers as the consent texts name them (src/loader/doh.js RESOLVERS, in order);
// STRINGS.dohNamed() puts the resolver of an owner's <meta name="mw-doh"> in their place.
const DOH_NAMES = 'Cloudflare, dns.sb or Google'

export const STRINGS = Object.freeze({
  // ---- boot (also in boot.js, which cannot import modules) -------------------------------------
  insecure: 'This page must be served over HTTPS (or localhost)',
  framed: 'Open this page directly',
  lockdown: 'Turn off Lockdown Mode for this website',
  hostOnlyBadge: 'Host only, not sharing',
  preparingEngine: 'Preparing offline engine...',

  // ---- product lines (verbatim, §4.1 and §4.2) --------------------------------------------------
  ledgerOneLiner: 'Site ledger: a signed, hash-linked log that every visitor copies and verifies. No mining, no consensus, no finality.',
  ledgerInfo: "Shared data on this site is kept in a signed log. Every visitor keeps a copy and checks every entry, so nobody can forge or quietly rewrite one. There's no mining and no single 'latest' version. Two visitors can briefly see different states, and they catch up when they connect.",
  ledgerAlive: "Each visit copies the log to one more device and serves it to others while the page is open. At any moment the log is reachable only if someone with a copy is online, and for small sites that's usually nobody. Your host's snapshot keeps it loadable and a pinned node keeps it always on.",
  sdkPublic: 'Everything written with mw.db is public and copied to every visitor. Deleting an entry hides it for visitors who receive the deletion. Copies on devices that never sync again stay where they are.',
  tagline: 'Websites loaded by magnet link, verified in your browser, from a plain static host. No backend. The light web.',

  // ---- consent (verbatim, §4.5) -----------------------------------------------------------------
  noticeText: "This site is delivered peer-to-peer. While it's open, your browser connects to other visitors and to connection servers, and they can see your IP address and that you're viewing this site. On Wi-Fi your browser also shares this site's files and posts with other visitors.",
  noticeSettings: 'Settings',
  noticeOk: 'OK',
  gateText: "Load this site peer-to-peer? Other visitors and the connection servers will see your IP address and that you're viewing this site. They can be anywhere in the world, and this software cannot make them protect your data. By choosing Load, you agree to your IP address being sent to them.",
  gateLoad: 'Load',
  gateHostOnly: 'Load from host only',
  gateCancel: 'Cancel',
  gateCancelled: 'This site was not loaded.',
  gateShowAgain: 'Show the options again',
  // DESIGN-REVIEW §4.5 as amended in code review round 1: Off stops file uploads only; gossip still relays posts.
  settingsShare: "Share with other visitors: On / Off. Off stops sharing this site's files. Posts are still passed between connected visitors, and your IP stays visible. Choose Host only to stop all peer connections.",
  settingsHostOnly: "Host only: no peer connections. Slower, and shared data won't sync.",

  // ---- v0.2.1 first-run card (production digest 9.2 a, research w2b-06 B1; DIGEST-AMENDMENTS C1) -------
  // Same-layer refusal: [Share and load] and [Load from host only] side by side. Nothing peer-to-peer and no
  // DNS-over-HTTPS lookup happens before a choice; the site renders from its host meanwhile.
  consentTitle: 'This site is delivered peer-to-peer.',
  consentText: "If you choose to share, your browser connects to other visitors and to connection servers run by third parties. They can see your IP address and that you are viewing this site, and anyone who knows this site's address can join and see who is online. Other visitors and these servers can be anywhere in the world, and this software cannot make them protect your data. While this page is open your browser may upload this site's files and posts to other visitors, which uses bandwidth and battery. Whichever you choose, this site keeps its files and settings on this device so it loads faster next time, until you clear this site's data ('Forget this site' in Settings removes the files); on iPhone and iPad, Safari clears them after 7 days without a visit.",
  consentChoice: 'You can load the site from its host only, with no peer connections, and change your mind any time in Settings.',
  consentMobile: 'On this phone sharing stays off until you turn on "Share on this network" in Settings.',
  consentDns: 'To find this site, your browser first asks a DNS-over-HTTPS service (' + DOH_NAMES + '), which sees your IP address and the name of this site.',
  // Post-wave fix B: the lookups that follow. A shell page on a public hostname asks DNS-over-HTTPS for a newer
  // pointer after a choice that allows it (src/loader/app.js scheduleUpdateCheck: right after the choice, then
  // every 5 minutes or the record's TTL, and on focus at most once a minute), so the card and the gate name the
  // service the choice covers. A site found only through DNS keeps asking whichever button the visitor chose.
  consentDnsAgain: 'While this page is open your browser asks again whether there is a newer version, at most once a minute, whichever you choose.',
  consentDnsUpdate: 'If you choose to share, your browser also asks a DNS-over-HTTPS service (' + DOH_NAMES + ') whether this site has a newer version, at most once a minute while this page is open. That service sees your IP address and the name of this site.',
  gateDnsUpdate: 'Loading it peer-to-peer also lets your browser ask a DNS-over-HTTPS service (' + DOH_NAMES + ') whether this site has a newer version, at most once a minute while this page is open. That service sees your IP address and the name of this site.',
  dohNamed: (text, host) => (host ? String(text).split(DOH_NAMES).join(String(host)) : text),
  consentShare: 'Share and load',
  consentHostOnly: 'Load from host only',
  consentSettings: 'Settings',
  consentNoHost: 'Not now',
  consentNotNow: 'This site was not loaded. It has no host copy, so it loads only from other visitors.',
  settingsConsentAgain: 'Change your sharing choice',

  // ---- hub, shared origin (verbatim, §3.3) ------------------------------------------------------
  hubSharedLoad: 'Load anyway: this site can read and change everything other sites stored on this hub',
  hubSharedBanner: "Sites on this hub share one browser origin and can access each other's data.",
  hubDetailsTitle: 'Before this site loads',
  hubDetailName: 'Name',
  hubDetailBtih: 'Infohash',
  hubDetailSize: 'Size',
  hubDetailTrackers: 'Connection servers',
  hubDetailPublisher: 'Publisher key',
  hubDetailUnknown: 'not known yet',
  hubDetailUnsigned: 'none (unsigned link)',
  hubLanding: 'Open a site with a link such as /#magnet:?xt=urn:btih:<infohash>, /#btih:<infohash> or /#host:example.com.',
  hubLabelMismatch: "This address does not belong to this site's subdomain.",

  // ---- mobile (verbatim, §4.3) ------------------------------------------------------------------
  mobileSharing: 'Sharing only while this page is open and on screen.',
  mobileDataOnly: 'On mobile data: downloading only. Tap to share.',
  mobileDownloadOnly: 'On this phone: downloading only. Tap to share.',
  // Code review round 1 (amends DESIGN-REVIEW S3): a Home Screen app has its own storage and starts empty.
  iosHomeScreen: "Safari may delete this site's copy and your keys for it after 7 days without a visit. Added to the Home Screen, the site keeps its own copy, but it starts empty there: sign in again in the Home Screen app (on a site without sign-in, export your identity here and import it there).",
  // Review round R 5.3 (UX-18): with a v0.3 identity nothing is exported here; the identity page keeps the backup.
  iosHomeScreenV03: "Safari may delete this site's copy after 7 days without a visit. Your identity is kept at the identity page: save your recovery kit there, then sign in again from the Home Screen app.",

  // ---- status ------------------------------------------------------------------------------------
  starting: 'Starting...',
  resolving: 'Finding this site...',
  lookingUpDns: (name) => 'Looking up ' + name + '...',
  waitingConsent: 'Waiting for your OK before connecting to other visitors.',
  connecting: 'Connecting...',
  downloading: (name) => 'Downloading ' + (name || 'site') + '...',
  fetchingTorrent: 'Fetching the torrent file from the host...',
  loadedCache: 'Loaded from this device',
  loadedSite: 'Site loaded',
  seeding: 'Sharing with other visitors',
  uploadsOff: 'Downloading only (sharing is off)',
  hostOnlyActive: 'Host only: no peer connections',
  offline: 'Offline: showing the copy on this device',
  backOnline: 'Back online',
  limitedMode: 'Limited mode: this browser has no offline engine',
  sourceLabel: (source) => ({ cache: 'From this device', peers: 'From other visitors', webseed: 'From the host', mixed: 'From visitors and the host' })[source] || '',
  peers: (n) => plural(n, 'peer', 'peers'),
  ledgerLine: ({ entries = 0, inSync = 0, peers = 0 } = {}) => {
    const head = 'Ledger: ' + plural(entries, 'entry', 'entries')
    if (inSync > 0) return head + ', in sync with ' + plural(inSync, 'peer', 'peers')
    if (peers > 0) return head + ', syncing with ' + plural(peers, 'peer', 'peers')
    return head + ', no peers connected'
  },
  ledgerCap: 'The ledger is full on this device. Only entries from the owner and moderators are added now.',
  // Code review round 1 (DESIGN-REVIEW item 4): the proof-of-work is a spam fee, never "mining".
  writeFee: ({ hashes = 0 } = {}) => 'Posting: working out the spam fee for this post (' + formatCount(hashes) + ' tries so far)',
  ledgerUnavailable: 'The site ledger could not be opened in this browser. The site still works; shared data is off.',
  ownerMismatch: 'pointer and ledger owner differ',
  ownerConflict: 'The site owner\'s key handed the ledger to two different keys. Owner changes are paused until the owner confirms one.',
  // Review round R 5.3 (GATE-1, PHISH-7, PTR-1): src/loader/app.js uses these and falls back to the same English text.
  keyChangedReview: 'Review the key change',
  rotationBlocked: 'This site set a recovery commitment for your old key that is not yours, so your key replacement cannot be written here. Your new key is a new identity on this site.',
  rotationPending: 'Your key replacement is not on this site yet. It is written as soon as this site\'s ledger has caught up.',
  lineageUnproven: ({ ownerFp, loFp }) => 'This link names the site ledger of publisher key ' + loFp + ' but is signed by another key, ' + ownerFp + ', and nothing shows that the first key handed the site over. It is not opened as that site here.',
  unmoderated: 'Unmoderated: this link has no owner key, so nobody can remove posts for everyone.',
  identity: ({ short, name }) => (name ? name + ' (' + short + ')' : 'You: ' + (short || '?')),

  // ---- pointer badges and banners (§4.4, §4, §5.8) ---------------------------------------------
  pointerSource: ({ source, resolver, ad }) => {
    if (source === 'meta') return 'page tag'
    // MF-30: AD=1 is the resolver's word, which the loader cannot check: never a bare "DNSSEC" badge (doh.js AD_WORDING).
    if (source === 'dns') return 'DNS via ' + (RESOLVER_NAMES[resolver] || resolver || 'DNS-over-HTTPS') + (ad ? ' (DNSSEC: resolver says validated)' : '')
    if (source === 'fragment') return 'magnet link'
    if (source === 'cache') return 'saved copy'
    return String(source || 'unknown')
  },
  pointerBadge: ({ source, resolver, ad, signed, pinnedSince }) => {
    let text = 'Pointer: ' + STRINGS.pointerSource({ source, resolver, ad }) + ', ' + (signed ? 'signed' : 'unsigned')
    if (signed && pinnedSince) text += ', key remembered since ' + isoDate(pinnedSince)
    return text
  },
  pointerExpired: (exp) => 'Pointer expired on ' + isoDate(exp) + '; showing the last known version.',
  pointerExpiresSoon: (exp) => 'The publisher must re-sign this site\'s pointer before ' + isoDate(exp) + '.',
  updateAvailable: 'Update available: reload',
  reload: 'Reload',
  firstTime: 'First time on this device: the publisher key of this site is remembered from now on.',
  keyChangedTitle: 'publisher key changed',
  keyChangedDetail: ({ scope, oldFp, newFp }) => 'The pointer for ' + scope + ' is signed by a different key than the one this device remembers.\nRemembered key: ' + oldFp + '\nNew key: ' + newFp + '\nConfirm only if the publisher told you the key changed.',
  keyChangedConfirm: 'Confirm new key',
  keyChangedKeep: 'Keep the remembered key',
  keyChangedRefused: 'You kept the remembered publisher key, so the new pointer was not used.',
  swOutdated: 'The offline engine was updated. Reload to use it.',
  externalBlocked: 'This site tried to open an external page',
  openInNewTab: 'Open in new tab',
  goBack: 'Go back',
  copied: 'Copied',

  // ---- errors and failure matrix (§5.4, §5.10, DESIGN-REVIEW S5) --------------------------------
  noWebseed: 'This link has no web seed or torrent URL. It only loads while another visitor is online.',
  webseedBroken: 'Web seed misconfigured (no Range support)',
  webseedUnreachable: 'Web seed unreachable (CORS preflight or network error)',
  // Code review round 1: a torrent with BEP 47 padding files cannot be served by a plain web seed.
  webseedPad: 'This site\'s torrent has padding files that a web seed cannot serve, so it loads from other visitors only.',
  // v0.2.1 B4: the web-seed circuit breaker.
  webseedBackoff: (host, minutes) => 'The web seed ' + host + ' is serving the wrong bytes, so it is skipped for ' + minutes + ' minutes.',
  webseedBackoffDown: (host, minutes) => 'The web seed ' + host + ' keeps failing, so it is skipped for ' + minutes + ' minutes.',
  // v0.2.1 A3: a signed withdrawal (st=withdrawn) from the publisher (PRODUCTION-DIGEST 9.2 (c)).
  withdrawnTitle: 'This content is no longer available here.',
  // Review round R 5.3 (PTR-12): the publisher's reason is quoted as theirs, never in the loader's own voice.
  withdrawnDetail: ({ why = null, ct = null, pending = false } = {}) => (why ? 'The publisher wrote (not checked): "' + why + '"\n' : '') +
    (pending
      ? 'Your browser is not showing or sharing it. The withdrawal came with a link: choose whether to delete the copy stored on this device.'
      : 'Your browser has stopped sharing it and has deleted its copy.') +
    ' Other visitors or other software may still hold copies that we cannot reach.' +
    (ct ? '\nIf you think this is a mistake, contact ' + ct + '.' : ''),
  withdrawnContact: 'Contact the publisher',
  // Code review round 1: a withdrawal that arrives by a link deletes stored copies only on this click.
  withdrawnDeleteCopy: 'Delete the stored copy',
  withdrawnDeleted: (n) => (n === 1 ? 'Deleted 1 stored version.' : 'Deleted ' + n + ' stored versions.'),
  pointerNotFoundTitle: "Could not find this site's address",
  pointerNotFound: (scope) => 'No usable pointer for ' + scope + '. The page tag, the DNS record and the copy on this device were checked.',
  dohBlocked: 'Cannot resolve pointer (DNS over HTTPS blocked)',
  tooLargeTitle: 'This site is larger than allowed here',
  tooLarge: (size, limit) => 'It is ' + size + '; the limit on this connection is ' + limit + '.',
  noPeersTitle: 'Nobody is sharing this site right now',
  timeoutTitle: 'The download stalled',
  timeout: 'Peers were found but stopped sending data. Retrying usually helps once another visitor is online.',
  badTorrentTitle: 'The torrent file does not match this site',
  badTorrent: 'The host served a torrent file whose infohash differs from the pointer. The publisher has to fix the deployment.',
  engineMissingTitle: 'The peer-to-peer engine did not load',
  engineMissing: 'Reload the page. If this keeps happening the deployment is missing /_mw/webtorrent.min.js.',
  storageFullTitle: 'Browser storage is full',
  storageFull: 'The site was downloaded but there is no room to keep it on this device.',
  genericErrorTitle: 'Something went wrong',
  retry: 'Retry',
  dismiss: 'Dismiss',
  cachedCorrupt: 'The copy on this device was damaged and was removed. Downloading it again.',
  matrix: {
    'tracker-unreachable': { label: 'Connection servers unreachable', remedy: 'Owner: add another tracker (tr=) to the pointer or run your own with tools/tracker.mjs.' },
    'nobody-online': { label: 'Nobody online to serve this site right now', remedy: 'Owner: add xs= and ws=, or run pin.mjs.' },
    nat: { label: (n) => plural(n, 'peer connection', 'peer connections') + ' failed (likely NAT)', remedy: 'Owner: keep ws= in the pointer so these visitors load from your host.' },
    'no-webseed': { label: 'No web seed in the pointer', remedy: 'Owner: add xs= and ws=, or run pin.mjs.' },
    'webseed-broken': { label: 'Web seed misconfigured (no Range support)', remedy: 'Owner: answer OPTIONS with Access-Control-Allow-Headers and serve Range requests with 206 (tools/check-webseed.mjs).' },
    'dns-blocked': { label: 'Cannot resolve pointer (DNS over HTTPS blocked)', remedy: 'Owner: put the pointer in a <meta name="mw-pointer"> tag on the host.' },
    // v0.2.1 additions (B4, B5, B7).
    'webseed-backoff': { label: 'Web seed skipped after repeated failures', remedy: 'Owner: serve every Range request with 206 and the exact bytes (tools/check-webseed.mjs).' },
    'wire-dropped': { label: (n) => plural(n, 'peer connection', 'peer connections') + ' closed for oversized messages', remedy: 'Nothing to fix here: the loader closes connections that announce oversized messages.' },
    connectivity: { label: 'Peer connectivity', remedy: '' }
  },
  // v0.2.1 B7: the connectivity probe's class, shown in the diagnostics panel (research w2b-03 R-04).
  connectivity: (cls) => ({
    'easy-mapping': 'direct connections likely',
    'easy-probable': 'direct connections probably work',
    hard: 'strict NAT: connections to some visitors will fail',
    'udp-blocked-or-no-stun': 'UDP blocked or STUN unreachable: the web seed carries this visit',
    'relay-only-reachable': 'only a relay is reachable',
    'unknown-single-stun': 'only one STUN server answered',
    'no-webrtc': 'no peer connections in this browser'
  })[cls] || String(cls || 'unknown'),
  peerDiscoveryDown: 'Peer discovery unavailable; loading from web seed',

  // ---- settings ----------------------------------------------------------------------------------
  settingsTitle: 'Settings',
  settingsSharing: 'Sharing',
  settingsShareLabel: 'Share with other visitors',
  settingsHostOnlyLabel: 'Host only',
  settingsClose: 'Close',
  settingsOn: 'On',
  settingsOff: 'Off',
  settingsShareOnNetwork: 'Share on this network',
  settingsShareOnNetworkNote: 'Phones on mobile data or an unknown network only download until you allow sharing here.',
  settingsStorage: 'Storage on this device',
  settingsStorageUsage: (used, quota) => used + (quota ? ' of ' + quota : '') + ' used',
  settingsPersisted: (state) => (state === true ? 'Kept until you clear it' : state === false ? 'The browser may clear it when space runs low' : 'Not requested yet'),
  settingsForget: 'Forget this site',
  settingsForgetDone: 'Removed from this device.',
  settingsIdentity: 'Your identity on this site',
  settingsExportIdentity: 'Export identity',
  settingsImportIdentity: 'Import identity',
  settingsPassphrase: 'Passphrase',
  settingsIdentityFile: 'Identity file',
  settingsIdentityExported: 'Identity exported. Keep the file and the passphrase safe.',
  settingsIdentityImported: 'Identity imported. Reloading...',
  settingsModerator: 'Moderator key',
  settingsImportModerator: 'Import moderator key',
  settingsRemoveModerator: 'Remove moderator key',
  settingsModeratorActive: (short) => 'Moderator key ' + short + ' is active on this device.',
  settingsModeratorNotListed: 'This key is not a moderator in the current site policy yet.',
  settingsLedger: 'Site ledger',
  settingsExportLedger: 'Export ledger JSON',
  settingsDebug: 'Diagnostics',
  settingsDebugEmpty: 'No problems detected.',
  settingsVersion: (v) => 'Loader ' + v,
  passphraseTooShort: 'Use a passphrase of at least 8 characters.',
  wrongPassphrase: 'Wrong passphrase or damaged identity file.'
})

export const STRING_HELPERS = Object.freeze({ formatCount, plural, isoDate })

// Review round R 5.3 (UX-13): the first-run consent card, the notice, the gate, the hub details, the status line and the
// settings panel in French. The consent rests on these texts, so a visitor whose browser asks for French reads them in
// French like the sign-in and error cards. Keys left out (diagnostics, error titles of the loader page) stay English.
const DOH_NAMES_FR = 'Cloudflare, dns.sb ou Google'
export const STRINGS_FR = Object.freeze({
  hostOnlyBadge: 'Hébergeur seul, aucun partage',
  ledgerOneLiner: 'Registre du site : un journal signé et chaîné par empreintes, que chaque visiteur copie et vérifie. Pas de minage, pas de consensus, pas de finalité.',
  noticeText: 'Ce site est distribué de pair à pair. Tant qu\'il est ouvert, votre navigateur se connecte à d\'autres visiteurs et à des serveurs de connexion, qui peuvent voir votre adresse IP et que vous consultez ce site. En Wi-Fi, votre navigateur partage aussi les fichiers et les messages de ce site avec d\'autres visiteurs.',
  noticeSettings: 'Réglages',
  noticeOk: 'OK',
  gateText: 'Charger ce site de pair à pair ? Les autres visiteurs et les serveurs de connexion verront votre adresse IP et que vous consultez ce site.',
  gateLoad: 'Charger',
  gateHostOnly: 'Charger depuis l\'hébergeur seul',
  gateCancel: 'Annuler',
  gateCancelled: 'Ce site n\'a pas été chargé.',
  gateShowAgain: 'Afficher de nouveau les choix',
  settingsShare: 'Partager avec les autres visiteurs : Oui / Non. Non arrête le partage des fichiers de ce site. Les messages passent toujours entre les visiteurs connectés, et votre IP reste visible. Choisissez Hébergeur seul pour arrêter toute connexion entre pairs.',
  settingsHostOnly: 'Hébergeur seul : aucune connexion entre pairs. Plus lent, et les données partagées ne se synchronisent pas.',
  consentTitle: 'Ce site est distribué de pair à pair.',
  consentText: 'Si vous choisissez de partager, votre navigateur se connecte à d\'autres visiteurs et à des serveurs de connexion gérés par des tiers. Ils peuvent voir votre adresse IP et que vous consultez ce site, et toute personne qui connaît l\'adresse de ce site peut s\'y joindre et voir qui est en ligne. Tant que cette page est ouverte, votre navigateur peut envoyer les fichiers et les messages de ce site à d\'autres visiteurs, ce qui utilise de la bande passante et de la batterie. Ce site garde aussi ses fichiers et ses réglages sur cet appareil pour se charger plus vite la prochaine fois (sur iPhone et iPad, jusqu\'à ce que Safari les efface).',
  consentChoice: 'Vous pouvez charger le site depuis son hébergeur seul, sans connexion entre pairs, et changer d\'avis à tout moment dans les Réglages.',
  consentMobile: 'Sur ce téléphone, le partage reste désactivé tant que vous n\'activez pas "Partager sur ce réseau" dans les Réglages.',
  consentDns: 'Pour trouver ce site, votre navigateur interroge d\'abord un service DNS sur HTTPS (' + DOH_NAMES_FR + '), qui voit votre adresse IP et le nom de ce site.',
  consentDnsAgain: 'Tant que cette page est ouverte, votre navigateur vérifie de nouveau s\'il existe une version plus récente, au plus une fois par minute, quel que soit votre choix.',
  consentDnsUpdate: 'Si vous choisissez de partager, votre navigateur demande aussi à un service DNS sur HTTPS (' + DOH_NAMES_FR + ') si ce site a une version plus récente, au plus une fois par minute tant que cette page est ouverte. Ce service voit votre adresse IP et le nom de ce site.',
  gateDnsUpdate: 'Le chargement de pair à pair permet aussi à votre navigateur de demander à un service DNS sur HTTPS (' + DOH_NAMES_FR + ') si ce site a une version plus récente, au plus une fois par minute tant que cette page est ouverte. Ce service voit votre adresse IP et le nom de ce site.',
  dohNamed: (text, host) => (host ? String(text).split(DOH_NAMES_FR).join(String(host)).split(DOH_NAMES).join(String(host)) : text),
  consentShare: 'Partager et charger',
  consentHostOnly: 'Charger depuis l\'hébergeur seul',
  consentSettings: 'Réglages',
  consentNoHost: 'Pas maintenant',
  consentNotNow: 'Ce site n\'a pas été chargé. Il n\'a pas de copie chez un hébergeur, donc il se charge seulement depuis d\'autres visiteurs.',
  settingsConsentAgain: 'Changer votre choix de partage',
  hubSharedLoad: 'Charger quand même : ce site peut lire et modifier tout ce que les autres sites ont enregistré sur ce hub',
  hubSharedBanner: 'Les sites de ce hub partagent une même origine dans le navigateur et peuvent accéder aux données les uns des autres.',
  hubDetailsTitle: 'Avant le chargement de ce site',
  hubDetailName: 'Nom',
  hubDetailBtih: 'Empreinte (infohash)',
  hubDetailSize: 'Taille',
  hubDetailTrackers: 'Serveurs de connexion',
  hubDetailPublisher: 'Clé de l\'éditeur',
  hubDetailUnknown: 'pas encore connu',
  hubDetailUnsigned: 'aucune (lien non signé)',
  iosHomeScreenV03: 'Safari peut supprimer la copie de ce site après 7 jours sans visite. Votre identité est gardée sur la page d\'identité : enregistrez-y votre trousse de récupération, puis reconnectez-vous depuis l\'app de l\'écran d\'accueil.',
  mobileSharing: 'Partage seulement tant que cette page est ouverte et à l\'écran.',
  mobileDataOnly: 'Sur données mobiles : téléchargement seulement. Touchez pour partager.',
  mobileDownloadOnly: 'Sur ce téléphone : téléchargement seulement. Touchez pour partager.',
  starting: 'Démarrage...',
  resolving: 'Recherche de ce site...',
  lookingUpDns: (name) => 'Recherche de ' + name + '...',
  waitingConsent: 'En attente de votre accord avant de se connecter aux autres visiteurs.',
  connecting: 'Connexion...',
  downloading: (name) => 'Téléchargement de ' + (name || 'ce site') + '...',
  loadedCache: 'Chargé depuis cet appareil',
  loadedSite: 'Site chargé',
  seeding: 'Partage avec les autres visiteurs',
  uploadsOff: 'Téléchargement seulement (le partage est désactivé)',
  hostOnlyActive: 'Hébergeur seul : aucune connexion entre pairs',
  offline: 'Hors ligne : affichage de la copie de cet appareil',
  backOnline: 'De nouveau en ligne',
  sourceLabel: (source) => ({ cache: 'Depuis cet appareil', peers: 'Depuis d\'autres visiteurs', webseed: 'Depuis l\'hébergeur', mixed: 'Depuis les visiteurs et l\'hébergeur' })[source] || '',
  peers: (n) => plural(n, 'pair', 'pairs'),
  updateAvailable: 'Mise à jour disponible : recharger',
  reload: 'Recharger',
  retry: 'Réessayer',
  dismiss: 'Fermer',
  settingsTitle: 'Réglages',
  settingsSharing: 'Partage',
  settingsShareLabel: 'Partager avec les autres visiteurs',
  settingsHostOnlyLabel: 'Hébergeur seul',
  settingsClose: 'Fermer',
  settingsOn: 'Oui',
  settingsOff: 'Non',
  settingsShareOnNetwork: 'Partager sur ce réseau',
  settingsShareOnNetworkNote: 'Les téléphones sur données mobiles ou sur un réseau inconnu ne font que télécharger tant que vous n\'autorisez pas le partage ici.',
  settingsStorage: 'Stockage sur cet appareil',
  settingsStorageUsage: (used, quota) => used + (quota ? ' sur ' + quota : '') + ' utilisés',
  settingsPersisted: (state) => (state === true ? 'Conservé jusqu\'à ce que vous l\'effaciez' : state === false ? 'Le navigateur peut l\'effacer s\'il manque de place' : 'Pas encore demandé'),
  settingsForget: 'Oublier ce site',
  settingsForgetDone: 'Retiré de cet appareil.',
  settingsIdentity: 'Votre identité sur ce site',
  settingsLedger: 'Registre du site'
})

/** stringsFor(lang) -> STRINGS, with the French entries of STRINGS_FR over it for 'fr' (UX-13). */
export function stringsFor (lang) {
  if (pickLang(lang) !== 'fr') return STRINGS
  return Object.freeze(Object.assign({}, STRINGS, STRINGS_FR))
}

export default STRINGS

// =====================================================================================================
// v0.3 strings (DESIGN-REVIEW "R" 2.11.2, 2.9.11, 2.14, 2.7.5 item 6, 3.7; lane ui).
// English and French for every error code, every card used on a site origin, the replaced sentences,
// the identity-chrome texts, and the noscript text. Rules: no em or en dashes, straight quotes, none of
// the banned words (see test/unit/ui-v03-strings.test.mjs); presence reads "Connected to you now", never
// the word online; removal reads "hide from copies that sync" and "remove", never erase (R 2.15).
// Placeholders are written {name} and filled by fmt().
// =====================================================================================================

export const LANGS = Object.freeze(['en', 'fr'])

/** pickLang(tag) -> 'en' | 'fr' (anything that is not French is English). */
export function pickLang (tag) {
  return /^fr(\b|-|_)/i.test(String(tag || '')) ? 'fr' : 'en'
}

/** fmt(text, params) fills {placeholders}; an unknown placeholder is left as written. */
export function fmt (text, params) {
  const p = params || {}
  return String(text).replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k])))
}

// ---- feature flags (MF-35, MF-63): both stay false until the gate rows pass ------------------------
// deliveryStates: false until gate rows G-CH-1 and G-CH-3 pass. iosTorStrings: false until the RT 16 Q8
// primary-source check on Tor Browser and iOS behaviour is done.
export const STRING_FLAGS = Object.seal({ deliveryStates: false, iosTorStrings: false })
export function setStringFlag (name, value) {
  if (!Object.prototype.hasOwnProperty.call(STRING_FLAGS, name)) throw new TypeError('unknown string flag ' + name)
  STRING_FLAGS[name] = value === true
}

// ---- error codes (R 2.11.2 "codes added", plus the codes R 2.9.11 and the methods name) -----------
export const ERROR_TEXT = Object.freeze({
  en: Object.freeze({
    E_NOT_SIGNED_IN: 'Sign in to do this.',
    E_USER_CANCELLED: 'You cancelled.',
    E_UNSUPPORTED: 'This browser cannot do this. Use a current version of Chrome, Edge, Firefox or Safari.',
    E_FIELD: 'That field name is reserved. Choose another.',
    E_DECRYPT: 'This could not be opened with your keys.',
    E_HOST_ONLY_IDENTITY: 'This address shares one origin with other sites, so your identity applies to this visit only.',
    E_POPUP_BLOCKED: 'Your browser blocked the sign-in window. Tap Sign in again.',
    E_IDP_UNREACHABLE: 'The identity page could not be reached. Check your connection and try again.',
    E_NEEDS_GESTURE: 'Tap the button on the page to continue.',
    E_NONCE_REQUIRED: 'This site did not send a sign-in code. Reload the page and try again.',
    E_LEDGER_FULL: 'This site cannot take more entries right now.',
    E_SYNCING: 'Still catching up with the site. Try again in a moment.',
    E_HOST_ONLY: 'This feature needs peer connections, and you chose host only.',
    E_NO_OWN_TRACKER: 'This site has not set up its own connection server, so chat is off here.',
    E_NO_CHAT_KEY: '{name} has not turned on messages on this site.',
    E_BLOCKED: 'You cannot send to {name}.',
    E_STAMP: 'Working out the spam fee did not finish. Try again.',
    E_NOT_MEMBER: 'You are not a member of this group.',
    E_NOT_ADMIN: 'Only an admin of this group can do this.',
    E_NOT_CONTACT: 'Direct connections are only for your contacts.',
    E_PEER_UNREACHABLE: '{name} could not be reached directly.',
    E_FILE_UNAVAILABLE: 'Nobody who has this file is online right now.',
    E_FILE_TOMBSTONED: 'This file was removed.',
    E_FILE_HASH: 'This file did not match its checksum and was dropped.',
    E_DENIED: 'You do not have access to this.',
    E_MEDIA_TYPE: 'This kind of file is not accepted here.',
    E_MEDIA_STRIP: 'Location and camera details could not be removed, so the file was not sent.',
    E_MEDIA_UNPLAYABLE: 'This browser cannot play this file.',
    E_REVOKED: 'Access to this was taken back.',
    E_POLICY: 'This site does not allow that.',
    E_LIMIT: 'That is over the limit.',
    E_RATE: 'Too fast. Wait a few seconds and try again.',
    E_POW_ABORTED: 'Cancelled before the spam fee finished.',
    E_BANNED: 'You cannot post here.',
    E_BAD_REQUEST: 'That request was not valid.',
    // Review round R 5.3 (UX-11): the SDK codes that had no sentence and reached visitors as "Something went wrong (E_CAP)."
    E_CAP: 'This device is out of storage for this site. Free some space, or remove saved sites in Settings.',
    E_NOT_OWNER: 'Only the owner of this site can do this.',
    E_NOT_MODERATOR: 'Only a moderator of this site can do this.',
    E_IDENTITY: 'Your keys or this site ledger are not available in this browser right now. Reload the page, or sign out and sign in again.',
    E_TIMEOUT: 'This took too long. Check your connection and try again.',
    E_INTERNAL: 'Something went wrong on this page. Reload it and try again.',
    E_NO_HOST: 'felinar is not running on this page. Reload the page and try again.',
    // ---- v0.3 C2: calls (SEEDING-AND-ZERO-SETUP-DESIGN 3.5; lane docs-strings). C2_ERROR_CODES lists them. ----
    E_BUSY: 'The other person is in another call.',
    E_DECLINED: 'The call was declined.',
    E_NO_ANSWER: 'Nobody answered the call.',
    E_MEDIA_DENIED: 'The browser did not allow the microphone or camera. Allow it in the site settings of your browser and try again.',
    E_NO_DEVICE: 'No microphone or camera was found on this device.',
    E_CALL_FAILED: 'The call could not be connected, or its connection could not be checked.'
  }),
  fr: Object.freeze({
    E_NOT_SIGNED_IN: 'Connectez-vous pour faire cela.',
    E_USER_CANCELLED: 'Vous avez annulé.',
    E_UNSUPPORTED: 'Ce navigateur ne peut pas faire cela. Utilisez une version récente de Chrome, Edge, Firefox ou Safari.',
    E_FIELD: 'Ce nom de champ est réservé. Choisissez-en un autre.',
    E_DECRYPT: 'Impossible d\'ouvrir cela avec vos clés.',
    E_HOST_ONLY_IDENTITY: 'Cette adresse partage une origine avec d\'autres sites, donc votre identité ne vaut que pour cette visite.',
    E_POPUP_BLOCKED: 'Votre navigateur a bloqué la fenêtre de connexion. Touchez Se connecter de nouveau.',
    E_IDP_UNREACHABLE: 'La page d\'identité est injoignable. Vérifiez votre connexion et réessayez.',
    E_NEEDS_GESTURE: 'Touchez le bouton de la page pour continuer.',
    E_NONCE_REQUIRED: 'Ce site n\'a pas envoyé de code de connexion. Rechargez la page et réessayez.',
    E_LEDGER_FULL: 'Ce site ne peut pas recevoir plus d\'entrées pour le moment.',
    E_SYNCING: 'Mise à jour avec le site en cours. Réessayez dans un instant.',
    E_HOST_ONLY: 'Cette fonction demande des connexions entre pairs, et vous avez choisi l\'hébergeur seul.',
    E_NO_OWN_TRACKER: 'Ce site n\'a pas son propre serveur de connexion, donc la messagerie est désactivée ici.',
    E_NO_CHAT_KEY: '{name} n\'a pas activé les messages sur ce site.',
    E_BLOCKED: 'Vous ne pouvez pas écrire à {name}.',
    E_STAMP: 'Le calcul des frais anti-pourriel n\'a pas abouti. Réessayez.',
    E_NOT_MEMBER: 'Vous n\'êtes pas membre de ce groupe.',
    E_NOT_ADMIN: 'Seul un administrateur de ce groupe peut faire cela.',
    E_NOT_CONTACT: 'Les connexions directes sont réservées à vos contacts.',
    E_PEER_UNREACHABLE: '{name} est injoignable directement.',
    E_FILE_UNAVAILABLE: 'Personne qui a ce fichier n\'est en ligne pour le moment.',
    E_FILE_TOMBSTONED: 'Ce fichier a été retiré.',
    E_FILE_HASH: 'Ce fichier ne correspondait pas à sa somme de contrôle et a été écarté.',
    E_DENIED: 'Vous n\'avez pas accès à ceci.',
    E_MEDIA_TYPE: 'Ce type de fichier n\'est pas accepté ici.',
    E_MEDIA_STRIP: 'Les données de lieu et d\'appareil n\'ont pas pu être retirées, donc le fichier n\'a pas été envoyé.',
    E_MEDIA_UNPLAYABLE: 'Ce navigateur ne peut pas lire ce fichier.',
    E_REVOKED: 'L\'accès à ceci a été retiré.',
    E_POLICY: 'Ce site ne permet pas cela.',
    E_LIMIT: 'Cela dépasse la limite.',
    E_RATE: 'Trop rapide. Attendez quelques secondes et réessayez.',
    E_POW_ABORTED: 'Annulé avant la fin du calcul des frais anti-pourriel.',
    E_BANNED: 'Vous ne pouvez pas écrire ici.',
    E_BAD_REQUEST: 'Cette demande n\'était pas valide.',
    E_CAP: 'Cet appareil n\'a plus d\'espace pour ce site. Libérez de l\'espace, ou retirez des sites enregistrés dans les Réglages.',
    E_NOT_OWNER: 'Seul le propriétaire de ce site peut faire cela.',
    E_NOT_MODERATOR: 'Seul un modérateur de ce site peut faire cela.',
    E_IDENTITY: 'Vos clés ou le registre de ce site ne sont pas disponibles dans ce navigateur pour le moment. Rechargez la page, ou déconnectez-vous puis reconnectez-vous.',
    E_TIMEOUT: 'Cela a pris trop de temps. Vérifiez votre connexion et réessayez.',
    E_INTERNAL: 'Un problème est survenu sur cette page. Rechargez-la et réessayez.',
    E_NO_HOST: 'felinar ne fonctionne pas sur cette page. Rechargez la page et réessayez.',
    E_BUSY: 'L\'autre personne est dans un autre appel.',
    E_DECLINED: 'L\'appel a été refusé.',
    E_NO_ANSWER: 'Personne n\'a répondu à l\'appel.',
    E_MEDIA_DENIED: 'Le navigateur n\'a pas autorisé le microphone ou la caméra. Autorisez-le dans les réglages du site de votre navigateur, puis réessayez.',
    E_NO_DEVICE: 'Aucun microphone ni aucune caméra n\'a été trouvé sur cet appareil.',
    E_CALL_FAILED: 'L\'appel n\'a pas pu être établi, ou sa connexion n\'a pas pu être vérifiée.'
  })
})

/** The codes R 2.11.2 adds, in its order (the test checks both languages for each). */
export const V03_ERROR_CODES = Object.freeze([
  'E_NOT_SIGNED_IN', 'E_USER_CANCELLED', 'E_UNSUPPORTED', 'E_FIELD', 'E_DECRYPT', 'E_HOST_ONLY_IDENTITY', 'E_POPUP_BLOCKED',
  'E_IDP_UNREACHABLE', 'E_NEEDS_GESTURE', 'E_NONCE_REQUIRED', 'E_LEDGER_FULL', 'E_SYNCING', 'E_HOST_ONLY', 'E_NO_OWN_TRACKER',
  'E_NO_CHAT_KEY', 'E_BLOCKED', 'E_STAMP', 'E_NOT_MEMBER', 'E_NOT_ADMIN', 'E_NOT_CONTACT', 'E_PEER_UNREACHABLE',
  'E_FILE_UNAVAILABLE', 'E_FILE_TOMBSTONED', 'E_FILE_HASH', 'E_DENIED', 'E_MEDIA_TYPE', 'E_MEDIA_STRIP', 'E_MEDIA_UNPLAYABLE', 'E_REVOKED'
])
/** Codes named by the R 2.9.11 and 2.11.2 method lists that already exist or are shared (also covered). */
export const V03_SHARED_CODES = Object.freeze(['E_POLICY', 'E_LIMIT', 'E_RATE', 'E_POW_ABORTED', 'E_BANNED', 'E_BAD_REQUEST'])
/** v0.3 C2 (SZ 3.5): the codes the calls lane adds, in the order the design lists them (English and French in ERROR_TEXT). */
export const C2_ERROR_CODES = Object.freeze(['E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED'])
/** The older codes a call also raises (already in ERROR_TEXT; listed so a test can check the whole set of SZ 3.5). */
export const C2_REUSED_CODES = Object.freeze(['E_NOT_SIGNED_IN', 'E_HOST_ONLY', 'E_POLICY', 'E_NOT_CONTACT', 'E_PEER_UNREACHABLE', 'E_LIMIT', 'E_UNSUPPORTED'])

/** errorText(code, lang, params) -> a sentence; an unknown code gives a generic line that names the code. */
export function errorText (code, lang = 'en', params = null) {
  const table = ERROR_TEXT[lang] || ERROR_TEXT.en
  const text = table[code] || ERROR_TEXT.en[code]
  if (!text) return (lang === 'fr' ? 'Une erreur est survenue (' : 'Something went wrong (') + String(code) + ').'
  return fmt(text, params)
}

// ---- cards (R 2.14.1; the first seven are shown at the identity origin and are kept here so the idp lane
// and the site share one wording) -----------------------------------------------------------------------
export const CARD_TEXT = Object.freeze({
  en: Object.freeze({
    signIn: 'Sign in to {origin}. This site gets a key that works only here. It cannot see your other sites. Code on this site can act as you here while you are signed in.',
    passkey: 'Your passkey may be saved by your password manager (for example iCloud Keychain or Google Password Manager), which then knows you have a felinar identity at {idp}. Your identity itself stays on your devices.',
    whatOthersSee: 'People connected to this site see your IP address next to the key you use here when you post or chat. Signing in does not send your key or the list of your other sites to any identity company. The host of the identity page does see your IP address and the time whenever your browser has to load that page.',
    twelveWords: 'These 12 words open every site you use with felinar. felinar never asks for them on the site you are signing in to. Type them only at {idp}.',
    recoveryKitIos: 'Safari deletes this page\'s data after 7 days without a visit. Save your recovery kit now. The sites you sign in to keep a sealed copy for this device.',
    sameIdentity: '{a} and {b} will both know this is you. This cannot be undone once this site has seen it.',
    hubIdentity: 'Everyone on {hub} will see one identity for you. Other sites still cannot match you by key.',
    staySignedIn: 'Anyone who uses this browser can act as you on this site until you sign out.',
    turnOnChat: 'Chat connects your browser to other visitors of this site through {tracker} and {stun}. They see your IP address and when you are active. Messages are encrypted between you and the people you write to. The site\'s own code can read your messages while this page is open. Anyone you write to can keep what you send. Chat also travels over the connections your browser already has for this site\'s ledger, which other trackers and STUN servers may have helped set up. Those servers do not learn that you chat.',
    presencePublic: 'Everyone who can reach you on this site will see which name is connected, and from which address.',
    holdMessages: 'While this page is open, and for up to 7 days, you will keep encrypted messages from other people that you cannot read. Nothing is written to disk, and the people who leave and collect them will see your IP address.',
    messageRequests: 'Strangers can send you a first message. You will not see it until you open your requests.',
    rooms: 'Public and signed. Anyone connected can read this, and a recording proves what you wrote.',
    groups: 'Members can keep and forward anything sent here, and can prove to others what you wrote in this group.',
    publicUpload: 'This file will be public on this site. People who fetch it will see your IP address while you share it.',
    privateUpload: 'Encrypted before it leaves this device. Only you, after signing in, and the people you share it with can open it. The site\'s own code can open it while you are signed in. People you share with can keep a copy.',
    fetchPublic: 'Fetching also shares it with others while this page is open, and they see your IP address next to it.',
    helpShare: 'You will distribute this file to other visitors. Others can see your IP address next to it.',
    directConnection: 'Connect directly (shows your IP address to this person).',
    turnRelay: 'Your connection goes through {operator}\'s relay, which sees both addresses and how much you send, never the content. The relay is open to anyone who loads this site.',
    chatKeyInLedger: 'Your chat key will be public and permanent in this site\'s ledger, so people can message you when nobody who has it is connected.',
    syncRecord: 'An encrypted copy goes into this site\'s ledger, which every visitor copies. Nobody without your keys can read it. Copies kept by others stay even after you remove it.',
    // v0.3 code review: the limit of docs/deviations/idp.md item 18 (a backup file or an escrowed vault copy made before the removal still holds the key)
    removePrivateData: 'This hides your encrypted record from copies that sync and destroys the key for this site, so remaining copies can no longer be opened by you or anyone who later gets your 12 words. A backup file made before now, or an earlier copy of your identity that a site keeps for the identity page, still holds the key, and restoring from it brings the key back.',
    replaceKeys: 'Each site gets a new key for you, and people who know your old key see that it changed. Pages you made keep their key: a page cannot move to a new key yet. A moderator role stays with the old key, and so may your place among a site\'s writers, until the site\'s owner adds the new key.',
    phoneUpload: 'Sending this file uses your mobile data. Keep this page open and on screen until it says sent.',
    sentOnPhone: 'Sent: one full copy reached {name}',
    scriptsNote: 'Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.',
    neverWords: 'felinar never asks for your 12 words on the site you are signing in to.',
    speedBump: 'This prompt is a speed bump, not a lock. Anything that matters opens at {idp}.'
  }),
  fr: Object.freeze({
    signIn: 'Connexion à {origin}. Ce site reçoit une clé qui ne fonctionne qu\'ici. Il ne peut pas voir vos autres sites. Le code de ce site peut agir en votre nom ici tant que vous êtes connecté.',
    passkey: 'Votre clé d\'accès peut être enregistrée par votre gestionnaire de mots de passe (par exemple le Trousseau iCloud ou Google Password Manager), qui sait alors que vous avez une identité felinar sur {idp}. Votre identité elle-même reste sur vos appareils.',
    whatOthersSee: 'Les personnes connectées à ce site voient votre adresse IP à côté de la clé que vous utilisez ici quand vous publiez ou écrivez. Se connecter n\'envoie ni votre clé ni la liste de vos autres sites à une société d\'identité. L\'hébergeur de la page d\'identité voit toutefois votre adresse IP et l\'heure chaque fois que votre navigateur doit charger cette page.',
    twelveWords: 'Ces 12 mots ouvrent tous les sites que vous utilisez avec felinar. felinar ne les demande jamais sur le site où vous vous connectez. Saisissez-les uniquement sur {idp}.',
    recoveryKitIos: 'Safari supprime les données de cette page après 7 jours sans visite. Enregistrez votre trousse de récupération maintenant. Les sites où vous vous connectez gardent une copie scellée pour cet appareil.',
    sameIdentity: '{a} et {b} sauront tous deux que c\'est vous. Cela ne peut pas être annulé une fois que ce site l\'a vu.',
    hubIdentity: 'Tout le monde sur {hub} verra une seule identité pour vous. Les autres sites ne peuvent toujours pas vous reconnaître par votre clé.',
    staySignedIn: 'Toute personne qui utilise ce navigateur peut agir en votre nom sur ce site jusqu\'à votre déconnexion.',
    turnOnChat: 'La messagerie relie votre navigateur aux autres visiteurs de ce site par {tracker} et {stun}. Ils voient votre adresse IP et quand vous êtes actif. Les messages sont chiffrés entre vous et les personnes à qui vous écrivez. Le code du site peut lire vos messages tant que cette page est ouverte. Toute personne à qui vous écrivez peut conserver ce que vous envoyez. La messagerie passe aussi par les connexions que votre navigateur a déjà pour le registre de ce site, que d\'autres trackers et serveurs STUN ont pu aider à établir. Ces serveurs n\'apprennent pas que vous utilisez la messagerie.',
    presencePublic: 'Toute personne qui peut vous joindre sur ce site verra quel nom est connecté, et depuis quelle adresse.',
    holdMessages: 'Tant que cette page est ouverte, et jusqu\'à 7 jours, vous conserverez des messages chiffrés d\'autres personnes que vous ne pouvez pas lire. Rien n\'est écrit sur le disque, et les personnes qui les déposent et les récupèrent verront votre adresse IP.',
    messageRequests: 'Des inconnus peuvent vous envoyer un premier message. Vous ne le verrez pas avant d\'ouvrir vos demandes.',
    rooms: 'Public et signé. Toute personne connectée peut le lire, et un enregistrement prouve ce que vous avez écrit.',
    groups: 'Les membres peuvent conserver et transmettre tout ce qui est envoyé ici, et peuvent prouver à d\'autres ce que vous avez écrit dans ce groupe.',
    publicUpload: 'Ce fichier sera public sur ce site. Les personnes qui le récupèrent verront votre adresse IP pendant que vous le partagez.',
    privateUpload: 'Chiffré avant de quitter cet appareil. Seuls vous, après connexion, et les personnes avec qui vous le partagez peuvent l\'ouvrir. Le code du site peut l\'ouvrir tant que vous êtes connecté. Les personnes avec qui vous partagez peuvent en garder une copie.',
    fetchPublic: 'Le récupérer le partage aussi avec d\'autres tant que cette page est ouverte, et ils voient votre adresse IP à côté.',
    helpShare: 'Vous distribuerez ce fichier à d\'autres visiteurs. Les autres peuvent voir votre adresse IP à côté.',
    directConnection: 'Se connecter directement (montre votre adresse IP à cette personne).',
    turnRelay: 'Votre connexion passe par le relais de {operator}, qui voit les deux adresses et la quantité envoyée, jamais le contenu. Le relais est ouvert à toute personne qui charge ce site.',
    chatKeyInLedger: 'Votre clé de messagerie sera publique et permanente dans le registre de ce site, pour que l\'on puisse vous écrire quand personne qui l\'a n\'est connecté.',
    syncRecord: 'Une copie chiffrée va dans le registre de ce site, que chaque visiteur copie. Personne sans vos clés ne peut la lire. Les copies gardées par d\'autres restent même après que vous l\'avez retirée.',
    removePrivateData: 'Cela masque votre fiche chiffrée des copies qui se synchronisent et détruit la clé pour ce site, de sorte que les copies restantes ne pourront plus être ouvertes par vous ni par quiconque obtiendrait plus tard vos 12 mots. Un fichier de sauvegarde fait avant maintenant, ou une copie plus ancienne de votre identité qu\'un site garde pour la page d\'identité, contient encore la clé, et une restauration à partir de celle-ci ramène la clé.',
    replaceKeys: 'Chaque site reçoit une nouvelle clé pour vous, et les personnes qui connaissent votre ancienne clé voient qu\'elle a changé. Les pages que vous avez créées gardent leur clé : une page ne peut pas encore passer à une nouvelle clé. Un rôle de modération reste attaché à l\'ancienne clé, et votre place parmi les auteurs d\'un site peut l\'être aussi, jusqu\'à ce que le propriétaire du site ajoute la nouvelle clé.',
    phoneUpload: 'L\'envoi de ce fichier utilise vos données mobiles. Gardez cette page ouverte et affichée à l\'écran jusqu\'à ce qu\'elle indique envoyé.',
    sentOnPhone: 'Envoyé : une copie complète est arrivée chez {name}',
    scriptsNote: 'Les scripts de cette page peuvent agir en votre nom sur ce site tant que vous êtes connecté. Ils ne peuvent pas atteindre vos autres sites.',
    neverWords: 'felinar ne demande jamais vos 12 mots sur le site où vous vous connectez.',
    speedBump: 'Cette fenêtre est un ralentisseur, pas un verrou. Tout ce qui compte s\'ouvre sur {idp}.'
  })
})

// ---- R 2.14.2: the sentences that replace older claims (the old wording must not appear anywhere) -------
export const REPLACED_SENTENCES = Object.freeze({
  en: Object.freeze({
    keyMatching: 'Sites cannot match you by key unless you choose to be recognised. They can still match you by IP address, a reused name or timing.',
    recordReaders: 'Other visitors and anyone holding a copy of the ledger see only ciphertext. The site\'s own code can read your record while you are signed in.',
    profileSealed: 'Encrypted. The site can read it while you are signed in.',
    passkeyNotice: CARD_TEXT.en.passkey,
    conversations: 'Conversations are never written to the site ledger. Anyone connected can record the encrypted copies.',
    holders: 'Holders can link the address that left a message to the address that collected it.',
    trackerGroups: 'Private groups are not announced to the public trackers; the site\'s own tracker sees the addresses of members who join.',
    neighbourIp: 'Your IP address, unless the site is busy enough that you are not connected to them directly.',
    presenceOff: 'Nobody sees your name as connected unless you turn presence on. People connected to you can see that your address is on this site\'s chat.',
    presenceKey: 'Public presence shows your key.',
    signInNoCompany: 'Signing in does not send your key or the list of your other sites to any identity company. The host of the identity page does see your IP address and the time whenever your browser has to load that page. Your passkey provider, if you use one, stores a passkey for the identity page.',
    extractable: 'Code on a site you are signed in to can copy your keys for that site.',
    uploadedContent: 'The loader never renders uploaded files at the site\'s address; site code that renders a file itself is responsible for it.',
    ownerReads: 'The owner cannot read them from the ledger or the swarm; the owner can read them through the code visitors run.'
  }),
  fr: Object.freeze({
    keyMatching: 'Les sites ne peuvent pas vous reconnaître par votre clé sauf si vous choisissez d\'être reconnu. Ils peuvent encore vous reconnaître par votre adresse IP, un nom réutilisé ou l\'horaire.',
    recordReaders: 'Les autres visiteurs et toute personne qui détient une copie du registre ne voient que du texte chiffré. Le code du site peut lire votre fiche tant que vous êtes connecté.',
    profileSealed: 'Chiffré. Le site peut le lire tant que vous êtes connecté.',
    passkeyNotice: CARD_TEXT.fr.passkey,
    conversations: 'Les conversations ne sont jamais écrites dans le registre du site. Toute personne connectée peut enregistrer les copies chiffrées.',
    holders: 'Les dépositaires peuvent relier l\'adresse qui a déposé un message à l\'adresse qui l\'a récupéré.',
    trackerGroups: 'Les groupes privés ne sont pas annoncés aux serveurs de connexion publics; le serveur de connexion du site voit les adresses des membres qui se joignent.',
    neighbourIp: 'Votre adresse IP, sauf si le site est assez actif pour que vous ne soyez pas relié directement à ces personnes.',
    presenceOff: 'Personne ne voit votre nom comme connecté sauf si vous activez la présence. Les personnes connectées à vous peuvent voir que votre adresse est dans la messagerie de ce site.',
    presenceKey: 'La présence publique montre votre clé.',
    signInNoCompany: 'Se connecter n\'envoie ni votre clé ni la liste de vos autres sites à une société d\'identité. L\'hébergeur de la page d\'identité voit toutefois votre adresse IP et l\'heure chaque fois que votre navigateur doit charger cette page. Votre fournisseur de clé d\'accès, si vous en utilisez un, garde une clé d\'accès pour la page d\'identité.',
    extractable: 'Le code d\'un site auquel vous êtes connecté peut copier vos clés pour ce site.',
    uploadedContent: 'Le chargeur n\'affiche jamais les fichiers téléversés à l\'adresse du site; le code du site qui affiche lui-même un fichier en est responsable.',
    ownerReads: 'Le propriétaire ne peut pas les lire dans le registre ni dans l\'essaim; il peut les lire par le code que les visiteurs exécutent.'
  })
})

// ---- identity chrome, prompts and low-risk confirmations on site origins (R 2.3.4, 2.8.4, MF-27) ------
export const UI_TEXT = Object.freeze({
  en: Object.freeze({
    openIdentity: 'Open identity page',
    signInButton: 'Sign in',
    signinWithMagnet: 'Sign in with felinar',
    signInTitle: 'Sign in',
    signInOpens: 'Sign in opens the felinar identity page in its own window.',
    signingIn: 'Opening the identity page...',
    tapToFinish: 'Tap to finish',
    tapToFinishText: 'One more tap is needed to finish.',
    cancel: 'Cancel',
    continue: 'Continue',
    accept: 'Accept',
    decline: 'Decline',
    ok: 'OK',
    close: 'Close',
    signedInAs: 'Signed in as',
    signOut: 'Sign out',
    removeFromDevice: 'Remove from this device',
    removeFromDeviceTitle: 'Remove from this device?',
    removeFromDeviceText: 'This deletes your working keys, saved copies and caches on this device. Nothing changes for other people. You can sign in again.',
    modePrivate: 'Private to this site',
    modeSame: 'Same as on {origin}',
    modeHub: 'One identity on {hub}',
    unlockPasskey: 'Unlocked with a passkey',
    unlockPassphrase: 'Unlocked with a passphrase',
    unlockVisit: 'This visit only',
    backupSaved: 'Backup saved',
    backupMissing: 'No backup yet',
    identiconLabel: 'Picture made from your key',
    evicted: 'This browser deleted your sign-in for this site. Tap Sign in to get it back.',
    ownerChanged: 'The owner of this site changed {minutes} minutes ago. If you did not expect this, do not share anything private here.',
    foreignAddress: 'This address is not one of this site\'s addresses.',
    redressCancelled: 'Cancelled: something moved or covered this button. Try again.',
    // Review round R 5.3 (UX-10): <mw-signin> in a browser that opens no sign-in window (an app's own browser), or after
    // a second block. The widget (src/widget/signin.js) picks it; requested of the identity area.
    signinOpenInBrowser: 'This browser cannot open the sign-in window. Open this page in Safari, Chrome, Firefox or Edge to sign in.',
    notTrusted: 'Use your own click or tap on this button.',
    modBanTitle: 'Ban {name}?',
    modBanText: '{name} ({short}) will no longer be able to write to this site. {until} You can unban later.',
    modBanUntil: 'The ban ends {date}.',
    modBanForever: 'The ban has no end date.',
    modUnbanTitle: 'Unban {name}?',
    modUnbanText: '{name} ({short}) will be able to write to this site again.',
    modTombstoneTitle: 'Hide {count} people\'s posts?',
    modTombstoneText: 'This hides posts by {count} people from copies that sync{before}. Copies kept by others that never sync stay as they are.',
    modTombstoneBefore: ', written before {date}',
    modDecideTitle: '{decision} this {kind}?',
    modDecideText: 'You are about to {decision} an item in the queue{reason}.',
    modDecideReason: ' with the reason "{reason}"',
    decisionAccept: 'accept',
    decisionDecline: 'decline',
    decisionDeny: 'deny',
    modConfirm: 'Confirm',
    uploadTitlePublic: 'Share this file publicly?',
    uploadTitlePrivate: 'Send this file privately?',
    uploadDetail: '{name} ({size}, {type})',
    uploadStripped: 'Location and camera details were removed.',
    // Code review v0.3 (conformance): only images and MP4, MOV and WebM videos are cleaned; the card says what happened.
    uploadAsIs: 'This file is shared exactly as it is. Documents and archives can carry a name or a location.',
    uploadUnchecked: 'This kind of file was not checked for location or camera details. Photos, audio and video in formats that are not cleaned can carry them.',
    phoneTitle: 'Send on mobile data?',
    phoneConfirm: 'Send now',
    offerTitleMedia: '{from} wants to send you a photo or video',
    offerTitleFile: '{from} wants to send you a file',
    offerDetail: '{name} ({size}, looks like {type}). Nothing is fetched until you accept.',
    offerFetch: 'Fetch',
    chatTitle: 'Turn on chat?',
    chatTurnOn: 'Turn on chat',
    chatUnavailable: 'Chat is not available on this site.',
    chatLobby: 'Lobby',
    chatDms: 'Messages',
    chatSend: 'Send',
    chatMessage: 'Message',
    chatNoMessages: 'No messages yet.',
    chatYou: 'You',
    chatConnected: 'Connected to you now',
    chatPickPerson: 'Choose a person',
    chatSignInFirst: 'Sign in to chat.',
    signinCooldown: 'Wait a few seconds before trying again.',
    signinFailed: 'Sign-in did not finish.',
    signinDone: 'Signed in.',
    signinInfo: 'Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.',
    // Code review v0.3: the recovery kit after the first meaningful action (R 2.2.6), the redirect round trip where the
    // sign-in window cannot open or keep its link (R 2.3.1, G-ID-7), and the folded header on phones.
    kitTitle: 'Save your recovery kit',
    kitPromptText: 'Your identity exists only on this device until you save your recovery kit. It opens at the identity page, and this site never sees it.',
    kitButton: 'Save my recovery kit',
    later: 'Later',
    continueHereTitle: 'Continue in this tab?',
    continueHereText: 'The sign-in window did not open or lost its link to this page. You can continue in this tab: the identity page opens in its place and then brings you back here.',
    continueHere: 'Continue in this tab',
    headerShow: 'Show who is signed in'
  }),
  fr: Object.freeze({
    openIdentity: 'Ouvrir la page d\'identité',
    signInButton: 'Se connecter',
    signinWithMagnet: 'Se connecter avec felinar',
    signInTitle: 'Connexion',
    signInOpens: 'Se connecter ouvre la page d\'identité felinar dans sa propre fenêtre.',
    signingIn: 'Ouverture de la page d\'identité...',
    tapToFinish: 'Touchez pour terminer',
    tapToFinishText: 'Un dernier toucher est nécessaire pour terminer.',
    cancel: 'Annuler',
    continue: 'Continuer',
    accept: 'Accepter',
    decline: 'Refuser',
    ok: 'OK',
    close: 'Fermer',
    signedInAs: 'Connecté en tant que',
    signOut: 'Se déconnecter',
    removeFromDevice: 'Retirer de cet appareil',
    removeFromDeviceTitle: 'Retirer de cet appareil?',
    removeFromDeviceText: 'Cela supprime vos clés de travail, les copies enregistrées et les caches sur cet appareil. Rien ne change pour les autres personnes. Vous pourrez vous reconnecter.',
    modePrivate: 'Privé à ce site',
    modeSame: 'Identique à celle de {origin}',
    modeHub: 'Une seule identité sur {hub}',
    unlockPasskey: 'Déverrouillé avec une clé d\'accès',
    unlockPassphrase: 'Déverrouillé avec une phrase secrète',
    unlockVisit: 'Cette visite seulement',
    backupSaved: 'Sauvegarde faite',
    backupMissing: 'Pas encore de sauvegarde',
    identiconLabel: 'Image créée à partir de votre clé',
    evicted: 'Ce navigateur a supprimé votre connexion à ce site. Touchez Se connecter pour la retrouver.',
    ownerChanged: 'Le propriétaire de ce site a changé il y a {minutes} minutes. Si vous ne vous y attendiez pas, ne partagez rien de privé ici.',
    foreignAddress: 'Cette adresse n\'est pas une adresse de ce site.',
    redressCancelled: 'Annulé : quelque chose a bougé ou recouvert ce bouton. Réessayez.',
    signinOpenInBrowser: 'Ce navigateur ne peut pas ouvrir la fenêtre de connexion. Ouvrez cette page dans Safari, Chrome, Firefox ou Edge pour vous connecter.',
    notTrusted: 'Utilisez votre propre clic ou toucher sur ce bouton.',
    modBanTitle: 'Bannir {name}?',
    modBanText: '{name} ({short}) ne pourra plus écrire sur ce site. {until} Vous pourrez lever le bannissement plus tard.',
    modBanUntil: 'Le bannissement prend fin le {date}.',
    modBanForever: 'Le bannissement n\'a pas de date de fin.',
    modUnbanTitle: 'Lever le bannissement de {name}?',
    modUnbanText: '{name} ({short}) pourra de nouveau écrire sur ce site.',
    modTombstoneTitle: 'Masquer les messages de {count} personnes?',
    modTombstoneText: 'Cela masque les messages de {count} personnes dans les copies qui se synchronisent{before}. Les copies gardées par d\'autres qui ne se synchronisent jamais restent telles quelles.',
    modTombstoneBefore: ', écrits avant le {date}',
    modDecideTitle: '{decision} cet élément ({kind})?',
    modDecideText: 'Vous êtes sur le point de choisir : {decision}, pour un élément de la file{reason}.',
    modDecideReason: ' avec la raison « {reason} »',
    decisionAccept: 'accepter',
    decisionDecline: 'refuser',
    decisionDeny: 'rejeter',
    modConfirm: 'Confirmer',
    uploadTitlePublic: 'Partager ce fichier publiquement?',
    uploadTitlePrivate: 'Envoyer ce fichier en privé?',
    uploadDetail: '{name} ({size}, {type})',
    uploadStripped: 'Les données de lieu et d\'appareil ont été retirées.',
    uploadAsIs: 'Ce fichier est partagé tel quel. Les documents et les archives peuvent contenir un nom ou un lieu.',
    uploadUnchecked: "Ce type de fichier n'a pas été vérifié pour le lieu ou l'appareil. Les photos, l'audio et la vidéo dans des formats non nettoyés peuvent les contenir.",
    phoneTitle: 'Envoyer avec les données mobiles?',
    phoneConfirm: 'Envoyer maintenant',
    offerTitleMedia: '{from} veut vous envoyer une photo ou une vidéo',
    offerTitleFile: '{from} veut vous envoyer un fichier',
    offerDetail: '{name} ({size}, semble être {type}). Rien n\'est récupéré avant que vous acceptiez.',
    offerFetch: 'Récupérer',
    chatTitle: 'Activer la messagerie?',
    chatTurnOn: 'Activer la messagerie',
    chatUnavailable: 'La messagerie n\'est pas disponible sur ce site.',
    chatLobby: 'Salon',
    chatDms: 'Messages',
    chatSend: 'Envoyer',
    chatMessage: 'Message',
    chatNoMessages: 'Aucun message pour le moment.',
    chatYou: 'Vous',
    chatConnected: 'Connecté avec vous en ce moment',
    chatPickPerson: 'Choisissez une personne',
    chatSignInFirst: 'Connectez-vous pour écrire.',
    signinCooldown: 'Attendez quelques secondes avant de réessayer.',
    signinFailed: 'La connexion n\'a pas abouti.',
    signinDone: 'Connecté.',
    signinInfo: 'Les scripts de cette page peuvent agir en votre nom sur ce site tant que vous êtes connecté. Ils ne peuvent pas atteindre vos autres sites.',
    kitTitle: 'Enregistrez votre trousse de récupération',
    kitPromptText: 'Votre identité n\'existe que sur cet appareil tant que vous n\'avez pas enregistré votre trousse de récupération. Elle s\'ouvre sur la page d\'identité, et ce site ne la voit jamais.',
    kitButton: 'Enregistrer ma trousse de récupération',
    later: 'Plus tard',
    continueHereTitle: 'Continuer dans cet onglet?',
    continueHereText: 'La fenêtre de connexion ne s\'est pas ouverte ou a perdu son lien avec cette page. Vous pouvez continuer dans cet onglet : la page d\'identité s\'ouvre à sa place, puis vous ramène ici.',
    continueHere: 'Continuer dans cet onglet',
    headerShow: 'Montrer qui est connecté'
  })
})

// ---- delivery states (R 2.7.5 item 6; MF-35). Shipped behind STRING_FLAGS.deliveryStates (false until the
// gate rows G-CH-1 and G-CH-3 pass). deliveryText() returns null while the flag is false.
export const DELIVERY_TEXT = Object.freeze({
  en: Object.freeze({
    delivered: 'Delivered',
    // code review v0.3 (round 2): HOLDING frames are not authenticated, so the count is what peers reported (one per neighbour wire)
    handed: '{count} peers reported holding it at {time}. They may go offline.',
    outbox: 'Will send when {name} is online while this page is open',
    'sent-unknown': 'Sent to the network. You will not know if it arrived until they reply.',
    'not-delivered': 'Not delivered: nobody who can hold it is online.'
  }),
  fr: Object.freeze({
    delivered: 'Remis',
    handed: '{count} pairs ont indiqué le garder à {time}. Ils peuvent se déconnecter.',
    outbox: 'Sera envoyé quand {name} sera en ligne, tant que cette page reste ouverte',
    'sent-unknown': 'Envoyé au réseau. Vous ne saurez pas s\'il est arrivé avant qu\'on vous réponde.',
    'not-delivered': 'Non remis : personne pouvant le conserver n\'est en ligne.'
  })
})
export function deliveryText (state, lang = 'en', params = null) {
  if (!STRING_FLAGS.deliveryStates) return null
  const t = (DELIVERY_TEXT[lang] || DELIVERY_TEXT.en)[state]
  return t ? fmt(t, params) : null
}

// ---- iOS and Tor conditional strings (R 2.12, MF-63): shown only when STRING_FLAGS.iosTorStrings is true ------
export const IOS_TOR_TEXT = Object.freeze({
  en: Object.freeze({
    torNoChat: 'This browser does not run the peer connections chat needs. You can sign in and read, but you cannot chat or fetch from other visitors.',
    iosHomeScreen: 'Add this site to your Home Screen to keep your sign-in. Safari deletes site data after 7 days without a visit.'
  }),
  fr: Object.freeze({
    torNoChat: 'Ce navigateur ne gère pas les connexions entre pairs dont la messagerie a besoin. Vous pouvez vous connecter et lire, mais pas écrire ni récupérer depuis d\'autres visiteurs.',
    iosHomeScreen: 'Ajoutez ce site à votre écran d\'accueil pour garder votre connexion. Safari supprime les données d\'un site après 7 jours sans visite.'
  })
})
export function iosTorText (key, lang = 'en') {
  if (!STRING_FLAGS.iosTorStrings) return null
  return (IOS_TOR_TEXT[lang] || IOS_TOR_TEXT.en)[key] || null
}

// ---- R 3.7 noscript text; the same sentence is in src/loader/index.html ---------------------------------
export const NOSCRIPT_TEXT = Object.freeze({
  en: 'This site loads from other visitors\' browsers and needs JavaScript.',
  fr: 'Ce site se charge depuis les navigateurs d\'autres visiteurs et a besoin de JavaScript.'
})

/** cardText(key, lang, params), uiText(key, lang, params): lookups with English fallback. */
export function cardText (key, lang = 'en', params = null) {
  const t = (CARD_TEXT[lang] || CARD_TEXT.en)[key] || CARD_TEXT.en[key]
  return t === undefined ? '' : fmt(t, params)
}
export function uiText (key, lang = 'en', params = null) {
  const t = (UI_TEXT[lang] || UI_TEXT.en)[key] || UI_TEXT.en[key]
  return t === undefined ? '' : fmt(t, params)
}

// =====================================================================================================
// v0.3 C2 strings (research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md "SZ" 3.1.5 and 3.5; lane docs-strings, written
// contract-first for the lanes wire-ui, seed-engine and calls). English and French, the same placeholders in
// both. The keys are the ones the design names; the English texts of the SZ tables are verbatim, and
// test/unit/strings-c2.test.mjs pins them. Rules as above: no em or en dashes, straight quotes, none of the banned
// words. "online" appears only where it says whether someone who holds a file can be reached (R 2.7.6 keeps
// "Connected to you now" for a person's presence), and a call says "connected". Each sentence that names who sees
// an IP address (call.start, call.incoming, call.group, seed.ask) keeps that clause in both languages.
// =====================================================================================================

// ---- seeding: availability labels (SZ 3.1.5), hand-off states, budget cards, dock mode, keeper tab, carry meter ----
export const SEED_TEXT = Object.freeze({
  en: Object.freeze({
    // availability labels; each one needs the evidence tier SZ 3.1.5 names (E0 to E4) and never shows a number above it
    'avail.onlyHere': 'Only on this device. Keep this page open until it is sent.',
    'avail.heldBy': 'Kept by you and at least {n} others online now (reported)',
    'avail.keptBySite': 'Kept by the site (checked {age} ago)',
    'avail.nobody': 'Nobody who has this is online right now.',
    'avail.noPin': 'No always-on copy exists for this site. This file is available only while someone who has it is online.',
    // hand-off of the member's own upload to the site's pin node
    'handoff.waiting': 'Waiting for the site to accept it.',
    'handoff.sending': 'Sending to the site: {pct}%',
    // budget cards (SZ 3.1.3, 3.1.4)
    'seed.monthUsed': 'Sharing paused: this site\'s limit of {cap} for this month is used. Your own uploads still go out.',
    'seed.ask': 'Help keep this available? While this page is open and your phone charges on Wi-Fi, it shares what you keep, up to {cap} a month on this site. Others can see your IP address and which files you share.',
    'seed.declareWifi': 'I am on Wi-Fi',
    'seed.declarePlugged': 'My phone is plugged in',
    // dock mode and the keeper tab (SZ 3.1.4)
    'dock.start': 'Keep this screen on and share for 2 hours',
    'dock.on': 'Keeping the screen on and sharing until {time}. Leave the page to stop.',
    'dock.stop': 'Stop and let the screen sleep',
    // why keeping the screen on did not start ('dock.refused.' + the reason dock.start gives) and why it ended ('dock.stopped.' + the reason of
    // dock.stop); the reasons are those of src/loader/dock.js (docs/deviations/seed-policy.md)
    'dock.refused.unsupported': 'Could not keep the screen on: this browser cannot do it.',
    'dock.refused.hidden': 'Could not keep the screen on: the page is not on screen. Open it and try again.',
    'dock.refused.declare': 'Could not keep the screen on: this browser cannot tell whether your phone is plugged in and on Wi-Fi. Confirm both and try again.',
    'dock.refused.unplugged': 'Could not keep the screen on: the phone is not plugged in.',
    'dock.refused.battery': 'Could not keep the screen on: the battery is low. Charge your phone and try again.',
    'dock.refused.denied': 'Could not keep the screen on: your browser did not allow it.',
    'dock.stopped.hidden': 'Stopped keeping the screen on: you left the page.',
    'dock.stopped.unplugged': 'Stopped keeping the screen on: the phone was unplugged.',
    'dock.stopped.battery': 'Stopped keeping the screen on: the battery is low.',
    'dock.stopped.cap': 'Stopped keeping the screen on: the time limit was reached.',
    'dock.stopped.user': 'Stopped keeping the screen on.',
    'dock.stopped.released': 'Stopped keeping the screen on: the browser let the screen turn off.',
    'keeper.toggle': 'Keep this site',
    'keeper.on': 'Keeping this site while this tab is open.',
    // the carry meter: measured counts of bytes, never a ranking (ARCHITECTURE 8, no incentive layer)
    'meter.visit': 'This visit: {p}% of the bytes came from {n} visitors, {h}% from the host.',
    'meter.tracker': '{n} connected to this site (tracker report, {time})'
  }),
  fr: Object.freeze({
    'avail.onlyHere': 'Seulement sur cet appareil. Gardez cette page ouverte jusqu\'à l\'envoi.',
    'avail.heldBy': 'Gardé par vous et au moins {n} autres personnes en ligne maintenant (déclaré)',
    'avail.keptBySite': 'Gardé par le site (vérifié il y a {age})',
    'avail.nobody': 'Personne qui a ceci n\'est en ligne pour le moment.',
    'avail.noPin': 'Aucune copie toujours disponible n\'existe pour ce site. Ce fichier n\'est disponible que tant qu\'une personne qui l\'a est en ligne.',
    'handoff.waiting': 'En attente de l\'acceptation par le site.',
    'handoff.sending': 'Envoi au site : {pct} %',
    'seed.monthUsed': 'Partage en pause : la limite de ce site pour ce mois, {cap}, est atteinte. Vos propres envois partent quand même.',
    'seed.ask': 'Aider à garder ceci disponible? Tant que cette page est ouverte et que votre téléphone se recharge sur le Wi-Fi, il partage ce que vous gardez, jusqu\'à {cap} par mois sur ce site. D\'autres personnes peuvent voir votre adresse IP et les fichiers que vous partagez.',
    'seed.declareWifi': 'Je suis sur le Wi-Fi',
    'seed.declarePlugged': 'Mon téléphone est branché',
    'dock.start': 'Garder cet écran allumé et partager pendant 2 heures',
    'dock.on': 'L\'écran reste allumé et le partage continue jusqu\'à {time}. Quittez la page pour arrêter.',
    'dock.stop': 'Arrêter et laisser l\'écran s\'éteindre',
    'dock.refused.unsupported': 'Impossible de garder l\'écran allumé : ce navigateur ne le permet pas.',
    'dock.refused.hidden': 'Impossible de garder l\'écran allumé : la page n\'est pas à l\'écran. Ouvrez-la et réessayez.',
    'dock.refused.declare': 'Impossible de garder l\'écran allumé : ce navigateur ne peut pas savoir si votre téléphone est branché et sur le Wi-Fi. Confirmez les deux et réessayez.',
    'dock.refused.unplugged': 'Impossible de garder l\'écran allumé : le téléphone n\'est pas branché.',
    'dock.refused.battery': 'Impossible de garder l\'écran allumé : la batterie est faible. Rechargez votre téléphone et réessayez.',
    'dock.refused.denied': 'Impossible de garder l\'écran allumé : votre navigateur ne l\'a pas autorisé.',
    'dock.stopped.hidden': 'L\'écran n\'est plus gardé allumé : vous avez quitté la page.',
    'dock.stopped.unplugged': 'L\'écran n\'est plus gardé allumé : le téléphone a été débranché.',
    'dock.stopped.battery': 'L\'écran n\'est plus gardé allumé : la batterie est faible.',
    'dock.stopped.cap': 'L\'écran n\'est plus gardé allumé : la durée maximale est atteinte.',
    'dock.stopped.user': 'L\'écran n\'est plus gardé allumé.',
    'dock.stopped.released': 'L\'écran n\'est plus gardé allumé : le navigateur a laissé l\'écran s\'éteindre.',
    'keeper.toggle': 'Garder ce site',
    'keeper.on': 'Ce site est gardé tant que cet onglet reste ouvert.',
    'meter.visit': 'Cette visite : {p} % des octets viennent de {n} visiteurs, {h} % de l\'hébergeur.',
    'meter.tracker': '{n} connectés à ce site (rapport du serveur de connexion, {time})'
  })
})

// ---- calls (SZ 3.5): the loader-owned call card and panel (src/loader/call-ui.js), every text from here -----------
// call.incoming holds the sentence only: its three buttons are call.accept.audio, call.accept.video and call.decline.
// {kind} is call.kind.audio or call.kind.video, {names} a list the caller joins, {duration} a clock such as 2:35.
export const CALL_TEXT = Object.freeze({
  en: Object.freeze({
    // the cards that name who will see the IP address, before any address leaves the device
    'call.start': 'Call {name}? Your browsers connect directly, so {name} will see your IP address. Nobody else is in the media path.',
    'call.startRelay': 'If a direct connection fails, the call goes through {operator}\'s relay, which sees both IP addresses and how much you send, not what you say.',
    'call.incoming': '{name} is calling ({kind}). Accepting shows your IP address to {name}.',
    'call.group': 'Join a call with {names}? Each of them will see your IP address.',
    'call.screen': 'Everyone in this call will see the screen or window you pick.',
    // conditions the person should know before and during a call
    'call.metered': 'You are on mobile data, so the call starts with audio only. Video uses about 2 MB a minute.',
    'call.ios': 'On iPhone, video stops when you leave this page, and an app on the Home Screen loses the microphone too. Keep this page open during the call.',
    'call.android': 'Keep this page open during the call. Android may cut the connection when the screen is off.',
    // code review v0.3 (round 2): what phones show until the gate rows allow the platform notes above (CALL_FLAGS.phoneNotes)
    'call.keepOpen': 'Keep this page open during the call.',
    'call.noPath': 'Could not connect to {name} directly. Some networks block direct connections, and this site has no relay.',
    'call.notHere': '{name} is not connected now. Calls ring only while {name} has this site open.',
    // how a call ends
    'call.ended': 'Call ended ({duration}).',
    'call.declined': '{name} declined.',
    'call.busy': '{name} is in another call.',
    // the two kinds named in call.incoming
    'call.kind.audio': 'audio',
    'call.kind.video': 'video',
    // controls
    'call.accept.audio': 'Accept with audio',
    'call.accept.video': 'Accept with video',
    'call.decline': 'Decline',
    'call.mute': 'Mute',
    'call.unmute': 'Unmute',
    'call.camera.on': 'Turn camera on',
    'call.camera.off': 'Turn camera off',
    'call.screen.start': 'Share screen',
    'call.screen.stop': 'Stop sharing',
    'call.hangup': 'Hang up',
    // one participant's state
    'call.state.ringing': 'Ringing',
    'call.state.connecting': 'Connecting',
    'call.state.direct': 'Direct',
    'call.state.relayed': 'Relayed by {operator}',
    'call.state.reconnecting': 'Reconnecting',
    'call.state.left': 'Left the call',
    // the browser or the network took something away
    'call.paused': 'Your camera is paused by the browser',
    'call.videoPaused': 'Video paused: the connection is too slow',
    // the tab title while a call rings, and the line while the caller waits
    'call.ringTitle': 'Incoming call',
    'call.calling': 'Calling {name}...'
  }),
  fr: Object.freeze({
    'call.start': 'Appeler {name}? Vos navigateurs se connectent directement, donc {name} verra votre adresse IP. Personne d\'autre ne se trouve sur le trajet du son et de l\'image.',
    'call.startRelay': 'Si une connexion directe échoue, l\'appel passe par le relais de {operator}, qui voit les deux adresses IP et la quantité envoyée, pas ce que vous dites.',
    'call.incoming': '{name} vous appelle ({kind}). Accepter montre votre adresse IP à {name}.',
    'call.group': 'Se joindre à un appel avec {names}? Chacune de ces personnes verra votre adresse IP.',
    'call.screen': 'Toutes les personnes de cet appel verront l\'écran ou la fenêtre que vous choisissez.',
    'call.metered': 'Vous êtes sur les données mobiles, donc l\'appel commence avec le son seulement. La vidéo utilise environ 2 Mo par minute.',
    'call.ios': 'Sur iPhone, la vidéo s\'arrête quand vous quittez cette page, et une application de l\'écran d\'accueil perd aussi le microphone. Gardez cette page ouverte pendant l\'appel.',
    'call.android': 'Gardez cette page ouverte pendant l\'appel. Android peut couper la connexion quand l\'écran est éteint.',
    'call.keepOpen': 'Gardez cette page ouverte pendant l\'appel.',
    'call.noPath': 'Impossible de se connecter directement à {name}. Certains réseaux bloquent les connexions directes, et ce site n\'a pas de relais.',
    'call.notHere': '{name} n\'est pas connecté en ce moment. Les appels ne sonnent que tant que {name} a ce site ouvert.',
    'call.ended': 'Appel terminé ({duration}).',
    'call.declined': '{name} a refusé.',
    'call.busy': '{name} est dans un autre appel.',
    'call.kind.audio': 'audio',
    'call.kind.video': 'vidéo',
    'call.accept.audio': 'Accepter avec le son',
    'call.accept.video': 'Accepter avec la vidéo',
    'call.decline': 'Refuser',
    'call.mute': 'Couper le micro',
    'call.unmute': 'Réactiver le micro',
    'call.camera.on': 'Activer la caméra',
    'call.camera.off': 'Couper la caméra',
    'call.screen.start': 'Partager l\'écran',
    'call.screen.stop': 'Arrêter le partage',
    'call.hangup': 'Raccrocher',
    'call.state.ringing': 'Sonnerie',
    'call.state.connecting': 'Connexion en cours',
    'call.state.direct': 'Direct',
    'call.state.relayed': 'Relayé par {operator}',
    'call.state.reconnecting': 'Reconnexion',
    'call.state.left': 'A quitté l\'appel',
    'call.paused': 'Votre caméra est mise en pause par le navigateur',
    'call.videoPaused': 'Vidéo en pause : la connexion est trop lente',
    'call.ringTitle': 'Appel entrant',
    'call.calling': 'Appel de {name}...'
  })
})

// ---- doors (C2 doors, docs/research/v03/S4-doors.md D3 to D6): the door view, the "not answering" banner, the Doors panel in
// Settings, the "Open a link" box of a door. 'door.view' is the sentence of S4 D4 and 'door.notAnswering' the banner of D5 verbatim;
// no text says or implies that a link moves by itself, and the door view always says what it cannot do. {hosts} is a list the
// caller joins with ', '. 'door.state.' + a probe state of src/loader/doors.js ('up', 'other-build', 'opaque', 'bad', 'down') or
// 'unknown'. -----------------------------------------------------------------------------------------------------------------
export const DOOR_TEXT = Object.freeze({
  en: Object.freeze({
    'door.view': 'This address can show the site but cannot store anything for it.',
    'door.viewIdentity': 'Your identity here lasts for this visit only.',
    'door.gateNote': 'This address shows the site in a limited view: it cannot store anything for it, and your identity here lasts for this visit only.',
    'door.openAt': 'Open at {host}',
    'door.notAnswering': 'This address is not answering. The owner lists: {hosts}.',
    'door.notAnsweringHint': 'This address is not answering. The link names: {hosts}.',
    'door.notAnsweringAlso': 'Not from the owner: {hosts}.',
    'door.confirmHint': 'Open {host}? This address came with the link, not from the site\'s owner.',
    'door.notAnsweringNone': 'This address is not answering. No other address is known for this site.',
    'door.panel.title': 'Doors',
    'door.panel.intro': 'The site lives at its key; domains are doors. These addresses can open it.',
    'door.panel.current': 'This address: {host}',
    'door.panel.lastGood': 'Last loaded from: {host}',
    'door.panel.owner': 'The owner\'s addresses',
    'door.panel.guest': 'Doors the owner signed',
    'door.panel.ledger': 'Doors the owner listed in the site ledger',
    'door.panel.hint': 'Doors the link suggested (not signed)',
    'door.panel.none': 'No other address is known for this site.',
    'door.panel.copy': 'Copy link with doors',
    'door.panel.copied': 'Link copied.',
    'door.panel.copyFailed': 'Could not copy the link. Select it and copy it:',
    'door.panel.build': 'Loader {version}, build {build}',
    'door.state.up': 'answering',
    'door.state.other-build': 'answering, another loader version',
    'door.state.opaque': 'answering, not checked',
    'door.state.bad': 'answers, but not as a door',
    'door.state.down': 'not answering',
    'door.state.unknown': 'not checked',
    'door.paste.title': 'Open a link',
    'door.paste.text': 'Paste a link to a site. Nothing loads before you choose to load it.',
    'door.paste.label': 'Link',
    'door.paste.open': 'Open',
    'door.paste.bad': 'This is not a link to a site.',
    'door.badLink': 'This link does not name a site.',
    'door.viewFailed': 'The limited view of this address did not start. Reload the page.',
    'door.app.home': 'Open the app once from your Home Screen while you are online.'
  }),
  fr: Object.freeze({
    'door.view': 'Cette adresse peut afficher le site mais ne peut rien garder pour lui.',
    'door.viewIdentity': 'Votre identité ici ne dure que le temps de cette visite.',
    'door.gateNote': 'Cette adresse affiche le site en vue limitée : elle ne peut rien garder pour lui, et votre identité ici ne dure que le temps de cette visite.',
    'door.openAt': 'Ouvrir sur {host}',
    'door.notAnswering': 'Cette adresse ne répond pas. Le propriétaire indique : {hosts}.',
    'door.notAnsweringHint': 'Cette adresse ne répond pas. Le lien indique : {hosts}.',
    'door.notAnsweringAlso': 'Pas du propriétaire : {hosts}.',
    'door.confirmHint': 'Ouvrir {host} ? Cette adresse est venue avec le lien, pas du propriétaire du site.',
    'door.notAnsweringNone': 'Cette adresse ne répond pas. Aucune autre adresse n\'est connue pour ce site.',
    'door.panel.title': 'Portes',
    'door.panel.intro': 'Le site vit à sa clé; les domaines sont des portes. Ces adresses peuvent l\'ouvrir.',
    'door.panel.current': 'Cette adresse : {host}',
    'door.panel.lastGood': 'Dernier chargement depuis : {host}',
    'door.panel.owner': 'Les adresses du propriétaire',
    'door.panel.guest': 'Portes signées par le propriétaire',
    'door.panel.ledger': 'Portes listées par le propriétaire dans le registre du site',
    'door.panel.hint': 'Portes suggérées par le lien (non signées)',
    'door.panel.none': 'Aucune autre adresse n\'est connue pour ce site.',
    'door.panel.copy': 'Copier le lien avec les portes',
    'door.panel.copied': 'Lien copié.',
    'door.panel.copyFailed': 'Impossible de copier le lien. Sélectionnez-le et copiez-le :',
    'door.panel.build': 'Chargeur {version}, compilation {build}',
    'door.state.up': 'répond',
    'door.state.other-build': 'répond, autre version du chargeur',
    'door.state.opaque': 'répond, non vérifiée',
    'door.state.bad': 'répond, mais pas comme une porte',
    'door.state.down': 'ne répond pas',
    'door.state.unknown': 'non vérifiée',
    'door.paste.title': 'Ouvrir un lien',
    'door.paste.text': 'Collez le lien d\'un site. Rien ne se charge avant que vous choisissiez de le charger.',
    'door.paste.label': 'Lien',
    'door.paste.open': 'Ouvrir',
    'door.paste.bad': 'Ce n\'est pas le lien d\'un site.',
    'door.badLink': 'Ce lien ne désigne aucun site.',
    'door.viewFailed': 'La vue limitée de cette adresse n\'a pas démarré. Rechargez la page.',
    'door.app.home': 'Ouvrez l\'application une fois depuis votre écran d\'accueil pendant que vous êtes en ligne.'
  })
})

/** doorText(key, lang, params): the DOOR_TEXT lookup for a language tag (pickLang: 'fr-CA' is French), English fallback; an unknown key gives ''. */
export function doorText (key, lang = 'en', params = null) {
  return lookupC2(DOOR_TEXT, key, pickLang(lang), params)
}

/** seedText(key, lang, params), callText(key, lang, params): lookups with English fallback; an unknown key gives ''. */
export function seedText (key, lang = 'en', params = null) {
  return lookupC2(SEED_TEXT, key, lang, params)
}
export function callText (key, lang = 'en', params = null) {
  return lookupC2(CALL_TEXT, key, lang, params)
}
function lookupC2 (table, key, lang, params) {
  const own = (t, k) => (t && Object.prototype.hasOwnProperty.call(t, k) ? t[k] : undefined)
  const text = own(table[lang], key) !== undefined ? own(table[lang], key) : own(table.en, key)
  return text === undefined ? '' : fmt(text, params)
}
