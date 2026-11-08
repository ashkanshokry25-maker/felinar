// tools/door-kit-files.mjs: the host settings and README of a door kit (v0.3 C2 doors; tools/publish.mjs --door-kit). A module of its own,
// with no imports, so tools/verify-release.mjs can rebuild the exact bytes a kit must hold without loading publish's dependencies:
// `verify-release.mjs verify <kit> --door-kit` refuses a kit whose host settings differ from these (review round SEC-5).

/**
 * The host settings of a door kit (Netlify and Cloudflare Pages: _headers and _redirects; Vercel: vercel.json; Caddy: Caddyfile) and its README.
 * { version } alone is the kit of a signed release: publish --door-kit and verify-release --door-kit both call it that way and compare bytes.
 * { version, release: false, buildId, commit } is a hand-assembled kit of a build that has no signed list (8.2 audit C N3 and K-F3): the six
 * files are the same and only README-DOOR.txt differs, so it stops saying "as released" and stops sending the reader to a check that cannot
 * pass. It names the build id (required; the rule build.mjs applies in applyPlaceholders: 4 to 64 of 0-9, a-z and a hyphen) and, if given,
 * the commit (7 to 40 lowercase hex digits).
 */
export function doorKitFiles({ version = '', release = true, buildId = '', commit = '' } = {}) {
  const notRelease = release === false;
  if (notRelease && !/^[0-9a-z-]{4,64}$/.test(String(buildId))) throw new Error('doorKitFiles: a kit that is not a signed release needs its build id');
  if (commit && !/^[0-9a-f]{7,40}$/.test(String(commit))) throw new Error('doorKitFiles: commit is not a git commit id');
  const headers = [
    '# Door kit headers (Netlify and Cloudflare Pages read this file; GitHub Pages ignores it).',
    '# Every rule that matches a path applies, and Cloudflare Pages joins a header that two of them set ("*, *", which browsers',
    '# refuse), so each header is set once per path: /_mw/door.json takes Access-Control-Allow-Origin from the /_mw/* rule.',
    '/mw-sw.js',
    '  Content-Type: text/javascript; charset=utf-8',
    '  Cache-Control: no-cache',
    '/_mw/door.json',
    '  Cache-Control: no-cache',
    '/_mw/*',
    '  Access-Control-Allow-Origin: *',
    '  X-Content-Type-Options: nosniff',
    '/ws/*',
    '  Access-Control-Allow-Origin: *',
    '/*',
    '  Referrer-Policy: no-referrer',
    '',
  ].join('\n');
  const redirects = [
    '# The root of a door opens the door page; a link\'s fragment (#...) stays with the browser through the redirect.',
    '/ /_mw/open.html 302',
    '',
  ].join('\n');
  const vercel = JSON.stringify({
    cleanUrls: false,
    trailingSlash: false,
    redirects: [{ source: '/', destination: '/_mw/open.html', permanent: false }],
    headers: [
      { source: '/mw-sw.js', headers: [{ key: 'Content-Type', value: 'text/javascript; charset=utf-8' }, { key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/_mw/door.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/_mw/(.*)', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }, { key: 'X-Content-Type-Options', value: 'nosniff' }] },
      { source: '/ws/(.*)', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }] },
      { source: '/(.*)', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ],
  }, null, 2) + '\n';
  const caddy = [
    '# Door kit for Caddy 2 (automatic HTTPS). Set DOOR_HOST to the door\'s name and copy this folder to /srv/door.',
    '{$DOOR_HOST} {',
    '\troot * /srv/door',
    '\t@root path /',
    '\tredir @root /_mw/open.html 302',
    '\theader /mw-sw.js Cache-Control "no-cache"',
    '\theader /_mw/door.json Cache-Control "no-cache"',
    '\theader /_mw/* Access-Control-Allow-Origin "*"',
    '\theader /ws/* Access-Control-Allow-Origin "*"',
    '\theader Referrer-Policy "no-referrer"',
    '\tfile_server',
    '}',
    '',
  ].join('\n');
  // The opening and step 1 are all that differ (8.2 audit C N3 and K-F3). Without a signed list there is no check against one to point at:
  // the build id identifies the build, and step 1 says that building its source prints the same id (build.mjs prints it and documents that
  // builds are reproducible). That sentence is a claim about each kit: whoever assembles a kit rebuilds from the commit and compares first.
  const opening = notRelease ? [
    'Door kit (felinar ' + version + ', build ' + buildId + (commit ? ', commit ' + commit : '') + ', not a signed release)',
    '',
    'This folder is the loader built from the source after release ' + version + ', with the settings a host needs. It is not the signed release',
    'and no signed list exists for it, so the check of a release kit (verify-release.mjs against the signed list) does not apply. A host that',
    'serves it is a door: anyone can open a site there with its light link, https://<this host>/_mw/open.html#... The site lives at its key;',
    'domains are doors.',
    '',
    '1. This build has no signed list. Its build id is in /_mw/door.json and build.json (' + buildId + ')' + (commit ? '; building the source at commit ' + commit : '; building its source'),
    '   with node build.mjs prints the same build id. Use doors you or people you trust run.',
  ] : [
    'Door kit (felinar ' + version + ')',
    '',
    'This folder is the loader, byte for byte as released, with the settings a host needs. A host that serves it is a door: anyone can',
    'open a site there with its light link, https://<this host>/_mw/open.html#... The site lives at its key; domains are doors.',
    '',
    '1. Check that it is the release (offline; the pinned release key is printed in README.md and SECURITY.md):',
    '   node tools/verify-release.mjs verify <this folder> --list hashes-dist.json --sig hashes-dist.json.sig --pubkey <pinned key> --door-kit --expect-version ' + version,
    '   (it names every file that is not in the signed list, and refuses host settings that differ from the ones made with the kit)',
  ];
  const readme = opening.concat([
    '2. Upload the whole folder to the root of a host name (not a sub-path):',
    '   - GitHub Pages: publish it as the site root (.nojekyll is here). Pages takes no headers of yours but sends',
    '     Access-Control-Allow-Origin: * itself, so other doors can read /_mw/door.json; every file is cached for up to 10 minutes.',
    '   - Cloudflare Pages or Netlify: deploy the folder; _headers and _redirects are read. Cloudflare Pages answers the door page at',
    '     /_mw/open (clean URLs) after a redirect that keeps a link\'s fragment; this loader enters door mode at both addresses.',
    '   - Vercel: deploy the folder; vercel.json is read.',
    '   - Your own server: Caddy with the Caddyfile here.',
    '3. Check the door: node tools/check-site.mjs https://<this host>/ --door',
    '4. A full door also serves a site\'s bytes: its web seed copy under /ws/<name>/ and its .torrent at /_mw/t/<btih>.torrent',
    '   (publish --door-kit <dir> ... --door-site <publish output> lays them out).',
    '',
    'What a door cannot do:',
    '- A link cannot reroute itself. When the first door of a link is down and the visitor never opened the site, the browser',
    '  shows its own error page and no code of ours runs. Give people more than one link.',
    '- Nobody can tell a good door from a hostile one on the first visit: a hostile or altered door can serve a hostile loader.',
    '  Use doors you or people you trust run, and check them with ' + (notRelease ? 'step 3' : 'steps 1 and 3') + '.',
    '- Doors do not beat a whitelist or a shutdown: at least one door must be reachable, and not intercepted by a certificate the',
    '  device trusts.',
    '- A site opened at a door runs in a limited view: no storage, no offline engine, an identity for this visit only. Its full',
    '  mode needs its own address.',
    '- A door sees the visitor\'s IP address and the time, not which site: the link\'s fragment never leaves the browser.',
    '- Free hosts can close an account or change their limits; spread doors over providers, registrars and countries.',
    '',
  ]).join('\n');
  return { '_headers': headers, '_redirects': redirects, 'vercel.json': vercel, 'Caddyfile': caddy, 'README-DOOR.txt': readme, '.nojekyll': '' };
}

