#!/usr/bin/env node
// little-calc.mjs - Little's-law calculator and a simple P2P offload model for magnet-web (w2c-07).
// Pure ESM, no dependencies, Node >= 22. All numbers it prints are MODEL OUTPUTS, not measurements.
//
//   node little-calc.mjs --visits 3000 --dwell 60 [--shape 0.6] [--consent 0.3] [--policy 0.35]
//        [--connect 0.8] [--ready 3] [--peak 1.9] [--size 20] [--webseed 8] [--peer 1] [--setup 2]
//   node little-calc.mjs --tables        tables used in docs/research/w2c-07-incentives-economics.md
//   node little-calc.mjs --montecarlo    simulation check of the Poisson claim (homogeneous + diurnal)
//   node little-calc.mjs --help
//
// Maths (all standard; see the research note for sources):
//   Little's law:  L = lambda * W            (L visitors online on average, lambda arrivals/s, W mean dwell s)
//   M/G/infinity:  with Poisson arrivals the number online is Poisson(lambda * E[S]) for ANY dwell distribution
//                  (insensitivity), so P(alone on arrival) = exp(-L) by PASTA.
//   Eligible seeders are a thinned Poisson stream: rate p * lambda, each contributing E[(S - t_ready)^+] seconds,
//   so seeders online ~ Poisson(a_seed), a_seed = lambda * p * E[(S - t_ready)^+].
//   Offload of one download of B MiB when k eligible peers are online and the web seed runs in parallel:
//   the web seed delivers min(rw, link)*t_setup alone, the remaining bytes split in proportion rw : k*u.

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const DAY = 86400

// ---------- small numeric helpers ----------
export function lgamma (x) { // Lanczos approximation (g = 7, n = 9), accurate to ~1e-13 for x > 0
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}
export const gamma = (x) => Math.exp(lgamma(x))

export function poissonPmf (k, mean) {
  if (mean === 0) return k === 0 ? 1 : 0
  return Math.exp(k * Math.log(mean) - mean - lgamma(k + 1))
}
export function poissonCdf (k, mean) { let s = 0; for (let i = 0; i <= k; i++) s += poissonPmf(i, mean); return Math.min(1, s) }
export function poissonQuantile (p, mean) { let k = 0; let c = poissonPmf(0, mean); while (c < p && k < 1e6) { k++; c += poissonPmf(k, mean) } return k }

// ---------- dwell-time model: Weibull with shape < 1 = "negative aging" (Liu, White, Dumais 2010) ----------
export function weibullFromMean (mean, shape = 0.6) { return { shape, scale: mean / gamma(1 + 1 / shape), mean } }
export const weibullSurvival = (d, s) => Math.exp(-Math.pow(s / d.scale, d.shape))
export const weibullMedian = (d) => d.scale * Math.pow(Math.LN2, 1 / d.shape)
// E[(S - t)^+] = integral from t to infinity of P(S > s) ds, composite Simpson on [t, sMax]
export function meanResidualAfter (d, t) {
  if (t <= 0) return d.mean
  const sMax = d.scale * Math.pow(30, 1 / d.shape) // survival < e^-30
  if (t >= sMax) return 0
  const n = 200000 // even
  const h = (sMax - t) / n
  let sum = weibullSurvival(d, t) + weibullSurvival(d, sMax)
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * weibullSurvival(d, t + i * h)
  return sum * h / 3
}

// ---------- core model ----------
export function offeredLoad (visitsPerDay, meanDwellS) { return visitsPerDay * meanDwellS / DAY } // Little: L = lambda W

/** Expected eligible seeders online: a_seed = lambda * p * E[(S - t_ready)^+]. */
export function seederLoad ({ visitsPerDay, meanDwellS, shape = 0.6, consent, policy, connect, readyS = 3 }) {
  const d = weibullFromMean(meanDwellS, shape)
  const seedTime = meanResidualAfter(d, readyS)
  const p = consent * policy * connect
  return { a: offeredLoad(visitsPerDay, meanDwellS), p, seedTimeFactor: seedTime / meanDwellS, aSeed: visitsPerDay / DAY * p * seedTime, dist: d }
}

