## What and why

<!-- One paragraph. Link the issue. -->

## Checklist

- [ ] `npm test` passes (lint:floor + unit) and `npm run test:e2e` passes locally
- [ ] No browser in tests reaches the internet (see `docs/DEV-NETWORK.md`)
- [ ] Browser floor respected (Safari/iOS 15.4, Chromium 110, Firefox 115): no post-floor APIs
- [ ] Shared code (`src/common`, `src/chain`) still runs in Node and browsers unchanged
- [ ] User-facing strings follow the wording rules (no "blockchain", no "serverless", no isolation claims for shared-origin hubs)
- [ ] Docs updated (`docs/`, `CHANGELOG.md`) if behaviour or CLI flags changed
- [ ] New dependency? Explain why in the PR and update `build.lock.json` if the vendored bundle changed
