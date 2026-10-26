// Real P-256 keys and signed hub directory entries for the social example's tests, in the format js/directory.js checks: the person signs
// "mw-dir-v1\n" + canonical({ ledgerId, name, pointer, t }) with the owner key of their pointer, the hub countersigns
// "mw-dir-hub-v1\n" + canonical({ ledgerId, name, pointer, sig, t }). WebCrypto of Node; ASCII only; not a test file.
import { webcrypto } from 'node:crypto';
import { recordText, hubText } from '../../examples/social/js/directory.js';
import { parsePointerText, ledgerIdFromPointer } from '../../examples/social/js/hub.js';
import { hubLabelFor } from '../../examples/social/js/ids.js';

const subtle = webcrypto.subtle;
const b64url = (u8) => Buffer.from(u8).toString('base64url');

/** newKey() -> { pub: 'p256:...', privateKey }: a fresh ECDSA P-256 key pair. */
export async function newKey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pub: 'p256:' + b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), privateKey: pair.privateKey };
}

/** sign(keys, text) -> base64url of the 64-byte signature. */
export async function sign(keys, text) {
  return b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(text))));
}

/** pointerOf(pub, n) -> { pointer, id, label }: a signed-looking record whose owner is pub (the pointer's own sig is checked at follow, not here). */
export function pointerOf(pub, n) {
  const pointer = 'v=mw1; btih=0123456789abcdef0123456789abcdef01234567; owner=' + pub + '; chain=dir' + String(n).padStart(19, '0') + '; seq=3; exp=1900000000; sig=' + 'S'.repeat(86);
  const id = ledgerIdFromPointer(parsePointerText(pointer));
  return { pointer, id, label: hubLabelFor(id) };
}

/** entry(record, person, hub) -> the record with sig (by person) and hubSig (by hub). */
export async function entry(record, person, hub) {
  const e = Object.assign({}, record);
  e.sig = await sign(person, recordText(e));
  e.hubSig = await sign(hub, hubText(e));
  return e;
}