/** Fraction of one download's bytes that come from peers when k eligible peers are online (web seed in parallel). */
export function offloadFraction ({ sizeMiB, webseedMiBps, peerMiBps, setupS, k }) {
  if (k <= 0) return 0
  const pre = webseedMiBps * setupS // web seed alone before the first peer wire is usable
  if (pre >= sizeMiB) return 0
  const remaining = sizeMiB - pre
  const share = (k * peerMiBps) / (webseedMiBps + k * peerMiBps)
  return remaining * share / sizeMiB
}
export function expectedOffload (aSeed, params) {
  const kMax = Math.max(60, Math.ceil(aSeed + 12 * Math.sqrt(aSeed + 1)))
  let e = 0
  for (let k = 0; k <= kMax; k++) e += poissonPmf(k, aSeed) * offloadFraction({ ...params, k })
  return e
}

export const SCENARIOS = { // p = consent * policy * connect; every value is an ASSUMPTION with the evidence named in the note
  pessimistic: { consent: 0.05, policy: 0.12, connect: 0.70 }, // notice ignored (Utz 5.5%), mobile-heavy site (fa.wikipedia 12% desktop)
  baseline: { consent: 0.30, policy: 0.35, connect: 0.80 }, // Utz mid-range, en/de.wikipedia desktop share, STUN-only ~80%
  optimistic: { consent: 0.90, policy: 0.60, connect: 0.85 } // default-on after notice (NetSession ~98% keep default), desktop-heavy audience
}

// ---------- output ----------
const f2 = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2))
const pct = (x) => (100 * x).toFixed(x < 0.01 ? 2 : x < 0.1 ? 1 : 0) + '%'
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def }
const has = (name) => process.argv.includes('--' + name)

function oneScenario () {
  const V = arg('visits', 3000); const S = arg('dwell', 60); const shape = arg('shape', 0.6)
  const consent = arg('consent', SCENARIOS.baseline.consent); const policy = arg('policy', SCENARIOS.baseline.policy)
  const connect = arg('connect', SCENARIOS.baseline.connect); const ready = arg('ready', 3); const peak = arg('peak', 1.9)
  const size = arg('size', 20); const ws = arg('webseed', 8); const peer = arg('peer', 1); const setup = arg('setup', 2)
  const r = seederLoad({ visitsPerDay: V, meanDwellS: S, shape, consent, policy, connect, readyS: ready })
  console.log(`visits/day ${V}, mean dwell ${S}s (Weibull shape ${shape}, median ${weibullMedian(r.dist).toFixed(1)}s)`)
  console.log(`E[N] visitors online (Little)      : ${f2(r.a)}     peak-hour (x${peak}): ${f2(r.a * peak)}`)
  console.log(`P(alone on arrival) = e^-E[N]       : ${pct(Math.exp(-r.a))}   at peak hour: ${pct(Math.exp(-r.a * peak))}`)
  console.log(`eligible fraction p                 : ${r.p.toFixed(3)} (consent ${consent} x policy ${policy} x connect ${connect}); seeding-time factor ${r.seedTimeFactor.toFixed(2)}`)
  console.log(`a_seed (eligible seeders online)    : ${f2(r.aSeed)}     P(no seeder online): ${pct(Math.exp(-r.aSeed))}   P(>=3 seeders): ${pct(1 - poissonCdf(2, r.aSeed))}`)
  const o = { sizeMiB: size, webseedMiBps: ws, peerMiBps: peer, setupS: setup }
  console.log(`expected offload, ${size} MiB site    : ${pct(expectedOffload(r.aSeed, o))}  (web seed ${ws} MiB/s, peers ${peer} MiB/s each, first wire after ${setup}s)`)
  console.log(`at peak hour (x${peak})               : a_seed ${f2(r.aSeed * peak)}, P(no seeder) ${pct(Math.exp(-r.aSeed * peak))}, expected offload ${pct(expectedOffload(r.aSeed * peak, o))}`)
}

