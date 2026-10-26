# w2a-01 - What site generators and SPA frameworks emit, and what breaks under a SW-served, path-prefixed or iframe-hosted deployment

> STATUS: INTERIM DRAFT written 2026-10-17 during research (checkpoint). The final version replaces this file. Evidence so far:
> real builds of 10 generators run through a Chromium 156 lab (see "Experiments"). Full write-up pending.

## Summary (interim)

1. The current design serves the site at `/_mw/s/<btih>/<path>`. Almost every generator emits ROOT-ABSOLUTE URLs by default
   (`/_next/...`, `/_astro/...`, `/assets/...`, `/_nuxt/...`, `/css/...`) and client routers read `location.pathname`. In a lab with real builds
   (Vite 8.3.4+React Router 8, Astro 7.4.0, Next.js 16.4.2 export, SvelteKit 3.1.0, Eleventy 3.1.7, Hugo 0.168.0, MkDocs 1.6.1+Material 9.7.7,
   Docusaurus 3.10.2, Nuxt 4.6.2) the prefix design renders a working page for 3 of 9 default builds (SvelteKit, MkDocs Material, Docusaurus hash-router build), shows only
   un-hydrated HTML for the static generators, and loads a nested copy of the loader shell inside the iframe on any root-absolute link.
2. Same-URL dispatch (SW answers `destination: document` with the shell and `destination: iframe` with the site; subresources dispatched by
   `Client.frameType`) passed home render, client-side navigation and deep link for every default build, with zero leaked requests.
3. A "remap root-absolute requests into the prefix by clientId" patch of the current design is NOT enough: dedicated workers and module graphs
   loaded from non-prefixed URLs escape it, and routers see `/_mw/s/<btih>/...` as their pathname (Vite+React Router, Docusaurus, Nuxt SPA show their 404 route).
4. The site's own service worker cannot register under the loader (SW script fetches bypass the SW and the host has no such file); a root-absolute `register('/sw.js')` silently resolves to the loader's own registration.

(See lab: scratchpad `lab/` - to be copied to docs/research/labs/w2a-01-lab/.)
