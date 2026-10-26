#!/bin/bash
# Runs INSIDE an Ubuntu 24.04 machine (OrbStack) as root: installs Node 24.22.0 + Caddy 2.11.7 from official checksummed releases,
# installs the reference tracker under systemd with the reference unit, and tests the whole chain over TLS.
set -uo pipefail
REF=${REF:-/path/to/docs/research/w2b-01-tracker-resilience-ref}  # set REF; for OrbStack copy the folder outside ~/Documents (macOS TCC blocks the VM there)
say() { printf '\n=== %s\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive
say "os"; . /etc/os-release; echo "$PRETTY_NAME  kernel $(uname -r)  arch $(uname -m)  systemd $(systemctl --version | head -1)"
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl ca-certificates xz-utils python3 >/dev/null 2>&1
case "$(uname -m)" in aarch64) NA=arm64; CA=arm64;; x86_64) NA=x64; CA=amd64;; esac
say "node 24.22.0 (sha256 verified)"
cd /tmp && curl -fsSLO https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-$NA.tar.xz && curl -fsSLO https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
grep " node-v24.22.0-linux-$NA.tar.xz\$" SHASUMS256.txt | sha256sum -c - && tar -xJf node-v24.22.0-linux-$NA.tar.xz -C /usr/local --strip-components=1 && node --version
say "caddy 2.11.7 (sha512 verified)"
curl -fsSLO https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_$CA.tar.gz && curl -fsSLO https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_checksums.txt
grep " caddy_2.11.7_linux_$CA.tar.gz\$" caddy_2.11.7_checksums.txt | sha512sum -c - && mkdir -p /tmp/caddy && tar -xzf caddy_2.11.7_linux_$CA.tar.gz -C /tmp/caddy && install -m 0755 /tmp/caddy/caddy /usr/local/bin/caddy && caddy version
say "install tracker + unit"
id mwtracker >/dev/null 2>&1 || useradd --system --home /opt/magnet-tracker --shell /usr/sbin/nologin mwtracker
mkdir -p /opt/magnet-tracker /etc/magnet-tracker && cp $REF/tracker/tracker.mjs $REF/tracker/package.json $REF/tracker/package-lock.json /opt/magnet-tracker/
(cd /opt/magnet-tracker && npm ci --omit=dev --ignore-scripts 2>&1 | tail -2)
sed 's#/usr/bin/node#/usr/local/bin/node#' $REF/deploy/magnet-tracker.service > /etc/systemd/system/magnet-tracker.service
cp $REF/deploy/env.example /etc/magnet-tracker/env && printf '%s\n' 'OPEN=1' 'ALLOW_FILE=' 'ALLOW_ORIGINS=' 'METRICS_PORT=9464' >> /etc/magnet-tracker/env
chown -R root:root /opt/magnet-tracker /etc/magnet-tracker
say "systemd-analyze verify"
systemd-analyze verify /etc/systemd/system/magnet-tracker.service 2>&1 | head -20; echo "verify exit: $?"
systemctl daemon-reload && systemctl start magnet-tracker; sleep 3
say "status"; systemctl --no-pager -l status magnet-tracker | head -14
say "limits as seen by the process"; PID=$(systemctl show -p MainPID --value magnet-tracker); grep -E 'Max open files|Max processes' /proc/$PID/limits; grep -E 'Seccomp|NoNewPrivs|CapEff' /proc/$PID/status
say "journal"; journalctl -u magnet-tracker --no-pager -n 5 | cut -c1-300
say "systemd-analyze security (exposure level)"; systemd-analyze security magnet-tracker.service --no-pager 2>&1 | tail -4
say "health + metrics (loopback)"; curl -s localhost:8000/healthz; echo; curl -s localhost:9464/metrics | grep -E '^mwt_(connections|swarms|build_info)' | head -5
say "caddy with tls internal in front (rtc.test)"
grep -q rtc.test /etc/hosts || echo '127.0.0.1 rtc.test' >> /etc/hosts
sed -e 's/rtc.example.com {/rtc.test {\n\ttls internal/' -e '/email ops@example.com/d' $REF/deploy/Caddyfile > /tmp/Caddyfile.test
mkdir -p /tmp/caddy-logs /tmp/caddy-data
(XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-data MW_LOG_DIR=/tmp/caddy-logs nohup caddy run --config /tmp/Caddyfile.test --adapter caddyfile > /tmp/caddy.out 2>&1 &)
sleep 4; ROOT=$(find /tmp/caddy-data -name root.crt | head -1); echo "root CA: $ROOT"
curl -s --cacert "$ROOT" https://rtc.test/healthz; echo
curl -s --cacert "$ROOT" https://rtc.test/ ; 
say "end-to-end probe over TLS: DNS+TLS+upgrade+announce+offer relay (probes/check_trackers.py)"
SSL_CERT_FILE="$ROOT" python3 -I $REF/probes/check_trackers.py --relay wss://rtc.test; echo "check_trackers exit: $?"
say "tracker unit tests inside the VM (node --test)"
(cd /tmp && rm -rf trk && mkdir trk && cp -r $REF/tracker/. trk/ && cd trk && rm -rf node_modules && npm ci --ignore-scripts 2>&1 | tail -1 && node --test --test-reporter=spec test/run.mjs 2>&1 | grep -E '^\s*(✔|✖|ℹ (tests|pass|fail))' | cut -c1-120)
say "caddy metrics (admin)"; curl -s localhost:2019/metrics | grep -E '^caddy_http_(requests_total|request_duration_seconds_count)' | head -3
say "restart drain: systemctl restart (SIGTERM -> 1001 closes spread, exit 0)"
systemctl restart magnet-tracker; sleep 2; journalctl -u magnet-tracker --no-pager -n 6 | cut -c1-200
echo; echo DONE
