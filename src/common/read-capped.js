// Bounded HTTP body reads (code review round 1): a response is read with a stream reader and given up
// as soon as it is longer than the cap, instead of buffering whatever a host sends before checking.

/**
 * readCappedBody(res, maxBytes) → Promise<Uint8Array | null>: the response body, or null (and the
 * stream cancelled) as soon as it is longer than maxBytes. A declared Content-Length above the cap is
 * refused before reading; a body without a stream reader is read whole and then checked.
 */
export async function readCappedBody(res, maxBytes) {
  const declared = Number(res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    } catch (_) { /* ignore */ }
    return null;
  }
  const reader = res && res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > maxBytes ? null : whole;
  }
  return readStreamCapped(reader, maxBytes);
}

/** readStreamCapped(reader, maxBytes) → Promise<Uint8Array | null>: a ReadableStream reader's bytes, or null past the cap. */
export async function readStreamCapped(reader, maxBytes) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch (_) { /* ignore */ }
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
