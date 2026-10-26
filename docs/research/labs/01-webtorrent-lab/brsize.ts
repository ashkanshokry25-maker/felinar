import { brotliCompressSync, gzipSync, constants } from 'node:zlib'
for (const f of Deno.args) {
  const data = await Deno.readFile(f)
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } })
  const gz = gzipSync(data, { level: 9 })
  console.log(f.split('/').slice(-2).join('/'), 'raw', data.length, 'gzip9', gz.length, 'brotli11', br.length)
}
