// VERIFY claim 5: what does one hashcash mint cost on this M3 for a REALISTIC block preimage? (Node: native crypto and pure JS, single thread; multi-Worker rates are in pow-bench-browser.mjs)
import crypto from 'node:crypto'
import vm from 'node:vm'
import fs from 'node:fs'
import os from 'node:os'
const PROJ = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '') // <repo root>
const SCR = new URL('.', import.meta.url).pathname
const { canonicalize } = await import(PROJ + '/src/chain/canonical.js')
const core = fs.readFileSync(SCR + 'miner-core.js', 'utf8')
vm.runInThisContext(core)

{
  const b64u = (n) => crypto.randomBytes(n).toString('base64url')
  const hex = (n) => crypto.randomBytes(n).toString('hex')
  // realistic telemetry-style block header e (ARCH v0.2 section 6.1); nonce fixed-width 8 hex placed via placeholder
  const mkE = (nParents) => ({ v: 1, site: b64u(32), author: 'B' + b64u(64).slice(0, 86), seq: 7, prev: Array.from({ length: nParents }, () => hex(32)).sort(), ts: 1792000000000, bits: 14, op: { t: 'append', l: '_tel', vh: hex(32) }, nonce: 'NNNNNNNN' })
  const results = []
  for (const nParents of [1, 3]) {
    const e = mkE(nParents)
    const canon = canonicalize(e)
    const tpl = new TextEncoder().encode(canon)
    const off = canon.indexOf('NNNNNNNN')
    const miner = globalThis.makeMiner(tpl, off, 8)
    // cross-check digest vs node:crypto
    const chk = miner.digestHex(0x1234abcd); const ref = crypto.createHash('sha256').update(canon.replace('NNNNNNNN', '1234abcd')).digest('hex')
    console.log(`\n=== preimage: ${nParents} parent(s), canonical(e) = ${tpl.length} bytes = ${miner.blocks} SHA-256 blocks ; digest cross-check vs node:crypto: ${chk === ref ? 'OK' : 'MISMATCH'} ===`)
    const stat = (arr) => { const a = [...arr].sort((x, y) => x - y); const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))]; return { n: a.length, mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2), median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +a[a.length - 1].toFixed(2) } }
    for (const bits of [14, 16]) {
      const N = bits === 14 ? 400 : 150
      // (1) native node:crypto
      const tN = []; const hN = []
      for (let i = 0; i < N; i++) {
        let n = (Math.random() * 2 ** 32) >>> 0; let k = 0; const t0 = performance.now()
        for (;;) { k++; const s = canon.replace('NNNNNNNN', n.toString(16).padStart(8, '0')); const d = crypto.createHash('sha256').update(s).digest(); if (((d.readUInt32BE(0)) >>> (32 - bits)) === 0) break; n = (n + 1) >>> 0 }
        tN.push(performance.now() - t0); hN.push(k)
      }
      // (2) pure JS single thread
      const tJ = []; const hJ = []
      for (let i = 0; i < N; i++) { const t0 = performance.now(); const k = miner.mine(bits, (Math.random() * 2 ** 32) >>> 0, 1e9); tJ.push(performance.now() - t0); hJ.push(k) }
      const sumH = (a) => a.reduce((s, x) => s + x, 0); const sumT = (a) => a.reduce((s, x) => s + x, 0)
      console.log(`bits=${bits} (expected ${2 ** bits} hashes)`)
      console.log(`   node:crypto 1 thread : ms ${JSON.stringify(stat(tN))}  mean hashes ${Math.round(sumH(hN) / N)}  rate ${(sumH(hN) / (sumT(tN) / 1000) / 1e6).toFixed(3)} MH/s`)
      console.log(`   pure-JS     1 thread : ms ${JSON.stringify(stat(tJ))}  mean hashes ${Math.round(sumH(hJ) / N)}  rate ${(sumH(hJ) / (sumT(tJ) / 1000) / 1e6).toFixed(3)} MH/s`)
      results.push({ nParents, bits, native: stat(tN), js: stat(tJ) })
    }
  }
  process.exit(0)
}
