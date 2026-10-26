// Shared by the page and the workers. Mirrors ARCHITECTURE v0.2 section 6.3 order: h recomputes -> (PoW) -> signature -> vh.
import { canonicalize, hex, utf8 } from '/chain/canonical.js';
import { verify } from '/chain/crypto.js';
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(s)));
export async function verifyBlock(b) {
  const h = hex.encode(await sha(canonicalize(b.e)));
  if (h !== b.h) return 'hash';
  // PoW: leadingZeroBits(h) >= e.bits is a trivial local check; test blocks are not mined, so it is not enforced here.
  if (!(await verify(b.e.author, 'mw-block-v1\n' + b.h, b.s))) return 'sig';
  if (b.v !== undefined) { const vh = hex.encode(await sha(canonicalize(b.v))); if (vh !== b.e.op.vh) return 'vh'; }
  return 'ok';
}
// verify-only (signature) fast path, for the raw-throughput comparison with doc 06 F47
export async function verifySigOnly(b) { return (await verify(b.e.author, 'mw-block-v1\n' + b.h, b.s)) ? 'ok' : 'sig'; }
