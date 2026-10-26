/* Uint8Array base64/hex (ES2026) polyfill: toHex, toBase64, fromHex, fromBase64.
   Classic script, ES2017 syntax only. Installs only what is missing. setFromHex/setFromBase64 are NOT provided.
   Needs btoa/atob (every target browser; Node >= 16). Needed by uint8-util@2.3.x (webtorrent 3.0.21). */
(function (G) {
  'use strict';
  var U = G.Uint8Array, P = U.prototype, A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var tag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(P), Symbol.toStringTag).get;
  function brand(a) { if (tag.call(a) !== 'Uint8Array') throw new TypeError('not a Uint8Array'); return a; }
  function live(a) { try { new U(a.buffer, 0, 0); } catch (e) { throw new TypeError('detached ArrayBuffer'); } return a; }
  function opts(o) {
    if (o === undefined) return {};
    if (o === null || (typeof o !== 'object' && typeof o !== 'function')) throw new TypeError('options must be an object');
    return o;
  }
  function alpha(o) {
    var a = o.alphabet;
    if (a === undefined) return 'base64';
    if (a !== 'base64' && a !== 'base64url') throw new TypeError('bad alphabet');
    return a;
  }
  var M = {
    toHex() {
      var a = brand(this), s = '', i;
      live(a);
      for (i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return s;
    },
    toBase64() {
      var a = brand(this), o = opts(arguments[0]), al = alpha(o), pad = !o.omitPadding, s = '', i;
      live(a);
      for (i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
      s = G.btoa(s);
      if (al === 'base64url') s = s.replace(/\+/g, '-').replace(/\//g, '_');
      return pad ? s : s.replace(/=+$/, '');
    },
    fromHex(s) {
      if (typeof s !== 'string') throw new TypeError('expected a string');
      if (s.length % 2) throw new SyntaxError('odd length');
      if (/[^0-9a-fA-F]/.test(s)) throw new SyntaxError('not hex');
      var r = new U(s.length / 2), i;
      for (i = 0; i < r.length; i++) r[i] = parseInt(s.substr(2 * i, 2), 16);
      return r;
    },
    fromBase64(s) {
      if (typeof s !== 'string') throw new TypeError('expected a string');
      var o = opts(arguments[1]), al = alpha(o), lc = o.lastChunkHandling, t, m, b, p, r, x, out, i;
      if (lc === undefined) lc = 'loose';
      else if (lc !== 'loose' && lc !== 'strict' && lc !== 'stop-before-partial') throw new TypeError('bad lastChunkHandling');
      t = s.replace(/[\t\n\f\r ]+/g, '');
      if (al === 'base64url') {
        if (/[+/]/.test(t)) throw new SyntaxError('bad character');
        t = t.replace(/-/g, '+').replace(/_/g, '/');
      }
      m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(t);
      if (!m) throw new SyntaxError('invalid base64');
      b = m[1]; p = m[2].length; r = b.length % 4;
      if (p ? r + p !== 4 : r) {                         // padding missing, misplaced or chunk incomplete
        if (lc === 'stop-before-partial' && (p ? r === 2 && p === 1 : true)) b = b.slice(0, b.length - r);
        else if (p || lc === 'strict' || r === 1) throw new SyntaxError('bad padding');
      } else if (lc === 'strict' && r && (A.indexOf(b.charAt(b.length - 1)) & (r === 2 ? 15 : 3))) {
        throw new SyntaxError('non-zero trailing bits');
      }
      x = G.atob(b); out = new U(x.length);
      for (i = 0; i < x.length; i++) out[i] = x.charCodeAt(i);
      return out;
    }
  };
  function def(o, k) { if (!(k in o)) Object.defineProperty(o, k, { value: M[k], writable: true, configurable: true }); }
  def(P, 'toHex'); def(P, 'toBase64'); def(U, 'fromHex'); def(U, 'fromBase64');
})(typeof globalThis === 'object' ? globalThis : self);
