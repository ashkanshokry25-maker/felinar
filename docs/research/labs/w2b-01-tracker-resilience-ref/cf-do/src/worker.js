// worker.js - WebTorrent-protocol WebSocket tracker on Cloudflare Workers + Durable Objects (Hibernation API). PROTOTYPE.
// One Durable Object per swarm. The stock WebTorrent client multiplexes every torrent of one tracker URL over ONE socket, and
// a socket can terminate in only one Durable Object, so the URL carries the swarm:  wss://<worker>/<40-hex info hash>
// (the loader controls `tr=`, so this costs nothing). Peer state lives ONLY in WebSocket attachments, so it survives hibernation.
import { DurableObject } from 'cloudflare:workers'

const INTERVAL_S = 120
const MAX_OFFERS = 10
const MAX_SDP = 16 * 1024
const MAX_MESSAGE = 64 * 1024
const MAX_SOCKETS = 500
const BIN20 = /^[\x00-\xff]{20}$/
const isBin20 = (s) => typeof s === 'string' && BIN20.test(s)
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o)
const hex = (bin) => Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')

function validate (msg) {
  if (!isObj(msg)) return 'not an object'
  if (msg.action === 'scrape') return 'scrape is disabled'
  if (msg.action !== 'announce') return 'invalid action'
  if (!isBin20(msg.info_hash)) return 'invalid info_hash'
  if (!isBin20(msg.peer_id)) return 'invalid peer_id'
  if (msg.offers !== undefined) {
    if (!Array.isArray(msg.offers) || msg.offers.length > MAX_OFFERS) return 'too many offers'
    for (const o of msg.offers) {
      if (!isObj(o) || !isBin20(o.offer_id) || !isObj(o.offer) || o.offer.type !== 'offer' || typeof o.offer.sdp !== 'string' || o.offer.sdp.length > MAX_SDP) return 'invalid offer'
    }
  }
  if (msg.answer !== undefined) {
    if (!isObj(msg.answer) || msg.answer.type !== 'answer' || typeof msg.answer.sdp !== 'string' || msg.answer.sdp.length > MAX_SDP) return 'invalid answer'
    if (!isBin20(msg.to_peer_id) || !isBin20(msg.offer_id)) return 'answer needs to_peer_id and offer_id'
  }
  return null
}
const fail = (ws, why) => { try { ws.send(JSON.stringify({ 'failure reason': why })) } catch (_) { /* closed */ } }

export default {
  async fetch (request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') return new Response('ok\n')
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('WebSocket only\n', { status: 426 })
    const room = url.pathname.slice(1).toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(room)) return new Response('path must be a 40-hex info hash\n', { status: 400 })
    const allow = (env.ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (allow.length && !allow.includes(request.headers.get('Origin'))) return new Response('origin not allowed\n', { status: 403 })
    const stub = env.SWARM.get(env.SWARM.idFromName(room))
    return stub.fetch(request)
  }
}

export class Swarm extends DurableObject {
  constructor (ctx, env) {
    super(ctx, env)
    console.log('Swarm constructed (cold start or wake from hibernation)')
  }

  async fetch (request) {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('swarm full\n', { status: 503 })
    const room = new URL(request.url).pathname.slice(1).toLowerCase()
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ room, peerId: null, complete: false })
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage (ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return ws.close(1009, 'message too big')
    let msg
    try { msg = JSON.parse(data) } catch (_) { return fail(ws, 'invalid json') }
    const bad = validate(msg)
    if (bad) return fail(ws, bad)
    const att = ws.deserializeAttachment() || {}
    if (hex(msg.info_hash) !== att.room) return fail(ws, 'info_hash does not match this endpoint')
    if (att.peerId && att.peerId !== msg.peer_id) return fail(ws, 'peer_id changed on this connection')

    const stopped = msg.event === 'stopped'
    ws.serializeAttachment({ room: att.room, peerId: stopped ? null : msg.peer_id, complete: msg.left === 0 })

    // Collect the other announced peers (state is read from attachments: hibernation-safe).
    let complete = 0; let incomplete = 0
    const others = []
    for (const p of this.ctx.getWebSockets()) {
      const a = p.deserializeAttachment()
      if (!a || !a.peerId) continue
      if (a.complete) complete++; else incomplete++
      if (p !== ws) others.push({ p, a })
    }

    if (msg.answer) {
      const target = others.find((o) => o.a.peerId === msg.to_peer_id)
      if (target) target.p.send(JSON.stringify({ action: 'announce', answer: msg.answer, offer_id: msg.offer_id, peer_id: msg.peer_id, info_hash: msg.info_hash }))
      return // like the reference tracker: no reply to an answer
    }
    if (stopped) return
    ws.send(JSON.stringify({ action: 'announce', interval: INTERVAL_S, info_hash: msg.info_hash, complete, incomplete }))
    if (msg.offers && msg.offers.length) {
      // random distinct recipients (partial Fisher-Yates)
      const n = Math.min(msg.offers.length, others.length)
      for (let i = 0; i < n; i++) {
        const j = i + Math.floor(Math.random() * (others.length - i));
        [others[i], others[j]] = [others[j], others[i]]
        others[i].p.send(JSON.stringify({ action: 'announce', offer: msg.offers[i].offer, offer_id: msg.offers[i].offer_id, peer_id: msg.peer_id, info_hash: msg.info_hash }))
      }
    }
  }

  webSocketClose (ws, code, reason) {
    try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000, reason) } catch (_) { /* already closed */ }
  }

  webSocketError (ws) {
    try { ws.close(1011, 'error') } catch (_) { /* gone */ }
  }
}