function tables () {
  const dwells = [20, 60, 180, 600]
  const visits = [100, 1000, 10000, 100000, 1000000]
  console.log('T1. Little\'s law: mean visitors online E[N] = visits/day x mean dwell / 86400, and P(alone on arrival) = e^-E[N]')
  console.log('visits/day   ' + dwells.map(d => `dwell ${d}s`.padStart(18)).join(''))
  for (const V of visits) console.log(String(V).padEnd(13) + dwells.map(d => `${f2(offeredLoad(V, d))} (${pct(Math.exp(-offeredLoad(V, d)))})`.padStart(18)).join(''))
  console.log('\nT2. Eligible seeders online (a_seed), mean dwell 60 s, Weibull shape 0.6, ready after 3 s; and daily visits needed for a_seed = 25')
  console.log('scenario      p        seedTime   ' + visits.map(v => `V=${v}`.padStart(11)).join('') + '   visits/day for a_seed=25')
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    const row = visits.map(V => seederLoad({ visitsPerDay: V, meanDwellS: 60, ...sc }))
    const unit = seederLoad({ visitsPerDay: 1, meanDwellS: 60, ...sc }).aSeed // a_seed is linear in visits
    console.log(name.padEnd(14) + row[0].p.toFixed(4).padEnd(9) + row[0].seedTimeFactor.toFixed(2).padEnd(11) + row.map(r => f2(r.aSeed).padStart(11)).join('') + String(Math.round(25 / unit)).padStart(26))
  }
  console.log('\nT3. Expected share of bytes from peers (model), web seed 8 MiB/s, peers 1 MiB/s each, first peer wire after 2 s')
  const sizes = [2, 5, 20, 50, 128]; const aS = [0.1, 1, 3, 10, 30, 100]
  console.log('site MiB   ' + aS.map(a => `a_seed=${a}`.padStart(12)).join(''))
  for (const B of sizes) console.log(String(B).padEnd(11) + aS.map(a => pct(expectedOffload(a, { sizeMiB: B, webseedMiBps: 8, peerMiBps: 1, setupS: 2 })).padStart(12)).join(''))
  console.log('\nT3b. Same, but a slow or distant web-seed path (2 MiB/s effective): peers matter more when the host path is slow')
  console.log('site MiB   ' + aS.map(a => `a_seed=${a}`.padStart(12)).join(''))
  for (const B of sizes) console.log(String(B).padEnd(11) + aS.map(a => pct(expectedOffload(a, { sizeMiB: B, webseedMiBps: 2, peerMiBps: 1, setupS: 2 })).padStart(12)).join(''))
  console.log('\nT4. Egress and list-price savings per month (30 days), baseline scenario, CloudFront list $0.085/GB (first 10 TB)')
  console.log('visits/day  site MiB  egress GB/mo  a_seed   offload   saved GB/mo   saved $/mo')
  for (const [V, B] of [[1000, 5], [10000, 5], [100000, 5], [10000, 50], [100000, 50], [100000, 500]]) {
    const r = seederLoad({ visitsPerDay: V, meanDwellS: 60, ...SCENARIOS.baseline })
    const off = expectedOffload(r.aSeed, { sizeMiB: B, webseedMiBps: 8, peerMiBps: 1, setupS: 2 })
    const gb = V * 30 * B / 1024
    console.log(String(V).padEnd(12) + String(B).padEnd(10) + gb.toFixed(0).padEnd(14) + f2(r.aSeed).padEnd(9) + pct(off).padEnd(10) + (gb * off).toFixed(1).padEnd(14) + '$' + (gb * off * 0.085).toFixed(2))
  }
  console.log('\nT5. What a mobile visitor pays to upload (price per GB from cable.co.uk 2023 edition; both directions count toward caps on most plans: assumption)')
  const prices = [['Israel (cheapest)', 0.02], ['Asia ex Near East avg', 1.10], ['global avg (2023)', 2.59], ['Sub-Saharan Africa avg', 3.31], ['Northern America avg', 4.59], ['Zimbabwe (dearest)', 43.75]]
  const ups = [5, 15, 50]
  console.log('region'.padEnd(26) + ups.map(u => `${u} MiB up`.padStart(12)).join('') + '   vs host saving at $0.085/GB')
  for (const [n, p] of prices) console.log(n.padEnd(26) + ups.map(u => ('$' + (u / 1024 * p).toFixed(4)).padStart(12)).join('') + `   visitor cost = ${(p / 0.085).toFixed(1)}x host saving`)
}

