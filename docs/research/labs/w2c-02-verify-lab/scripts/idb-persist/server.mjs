import http from 'node:http'; import { readFile } from 'node:fs/promises';
const [,, port, file] = process.argv; const html = await readFile(file);
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(html); }).listen(Number(port), '127.0.0.1', () => console.log('listening', port));
