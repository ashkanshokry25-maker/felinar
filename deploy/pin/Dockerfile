# deploy/pin/Dockerfile: a pin node, tools/pin.mjs in Playwright Chromium, for one felinar site.
# It keeps the real loader open so the site's files and its ledger have one copy that is always online.
# Read README.md in this directory first.
#
# Build from the repository root (the image needs package.json, the lockfile, src/, tools/ and the
# browser launch policy in test/e2e/browser-args.mjs):
#   docker build -f deploy/pin/Dockerfile -t felinar-pin .
# Run (PIN_URL is required; extra arguments go to tools/pin.mjs):
#   docker run -d --name mw-pin --init --restart unless-stopped --cap-drop ALL --security-opt no-new-privileges \
#     -v mw-pin:/var/lib/mw-pin -e PIN_URL=https://example.com/ felinar-pin --snapshot /var/lib/mw-pin/ledger.json.gz
#
# Environment (v0.3 C2; deploy/one-box/docker-compose.yml uses the same names):
#   PIN_URL          the site to keep online (required)
#   PIN_KEY          path of the pin key file inside a volume, for example /var/lib/mw-pin/pin.jwk (mode 600, owned by the
#                    image's user, uid 1000). Never baked into the image: the build below fails if a .jwk file is in it.
#                    With it the node signs mw_pin1 hello and receipt frames and the heartbeat (--pin-key).
#   PIN_STATUS       where the signed heartbeat goes when PIN_KEY is set (--status); default /srv/site/ws/pin-status.json,
#                    a directory the web server serves at the pointer's ws= base. Empty: no heartbeat.
#   PIN_MONTH_CAP    bytes (or 500GiB, 2TB) the pinned files may upload per UTC calendar month (--month-cap). Empty: no cap.
#   PIN_AUTO_ACCEPT  "owner": pin at once the file requests whose author is the site's owner key (--files --auto-accept owner).
#   PIN_PROFILE, PIN_INTERVAL  as before: the browser profile directory and the seconds between status lines.
#   MW_CHROMIUM_NO_SANDBOX  1 in this image (see "The Chromium sandbox" below); empty turns Chromium's own sandbox on.

# The base image: pin it by digest for a repeatable build (review round SUP-9), for example
#   LW_NODE_IMAGE=node:24-bookworm-slim@sha256:<digest> in the one-box .env; the digest from
#   docker buildx imagetools inspect node:24-bookworm-slim on a machine you trust.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/felinar

COPY package.json package-lock.json .npmrc ./
# Every dependency from the lockfile, without install scripts (.npmrc). Playwright is a dev dependency
# and the pin needs it; esbuild and http-server come with it and are not used. Then the Chromium build
# that matches this Playwright version, with the system libraries it needs (apt).
RUN npm ci --ignore-scripts --include=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY tools ./tools
COPY test/e2e/browser-args.mjs ./test/e2e/browser-args.mjs

# No key ever goes into the image: the pin key lives in a volume (PIN_KEY), the owner key never on a pin node.
RUN if find /opt/felinar -name '*.jwk' -not -path '*/node_modules/*' | grep -q .; then \
      echo 'error: a .jwk key file was copied into the image; keys belong in a volume (PIN_KEY)' >&2; exit 1; \
    fi

# The browser profile (the site's copy, the ledger, the consent choice), the pin stores, snapshots and the
# pin key live under /var/lib/mw-pin: mount a volume so they survive a new container. /srv/site/ws is where
# the heartbeat goes by default: mount the web server's ws/ directory there (writable by uid 1000).
RUN mkdir -p /var/lib/mw-pin /srv/site/ws && chown node:node /var/lib/mw-pin /srv/site/ws
VOLUME ["/var/lib/mw-pin"]

# The Chromium sandbox (code review v0.3, round 2). tools/live.mjs starts a browser that reaches the internet with Chromium's own
# sandbox. Docker's default seccomp profile does not let an unprivileged process create the user namespaces that sandbox needs,
# so in this image MW_CHROMIUM_NO_SANDBOX=1 starts Chromium without it (the tool prints a warning on every launch), and the
# container itself is the boundary: run it as the node user, with --cap-drop ALL and --security-opt no-new-privileges (the one-box
# compose file does both), and keep only the volumes writable. To run with Chromium's sandbox as well, start the container with a
# seccomp profile that allows user namespaces (Playwright publishes one for its Docker images) and -e MW_CHROMIUM_NO_SANDBOX=
# (empty); deploy/pin/README.md, "The Chromium sandbox".
ENV NODE_ENV=production \
    MW_CHROMIUM_NO_SANDBOX=1 \
    PIN_URL="" \
    PIN_PROFILE=/var/lib/mw-pin/profile \
    PIN_INTERVAL=60 \
    PIN_KEY="" \
    PIN_STATUS=/srv/site/ws/pin-status.json \
    PIN_MONTH_CAP="" \
    PIN_AUTO_ACCEPT=""
USER node

# With MW_CHROMIUM_NO_SANDBOX=1 Chromium runs without its own sandbox and with --disable-dev-shm-usage, so no extra
# capabilities and no larger /dev/shm are needed. Run with --init (or init: true in Compose) so the browser's exited
# processes are reaped. SIGTERM (docker stop) makes the pin close the browser, write a heartbeat that lists
# nothing, and exit 0. The flags taken from the environment come before the arguments you add.
ENTRYPOINT ["/bin/sh", "-c", "if [ -z \"$PIN_URL\" ]; then echo 'error: set PIN_URL to the site to keep online, for example: docker run -e PIN_URL=https://example.com/ felinar-pin' >&2; exit 2; fi; if [ -n \"$PIN_AUTO_ACCEPT\" ]; then set -- --files --auto-accept \"$PIN_AUTO_ACCEPT\" \"$@\"; fi; if [ -n \"$PIN_MONTH_CAP\" ]; then set -- --month-cap \"$PIN_MONTH_CAP\" \"$@\"; fi; if [ -n \"$PIN_KEY\" ]; then if [ -n \"$PIN_STATUS\" ]; then set -- --status \"$PIN_STATUS\" \"$@\"; fi; set -- --pin-key \"$PIN_KEY\" \"$@\"; fi; exec node tools/pin.mjs \"$PIN_URL\" --headless --profile \"$PIN_PROFILE\" --interval \"$PIN_INTERVAL\" \"$@\"", "mw-pin"]
CMD []
