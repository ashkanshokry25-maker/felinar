// w1-13 B1: build our own browser bundle of webtorrent 3.0.21 with esbuild (what webtorrent/scripts/browser.webpack.js does with webpack).
// Usage: node docs/research/labs/w1-13-lab/b1-build.mjs <variant> [--target=floor] [--patch] [--slim]  -> out/wt-<variant>.js (+ metafile)
import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const labNM = here + 'node_modules/'
const variant = process.argv[2] ?? 'plain'
const flags = new Set(process.argv.slice(3))
const FLOOR = ['es2020', 'safari15.4', 'chrome110', 'firefox115'] // ARCHITECTURE.md section 10
mkdirSync(here + 'out', { recursive: true })

// ---------- source patches (each must match exactly once or the build fails) ----------
const patches = [
  { file: '/node_modules/bittorrent-protocol/index.js', name: 'wire message-length cap',
    from: `  _onMessageLength (buffer) {
    const length = getUint32(buffer)
    if (length > 0) {`,
    to: `  _onMessageLength (buffer) {
    const length = getUint32(buffer)
    if (length > 262144 + 64) { this.destroy(new Error('message too large')); return } // MW patch: cap (BitTorrent block = 16 KiB + 9; data-channel limit 256 KiB)
    if (length > 0) {` },
  { file: '/node_modules/webtorrent/lib/webconn.js', name: 'web seed: no preflight-triggering headers',
    from: `          headers: {
            'Cache-Control': 'no-store',
            'user-agent': \`WebTorrent/\${VERSION} (https://webtorrent.io)\`,
            range: \`bytes=\${start}-\${end}\`
          },`,
    to: `          headers: {
            range: \`bytes=\${start}-\${end}\`
          },` },
  { file: '/node_modules/webtorrent/lib/torrent.js', name: 'xs fetch: no user-agent header',
    from: `        headers: {
          'user-agent': self.client.userAgent
        },
        signal`,
    to: `        signal` },
  { file: '/node_modules/webtorrent/lib/webconn.js', name: 'web seed: in-file range end (upstream mixes absolute and relative offsets)', flag: '--padfix',
    from: `          end: Math.min(fileEnd, rangeEnd - requestedFile.offset)`,
    to: `          end: Math.min(requestedFile.length - 1, rangeEnd - requestedFile.offset)` },
  { file: '/node_modules/webtorrent/lib/webconn.js', name: 'web seed: synthesize BEP 47 .pad/<n> files as zeros', flag: '--padfix',
    from: `        const res = await fetch(url, {`,
    to: `        if (url.includes('/.pad/')) return new Uint8Array(end - start + 1) // MW patch: BEP 47 padding file = zeros, never fetched
        const res = await fetch(url, {` },
  { file: '/node_modules/parse-torrent/index.js', name: 'torrent URL fetch: no user-agent header',
    from: `        headers: { 'user-agent': 'WebTorrent (https://webtorrent.io)' },
`,
    to: `` }
]
const applied = []
const patchPlugin = {
  name: 'mw-patches',
  setup (build) {
    build.onLoad({ filter: /\.js$/ }, args => {
      const p = patches.filter(x => args.path.endsWith(x.file) && (!x.flag || flags.has(x.flag)))
      if (!p.length) return null
      let src = readFileSync(args.path, 'utf8')
      for (const x of p) {
        if (src.split(x.from).length !== 2) throw new Error(`patch "${x.name}" did not match exactly once in ${args.path}`)
        src = src.replace(x.from, () => x.to); applied.push(x.name)
      }
      return { contents: src, loader: 'js' }
    })
  }
}

// ---------- webpack `alias: false` + polyfills ----------
const EMPTY = /^(net|fs|http|os|crypto|dgram|bittorrent-dht|ut_pex|@silentbot1\/nat-api|load-ip-set)$/
const shimPlugin = {
  name: 'wt-shims',
  setup (build) {
    build.onResolve({ filter: EMPTY }, args => ({ path: args.path, namespace: 'wt-empty' }))
    build.onLoad({ filter: /.*/, namespace: 'wt-empty' }, () => ({ contents: 'module.exports = {}', loader: 'js' }))
    build.onResolve({ filter: /^fs-chunk-store$/ }, () => flags.has('--slim')
      ? { path: 'fsa-stub', namespace: 'wt-stub' }
      : build.resolve('fsa-chunk-store', { kind: 'import-statement', resolveDir: root }))
    if (flags.has('--slim')) {
      // create-torrent is only used by client.seed(); the loader never seeds from files (it re-seeds verified stores)
      build.onResolve({ filter: /^create-torrent$/ }, () => ({ path: 'create-torrent-stub', namespace: 'wt-stub' }))
      // BrowserServer/NodeServer (client.createServer) is unusable for sites (see research 01) -> stub the module
      build.onResolve({ filter: /\/lib\/server\.js$/ }, () => ({ path: 'server-stub', namespace: 'wt-stub' }))
      build.onLoad({ filter: /^fsa-stub$/, namespace: 'wt-stub' }, () => ({ contents: 'export default class NoDefaultStore { constructor () { throw new Error("no default chunk store: pass opts.store or opts.preloadedStore") } }', loader: 'js' }))
      build.onLoad({ filter: /^create-torrent-stub$/, namespace: 'wt-stub' }, () => ({ contents: 'export default function createTorrent () { throw new Error("create-torrent excluded from this build") }\nexport const parseInput = createTorrent', loader: 'js' }))
      build.onLoad({ filter: /^server-stub$/, namespace: 'wt-stub' }, () => ({ contents: 'export class NodeServer {}\nexport class BrowserServer {}', loader: 'js' }))
    }
  }
}

const t0 = Date.now()
const result = await esbuild.build({
  stdin: { contents: "export { default } from 'webtorrent'", resolveDir: root, loader: 'js', sourcefile: 'entry.js' },
  bundle: true, format: 'esm', platform: 'browser', minify: true, legalComments: 'none', metafile: true,
  target: flags.has('--target=floor') ? FLOOR : 'esnext',
  alias: { events: labNM + 'events/events.js', path: labNM + 'path-esm/index.js', ...(flags.has('--nodebug') ? { debug: here + 'debug-noop.js' } : {}) },
  inject: [here + 'process-shim.js'],
  define: { global: 'globalThis' },
  plugins: [shimPlugin, ...(flags.has('--patch') ? [patchPlugin] : [])],
  outfile: here + `out/wt-${variant}.js`, logLevel: 'warning', write: true
})
const bytes = readFileSync(here + `out/wt-${variant}.js`)
const gz = gzipSync(bytes, { level: 9 }).length
const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
// per-package byte attribution from the metafile
const outKey = Object.keys(result.metafile.outputs)[0]
const per = new Map()
for (const [file, info] of Object.entries(result.metafile.outputs[outKey].inputs)) {
  const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)
  const pkg = m ? m[m.length - 1].replace('node_modules/', '').replace(/\/$/, '') : '(app)'
  per.set(pkg, (per.get(pkg) ?? 0) + info.bytesInOutput)
}
const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`)
writeFileSync(here + `out/wt-${variant}.meta.json`, JSON.stringify(result.metafile))
console.log(JSON.stringify({ variant, flags: [...flags], buildMs: Date.now() - t0, rawBytes: bytes.length, gzip9: gz, brotli11: br, patchesApplied: applied, warnings: result.warnings.length, topPackagesByOutputBytes: top }, null, 1))
