### F4. Hosting options and costs on 2026-10-17: a tracker costs $0-7 a month; egress, not CPU, is the line item, and the client policy decides it

Prices below are list prices read on 2026-10-17 from vendor pages ([S] = through the fetch summariser); egress figures use the model of F3 (≈ 50 B/s per socket at the stock 5 offers in a swarm of ≥ 6 peers, ≈ 1 B/s with the count-aware policy of F7).

| Platform | Plan and price | Egress | Fit and caveats |
|---|---|---|---|
| **Oracle Cloud Always Free** (docs read again today) | `VM.Standard.A1.Flex`: first 1,500 OCPU-hours and 9,000 GB-hours/month free = **2 OCPU / 12 GB** (one instance or two of 1 OCPU); two `VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB); PAYG upgrade keeps Always Free resources free | **10 TB/month** outbound | Best fit and what Novage runs 120k sockets on. Home region only; "out of host capacity" errors; **idle reclamation** if over 7 days CPU p95 < 20% and network < 20% and (A1) memory < 20%; outbound TCP 25 blocked; use stateless security-list rules |
| **Fly.io** [S] | no free tier for new orgs (trial: 2 h of Machine time or 7 days); shared-cpu-1x 256 MB **$2.19**, 512 MB **$3.69**, 1 GB **$6.70** per month (Ashburn/Secaucus; Frankfurt 1 GB $7.73, Singapore $8.50); dedicated IPv4 $2; shared IPv4 and IPv6 free | **$0.02/GB** NA/EU, $0.04 APAC/SA, $0.12 Africa/India; inbound free | TLS at Fly's proxy (no Caddy); default concurrency type `connections` with `soft_limit` 20 if unset, `hard_limit` unset; keep `auto_stop_machines = "off"`; `Fly-Client-IP` for the client address |
| **DigitalOcean** [S] | Basic Droplet **$4** (512 MiB, 10 GiB, 500 GiB transfer), **$6** (1 GiB, 1,000 GiB), $12 (2 GiB, 2,000 GiB), $18 (2 vCPU, 3,000 GiB) | included per plan (overage price not on the page) | Plain VM; the $4 plan holds ≈ 15k sockets of the wrapper (25 KiB each) |
| **Hetzner Cloud** [S] | plan pages list EU shared plans CX23/CAX11 (2 vCPU, 4 GB, 40 GB), CPX22 etc.; **prices are rendered client-side and could not be read** (**unverified**); the 2020-dated billing FAQ example shows a €3.29/month server | EU locations **≥ 20 TB** included; Singapore 0.5-5 TB, US (Hillsboro, Ashburn) 1-5 TB; overage price not readable | Largest included egress; the plan pages showed every EU shared plan as "currently unavailable" at fetch time (possibly a rendering artefact; check the console) |
| **Cloudflare Workers + Durable Objects** | Workers Paid **$5/month minimum** (10 M Worker requests, 1 M DO requests included) - F6 | no egress charge; billed per request (20:1 for WebSocket messages) | no server to patch; code is ours; per-swarm URL |
| Render Free, GCP e2-micro/Cloud Run free, Koyeb | wave-1 findings unchanged: Render sleeps after 15 min without inbound traffic; GCP includes 1 GB/month egress; Koyeb unverified | - | not suitable |
| Vultr | pricing page returned 403 to the fetch tool | - | not evaluated |

**Monthly cost, one tracker, my estimate from the list prices above and the egress model** (sockets = permanently connected tabs; a visit lasts 120 s, so N sockets = N x 720 visits/day = N x 21,600 visits/month; Cloudflare is priced per visit at ≈ 1.2 DO requests + 1 Worker request + ≈ 12 ms CPU, about $0.72 per million visits beyond the included allowances):

| Workload | Oracle A1 | DigitalOcean | Hetzner EU | Fly.io | Cloudflare Worker + DO |
|---|---|---|---|---|---|
| 100 sockets (2.2 M visits/month; real small sites have far fewer) | $0 | $4 | not readable | $3.69 (512 MB) | **≈ $5.2** |
| 2,000 sockets, stock policy (≈ 260 GB/month; 43 M visits/month) | $0 | $6 (1,000 GiB included) | included | $3.69 + 259 GB x $0.02 = **$8.9** | ≈ $32 |
| 20,000 sockets, stock policy (≈ 2.6 TB/month; 430 M visits/month) | $0 (inside 10 TB) | $24 plan (4 TB included) | included (20 TB) | 2 GB RAM needed: $13.39 + **$52** = ≈ $65 | ≈ $300, not competitive |
| 20,000 sockets, count-aware policy (egress ≈ 0) | $0 | $6-12 | included | $13.39 | ≈ $300 (cost is per visit, not per byte) |

**Reading.** At the visit levels the architecture review expects (10k visits/day ≈ 14 concurrent sockets) every row is within a few dollars of its fixed price; the only ways to make a tracker expensive are to keep the stock "5 offers per cycle" policy on a metered host at tens of thousands of sockets (Fly.io: $52 of egress for 20k sockets; the F7 policy removes it) or to run the Cloudflare variant at sustained high concurrency (it is priced per visit and beats a flat VM only below roughly 10 M visits/month). The free Oracle option is real but carries the reclamation and capacity caveats, so the reference runbook pairs it with the external probe (F9) and a second, independent tracker.
**Confidence:** high for the quoted prices and allowances (official pages read today); medium for the cost table (my arithmetic; the Cloudflare row assumes one Worker request and one DO request per upgrade, about 4 incoming messages = 0.2 billed requests, and about 12 ms CPU per visit); **unverified** for Hetzner prices and Vultr.
**Sources:** Oracle, Fly.io, DigitalOcean, Hetzner, Cloudflare pages listed in the sources section; F3/F6/F7 for the model.
**Source date:** 2026-10-17 (Oracle, Fly.io, DigitalOcean, Hetzner pages undated; Cloudflare "last updated Sep 30 / Oct 2, 2026").

