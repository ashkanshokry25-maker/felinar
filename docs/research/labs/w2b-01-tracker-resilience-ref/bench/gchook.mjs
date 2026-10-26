// Preloaded with `node --expose-gc --import ./gchook.mjs <script>`: on SIGUSR2 force two GCs and print retained memory.
process.on('SIGUSR2', () => {
  global.gc(); global.gc()
  const m = process.memoryUsage()
  process.stdout.write(JSON.stringify({ msg: 'mem', rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers }) + '\n')
})
