import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const dir = process.argv[2];
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const nfc = 'café.html', nfd = 'café.html';
// create the file with an NFD name, then try to create the NFC-named one
fs.writeFileSync(path.join(dir, nfd), 'written-as-NFD');
let second = 'created';
try { fs.writeFileSync(path.join(dir, nfc), 'written-as-NFC', { flag: 'wx' }); } catch (e) { second = 'error ' + e.code; }
const names = fs.readdirSync(dir);
console.log('platform', os.platform(), os.release());
console.log('second write (NFC after NFD, wx):', second);
console.log('readdir count:', names.length);
for (const n of names) console.log(' readdir name codepoints:', [...n].map(c => c.codePointAt(0).toString(16)).join(' '), '| isNFC:', n === n.normalize('NFC'), '| isNFD:', n === n.normalize('NFD'));
// case sensitivity
fs.writeFileSync(path.join(dir, 'Readme.txt'), 'a');
let cs = 'created';
try { fs.writeFileSync(path.join(dir, 'README.txt'), 'b', { flag: 'wx' }); } catch (e) { cs = 'error ' + e.code; }
console.log('case-colliding create (README.txt after Readme.txt):', cs, '| readdir:', fs.readdirSync(dir).filter(n => /readme/i.test(n)));
