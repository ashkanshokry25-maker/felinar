// Negentropy sync cost simulation using the reference JS implementation (hoytech/negentropy js/Negentropy.js), both sides local.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const { Negentropy, NegentropyStorageVector } = require(process.argv[2] || './Negentropy.js');
function mkItems(n) { const t0 = 1_790_000_000; let t = t0; const items = []; const seen = new Set();
  for (let i = 0; i < n; i++) { t += Math.floor(-Math.log(1 - Math.random()) * 300); const id = randomBytes(32).toString('hex'); items.push({ ts: t, id }); }
  return items; }
async function sim(name, serverItems, clientItems, frame) {
  const mk = (items) => { const s = new NegentropyStorageVector(); for (const it of items) s.insert(it.ts, it.id); s.seal(); return s; };
  const cli = new Negentropy(mk(clientItems), frame), srv = new Negentropy(mk(serverItems), frame);
  let msg = await cli.initiate(); let up = msg.length / 2, down = 0, rounds = 0; const have = new Set(), need = new Set();
  const t0 = performance.now();
  while (msg !== null) {
    const [resp] = await srv.reconcile(msg); rounds++;
    if (resp === null) break; down += resp.length / 2;
    const [newMsg, h, n] = await cli.reconcile(resp);
    for (const x of h) have.add(x); for (const x of n) need.add(x);
    msg = newMsg; if (msg !== null) up += msg.length / 2;
  }
  const ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ name, server: serverItems.length, client: clientItems.length, frame: frame || 'unlimited', rounds, up_bytes: Math.round(up), down_bytes: Math.round(down), total_bytes: Math.round(up + down), hex_wire_bytes: Math.round((up + down) * 2), client_has_server_lacks: have.size, client_needs: need.size, naive_all_ids_bytes: serverItems.length * 32, ms }));
}
const N = 12000; const all = mkItems(N);
for (const frame of [0, 50000]) {
  await sim('A fresh visitor (0 of N)', all, [], frame);
  await sim('B returning, missing newest 1000', all, all.slice(0, N - 1000), frame);
  await sim('C returning, missing newest 50', all, all.slice(0, N - 50), frame);
  const lacking = new Set(); while (lacking.size < 200) lacking.add(Math.floor(Math.random() * N));
  await sim('D pinner(12000) vs relay lacking 200 random', all, all.filter((_, i) => !lacking.has(i)), frame);   // client=relay's set, server=pinner... (symmetry: roles swapped for cost)
}
await sim('E small ledger fresh (1000)', all.slice(0, 1000), [], 0);
await sim('F identical sets (12000)', all, all, 0);
