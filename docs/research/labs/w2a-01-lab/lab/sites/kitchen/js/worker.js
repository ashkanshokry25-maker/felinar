// classic worker created with a ROOT-ABSOLUTE url
(async () => {
  const out = { loc: self.location.pathname };
  try { out.fetchAbs = await (await fetch('/data/abs.json')).json(); } catch (e) { out.fetchAbs = 'ERR ' + e.message; }
  try { importScripts('/js/imp.js'); out.importScripts = self.__imp || 'ran-no-global'; } catch (e) { out.importScripts = 'ERR ' + e.message; }
  postMessage(out);
})();
