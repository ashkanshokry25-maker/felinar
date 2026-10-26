// Does Yjs's default GC make "load into a Y.Doc and re-encode" (what y-indexeddb's trim does) lossy for deleted content?
const Y = await import(process.argv[2]);
const run = (gc) => {
  const d = new Y.Doc({ gc }); const updates = []; d.on('update', (u) => updates.push(u));
  const t = d.getText('t');
  t.insert(0, 'secret-'.repeat(5000));          // 35,000 chars
  t.delete(0, 35000);                            // delete it all
  t.insert(0, 'visible');
  const merged = Y.mergeUpdates(updates);        // L0: mergeUpdates (what the docs say does not GC)
  const re = new Y.Doc({ gc }); Y.applyUpdate(re, merged);
  const reencoded = Y.encodeStateAsUpdate(re);   // what y-indexeddb stores when it trims
  const hasSecret = (u) => Buffer.from(u).toString('latin1').includes('secret-');
  return { gc, updatesBytes: updates.reduce((a, u) => a + u.length, 0), mergedBytes: merged.length, mergedContainsDeletedText: hasSecret(merged), reencodedBytes: reencoded.length, reencodedContainsDeletedText: hasSecret(reencoded), text: re.getText('t').toString() };
};
console.log(JSON.stringify([run(true), run(false)], null, 1));
