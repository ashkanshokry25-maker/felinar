// Query relay.nostr.watch for NIP-66 relay-liveness events (kind 30166) of the relays we may rely on.
import WebSocket from 'ws'
const relays = process.argv.slice(2)
const ws = new WebSocket('wss://relay.nostr.watch')
const events = []
ws.on('open', () => {
  ws.send(JSON.stringify(['REQ', 'a', { kinds: [30166], '#d': relays, limit: 200 }]))
  ws.send(JSON.stringify(['REQ', 'b', { kinds: [10166], limit: 20 }]))
})
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m[0] === 'EVENT') events.push(m)
  if (m[0] === 'EOSE' && m[1] === 'a') setTimeout(() => ws.close(), 3000)
})
function summarize () {
  const by = {}
  let monitors = new Set()
  for (const [, sub, ev] of events) {
    if (sub === 'b') { monitors.add(ev.pubkey.slice(0, 8)); continue }
    const tag = (n) => (ev.tags.find((t) => t[0] === n) || [])[1]
    const d = tag('d')
    const rec = { created: new Date(ev.created_at * 1000).toISOString(), monitor: ev.pubkey.slice(0, 8), rttOpen: tag('rtt-open'), rttRead: tag('rtt-read'), rttWrite: tag('rtt-write'), R: ev.tags.filter((t) => t[0] === 'R').map((t) => t[1]), net: tag('n'), kinds: ev.tags.filter((t) => t[0] === 'k').length }
    ;(by[d] ||= []).push(rec)
  }
  for (const [d, recs] of Object.entries(by)) {
    recs.sort((a, b) => b.created.localeCompare(a.created))
    console.log(d, 'events:', recs.length, 'newest:', recs[0].created, 'monitors:', new Set(recs.map((r) => r.monitor)).size, '| rtt-open ms (newest 5):', recs.slice(0, 5).map((r) => r.rttOpen).join(','), '| R:', JSON.stringify(recs[0].R), '| kinds tags:', recs[0].kinds)
  }
  console.log('monitor announcements (kind 10166) seen:', monitors.size, '| total events', events.length)
  process.exit(0)
}
ws.on('close', summarize)
ws.on('error', (e) => { console.log('error', e.message); process.exit(1) })
setTimeout(summarize, 20000)
