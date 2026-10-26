import { verifyBlock, verifySigOnly } from '/verify-core.js';
self.onmessage = async (ev) => {
  const { id, blocks, mode, conc } = ev.data;
  const fn = mode === 'sig' ? verifySigOnly : verifyBlock;
  let ok = 0, bad = 0;
  for (let i = 0; i < blocks.length; i += conc) {
    const r = await Promise.all(blocks.slice(i, i + conc).map(fn));
    for (const x of r) x === 'ok' ? ok++ : bad++;
  }
  self.postMessage({ id, ok, bad });
};
