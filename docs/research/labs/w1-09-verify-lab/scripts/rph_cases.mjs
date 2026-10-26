// Verification-run test cases for navigator.registerProtocolHandler (independent re-implementation).
// Evaluated INSIDE the page. Returns { caseName: 'ok' | 'ErrName: message' }.
export const PAGE_FN = () => {
  const r = {}
  const t = (n, f) => { try { f(); r[n] = 'ok' } catch (e) { r[n] = (e && e.name || 'Error') + ': ' + (e && e.message || e) } }
  r.env = {
    ua: navigator.userAgent,
    href: location.href,
    origin: location.origin,
    isSecureContext,
    typeofRegister: typeof navigator.registerProtocolHandler,
    typeofUnregister: typeof navigator.unregisterProtocolHandler,
    typeofIsRegistered: typeof navigator.isProtocolHandlerRegistered,
    typeofRegisterContentHandler: typeof navigator.registerContentHandler,
    inNavigator: 'registerProtocolHandler' in navigator,
    protoHas: Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(navigator), 'registerProtocolHandler'),
    registerLength: (navigator.registerProtocolHandler || {}).length
  }
  if (typeof navigator.registerProtocolHandler !== 'function') return r
  const o = location.origin
  const R = (s, u, ...x) => navigator.registerProtocolHandler(s, u, ...x)
  const c = {}
  // ---- scheme cases (url fixed to a valid same-origin template)
  const U = o + '/#%s'
  for (const s of ['magnet', 'MAGNET', 'Magnet', 'web+magnetweb', 'WEB+MagnetWeb', 'web+a', 'ipfs', 'ftp', 'mailto', 'tel', 'payto',
    'bittorrent', 'https', 'http', 'javascript', 'data', 'file', 'blob', 'web+magnet2', 'web+', 'web+magnet-x', 'web+mägnet', 'web+magnet_x', 'magnet:', '', ' magnet', 'magnet ', 'x-magnet', 'ext+magnet', 'web']) {
    t('scheme ' + JSON.stringify(s), () => R(s, U))
  }
  // ---- template cases (scheme fixed to magnet)
  const tpl = {
    'abs /#%s': o + '/#%s',
    'rel /#%s': '/#%s',
    'rel #%s (fragment only)': '#%s',
    'rel %s (bare)': '%s',
    'abs ?m=%s': o + '/?m=%s',
    'abs /open#%s': o + '/open#%s',
    'scheme-relative //host/#%s': '//' + location.host + '/#%s',
    'two %s': o + '/#%s&b=%s',
    'no %s (abs)': o + '/',
    'no %s (empty)': '',
    '%s in host': 'http://%s.' + location.host + '/',
    '%s in port': 'http://' + location.hostname + ':%s/',
    '%s inside port digits': 'http://' + location.hostname + ':' + (location.port || '80') .slice(0, 1) + '%s' + (location.port || '80').slice(1) + '/',
    '%s in userinfo': 'http://%s@' + location.host + '/',
    'cross-origin https example.org': 'https://example.org/#%s',
    'cross-origin http example.org': 'http://example.org/#%s',
    'same host other port': 'http://' + location.hostname + ':1/#%s',
    'localhost vs 127.0.0.1': 'http://localhost:' + location.port + '/#%s',
    'ftp scheme': 'ftp://' + location.host + '/%s',
    'javascript: url': 'javascript:%s',
    'data: url': 'data:text/html,%s',
    'blob: url': 'blob:' + o + '/00000000-0000-0000-0000-000000000000#%s'
  }
  for (const [k, u] of Object.entries(tpl)) t('template ' + k, () => R('magnet', u))
  t('3-arg legacy title', () => R('magnet', U, 'Title'))
  t('1-arg', () => R('magnet'))
  t('0-arg', () => R())
  t('order: bad scheme + no %s', () => R('bittorrent', o + '/'))
  t('order: ok scheme + cross-origin + no %s', () => R('magnet', 'https://example.org/'))
  return r
}
