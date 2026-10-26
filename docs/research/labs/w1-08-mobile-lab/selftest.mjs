import vm from 'node:vm'; import fs from 'node:fs';
const ctx = vm.createContext({ btoa, atob, console });
vm.runInContext(fs.readFileSync('u8-polyfill.js', 'utf8'), ctx);
const r = vm.runInContext(`
(function () {
  var a = new Uint8Array([1, 2, 254, 255]);
  var out = {
    hex: a.toHex(), b64: a.toBase64(), b64url: a.toBase64({ alphabet: 'base64url', omitPadding: true }),
    fromHex: Array.from(Uint8Array.fromHex('0102FEFF')), fromB64url: Array.from(Uint8Array.fromBase64('AQL-_w', { alphabet: 'base64url' })),
    empty: [new Uint8Array(0).toHex(), new Uint8Array(0).toBase64(), Uint8Array.fromHex('').length, Uint8Array.fromBase64('').length],
    big: (function () { var b = new Uint8Array(100000); for (var i = 0; i < b.length; i++) b[i] = i & 255; var s = b.toBase64(); var r = Uint8Array.fromBase64(s); var ok = r.length === b.length; for (var i = 0; i < b.length && ok; i++) if (r[i] !== b[i]) ok = false; return ok; })(),
    errs: []
  };
  function t(name, f, E) { try { f(); out.errs.push(name + ': NO THROW'); } catch (e) { out.errs.push(name + ': ' + (e instanceof E ? 'ok ' + E.name : 'WRONG ' + e.name)); } }
  t('odd hex', function () { Uint8Array.fromHex('abc'); }, SyntaxError);
  t('bad hex', function () { Uint8Array.fromHex('zz'); }, SyntaxError);
  t('non-string', function () { Uint8Array.fromHex(5); }, TypeError);
  t('strict missing pad', function () { Uint8Array.fromBase64('AQL', { lastChunkHandling: 'strict' }); }, SyntaxError);
  t('loose 1-char', function () { Uint8Array.fromBase64('A'); }, SyntaxError);
  t('b64url rejects +', function () { Uint8Array.fromBase64('a+b/', { alphabet: 'base64url' }); }, SyntaxError);
  t('bad alphabet', function () { new Uint8Array(1).toBase64({ alphabet: 'x' }); }, TypeError);
  t('not u8', function () { Uint8Array.prototype.toHex.call([1]); }, TypeError);
  out.stopBefore = Array.from(Uint8Array.fromBase64('AQLx', { lastChunkHandling: 'stop-before-partial' })).concat(['|']).concat(Array.from(Uint8Array.fromBase64('AQL+Aw', { lastChunkHandling: 'stop-before-partial' })));
  out.descr = JSON.stringify(Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex').enumerable) + ' name=' + Uint8Array.fromBase64.name + ' len=' + [Uint8Array.prototype.toHex.length, Uint8Array.prototype.toBase64.length, Uint8Array.fromHex.length, Uint8Array.fromBase64.length].join(',');
  return JSON.stringify(out, null, 1);
})()`, ctx);
console.log(r);