function montecarlo () {
  function rng (a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
  const run = (name, V, meanS, shape, days, phi, seed) => {
    const rand = rng(seed); const d = weibullFromMean(meanS, shape); const H = days * DAY
    const lam = V / DAY; const lamMax = lam * (phi > 1 ? phi : 1); const A = phi - 1 // rate(t) = lam*(1 + A cos(2 pi (t - tPeak)/DAY)), peak at 15:00
    const tPeak = 15 * 3600
    const arr = []; const dep = []; const dwell = []
    let t = 0
    for (;;) {
      t += -Math.log(1 - rand()) / lamMax; if (t >= H) break
      const keep = phi > 1 ? (1 + A * Math.cos(2 * Math.PI * (t - tPeak) / DAY)) / (1 + A) : 1
      if (rand() > keep) continue
      const S = d.scale * Math.pow(-Math.log(1 - rand()), 1 / d.shape)
      arr.push(t); dep.push(t + S); dwell.push(S)
    }
    const depS = Float64Array.from(dep).sort()
    // sample N(t) every 60 s after a 1 day warm-up; for diurnal runs also accumulate by hour of day
    const step = 60; let ia = 0; let id = 0
    const N = []; const byHour = Array.from({ length: 24 }, () => [])
    for (let g = DAY; g < H; g += step) {
      while (ia < arr.length && arr[ia] <= g) ia++
      while (id < depS.length && depS[id] <= g) id++
      const n = ia - id; N.push(n); byHour[Math.floor((g % DAY) / 3600)].push(n)
    }
    const mean = N.reduce((s, x) => s + x, 0) / N.length
    const varr = N.reduce((s, x) => s + (x - mean) ** 2, 0) / (N.length - 1)
    const p0 = N.filter(x => x === 0).length / N.length
    const sorted = Float64Array.from(dwell).sort(); const tot = sorted.reduce((s, x) => s + x, 0)
    const top = (q) => { const from = Math.floor(sorted.length * (1 - q)); let s = 0; for (let i = from; i < sorted.length; i++) s += sorted[i]; return s / tot }
    const out = { name, visits: arr.length, perDay: arr.length / days, theoryMean: V * meanS / DAY, simMean: mean, simVar: varr, fano: varr / mean, simP0: p0, theoryP0: Math.exp(-V * meanS / DAY), medianDwell: sorted[Math.floor(sorted.length / 2)], meanDwell: tot / sorted.length, top10Share: top(0.10), top1Share: top(0.01) }
    if (phi > 1) {
      const hm = byHour.map(a => a.reduce((s, x) => s + x, 0) / a.length)
      out.peakHourMeanOverDayMean = Math.max(...hm) / (hm.reduce((s, x) => s + x, 0) / 24)
      out.peakHourUtc = hm.indexOf(Math.max(...hm))
    }
    return out
  }
  const rows = [
    run('V=3000/day  dwell 60s k=0.6 homogeneous', 3000, 60, 0.6, 40, 1, 1),
    run('V=30000/day dwell 60s k=0.6 homogeneous', 30000, 60, 0.6, 20, 1, 2),
    run('V=300/day   dwell 20s k=0.5 homogeneous', 300, 20, 0.5, 80, 1, 3),
    run('V=30000/day dwell 60s k=0.6 diurnal phi=1.9', 30000, 60, 0.6, 20, 1.9, 4)
  ]
  for (const r of rows) console.log(JSON.stringify(r, (k, v) => typeof v === 'number' ? Number(v.toPrecision(5)) : v))
}

if (has('help')) console.log(process.argv[1] + ' --visits N --dwell S | --tables | --montecarlo')
else if (has('tables')) tables()
else if (has('montecarlo')) montecarlo()
else if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) oneScenario()
