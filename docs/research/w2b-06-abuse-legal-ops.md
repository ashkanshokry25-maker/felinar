# w2b-06: Abuse handling, legal and privacy operations for a P2P-distributed web

**Project:** magnet-web (static loader + WebTorrent/WebRTC + Service Worker + per-site signed log)
**Wave / topic:** W2b-06, production readiness: abuse, legal and privacy operations
**Written:** 2026-10-17. **Status:** research input for design decisions. **This is not legal advice.** Every template below is a draft for review by counsel in the jurisdictions where you operate.
**Prefers 2024-2026 sources.** Older sources are flagged `OLD`.

## 0. How this was researched, and what could not be checked

- Method: primary texts were downloaded and read as text on this machine wherever possible (statutes, CJEU judgments, EDPB and WP29 guidelines, the USENIX Security 2024 IPFS moderation paper, RFCs). Appendix C labels every source `local` (quotes are verbatim from the downloaded text), `summ` (read through a summariser; only fragments that the summariser itself put in quotation marks are quoted) or `snippet` (search blurb only, never the sole basis).
- **Search budget exhausted mid-run.** The shared WebSearch quota (200 per turn across all agents) ran out after this agent had run 14 searches. After that point only direct fetches of known primary URLs were possible. Consequently these are **unverified** and listed again in section 7: California CIPA "pen register" litigation and SB 690 status (leginfo returned 403), Ofcom's Online Safety Act codes (ofcom.org.uk returned 403), AWS's own DMCA policy page (404), the Matrix spec body for moderation policy lists, EU Regulation (EU) 2026/1881 on EUR-Lex, final-adoption status of EDPB Guidelines 1/2024 and 02/2025, any post-Cox lower-court decision, and the current Quebec consolidation (legisquebec.gouv.qc.ca returned 403; the enacted Act S.Q. 2021, c. 25 was read instead).
- EUR-Lex intermittently answered HTTP 202 (AWS WAF challenge); retries with delays succeeded for every judgment and regulation quoted. The Digital Services Act article text was read from an unofficial verbatim mirror (eu-digital-services-act.com) and its section structure, recital 28 and the Implementing Regulation were cross-read on EUR-Lex.
- Local context read first, **re-read after `docs/ARCHITECTURE.md` changed on disk mid-run (now v1, 643 lines, 2026-10-17 17:17)**: ARCH v1 (pointer record v1 with `consent=notice|gate`, subdomain hub s3.2, shared-origin demo hub s3.3, drop-in mode s3.4, takedown s5.8, moderators s6.2, policy and consent s8), `docs/review/DESIGN-REVIEW.md` (item 1 redactable blocks, item 4 `writers:'owner'` default, item 12 consent strings and gate, item 20 kill switch, item 21 takedown, item 25 release gate), `docs/review/security.md` (M6, M8), `docs/research/03-webrtc-nat-privacy.md` (R-11 disclosure draft), `docs/research/06-browser-chain-vs-crdt.md` (3.1.5 moderation; open question 12 "legal exposure is unresearched"), and the sibling `w2c-02-chain-production-features.md` (redaction by commitment, GDPR erasure). All recommendations in section 5 are written as **amendments to ARCH v1 / DESIGN-REVIEW section numbers**, and this document does not repeat what those already decide.
- Export controls: out of scope per the brief, not researched.

## 1. Summary

1. **Liability attaches to services, not to hashes.** An infohash cannot be recalled. What can be acted on is (a) the signed pointer, (b) the parties that run services (loader host, web-seed host, hub origin, any tracker the project runs), (c) a client-enforced denylist, and (d) chain-level redaction. Section 4 gives the takedown ladder and what it cannot do.
2. **US secondary liability narrowed on 2026-03-25 (Cox v. Sony, No. 24-171).** The Court held a provider is contributorily liable "only if it intended that the provided service be used for infringement", shown only by inducement or a service "tailored to that infringement"; "mere knowledge ... is insufficient". A general-purpose loader has substantial non-infringing uses, so the exposure moves to *inducement* (marketing, a piracy-oriented directory, example sites). DMCA s.512 still governs monetary relief and needs a registered agent, notice-and-takedown and a repeat-infringer policy.
3. **Everywhere else the operative test is still "knowledge plus expeditious action".** EU: DSA Art. 6(1)(b), and an Art. 16(3) notice counts as actual knowledge if a diligent provider can see the illegality "without a detailed legal examination"; CJEU YouTube/Cyando (2021) and Ziggo (2017). UK: Electronic Commerce (EC Directive) Regulations 2002 reg 19 ("ECR"). Canada: notice-and-notice (ss. 41.25-41.26), hosting protection lost only on knowledge of a court decision (s. 31.1(5)), plus the "enabler" offence (s. 27(2.3)).
4. **The three product features that most raise legal risk:** (i) any hub-run index or search over sites (Ziggo: "indexation of metadata ... and the provision of a search engine" is a communication to the public); (ii) failing to disable access fast after a notice; (iii) reputation blocking of the hub: Google Safe Browsing strips `#fragment` and matches by host suffix, so on the shared-origin hub (ARCH s3.3) one bad site flags every site, and on the subdomain hub (s3.2) a listing of the hub's registered domain covers every label (Sokoto et al.: 56 IPFS gateways were blocked entirely).
5. **Visitors who seed carry real but modest exposure.** CJEU Mircom (C-597/19): uploading unusable pieces is still "making available", and automatic upload does not negate deliberateness when the user was "duly informed". No safe harbour exists for end users. Statutory damages differ sharply (US $750-$30,000 per work; Canada $100-$5,000 *total* for non-commercial). I found **no public evidence** of notices against WebRTC-only WebTorrent swarms (unknown).
6. **ARCH v1 s8 already puts the notice before the first announce, which is the right order; four gaps remain for the EEA, UK and Quebec.** (a) The non-gated notice offers `[OK]` and `[Settings]` but no refusal on the same layer, so "OK" reads as acknowledgement rather than freely given consent; (b) uploads then start by default on Wi-Fi; (c) no versioned consent record (GDPR Art. 7(1): the controller must be able to demonstrate consent); (d) a drop-in site that already runs a consent manager has no documented bridge. The legal basis: EDPB Guidelines 2/2023: Art. 5(3) covers any storage in, or access to, the terminal regardless of medium or personal data, and locally stored information "or any derivation" leaving the device is "access". The strictly-necessary tests (WP29 04/2012; UK PECR Sch. A1 para 4) cover rendering the requested site, not uploading it to strangers. IP addresses are personal data (Breyer) and the operator that makes the browser transmit them to trackers, STUN and peers is a (joint) controller for that transmission (Fashion ID). Safe default: **P2P participation is opt-in, with a web-seed/HTTP baseline.**
7. **Append-only chain plus personal data collides with erasure.** EDPB 02/2025 (consultation text): avoid personal data on-chain, keys can be personal data, "technical impossibility cannot be invoked". CJEU Russmedia (2025-12-02): a hosting-style exemption does not shield GDPR duties. Chain redaction ops are specified in `w2c-02`; this document adds the legal triggers (data protection impact assessment or DPIA, controller role, owner as UK OSA "provider").
8. **Mandatory-reporting and order-response duties exist even for tiny operators:** US 18 U.S.C. 2258A (report on actual knowledge; no duty to scan; preserve 1 year; fines up to $850,000/$600,000); Canada's mandatory-reporting Act (21-day preservation today); EU terrorist-content removal "within one hour" (Reg. 2021/784 Art. 3(3)); EU e-evidence representatives (due 2026-08-18, so already applicable); DSA Art. 18. A P2P hub sees no bytes, so hash-matching (PhotoDNA, PDQ) can only happen where bytes are handled: the web-seed/CDN and any pin/seedbox service.
9. **Small-operator relief under the DSA is partial.** Micro/small enterprises are exempt from Art. 15 reporting and the online-platform section (Arts. 19-28) but **still owe** points of contact (Arts. 11-12), terms that describe moderation (Art. 14), a legal representative if non-EU (Art. 13), notice-and-action (Art. 16), statements of reasons (Art. 17) and Art. 18 notification.
10. **Changes recommended before any public hub or "migrate your existing site" launch (P0), all as amendments to ARCH v1:** a real choice in the first-run notice plus a consent record and CMP bridge (s8); pointer fields for withdrawal, abuse contact and audience flags, and a withdrawal that purges *all* versions (s4, s5.8); a signed double-hashed client denylist that also drives a seeding stop (new); hub hardening: no directory or search, apex gate only, PSL and reputation monitoring (s3.2); operator registrations and mailboxes; DPIA/PIA and a privacy notice; a notice-and-action runbook with a measured time-to-block added to the s12 release gate. Section 5 has effort and acceptance tests; Appendices A and B are the operations checklist and template text.

## 2. Role map: who is exposed to what

Deployments differ; the same person may hold several roles. "Hub" = a shared origin that renders arbitrary magnets (ARCH s.3). In **per-domain mode** the site owner hosts the loader on their own domain, so the owner is the operator and the project is only a software vendor.

| Role | What they run / do | Main legal hooks | Takedown lever they control |
|---|---|---|---|
| Site owner / publisher | Holds owner key, signs pointer, sets chain policy, moderates | Copyright (content), GDPR controller for chain data and for the IP disclosure their loader causes (Fashion ID), UK Online Safety Act (OSA) "provider" if users can post (s.226), DMCA agent if they host | Withdraw pointer, `mod.*` ops, delete web seed |
| Loader host (S3/CloudFront, GitHub Pages, Cloudflare Pages) | Serves HTML/JS/SW | Hosting provider for the loader code (DSA Art. 6; s.512(c)); its own AUP and repeat-infringer policy | Host can disable the whole site/account |
| Web-seed host | Serves bytes over HTTP Range | Hosting provider for the actual content bytes: the **main bytes chokepoint** | Object/bucket disable |
| Hub operator | Subdomain hub (ARCH s3.2: gate, then `<label>.hub.example`) or shared-origin demo hub (s3.3) | Gateway-like: s.512(d) location tool; Ziggo/YouTube tests; Safe Browsing reputation; GDPR controller; OSA/DSA status unsettled | Hub denylist, allowlist at the gate, refuse to redirect |
| Tracker / STUN operator (third party today) | WSS signalling, IP discovery | Conduit-like by analogy (UNVERIFIED); GDPR controller for its logs; no published abuse policy found, see `02-wss-trackers.md` F12 | Remove infohash (only if allowlist exists) |
| DoH resolver | Sees `_magnet.<domain>` | Recital 28 DSA lists DNS services as potential conduit/caching | None relevant |
| Registrar / DNS host | Domain, TXT record | ICANN 2024 DNS-abuse rules (malware, phishing) exclude "website content abuses" | Suspend domain (DNS abuse only) |
| Visitor / seeder | Browser holds and uploads pieces | Mircom "making available"; no safe harbour; GDPR data subject; PECR/ePrivacy "user" | Pause sharing, purge, forget site |
| Always-on pin / seedbox | `pin.mjs` or headless node | Hosting-like for whatever it pins; for third-party content it is a hosting provider | Unpin |
| Project maintainers | Publish code, docs, defaults | Cox: *inducement* via marketing/examples; Canada s.27(2.4)(a); shipping a default tracker list makes third parties see every visit | Neutral docs; no default open tracker |

## 3. Findings

Format: claim, confidence, whether it is design-critical (DC: wrong means an architecture or compatibility promise changes), evidence with verbatim quotes, sources with source dates, and the implication for magnet-web. "Inference" marks my own reasoning on top of a source.

### 3A. Intermediary status, safe harbours and secondary liability

**F1 (DC). US contributory copyright liability now requires intent; knowledge alone is not enough.** Confidence: high on the holding, medium on how lower courts will apply it to P2P hubs (no post-Cox decision read).
- *Cox Communications, Inc. v. Sony Music Entertainment*, No. 24-171, decided **2026-03-25**, Thomas J. for seven Justices; Sotomayor J. (with Jackson J.) concurring in the judgment only. Holding: a provider is "contributorily liable for a user's infringement only if it intended that the provided service be used for infringement", "which can be shown only if the party induced the infringement or the provided service is tailored to that infringement". Inducement: "actively encourages infringement through specific acts". Tailored: "not capable of 'substantial' or 'commercially significant' noninfringing uses". "[M]ere knowledge that a service will be used to infringe is insufficient". The majority noted Cox sent warnings, suspended and terminated accounts, which undercut encouragement. Part IV: the s.512 safe harbour protects providers that terminate repeat infringers "in appropriate circumstances"; the Court did **not** decide whether Cox met the repeat-infringer requirement (an earlier Fourth Circuit decision had foreclosed Cox's safe-harbour defence for the period). Sotomayor's concurrence argues the two-theory limit is unexplained and weakens the DMCA's incentive structure.
- Inference for us: the loader is plainly capable of substantial noninfringing use, so the risk shifts to **inducement** (README/launch copy, example sites, a directory of "free movies") and to claims the opinion did not touch (direct and vicarious liability). Keep marketing neutral; keep a record of abuse actions (it is the evidence that you did *not* encourage infringement).
- Sources: FindLaw copy of the opinion https://caselaw.findlaw.com/court/us-supreme-court/24-171.html (read through a summariser, short fragments; opinion 2026-03-25). Corroboration: search-result summaries from AIPLA (2026-03-25), Quinn Emanuel, Holland & Knight (2026-04), Ballard Spahr (2026-04) (titles and blurbs only).

**F2. DMCA s.512 mechanics that a hub or web-seed host must implement (text unchanged since 2010).** Confidence: high for the statute; medium-high for the agent fee and renewal (older sources).
- Operative words (Cornell LII, last amendment shown 2010): (c)(2) provider "has designated an agent to receive notifications of claimed infringement"; (c)(3)(A) notice is "a written communication provided to the designated agent ... that includes substantially" the listed elements (signature, work identified, material and location, contact details, good-faith statement, accuracy and authority "under penalty of perjury"); (d) information location tools ("referring or linking users to an online location"); (g)(2)(B)-(C) counter notice, material restored "not less than 10, nor more than 14, business days" after receipt unless suit is filed; (i)(1)(A) "adopted and reasonably implemented, and informs subscribers and account holders ... a policy that provides for the termination in appropriate circumstances of subscribers and account holders ... who are repeat infringers"; (m) no duty to monitor; (f) liability for knowing material misrepresentation.
- Agent registration: through the Office's online system only (paper designations are no longer accepted, per the directory page); fee **$6** (entry "Designation of agent under 17 U.S.C. 512(c)(2)" in the copyright.gov fee table, undated page); a designation "expires and becomes invalid three years after it is registered with the Office" unless renewed by amending or resubmitting (Library of Congress blog, **2019-10-17, OLD** but authoritative; I did not find a 2026 page restating it).
- Inference: a hub that renders `#magnet:` links is an "information location tool" operator; *disabling the reference* is the (d)(3) remedy, which maps one-to-one onto a denylist entry (R3).
- Sources: https://www.law.cornell.edu/uscode/text/17/512 ; https://www.copyright.gov/dmca-directory/ ; https://www.copyright.gov/about/fees.html ; https://blogs.loc.gov/copyright/2019/10/it-may-be-time-to-renew-your-dmca-agent-registration/ (2019-10-17).

**F3 (DC). EU DSA: what a small intermediary still owes.** Confidence: high (final text; structure confirmed on the Commission-aligned mirror; Implementing Regulation read on EUR-Lex).
- Art. 6(1): hosting provider is not liable on condition it "does not have actual knowledge of illegal activity or illegal content" **or** "upon obtaining such knowledge or awareness, acts expeditiously to remove or to disable access". Art. 16(3): a notice gives actual knowledge "where [it] allow[s] a diligent provider of hosting services to identify the illegality ... without a detailed legal examination". Art. 7: good-faith voluntary detection does not forfeit the exemption. Art. 8: "No general obligation to monitor".
- Structure: Section 1 (Arts. 11-15) applies to **all** intermediaries: single points of contact for authorities and for recipients, "which shall not solely rely on automated tools" (Art. 12(1)); legal representative for non-EU providers offering services in the Union (Art. 13); terms that describe "policies, procedures, measures and tools used for the purpose of content moderation ... as well as the rules of procedure of their internal complaint handling system" (Art. 14(1)); yearly transparency report (Art. 15). Section 2 (Arts. 16-18) applies to hosting providers: notice-and-action with four required notice elements (Art. 16(2)(a)-(d)), statement of reasons for any visibility restriction or suspension (Art. 17), notification of suspicion of offences "involving a threat to the life or safety of a person" (Art. 18). Section 3 (Arts. 19-28, online platforms) is excluded for micro and small enterprises by Art. 19 (apart from Art. 24(3)); Art. 15(1) is excluded for them by Art. 15(2) unless they are designated very large online platforms.
- Reporting format: Commission Implementing Regulation (EU) 2024/2835: yearly period 1 January-31 December; report public "at the latest by two months after" the period; templates in Annex I "as of 1 July 2025". Even exempt operators can use it as the template for voluntary reports (R12).
- SME thresholds (Recommendation 2003/361/EC, from memory, not re-fetched): small = fewer than 50 staff and turnover or balance sheet at most EUR 10 million; micro = fewer than 10 and at most EUR 2 million.
- Sources: https://www.eu-digital-services-act.com/Digital_Services_Act_Article_6.html (and Articles 7, 8, 11-19 on the same host; final text, mirror); https://www.eu-digital-services-act.com/Digital_Services_Act_Articles.html (section structure); Implementing Regulation 2024/2835 on EUR-Lex (CELEX 32024R2835, 2024-11-04).

**F4. Which DSA category fits which magnet-web component is partly unsettled.** Confidence: medium for the mapping (inference), low for the hub.
- Recital 28: services "establishing and facilitating the underlying logical architecture and proper functioning of the internet ... can also benefit from the exemptions ... to the extent that their services qualify as 'mere conduit', 'caching' or 'hosting' services. Such services include ... domain name system (DNS) services, top-level domain name registries, registrars, ... cloud infrastructure services, or content delivery networks". Art. 3(g): hosting is "the storage of information provided by, and at the request of, a recipient of the service"; Art. 3(i) online platform = hosting service that "stores and disseminates information to the public".
- Mapping (inference): static host and web-seed host = hosting; CDN = caching; DoH resolver/DNS host = conduit/caching; a WSS tracker relaying offers/answers = conduit-like (no authority found); a hub that stores nothing but causes each visitor's browser to fetch and render third-party content fits none of Arts. 4-6 cleanly; chain relay by visitors' browsers is not a service in the commercial sense. Where no exemption applies, national law applies and the F5 tests decide.
- Sources: https://www.eu-digital-services-act.com/Digital_Services_Act_Preamble_21_to_30.html (recital 28) ; Art. 3 and Art. 4-6 pages as above.

**F5 (DC). CJEU tests for operators of sharing and index platforms: do not run an index; act fast after a warning.** Confidence: high (judgment text read).
- *Stichting Brein v Ziggo and XS4ALL* (C-610/15, **2017-06-14, OLD but binding**): "communication to the public" covers "the making available and management, on the internet, of a sharing platform which, by means of indexation of metadata relating to protected works and the provision of a search engine, allows users of that platform to locate those works and to share them in the context of a peer-to-peer network."
- *YouTube/Cyando* (C-682/18 and C-683/18, **2021-06-22**): an operator "does not make a 'communication to the public' ... unless it contributes, beyond merely making that platform available, to giving access to such content ... That is the case, inter alia, where that operator has specific knowledge that protected content is available illegally on its platform and refrains from expeditiously deleting it or blocking access to it, or ... refrains from putting in place the appropriate technological measures that can be expected from a reasonably diligent operator ... or ... participates in selecting protected content ..., provides tools ... specifically intended for the illegal sharing ... or knowingly promotes such sharing". General knowledge is not enough, but "[t]he situation is, however, different where that operator, despite having been warned by the rightholder ..., refrains from expeditiously taking the measures necessary". The hosting exemption applies "provided that that operator does not play an active role of such a kind as to give it knowledge of or control over the content".
- Implication: (1) **no hub-run directory, search, "featured sites" or recommendation feed** unless it sits behind full notice-and-action; (2) a fast, documented notice-to-block path is the central safeguard; (3) denylist and repeat-infringer handling count as "appropriate technological measures" evidence.
- Sources: EUR-Lex CELEX:62015CJ0610 and CELEX:62018CJ0682 (read locally).

**F6 (DC). Seeders: uploading unusable pieces is "making available"; being informed makes it deliberate.** Confidence: high for the text; medium for application to browser peers (no case found).
- *Mircom* (C-597/19, **2021-06-17**) para 43: "the fact that the pieces which are transmitted are unusable in themselves is irrelevant since what is made available is the file containing the work". Para 46: no minimum number of pieces. Para 48: "any act whereby a user, in full knowledge of the consequences of what he or she is doing, gives access to protected work is liable to constitute an act of communication". Para 49: where users "have subscribed to that software by giving their consent to its application after having been duly informed of its characteristics, those users must be regarded as acting in full knowledge of their conduct ... the deliberate nature of their conduct is in no way negated by the fact that the uploading is automatically generated by that software."
- Double edge (inference): the disclosure that GDPR/ePrivacy transparency *requires* (visitors share files and others see their IP) is also what establishes "full knowledge". Mitigation is not to hide it but to bound *what* a browser seeds: only the site the visitor is viewing, at the signed current `btih`, not on any denylist; stop seeding on withdrawal; never act as a generic torrent client.
- Sources: EUR-Lex CELEX:62019CJ0597 (read locally). Corroboration: Wolters Kluwer Copyright Blog and SCL summaries (search blurbs).

**F7. US seeding claims and evidence quality.** Confidence: medium.
- Statutory damages: "not less than $750 or more than $30,000" per work, up to "$150,000" if willful, floor "$200" if innocent (17 U.S.C. 504(c), amounts since 1999).
- Seeding as distribution is being litigated, not settled: in *Kadrey v. Meta* (N.D. Cal. 3:23-cv-03417) the BitTorrent distribution claim survived Meta's June 2025 fair-use win, and Judge Chhabria granted leave around **2026-03-25** to add a contributory-infringement claim "related to torrenting" (TorrentFreak 2026-03-30). Trackers report further discovery orders in August 2026 (secondary, dates unverified). No ruling on whether seeding chunks is "distribution" was found.
- Evidence of fault is weak by construction: Piatek, Kohno and Krishnamurthy (UW, HotSec 2008, **OLD**) generated DMCA notices against printers and a wireless access point that never shared content and concluded "practically any Internet user can be framed"; swarm-membership detection is "inconclusive".
- Unknown/unverified: whether any monitoring firm joins WebRTC-only WebTorrent swarms; I found no public notice, complaint or case involving instant.io, file.pizza or a WebTorrent site.
- Sources: https://www.law.cornell.edu/uscode/text/17/504 ; https://torrentfreak.com/judge-allows-bittorrent-seeding-claims-against-meta-despite-lawyers-lame-excuses/ (2026-03-30) ; https://dmca.cs.washington.edu/ (2008).

**F8 (DC for operators in Canada). Canada differs structurally: notice-and-notice, a narrow hosting carve-out, and an "enabler" offence.** Confidence: high (statute current to 2026-09-30, last amended 2024-11-07).
- s. 31.1(4)-(5): a hosting provider does not infringe "by virtue of that act alone", but (5) the protection is lost only "if the person providing the digital memory knows of a decision of a court of competent jurisdiction to the effect that the person who has stored the work ... infringes". s. 31.1(6): subsections (1), (2), (4) do not apply to acts under s. 27(2.3).
- s. 27(2.3): infringement "to provide a service primarily for the purpose of enabling acts of copyright infringement if an actual infringement ... occurs ... as a result of the use of that service". s. 27(2.4) factors include (a) marketing as usable to infringe, (b) knowledge of "a significant number of acts", (c) "significant uses other than to enable acts of copyright infringement", and (d) "the person's ability, as part of providing the service, to limit acts of copyright infringement, and any action taken by the person to do so".
- ss. 41.25-41.26 (notice-and-notice): notices go to persons providing "the means, in the course of providing services related to the operation of the Internet", "digital memory", or an "information location tool"; a notice must not contain "an offer to settle the claimed infringement"; the provider must "as soon as feasible forward the notice electronically" and keep identifying records **six months** (one year if the claimant notifies it started proceedings); failure carries statutory damages "not less than $5,000 and not more than $10,000".
- s. 38.1(1)(b): non-commercial infringement statutory damages "not less than $100 and not more than $5,000 ... for all works" in the proceeding (commercial: $500-$20,000 per work).
- Implication: a Canadian-run hub should run a *forwarder* (R9) and treat s. 27(2.4)(d) as a reason to document blocklist actions. Individual visitors face a very low statutory ceiling in Canada compared with the US.
- Sources: https://laws-lois.justice.gc.ca/eng/acts/C-42/section-31.1.html ; .../section-27.html ; .../section-41.25.html ; .../section-41.26.html ; .../section-38.1.html (all current to 2026-09-30).

**F9. UK: hosting exemption survives; the Online Safety Act turns *control over who can post* into provider status.** Confidence: high for statute text; Ofcom's codes not verified.
- Electronic Commerce (EC Directive) Regulations 2002 reg 19: hosting provider not liable if no actual knowledge or, "upon obtaining such knowledge or awareness, acts expeditiously to remove or to disable access".
- Online Safety Act 2023 s. 3(1): a user-to-user service is one where content "generated directly on the service by a user ... or uploaded to or shared on the service by a user ... may be encountered by another user". s. 4(5)-(6): UK links = "a significant number of United Kingdom users" or UK is a target market, or a "material risk of significant harm" to UK individuals. **s. 226(2)-(3)**: the provider is "the entity that has control over who can use the user-to-user part of the service"; if no entity but individuals have that control, those individuals.
- Inference: a site owner whose chain policy (`writers: open|allow`) and ban power define who may post is the OSA "provider" for that site; a guestbook meets s. 3(1). Whether the sibling "limited functionality" exemptions or Ofcom's proportionality guidance relieve a tiny site was **not verified** (ofcom.org.uk returned 403).
- Sources: https://www.legislation.gov.uk/uksi/2002/2013/regulation/19 ; https://www.legislation.gov.uk/ukpga/2023/50/section/3 , /section/4 , /section/226.

### 3B. Takedown mechanics and precedent in content-addressed and decentralised systems

**F10 (DC). A hash denylist is the established pattern, but it is reactive, leaky and trivially evaded; build it as one lever among several.** Confidence: high (paper and docs read in full).
- Kubo's content-blocking doc: "Content blocking is an opt-in decision made by the operator of `ipfs daemon`"; `*.deny` files; "Sensitive content paths can be double-hashed to block without revealing them"; a gateway answers HTTP **410 Gone**; Bitswap neither requests nor serves blocked blocks; it does **not** cover routing records; and it describes denylists as reactive: "you block bad content after it appears and keep adding entries", which "turns into whack-a-mole". IPIP-383 adds a compact format with per-entry tags such as a reason (IPFS blog, **2023-04-26**).
- Measured, Sokoto et al., "Guardians of the Galaxy: Content Moderation in the InterPlanetary File System", USENIX Security 2024 (**Aug 14-16, 2024**): 368,762 flagged files; about **87.97% DMCA**, 5.81% phishing, 0.06% terrorist, under 0.01% potential CSAM. "[O]nly the ones operated by Protocol Labs filter the entire badbits list. The other public gateways, including those operated by large CDNs, filter less than 20% of the content." Half of flagged CIDs were listed within 24 hours. More than 60% of takedown *emails* were accepted but "the majority of CID takedown requests are actually rejected", because DMCA emails carry up to eight times more CIDs and are sent "optimistically". Evasion: re-adding the same content under a different hash function evaded blocking of **97.4%** of blocked CIDs on 56 of the 57 gateways that blocked anything; a wrapping directory evaded one gateway for 67 of 68 CIDs. Authors recommend a reason taxonomy and per-jurisdiction feeds.
- Inference for BitTorrent: any re-pack (piece length, file order, torrent name) changes the infohash, so a `btih`-only list is as evadable as the CID list. A **per-file SHA-256** survives re-packing; drop-in mode already publishes one per file in `/.mw/files.json` (ARCH s3.4.1) and ARCH s7.3 verifies files before serve or upload, so a file-hash check fits at that point. Neither stops a client that ignores the list, which is why pointer withdrawal and host action stay primary.
- Operational lesson: budget for bulk, over-broad notices; require a `btih`, host or path, not a work title.
- Sources: https://usenix.org/system/files/usenixsecurity24-sokoto.pdf (read locally, 2024-08) ; https://raw.githubusercontent.com/ipfs/kubo/master/docs/content-blocking.md ; https://blog.ipfs.tech/2023-content-blocking-for-the-ipfs-stack/ (2023-04-26).

**F11 (DC). URL-reputation systems cannot see the fragment and match by host suffix: a hub gets flagged as a unit.** Confidence: high for the mechanism (Google's own doc); medium for effects on wildcard labels (not tested).
- Google Safe Browsing v4 canonicalization: "if the URL ends in a fragment, remove the fragment" (example `http://google.com/#frag` becomes `http://google.com/`). Lookups try the exact host, then up to four shorter host suffixes, and root-based path prefixes, so a listing on a parent host or path can also match names and paths beneath it, and a block cannot single out one subdomain that sits under a broader listed entry (as summarised from Google's page).
- Sokoto et al. (GSB = Google Safe Browsing): "GSB blocks 56 gateways entirely, yet it allows the downloading of all denylist content from the remaining gateways"; 95% of the blocked gateways were already offline; one gateway had 99% of its requests attributed to phishing. Gateways are a favoured phishing delivery path because no software install is needed.
- Consequence for ARCH s3.2/s3.3: on the **shared-origin hub** one bad magnet flags the host that every other site uses; on the **subdomain hub** each label is its own host (good), but the pointer lives in the fragment (`<label>.hub.example/#<pointer>`), so the reputation system sees only `<label>.hub.example/` and a listing of `hub.example` covers every label. Whether listing the hub on the Public Suffix List (PSL) changes Safe Browsing behaviour is **unverified**; PSL listing still isolates cookies and storage.
- Sources: https://developers.google.com/safe-browsing/v4/urls-hashing (undated) ; Sokoto et al. as above.

**F12. Hosts and registrars act on different things; the static host and the web-seed host are the practical chokepoints for bytes.** Confidence: high for pages read; AWS not verified.
- GitHub (DMCA takedown policy): terminates repeat infringers "in appropriate circumstances and in its sole discretion"; a claim against a whole repository disables all of it "expeditiously"; for specific content GitHub contacts the owner and gives about one business day, else disables the repository; counter-notice window "10-14 days"; redacted notices are published at github.com/github/dmca.
- Cloudflare ("Our approach to abuse"): for pass-through products (CDN, proxy) it states that it does not host the content, forwards the complaint to the site operator and hosting provider and shares the origin IP; for hosting products (Pages, Workers, Stream, Images) it may remove or disable access; copyright follows the DMCA process; it keeps a repeat-infringer termination policy; abuse form at abuse.cloudflare.com; a Transparency Report exists.
- ICANN (global DNS-abuse amendments **effective 2024-04-05**): registrars must "promptly take appropriate mitigation actions against domains for which the contracted party has actionable evidence demonstrating that the domains are being used for DNS Abuse"; the work "will neither include matters pertaining to website content abuses". So a registrar is a lever for DNS abuse on a *domain*, not for infringing pages (ICANN's usual definition covers malware, botnets, phishing, pharming and spam as a delivery vector; the page I read did not list them).
- AWS's own copyright page returned 404; its handling of S3/CloudFront content is **not verified** here.
- Consequence: put the loader host and the web-seed host under different accounts or vendors (one termination should not remove both), and expect the first practical enforcement to arrive as an account-level complaint to one of them.
- Sources: https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy ; https://www.cloudflare.com/trust-hub/abuse-approach/ ; https://www.icann.org/resources/pages/global-amendment-2024-en (2024-02-05 notice).

**F13. Decentralised systems converge on subscribable, advisory moderation lists and best-effort deletion.** Confidence: medium (Matrix spec body not read; Nostr and IPFS read).
- Nostr NIP-09 (kind 5): relays "SHOULD delete or stop publishing" the referenced events; deletion cannot be guaranteed and relays "should not be treated as authoritative". NIP-56 (kind 1984 reports): types `nudity`, `malware`, `profanity`, `illegal`, `spam`, `impersonation`, `other`; an `x` tag carries the info hash of a blob; the spec does not recommend automatic relay moderation because reports "can be easily gamed" and suggests trusted moderators.
- Matrix: the client-server API v1.19 has a "Moderation policy lists" module (section 36: `m.ban` recommendation, subscribing, client and server behaviour, security considerations; table of contents read, body not). From MSC2313 mirrors: policy rules are state events (`m.policy.rule.user|room|server`) with an entity glob, a `recommendation` and a `reason`; enforcement is left to implementers; Mjolnir and Draupnir subscribe to them. (`w2c-02` G10 reads Matrix redaction pages in full.)
- ar.io: gateways follow Arweave's "voluntary content moderation model" and block by transaction id through an admin `block-data` endpoint (search snippet only; page 404 on direct fetch).
- Takeaways: (1) separate **who publishes** a list from **who enforces** it; (2) carry a reason and a reference on every entry; (3) never auto-enforce from public, ungated reports; (4) say plainly that deletion binds cooperating nodes only (ARCH s5.8 and DESIGN-REVIEW 4.5 already do).
- Sources: https://raw.githubusercontent.com/nostr-protocol/nips/master/09.md ; .../56.md ; https://spec.matrix.org/v1.19/client-server-api/ (contents) ; MSC2313 mirrors (search blurbs).

**F14. Closest working precedents for "P2P web with real users": PeerTube (disclose, allow switching off) and Tor/EFF (conduit defence, template response).** Confidence: high for pages read.
- PeerTube admin privacy guide: the viewer's IP "is stored in the platform's BitTorrent/WebTorrent tracker" while watching and passed to other viewers, some "outside the European Union"; the admin can disable P2P in the administration interface and each user in their own settings; the player warns users and the dismissal is stored in local storage (`video-watch-privacy-concern`); "core PeerTube without plugins doesn't send personal data to any third party if P2P and remote redundancy are disabled"; admins fill a Terms section users must accept. PeerTube's practice is **notice plus switch-off**; I found no regulator decision endorsing or rejecting it.
- Tor Project / EFF: relay operators rely on s.512(a) ("material that is simply transmitted without modification"), publish a DMCA response template and warn "We cannot guarantee that you will never face any legal liability"; US wiretap-law risk arises "if they monitor, log, or disclose Tor users' communications" (so operators should not log visitor traffic they do not need).
- Sources: https://docs.joinpeertube.org/admin/privacy-guide (undated) ; https://community.torproject.org/relay/community-resources/eff-tor-legal-faq/ and .../tor-abuse-templates/ (undated).

### 3C. Privacy, storage in visitors' browsers, IP exposure, children

**F15 (DC). ePrivacy Art. 5(3) covers a Service Worker cache, IndexedDB and upload of stored pieces; the EDPB says so in terms.** Confidence: high for the guideline text; the application to P2P loaders is my inference (no regulator guidance on P2P web loaders found).
- EDPB Guidelines 2/2023 (v2.0, adopted **2024-10-07**): para 36 storage happens "by instructing software on the terminal equipment to generate specific information ... This includes making use of established protocols such as browser cookie storage as well as customized software, regardless of who created or installed the protocols or software". Para 37: no limit on duration or amount. Para 38: "the notion of storage does not depend on the type of medium". Para 12: "the notion of information includes both non-personal data and personal data". Para 44: a browser using locally stored data is not "access" "as long as the information does not leave the device, but when this information or any derivation of this information is accessed, Article 5(3) ePD would apply". Para 53: client-side code that makes processed information "available to a third-party ... would constitute a 'gaining of access to information already stored'". Para 45 treats distributed mining software as storage and its later network send as access. Paras 54-55: access to an IP address triggers Art. 5(3) only where it originates from the terminal; footnote 28 keeps "the use and function of an IP address for the establishment and conveyance or transmission of underlying technical communications" separate.
- The guidelines **expressly do not analyse the exemptions** (paras 4, 40, 56); they point to national guidance.
- Inference: registering the SW, writing files to IndexedDB or Cache Storage, and **reading them back to send to other visitors** are each Art. 5(3) acts, regardless of whether the bytes are personal data.
- Sources: https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf (read locally).

**F16 (DC). The "strictly necessary" exemption fits rendering the requested site, not sharing it with strangers.** Confidence: medium-high (WP29 is OLD but still the reference test; UK text is current).
- WP29 Opinion 04/2012 (WP194, **2012-06-07, OLD**): criterion B = "strictly necessary in order for the provider of an information society service explicitly requested by the subscriber or user to provide the service"; two tests: the user "did a positive action to request a service with a clearly defined perimeter" and "if cookies are disabled, the service will not work"; "third party" and persistent items are rarely exempt; lifespan "must be set to expire once it is not needed".
- UK PECR as substituted on **2026-02-05** (DUAA 2025 ss. 112(2), 142(1); SI 2026/82): reg 6(1) "Subject to Schedule A1, a person must not store information, or gain access to information stored, in the terminal equipment of a subscriber or user"; reg 6(2) "storing or accessing" includes instigating it. Sch. A1 para 2 consent (clear and comprehensive information plus consent; for repeated same-purpose access, "sufficient that the requirements ... are met in respect of the initial use"); para 4 strictly necessary for a service "requested by the subscriber or user" (examples: protect information, terminal security, fraud, technical faults, authentication, "maintaining a record of selections made on a website"); para 5 statistics; **para 6 appearance or functionality** ("enable an enhancement of the appearance or functionality of the website", with clear information and a "simple means of objecting, free of charge"); para 7 emergency. There is **no exception for sharing a site's files with other visitors**.
- ICO guidance (first published 2024-12-20; updated 2025-07-07 for DUAA; **last updated 2026-04-29**) lists cookies, pixels, link decoration, fingerprinting, web storage and scripts or tags; service workers are not mentioned (read through a summariser, so exact wording unverified).

| Operation in ARCH v1 | Art. 5(3) act | Exempt? (inference) | Suggested default |
|---|---|---|---|
| Register `/mw-sw.js`; precache shell | storage | Yes while used to deliver the requested site | Treat as necessary; say so in the privacy notice |
| Write the site's files so this visit renders | storage | Yes during the visit | Necessary |
| Keep those files after the visit (offline, faster return) | storage beyond need | EU: not strictly necessary unless the user asked to keep it. UK: arguably Sch. A1 para 6 with notice and objection | Put "keep on this device" in the consent card; UK may rely on para 6 |
| Pointer cache and TOFU pin | storage | Yes (security of the requested service) | Necessary |
| Create ledger identity key | storage | Only once the visitor acts (posts) | Create lazily on first write, never on page load |
| Upload stored pieces to peers (seeding) | access + transmission | **No** (benefits other visitors) | Consent (the notice/gate), off until given |
| Persist and relay other visitors' posts | storage + access | Display of posts: yes. Persisting and relaying them for others: **no** | Same consent as seeding |
| Tracker/STUN/peer connections | IP disclosure (GDPR, not Art. 5(3) per fn 28) | n/a | Consent card first (F18); web seed meanwhile |

**F17. The Digital Omnibus is not changing Art. 5(3) within the design horizon.** Confidence: medium (one tracking dossier, updated 2026-10-11).
- The Commission's November 2025 proposal would have moved terminal-equipment rules touching personal data into new GDPR Arts. 88a/88b. EUTechReg (v1.2, **updated 2026-10-11**): "GDPR Articles 88a and 88b were still deleted in the September text" (Irish Presidency compromise of 3 September, ST 12535/26) and in the 2 October text (ST 13886/26); Coreper discussed the mandate on 7 October and the vote slipped to 11 October (outcome not reported); Parliament's joint ITRE-LIBE draft report (22 June; rapporteurs Kaljurand and Salla) has tabled amendments but no committee vote. Treat Art. 5(3) as unchanged and re-check before launch.
- Source: https://research.eutechreg.com/dossiers/gdpr-reform-digital-omnibus/ (2026-10-11).

**F18 (DC). Visitor IPs are personal data; the party whose code makes the browser send them is a controller; "legitimate interest" is hard to show when an HTTP alternative exists.** Confidence: high for the case law; the conclusion for a P2P loader is inference.
- *Breyer* (C-582/14, **2016-10-19**): a dynamic IP address "constitutes personal data ... in relation to that provider, where the latter has the legal means which enable it to identify the data subject with additional data which the internet service provider has". EDPB 02/2025 also lists "IP addresses" among data processed around a ledger that "can constitute personal data". CCPA (statute text posted Aug 2024) lists "Internet Protocol address" among identifiers; COPPA (16 CFR 312.2) lists an IP address among persistent identifiers.
- *Fashion ID* (C-40/17, **2019-07-29**): a website operator that embeds a plugin causing the visitor's browser "to request content from the provider of that plugin and, to that end, to transmit to that provider personal data of the visitor can be considered to be a controller ... limited to the operation or set of operations ... in respect of which it actually determines the purposes and means, that is to say, the collection and disclosure by transmission of the data at issue"; consent and the information duty fall on that operator for those operations. By analogy the operator of a loader that makes browsers announce to trackers, query STUN and connect to peers is a controller for that transmission.
- Legitimate interest: three cumulative conditions (Mircom paras on Art. 6(1)(f)); *KNLTB* (C-621/22, **2024-10-04**): a commercial interest can qualify "provided that it is not contrary to the law" but the processing must be "strictly necessary" and not overridden; EDPB Guidelines 1/2024 on Art. 6(1)(f) (v1.0, **2024-10-08**, consultation text; final status not checked) apply the same three steps with "reasonable expectations".
- Mircom also shows the other direction. Its answer to questions 3 and 4: Art. 6(1)(f) "precludes in principle, neither the systematic recording, by the holder of intellectual property rights as well as by a third party on his or her behalf, of IP addresses of users of peer-to-peer networks whose Internet connections have allegedly been used in infringing activities", provided the requests are "justified, proportionate and not abusive" and rest on a national legal basis (Art. 15(1) of Directive 2002/58). So **third parties may lawfully log visitor IPs in the swarm**; the operator cannot prevent this and the notice must say so (README already does).
- Inference: peer IP exposure is not needed for the visitor's requested service (a web seed can deliver it), so Art. 6(1)(b) fails; Art. 6(1)(f) is arguable for resilience but weak on "strictly necessary" where a web seed exists. The single prompt that satisfies Art. 5(3) for seeding (F16) also gives a consent basis here. Where the visitor declines, serve from the web seed only (ARCH s8 "Host only").
- Sources: EUR-Lex CELEX:62014CJ0582, 62017CJ0040, 62022CJ0621, 62019CJ0597 (read locally); EDPB 1/2024 PDF (read locally).

**F19. A hosting-style exemption does not shield GDPR duties (Russmedia, 2025-12-02).** Confidence: high for the holding; applicability to chain owners is inference.
- C-492/23, Grand Chamber, operative part: the operator of an online marketplace, "as controller ... of the personal data contained in advertisements", must "before the publication ... by means of appropriate technical and organisational measures" identify ads with Art. 9(1) data, verify the advertiser is the data subject, and refuse publication absent explicit consent or another Art. 9(2) ground; must secure against copying; and "cannot rely, in respect of an infringement of the obligations arising from Article 5(2) and Articles 24 to 26 and 32 of [the GDPR], on Articles 12 to 15 of [Directive 2000/31]" (the liability exemptions that the DSA now carries).
- Inference: a site owner who enables open writing and moderates is the closest analogue to that operator (also `w2c-02` G16). Pre-publication screening is impossible in a replicated log, which argues for the owner-write default already in DESIGN-REVIEW item 4, owner-approved queues for free text, and a sealed inbox for personal data.
- Source: EUR-Lex CELEX:62023CJ0492 (read locally).

**F20. EDPB blockchain guidance applies by analogy to a replicated log; its core points are already mostly adopted in DESIGN-REVIEW item 1.** Confidence: medium (consultation text; analogy).
- Guidelines 02/2025, Version 1.1, adopted 08 April 2025 as a "version for public consultation" (final status unknown): "As a general rule, storing personal data on a blockchain should be avoided, if this conflicts with data protection principles"; public keys that can identify a natural person "by means reasonably likely to be used ... qualify as personal data"; "technical impossibility cannot be invoked to justify non-compliance with GDPR requirements"; "The rights to erasure and to object must be complied with by design"; encrypted data "is still personal data"; "the use of unsalted or unkeyed hashes should, in general, not be considered sufficient to guarantee the necessary level of confidentiality protection for storing personal data on a public blockchain"; a DPIA "is mandatory" where the processing is likely to result in high risk.
- Fit: payload-outside-hash redaction (`vh`) and tombstones (DESIGN-REVIEW item 1) are the right mechanism; keep `vh` **salted or keyed** for low-entropy values (`w2c-02` G10 notes this), round `ts`, and run the DPIA.
- Source: https://www.edpb.europa.eu/system/files/2025-04/edpb_guidelines_202502_blockchain_en.pdf (read locally).

**F21. DPIA/PIA triggers; Quebec adds three concrete duties.** Confidence: high (WP248 and the enacted Quebec Act read).
- WP29 WP248 rev.01 (EDPB-endorsed): nine criteria; "In most cases, a data controller can consider that a processing meeting two criteria would require a DPIA". Likely hits: **innovative use of new technology** (WebRTC P2P delivery plus a signed replicated log), **large scale** (number of subjects, duration, geographic extent), **vulnerable data subjects** if children use a site, arguably **systematic monitoring** (anyone in the swarm can see which site you view). Two or more: run a DPIA for hubs and for owners with material audiences.
- Quebec, Act to modernize legislative provisions as regards the protection of personal information (S.Q. 2021, c. 25, assented 2021-09-22; general commencement **2023-09-22**, s.175; read from the enacted PDF, not a consolidation): s.3.3 a privacy impact assessment "for any project to acquire, develop or overhaul an information system or electronic service delivery system involving the collection, use, communication, keeping or destruction of personal information"; s.8.1 anyone collecting personal information "using technology that includes functions allowing the person concerned to be identified, located or profiled must first inform the person (1) of the use of such technology; and (2) of the means available to activate the functions"; s.9.1 a "technological product or service having privacy settings" must give "the highest level of confidentiality by default, without any intervention by the person concerned" (browser-cookie settings excepted). Penalties: administrative monetary penalty up to **$10,000,000 or 2% of worldwide turnover** (s.90.12); penal fines up to **$25,000,000 or 4%** for listed offences.
- Inference: for Quebec visitors "Share with other visitors" is a privacy setting that should default to **off**, and the IP/location exposure to peers should be disclosed as an identify/locate function with the means to turn it on.
- Sources: WP248 PDF (https://ec.europa.eu/newsroom/document.cfm?doc_id=47711, 2017); https://www.publicationsduquebec.gouv.qc.ca/fileadmin/Fichiers_client/lois_et_reglements/LoisAnnuelles/en/2021/2021C25A.PDF (2021-09-22).

**F22. Canada's anti-spam law (CASL) is unlikely to be engaged by the JavaScript loader.** Confidence: medium.
- CASL s.10(8) (current to 2026-09-30, last amended 2026-01-01): a person "is considered to expressly consent to the installation of a computer program if" it is "a cookie", "HTML code", "Java Scripts", an operating system, a program executable only through such a program, or specified by regulation, **and** "the person's conduct is such that it is reasonable to believe that they consent". s.10(5) lists functions needing disclosure for other programs, including "collecting personal information stored on the computer system" and "causing the computer system to communicate with another computer system ... without the authorization of the owner".
- Inference: a browser-delivered loader is JavaScript; if a downloadable client (extension, desktop pin tool) is ever shipped, s.10(5) disclosures apply.
- Source: https://laws-lois.justice.gc.ca/eng/acts/E-1.6/section-10.html (read through a summariser).

**F23. US state privacy law: IP addresses count, but delivery-only exposure to peers is not obviously a "sale" or "sharing"; the CIPA pen-register theory is unverified.** Confidence: medium (CCPA); low (CIPA).
- CCPA text (cppa.ca.gov PDF, "effective 7/15/2024 - AB 3286 update"): applies to a business with annual gross revenues over **$25,000,000** (as adjusted) or that buys, sells or shares the personal information of **100,000** or more consumers or households; "personal information" includes "Internet Protocol address"; "Share" means disclosure to a third party "for cross-context behavioral advertising". Most small hubs fall below the thresholds; the thresholds are CPI-adjusted (adjusted figure not verified).
- California's CIPA s.638.51 "pen register / trap and trace" suits against third-party trackers that collect IP addresses were not verified (leginfo returned 403) and so no claim is made; flagged for counsel because trackers and STUN servers collect visitor IPs without a prompt on today's pages.

**F24. Children: IPs are COPPA "personal information", disclosure to third parties needs separate parental consent unless integral, and GDPR Art. 8 sets 16 (or a national 13-16).** Confidence: high for text; compliance date derived.
- 16 CFR 312.2 (eCFR, as amended at 90 FR 16977, **2025-04-22**): personal information includes "A persistent identifier ... includes ... an Internet Protocol (IP) address"; "support for the internal operations" includes "(ii) Perform network communications" but information so collected "cannot be used or disclosed to contact a specific individual ... or for any other purpose"; 312.5(a)(2) "separate verifiable parental consent" for disclosure to third parties "unless such disclosure is integral to the website or online service"; a mixed-audience service "shall not be deemed directed to children with regard to any visitor not identified as under 13"; a service is deemed directed to children "when it has actual knowledge that it is collecting personal information directly from users of another website or online service directed to children"; linking via "information location tools" alone does not make a service child-directed. FTC release (**2025-01-16**): effective 60 days after Federal Register publication, full compliance "one year from that publication date"; publication was 2025-04-22 (eCFR amendment citation), so the rule took effect about 2025-06-21 (the Federal Register states the exact date; not read) and full compliance fell due **2026-04-22** (derived, not read as a date on a page).
- GDPR Art. 8(1): consent for information-society services offered directly to a child is lawful "where the child is at least 16 years old" (Member States may lower to not below 13).
- Inference: peers receiving a child's IP is a disclosure to third parties that is not "integral" (the site works from the web seed). A child-directed site should run **host-only** with no ledger identity.
- Sources: https://www.ecfr.gov/current/title-16/part-312 (API render, read locally) ; https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data (2025-01-16) ; https://gdpr-info.eu/art-8-gdpr/.

### 3D. Mandatory reporting, orders, and child-safety tooling

**F25. US: report apparent CSAM on actual knowledge; no duty to scan; keep the report's contents one year; fines are tiered by size.** Confidence: high (statute page read through a summariser; amendments shown).
- 18 U.S.C. 2258A(a)(1): a provider "shall, as soon as reasonably possible after obtaining actual knowledge" of the listed facts, report to the NCMEC CyberTipline; (f): nothing requires a provider to "monitor any user, subscriber, or customer" or to affirmatively search, screen or scan; (h): a completed report is a request to preserve the reported contents for **1 year**; (e) knowing and willful failure: up to **$850,000** (provider with 100,000,000 or more monthly active users) or **$600,000** (fewer) for a first failure, **$1,000,000** / **$850,000** after. Amended by Pub. L. 118-59 (**2024-05-07**: preservation 90 days to 1 year, higher penalties) and Pub. L. 119-60 (**2025-12-18**).
- Inference (counsel to confirm): a hub or web-seed host that is told of a magnet or URL containing apparent CSAM has "actual knowledge" of facts to report even though it holds no bytes. **Do not download or open the material to confirm**; report the address and context. The Sokoto authors followed the same rule: they "never inspect the material" and did not download content recorded under CSAM takedown requests, "instead ... shared this information with the IWF".
- Source: https://www.law.cornell.edu/uscode/text/18/2258A .

**F26. Canada: a mandatory-reporting Act already covers "Internet content hosting" and today preserves for 21 days.** Confidence: high (current to 2026-09-30, last amended 2025-10-10).
- Act respecting the mandatory reporting of Internet child sexual abuse and exploitation material by persons who provide an Internet service (S.C. 2011, c. 4): applies to anyone providing Internet access, content hosting or email to the public; s.2 report an address "as soon as feasible" to the designated organization; s.3 notify police on reasonable grounds; s.4 preserve related data **21 days**; s.6 no duty to seek out the material; s.7 no civil proceeding for a good-faith report; s.10 penalties for persons other than individuals up to $10,000, $50,000, $100,000 (first, second, subsequent). Amendments in 2026, c. 19 (not yet in force) would extend preservation to **one year**.
- Source: https://laws-lois.justice.gc.ca/eng/acts/I-20.7/FullText.html .

**F27 (DC for EU-facing operators). EU: a one-hour removal clock, e-evidence representatives from 2026-08-18, and the DSA criminal-suspicion duty.** Confidence: high for texts; medium for who is in scope.
- Terrorist Content Online Regulation (EU) 2021/784 Art. 3(3): hosting providers "shall remove terrorist content or disable access to terrorist content in all Member States as soon as possible and in any event within **one hour** of receipt of the removal order". Art. 5(4): exposure is established by "two or more final removal orders in the previous 12 months". Contact points under Art. 15.
- E-evidence: Regulation (EU) 2023/1543 "shall apply from 18 August 2026"; Directive (EU) 2023/1544 Art. 3(6): providers offering services in the Union on 18 February 2026 must designate establishments or appoint legal representatives "by 18 August 2026", later entrants within six months. Scope (Art. 2(1)): includes information-society services that "enable their users to communicate with each other" or "make it possible to store or otherwise process data on behalf of the users to whom the service is provided, provided that the storage of data is a defining component of the service"; recital 47 names marketplaces and other hosting services.
- DSA Art. 9 (orders against illegal content: inform the authority of "any effect given to the order without undue delay") and Art. 18 (above).
- Inference: a tiny hub that offers a posting site to EU users is plausibly in scope of all three; none has a small-business exemption in the text I read. Confirm "offering services in the Union" (substantial connection) before paying for a representative.
- Sources: EUR-Lex CELEX:32021R0784, 32023R1543, 32023L1544 (read locally).

**F28. Hash-matching tools exist, but a P2P hub sees no bytes: use them only where bytes are handled.** Confidence: high for what the vendors say; the placement conclusion is inference.
- Microsoft PhotoDNA: Cloud Service "free for qualified customers"; apply through a form; "is not facial recognition software"; hash cannot be reversed; the page does not mention on-premises distribution (page undated, (c) 2026).
- Cloudflare CSAM Scanning Tool (docs, **last updated 2026-05-01**): compares "content served for your website through the Cloudflare cache to known lists of CSAM" from child-safety groups such as NCMEC; daily email with file paths; a block is applied "if possible" and may fail; only cached content is scanned; **the customer must report** to NCMEC or the competent authority and preserve content and related data; no pricing on the page.
- Meta PDQ (ThreatExchange repo): perceptual hash using DCT; the README suggests starting thresholds of distance "<=31" and quality "<=49" to tune; licence not stated on the README page.
- IWF membership: members receive "licenced access to our dynamic blocking lists and our alerts services"; fees not shown on the page I could read.
- Inference: (1) the **web-seed/CDN** is the only place a magnet-web operator handles complete files; enable Cloudflare's tool there if it fronts the seed; (2) a pin or seedbox service that stores others' files is a host and should apply for PhotoDNA before launch; (3) do not ship secret-hash lists to browsers, which would leak them; client-side blocking should use *public, operator-curated* denylists only; (4) CSAM handling is by reporting and pointer/host action, not by matching in the swarm.
- Sources: https://www.microsoft.com/en-us/photodna ; https://developers.cloudflare.com/cache/reference/csam-scanning/ (2026-05-01) ; https://raw.githubusercontent.com/facebook/ThreatExchange/main/pdq/README.md ; https://www.iwf.org.uk/membership/ .

**F29. EU interim rules for voluntary CSAM detection lapsed on 2026-04-03 and were renewed to 2028-04-03; the permanent regulation is still in trilogue.** Confidence: low-medium (secondary sources only; not confirmed on EUR-Lex).
- Search-result summaries (LexisNexis, dig.watch, Euronews 2026-07-28, nicfab.eu) report: Parliament rejected the extension of Regulation (EU) 2021/1232 on 2026-03-26 (228 to 311, 92 abstentions); the derogation lapsed 2026-04-03; a new Regulation (EU) 2026/1881 was passed by Parliament 2026-07-09 and by the Council by written procedure on 2026-07-23 (25 for, 1 against, 1 abstention), valid to 2028-04-03 and excluding end-to-end-encrypted services; the permanent CSA Regulation had "compromises on almost the entire Regulation" on 2026-06-29. Relevance is limited: magnet-web has no private messaging, so there is nothing for an operator to voluntarily scan.

### 3E. Operations: contact points, notice formats, transparency

**F30. Abuse and security contacts are standardised and cheap.** Confidence: high.
- RFC 2142 (**May 1997, OLD** but still the reference): "the <ABUSE@COMPANY.COM> address must be valid and supported" at the organization's top-level domain; SECURITY for security bulletins or queries; NOC for network operations.
- RFC 9116 (April 2022): `security.txt` at `/.well-known/security.txt`; fields `Contact` (required), `Expires` (required), `Encryption`, `Acknowledgments`, `Preferred-Languages`, `Canonical`, `Policy`, `Hiring`.
- DSA Arts. 11-12 require single points of contact (recipients' channel "shall not solely rely on automated tools"); ICANN 2024 requires registrars' abuse contacts to be "readily accessible".
- Sources: https://www.rfc-editor.org/rfc/rfc2142.txt ; https://www.rfc-editor.org/rfc/rfc9116.txt .

**F31. One intake form can satisfy DMCA, DSA and Canadian notices; Canada also bans settlement demands inside a notice.** Confidence: high for DSA and Canada (full text read); DMCA elements (i)-(iv) are the statute's standard list, (v)-(vi) quoted from the page.

| Element | DMCA s.512(c)(3)(A) | DSA Art. 16(2) | Canada s.41.25(2)-(3) |
|---|---|---|---|
| Who is complaining | (i) signature, (iv) contact details | (c) name and email (except offences in Arts. 3-7 of Directive 2011/93/EU) | (a) name and address |
| What right / why illegal | (ii) the work | (a) "sufficiently substantiated explanation of the reasons" | (b) the work, (c) claimant's interest, (e) the infringement |
| Where | (iii) material and information to locate it | (b) "exact electronic location ... such as the exact URL or URLs" | (d) location data, (f) date and time |
| Good faith and accuracy | (v) good-faith belief; (vi) accuracy and authority "under penalty of perjury" | (d) bona fide belief that the information and allegations "are accurate and complete" | none |
| Forbidden content | none | none | (3)(a)-(c) no offer to settle, no demand for payment or personal information, no reference to one |
| Effect | gives knowledge; counter-notice route (g) | Art. 16(3): knowledge if no "detailed legal examination" is needed; Arts. 16(4)-(5) acknowledge and notify decision | provider forwards (s.41.26) |

For magnet-web, "location" must be a tuple the operator can act on: **hub label or hostname, `btih`, file path, and (for ledger posts) block hash `h`**. A bare work title is not actionable.

**F32. Transparency reporting is a legal duty only above the micro/small line, but a minimal report is cheap and is the best evidence of good faith.** Confidence: high.
- DSA Art. 15(1) list (orders by type and median time; notices by type, actions, automated handling, median time; own-initiative moderation; complaints; automated means) and Implementing Regulation 2024/2835 (annual 1 January-31 December, public within two months, Annex I templates from 2025-07-01). Art. 15(2) exempts micro and small enterprises that are not very large online platforms.
- Practice: GitHub publishes redacted notices and counter-notices at github.com/github/dmca; Lumen (a Harvard Law School Library research project; its page reports over seventy-five million notices as of June 2026) collects takedown and other legal-removal notices voluntarily shared by companies and does not verify claims.
- Sources: Implementing Regulation 2024/2835 (CELEX 32024R2835, read locally) ; https://lumendatabase.org/pages/about ; GitHub policy page (above).

## 4. Takedown ladder: what each lever does, and what nothing can do

Reasoning built on ARCH v1 (s4, s5.8, s6.2, s7.3, kill switch in DESIGN-REVIEW item 20) plus F10-F12. "Proposed" marks things not in ARCH v1 yet.

| Level | Who acts | Mechanism | New visitors | Visitors who already hold it, and seeders | Typical latency |
|---|---|---|---|---|---|
| L0 Publisher withdrawal | Site owner | Sign pointer `seq+1`; today publish a new version (DESIGN-REVIEW 21). Proposed: `st=withdrawn` with `btih` of 40 zeros so older loaders fail closed; remove `<meta>`, TXT, web-seed objects | Nothing to load; rollback refusal stops stale pointer replay | Loader sees the higher `seq` on DoH recheck (min 5 min), `focus`, or reload; stops seeding the old `btih` at once (s5.8); **offline devices keep the files until they reconnect**; s5.8 keeps the previous version too (gap for legal removal, see R2) | Minutes while a tab is open; unbounded for offline devices |
| L1 Hub gate | Hub operator | Refuse the redirect in the s3.2 gate for a label or magnet; no listing | Not reachable via that hub | None (does not touch other hubs or per-domain deployments) | Immediate |
| L2 Client denylist (proposed) | Hub operator and owner (signed lists) | Match `btih`, host, or per-file SHA-256 at announce, serve, seed, render | Loader refuses | Purged and stopped at next list refresh | List TTL: hub-mode load revalidates each time; others at most 1 hour |
| L3 Infrastructure | Web-seed host, loader host, CDN, registrar (DNS abuse only), tracker operator (allowlist) | Disable object or account; ship the kill-switch SW; suspend domain; drop infohash from `tracker.mjs --allow` | HTTP path gone; peers may still serve if reachable | P2P-only persists among peers that have the pointer | Host-dependent (GitHub: about one business day for specific content) |
| L4 Orders | Courts and authorities | DSA Art. 9; TCO (one hour); injunctions | As ordered | As ordered | Statutory |
| L5 Ledger moderation | Owner and moderators | `tombstone` drops `v`, `ban` voids an author, per ARCH s6.2 and DESIGN-REVIEW 1 | Newcomers receive stubs only | Cooperating nodes purge; others keep | Gossip-bound |

**What nothing can do:** recall bytes from a client that ignores the list or runs modified code; revoke an infohash; prevent re-publication under a new infohash, label or domain (whack-a-mole, F10); delete logs held by third-party trackers, STUN servers and DoH resolvers. Say so in the README and ToS (DESIGN-REVIEW 24 already requires the honesty layer).

## 5. Recommendations for magnet-web

Priorities: **P0** before any public hub or "migrate your existing site" launch; **P1** before general availability; **P2** within the first quarter in production; **P3** watch/optional. Effort: S under 2 days, M under 2 weeks, L over 2 weeks of one engineer. Each item names the ARCH v1 / DESIGN-REVIEW text it amends. Counsel should review R1, R5, R6 and Appendix B before use.

| ID | Pri | Effort | What | Amends |
|---|---|---|---|---|
| R1 | P0 | M | A real choice in the first-run card, a versioned consent record, a CMP bridge | ARCH s8, s3.4.9; DESIGN-REVIEW 12 |
| R2 | P0 | M | Pointer fields for withdrawal, abuse contact, audience; withdrawal purges all versions | ARCH s4, s5.8; DESIGN-REVIEW 21 |
| R3 | P0 | L | Signed, double-hashed client denylist that stops announce, serve, seed and render | new module; ARCH s5.3-5.4, s7.3 |
| R4 | P0 | M | Hub hardening: apex is a gate only, no directory or search, allowlist default, PSL and reputation monitoring, report link | ARCH s3.2-3.3 |
| R5 | P0 (hub) / P2 (code only) | S | Operator registrations and mailboxes | DEPLOY.md, hub runbook |
| R6 | P0 | M | Privacy package: notice, ROPA, DPIA, Quebec PIA, recipients register | new `docs/PRIVACY.md` |
| R7 | P0 | M | Notice-and-action runbook, intake form, case log, time-to-block drill in the release gate | DESIGN-REVIEW 25; ARCH s12 |
| R8 | P0 | S | Owner duties text: provider, controller, minors, PII, moderation policy | DEPLOY.md; ARCH s6 |
| R9 | P1 | S | Canada notice-and-notice forwarder procedure | runbook |
| R10 | P1 | S-M | CSAM, terror and imminent-harm playbook; one-hour path; scanning at the web seed | runbook; CDN config |
| R11 | P1 | M | Moderator console and sealed report channel (no owner key in browsers) | ARCH s6.2 |
| R12 | P1 | S | Transparency page, annual report, notice archive | runbook |
| R13 | P1 | S | Infrastructure separation and dependency register; kill-switch drill | DESIGN-REVIEW 20 |
| R14 | P1 | S-M | Audience flags (`aud=kids`, `aud=sensitive`) forcing host-only | ARCH s4, s8 |
| R15 | P1 | S | Legal migration checklist for existing sites | DEPLOY.md |
| R16 | P1 | S | Tracker and STUN posture and recipients disclosure | DESIGN-REVIEW 12 |
| R17 | P2 | M | "What this device shares" panel with stop and forget | ARCH s8, s5.10 |
| R18 | P2 | S-M | Append-only moderation audit log and statements of reasons | runbook |
| R19 | P2 | S | Counsel review package, entity and insurance decisions | - |
| R20 | P2 | S | ToS role clauses | Appendix B4 |
| R21 | P2 | S | Jurisdiction decisions (EU, UK, Canada, Quebec) and representatives | - |
| R22 | P3 | S | Watch list of pending law and cases | - |
| R23 | P3 | M | Optional PDQ check in the publish tool or a pin service | tools/ |
| R24 | P3 | S | Counter-notice and appeals tooling | runbook |

### P0

**R1. A real choice in the first-run card, a consent record, and a CMP (consent management platform) bridge.** Effort M.
- ARCH s8 already shows the notice *before* the first announce and starts only the HTTP web-seed download until `[OK]`; keep that order. Gaps (F15, F16, F18, F21): the non-gated card has `[Settings][OK]` and no refusal on the same layer; uploads then default on for Wi-Fi; there is no versioned record; drop-in sites that already run a consent manager have no bridge.
- Change: (a) make the non-gated card the same two-action card as the gate when `ws=`/`xs=` exists: **`[Share and load]` `[Load from host only]`**, plus `[Settings]`; the site renders from the web seed while the card is open. (b) Make `consent=gate` the documented default for any site with personal data or an EEA, UK or Quebec audience; `consent=notice` stays available as the owner's explicit, documented choice (DEPLOY says which sites it fits). Do **not** infer region from the browser (inaccurate and itself privacy-invasive); one global default avoids it. (c) Store `{consentVersion, choice, ts (day precision), scope}` in `prefs`; bump `consentVersion` whenever the card text, tracker or STUN recipients, or retention change, and re-ask. Withdrawal in Settings must be as easy as giving it (GDPR Art. 7(3)-(4)); "Host only" already exists. (d) CMP bridge: `data-mw-consent="external"` on the script tag makes the engine wait for `mw.consent.accept()`/`reject()` from the site's consent manager; document the mapping for common CMPs. (e) Card text names the recipient categories ("connection servers and STUN servers run by third parties", "other visitors", "anyone who knows the site's infohash can see who is online") and says what is stored on the device and why (PECR Sch. A1 para 2 "clear and comprehensive information"). Quebec: nothing pre-selected, "Share" never defaults on (s.9.1 of the Quebec Act).
- Accept (E2E): with `consent=gate` the first run opens **no** tracker WebSocket and creates **no** `RTCPeerConnection` before a click and still renders from the web seed; after `[Load from host only]` there are still none; after `[Share and load]` announces start; a `consentVersion` bump re-prompts; CMP mode starts nothing until `mw.consent.accept()`.

**R2. Pointer fields for withdrawal, contact and audience; withdrawal purges every version.** Effort M.
- ARCH s4 keeps and signs unknown keys, so additions are backward compatible. Add optional: `st=active|withdrawn`; `ct=<https URL or mailto: URI>` (abuse and legal contact shown in the gate, error pages and the report link); `lg=<https URL>` (privacy/terms page shown in the card); `aud=general|kids|sensitive` (R14); optional `why=owner|copyright|court|tos` on a withdrawal.
- **Withdrawn record:** a signed record with `st=withdrawn` and `btih` of 40 zeros, higher `seq`. New loaders purge *all* stored versions for the scope, stop seeding and show the notice with `ct`; **older loaders ignore `st` but cannot fetch the zero infohash, so they fail closed** (the higher-`seq` record has superseded the cached one, so the cache fallback in s4 source 4 is not taken).
- Amend ARCH s5.8 "keep at most the current version and the previous one": on withdrawal or a denylist hit keep **none** (the previous version may be the one complained about). Amend DESIGN-REVIEW 21's DEPLOY sentence to include the offline-device caveat and the withdrawal procedure (`publish.mjs --withdraw`).
- Accept: unit tests for parse, sign and verify with the new keys, rollback refusal, and zero-btih handling; E2E: after a withdrawal, IndexedDB holds no rows for the scope after one recheck, no announce for the old `btih` appears, and the unmodified v1 loader fixture shows its "no peers" error rather than content.

**R3. A signed, double-hashed client denylist.** Effort L.
- New `denylist.js` and a static `/_mw/deny.json` (hub or host) plus optional owner list `dl=<https URL>` in the pointer. Entry: `{k:'btih'|'file'|'host'|'label', h:<sha256 hex>, r:<reason code>, ref:<case id or Lumen URL>, t:<unix>}`; `btih`, `host` and `label` entries hash the lowercase value, `file` entries hash the file bytes. Lists are signed (ECDSA P-256), carry monotonic `seq` and `exp`, and are verified against a pinned hub key (hub list) or the owner key (owner list). Reason codes: `copyright`, `phishing`, `malware`, `court`, `owner`, `tos`; **no CSAM content hashes in public lists** (use IWF/NCMEC channels, F28); pointer-level entries are enough.
- Enforcement points: before any network I/O at pointer resolution (host, label, `btih`); after download or from IndexedDB before serve or upload, using the per-file SHA-256 that drop-in already ships (ARCH s3.4.1, s7.3); refuse to serve pieces for a blocked `btih` on the wire; skip ledger payloads whose `vh` is listed. Fail safe: a list that cannot be fetched keeps the last good list (warn after N days) and **never blocks an unlisted site**; unsigned lists are ignored.
- Freshness: hub-mode loads revalidate (ETag) every time; other modes at most hourly. UI on a hit: "This content has been removed. Reason: <r>. Reference: <ref>. Contact: <ct>." plus an appeal link (R24).
- Governance: every entry needs a `ref`; host-level entries need a second reviewer; log each change (R18).
- Why: F2 (s.512(d)(3) remedy is disabling the reference), F5 (technological measures a diligent operator would take), F8 (s.27(2.4)(d)), F10 (file-hash dual key survives re-packing).
- Accept: unit tests for matching and signature; E2E: add a `btih`, and within one refresh seeding stops and announces stop; re-pack the same files with a different piece length and they are still blocked by file hash; a failing list fetch keeps the previous list; an unlisted site still loads.

**R4. Hub hardening.** Effort M.
- Amend ARCH s3.2: the hub **apex serves the gate only and never renders third-party content**; production hubs require wildcard certificate, PSL listing, and an **allowlist mode (default)** where the gate refuses unknown labels; "open hub" is an explicit, documented risk acceptance. No directory, search, "recent sites", featured list or recommendation feed at the hub (F5); if a catalogue is wanted, it is an operator-curated allowlist and the operator then runs full notice-and-action. Permanent banner on every label gains **"Report this site"** (prefilled with label, `btih`, `ct`). The repeat-infringer policy (s.512(i)(1)(A) needs "account holders") keys on **owner key fingerprint + registrable domain + verified contact**; the allowlist is what gives the hub a contact to terminate.
- Amend ARCH s3.3: the shared-origin hub is demo-only; add a build flag (`--demo-hub`) that refuses to serve it on any host except localhost and RFC 1918 addresses.
- Operate: register the hub domains in Google Search Console, watch Safe Browsing site status, keep a "Deceptive site ahead" review runbook (F11). Whether PSL listing alters reputation scoping is untested; test with a controlled bad label before launch.
- Accept: build refuses the shared-origin hub on a public hostname; in allowlist mode the gate rejects an unknown label; the banner link prefilled correctly; the runbook exists.

**R5. Operator registrations and mailboxes.** Effort S. P0 for any entity that operates a hub or hosts third-party bytes; P2 for a code-only maintainer.
- US: register a **DMCA designated agent** at the Copyright Office (online, $6, renew within three years; calendar a reminder at 30 days) before relying on s.512(c)/(d); publish the agent contact on the site.
- Mailboxes on the operating domain: `abuse@`, `dmca@` (or the agent alias), `privacy@`, `security@` (RFC 2142 requires `abuse@` to be valid); publish `/.well-known/security.txt` with `Contact` and `Expires` (RFC 9116); one legal/abuse page (Appendix B5, B10).
- EU/UK: if the hub offers services in the Union and the operator is outside it, decide the **legal representative** (DSA Art. 13; GDPR Art. 27 unless the processing is occasional and low-risk; e-evidence Directive Art. 3(6), due 2026-08-18 and therefore already applicable) and the **TCO contact point** (Art. 15) once any removal order is received; DSA single points of contact (Arts. 11-12) can be the same mailbox plus a form.
- Accept: a checklist signed off in the hub runbook with dates; a test email to each mailbox is acknowledged by a human within one business day.

**R6. Privacy package.** Effort M.
- Create `docs/PRIVACY.md` from Appendix B3. Contents: controller identity per deployment type (F18), purposes and bases (consent for peer connections and seeding; necessity for rendering), **recipients register** (static host, web-seed host, trackers, STUN, DoH resolvers, other visitors; per ARCH s4 and DESIGN-REVIEW 12), retention (host logs, tracker logs if run), transfers, rights and how to exercise them, breach contacts (Art. 33: 72 hours), children.
- Run a **DPIA** (WP248: innovative technology, scale, vulnerable people, monitoring) for hubs and for owners above a modest audience, and a **Quebec privacy impact assessment** (s.3.3) if Quebec residents are served; record the decision not to log visitor IPs on operator-run services.
- Accept: documents exist, are linked from the card, the gate, Settings and the legal page, and every recipient named in the pointer's `tr` list or in `CONFIG.stun` appears in the register.

**R7. Notice-and-action runbook and a measured time-to-block.** Effort M.
- Write `docs/ABUSE-RUNBOOK.md` from Appendix A. Intake page `/report` (static; composes a prefilled email or opens a form) collecting the F31 fields and the technical tuple (label or host, `btih`, path, block hash). Case log schema in A3. Statement-of-reasons template (B7) to owners; counter-notice flow.
- Add a **takedown drill row to the ARCH s12 manual release gate** (DESIGN-REVIEW 25): time from receiving a test notice to (a) denylist published, (b) a running loader stopping seeding, (c) the hub gate refusing; targets: P0 under 60 minutes (the TCO clock), P2 under 24 hours.
- Accept: DEMO-RESULTS.md holds the measured times and the date of the last drill.

**R8. Owner duties text.** Effort S.
- Add to DEPLOY.md an "Owner duties" section: you are the publisher of your site and ledger; with open writing you are the UK OSA "provider" if you control who can post (F9) and the closest analogue to the controller in Russmedia (F19), so keep `writers:'owner'` unless you accept those duties; no personal data in public keys, values or `ts` (round it); use the sealed inbox for contact-form data (`w2c-02`); publish your moderation policy and complaint route (DSA Art. 14(1) content); put `ct=` in the pointer; keep the owner key off browsers (ARCH s6.2); how to withdraw (R2).
- Accept: DEPLOY.md section exists; `publish.mjs` warns when a pointer has `writers:'open'` and no `ct`.

### P1

**R9. Canada notice-and-notice forwarder.** Effort S. For any hub or host with Canadian users: forward a compliant notice "as soon as feasible" to the owner, record the forwarding, keep identifying records six months (one year if proceedings are notified), treat a notice that contains a settlement offer or a demand for payment or personal information as non-compliant under s.41.25(3); the forwarding duty in s.41.26(1) is framed for compliant notices (summary read, text not re-read in full), so decide with counsel whether to forward, strip or refuse. Missing the duty costs statutory damages of $5,000-$10,000. Template B6.

**R10. CSAM, terror and imminent-harm playbook.** Effort S-M.
- Rules: never download, open or forward the material to verify; capture only the notice, URL or tuple and timestamps; report to NCMEC (US operators, 2258A) or the designated organization and police (Canada, 21-day preservation; one year when 2026 c. 19 is in force) or the national hotline (INHOPE members) or IWF (UK); preserve the report contents one year; apply the pointer, gate and denylist blocks immediately; tell the owner only if counsel and the authority agree (Canada s.5 bars disclosing a report or notification if that could prejudice a criminal investigation).
- One-hour path: a named person, a monitored contact, and a runbook that gets a hub denylist entry live within an hour; for EU orders also DSA Art. 9 feedback "without undue delay".
- Tooling: enable the Cloudflare CSAM Scanning Tool on any Cloudflare-fronted web seed (best effort, cache-served only); apply for PhotoDNA before launching any pin or seedbox service that stores others' files; accept that a pure hub has no bytes to match (F28).
- Staff safety: viewing is not required; limit exposure; no one reviews alone.

**R11. Moderator console and sealed reports.** Effort M. ARCH s6.2 keeps the owner key out of browsers, so build a headless Node console (same protocol as `pin.mjs`) that holds owner or moderator keys, reads **sealed reports** (encrypted to the moderator key; never public ledger events, because public reports can dox the reporter and "can be easily gamed", F13), applies `tombstone`/`ban` in batches with reason codes, and exports a case file for R18. Do not auto-enforce from report counts.

**R12. Transparency page and annual report.** Effort S. Publish `/transparency` yearly (1 January-31 December, within two months) even if exempt under DSA Art. 15(2): counts of notices by type and source, actions, median time to act, counter-notices and outcomes, government orders, denylist size, repeat-infringer terminations. Archive redacted notices in a public repository or submit to Lumen where lawful.

**R13. Infrastructure separation and dependency register.** Effort S. Keep loader host, web-seed host, tracker and DoH on separate accounts; a register lists each vendor, its abuse policy URL (GitHub and Cloudflare read; AWS unverified), its termination triggers and an alternate. Drill the kill switch (DESIGN-REVIEW 20) once per release. Keep a second web-seed host for continuity.

**R14. Audience flags.** Effort S-M. `aud=kids` forces host-only (no trackers, no WebRTC), read-only ledger with no identity and no gossip; `aud=sensitive` forces `consent=gate` with "Load from host only" preselected; the loader refuses `p2p` on `aud=kids` even if the owner sets `consent=notice`. Hub ToS bars child-directed sites in P2P mode. Rationale: F24, and swarm membership reveals what a visitor reads (special-category inference).
- Accept: with `aud=kids` a network log shows zero peer or tracker traffic; ledger writes fail with a clear message.

**R15. Legal migration checklist for existing sites** (the "migrate easily" goal). Effort S. DEPLOY.md and `publish.mjs --dropin` output a checklist: list current cookies, trackers and consent manager; update the privacy policy with Appendix B3 text; wire the CMP (R1d); decide `consent=gate|notice`; audit any imported user data for personal information before `tools/import` (`w2c-02` R14); add `ct=`; publish abuse contact; confirm host AUP allows this use; keep the host-served documents as the fallback (ARCH s3.4.8).

**R16. Tracker and STUN posture.** Effort S. Do not operate an open public tracker (`tracker.mjs` already refuses without `--allow`); if the project ships a default tracker or STUN list, name those operators as recipients in the card and PRIVACY.md and re-ask consent when the list changes (R1c). Public trackers publish no abuse policy (`02-wss-trackers.md` F12), so complaints about swarm membership will not be resolved there.

### P2 and P3

**R17. "What this device shares" panel.** Effort M. In Settings list each site held, bytes uploaded, peer count, "Stop sharing" and "Forget this site" (ARCH s8 has Forget); reflect withdrawals and denylist hits. Gives informed-consent substance (Mircom paras 48-49 cut both ways, F6) and supports Art. 7 withdrawal.

**R18. Audit log and statements of reasons.** Effort S-M. Append-only, hash-chained JSON Lines of each notice, decision, list change, statement of reasons (DSA Art. 17(3) fields) and appeal, with a retention schedule (Appendix A5).

**R19. Counsel package; entity and insurance.** Effort S. Questions for counsel are in section 7; decide the operating entity (not a person) and whether media-liability insurance is available for a P2P hub.

**R20. ToS role clauses.** Effort S. Appendix B4: owner is publisher; hub is a technical gateway with no editorial control; right to block; no promotion of infringement; honesty about what takedown can and cannot do.

**R21. Jurisdiction decisions.** Effort S. For each of EU, UK, Canada (and Quebec) decide: targeted or not (language, currency, marketing), representatives (R5), UK OSA risk assessment for any hub or site with user posting (F9), Quebec officer and PIA (F21).

**R22. Watch list.** Effort S. Post-Cox decisions on P2P services; *Kadrey v. Meta* on seeding; Digital Omnibus Council mandate; EDPB final 1/2024 and 02/2025; Ofcom codes for small user-to-user services; Reg. (EU) 2026/1881 text; ICO/CNIL on service workers; California CIPA pen-register decisions and SB 690.

**R23. Optional perceptual-hash check.** Effort M. A publish-time opt-in PDQ check for image-heavy sites and a mandatory PhotoDNA step in any pin service; confirm PDQ's licence first.

**R24. Counter-notice and appeals tooling.** Effort S. A form and procedure that restores content after the statutory window unless the claimant files suit (US 10-14 business days, s.512(g)(2)(C)); EU internal complaint route for hosts above the micro/small line (Art. 20 applies only to online platforms; offer one anyway); log outcomes.

## 6. Gotchas

1. **The URL fragment is invisible to reputation systems and servers.** Safe Browsing deletes it; hub labels carry the pointer in it. One flag can cover every label under a listed parent (F11).
2. **A `btih`-only blocklist is evaded by re-packing.** Piece length, name or file order changes the infohash; use a per-file SHA-256 as the second key (F10).
3. **Withdrawal does not reach devices that stay offline.** ARCH s5.8 also keeps the *previous* version; for a legal removal keep none (R2).
4. **Informing visitors about seeding is both required and incriminating.** Mircom ties deliberateness to being "duly informed"; bound what a browser seeds instead of hiding the disclosure (F6).
5. **A lapsed DMCA agent designation silently weakens s.512(c)/(d).** The designation "expires and becomes invalid" after three years (2019 source, OLD); put the renewal in a calendar and on the A2 list.
6. **Counter-notice clocks differ.** US statute: restore after "not less than 10, nor more than 14, business days"; GitHub's page says "10-14 days"; Canada has no counter-notice but a six-month record duty; the DSA wants a statement of reasons and, for larger platforms, an internal complaint route.
7. **The DSA small-business relief is partial.** No yearly report and no online-platform section, but contacts, terms, notice-and-action, statements of reasons and Art. 18 still apply (F3).
8. **Expect bulk, over-broad notices.** On IPFS, over 60% of emails were accepted yet most CIDs were rejected; review per item and never auto-remove on a keyword (F10).
9. **Never open suspected CSAM to check it.** Report from the notice and the address; limit who sees anything; staff exposure is a harm in itself (F25, R10).
10. **Public report events on the ledger expose the reporter.** Use sealed reports and treat counts as advisory (F13, R11).
11. **Author keys, timestamps and unsalted hashes are identifiers.** EDPB treats public keys as personal data and calls unsalted hashes insufficient: round `ts`, salt or key `vh`, rotate device keys (F20).
12. **A consent manager can break P2P.** If the site's CMP blocks the engine until "marketing" consent, sharing will rarely start. Map it to a functional or sharing category and do not bundle it with advertising consent.
13. **The static host always sees the first visit's IP.** Turn off optional access logs (S3 and CloudFront access logging are opt-in, from general knowledge, not verified here) or disclose them; the host is a recipient (R6).
14. **Drop-in keeps the host as the legal chokepoint.** HTML stays on the host (ARCH s3.4.1), so a host takedown removes the pages even if the assets live in the swarm; shell mode is the more resilient and the more exposed.
15. **Marketing words create liability.** "Uncensorable", "cannot be taken down" and piracy-flavoured examples feed Cox inducement and Canada s.27(2.4)(a); DESIGN-REVIEW 24's honesty layer is also a legal control.
16. **Cox v. Sony does not remove the need for s.512.** It narrowed *contributory* liability only; direct and vicarious theories and statutory-damages exposure remain, and end-user seeders have no safe harbour.
17. **Official EU texts can be hard to fetch.** EUR-Lex answered HTTP 202 (WAF) intermittently; a verbatim mirror was used for the DSA articles and cross-checked against EUR-Lex for recital 28 and the Implementing Regulation.
18. **Two EDPB texts are consultation versions** (02/2025 v1.1, 1/2024 v1.0); the Quebec text read is the enacted Act, not a consolidation.

## 7. Open questions and unverified items

**Could not be verified in this run (search quota exhausted or site blocked):**
- California CIPA s.638.51 pen-register suits against trackers and SB 690's status (leginfo 403). Matters because trackers and STUN servers collect IPs without a prompt.
- Ofcom's Online Safety Act codes and small-service guidance, including hash-matching measures (ofcom.org.uk 403); the statute text (ss. 3, 4, 226) was read.
- AWS's copyright and abuse policy for S3/CloudFront (page 404).
- Matrix's spec body for moderation policy lists (table of contents and MSC2313 mirrors only).
- Regulation (EU) 2026/1881 on EUR-Lex (secondary sources only) and the permanent CSA Regulation.
- Final adoption of EDPB Guidelines 1/2024 and 02/2025; the effect of CJEU C-413/23 P (EDPS v SRB) on hashed or pseudonymised identifiers (also unread in `w2c-02`).
- A 2026 Copyright Office page restating the DMCA agent fee and three-year renewal; the COPPA compliance date is derived from the FTC release and the Federal Register date, not read as a date.
- Any post-Cox lower-court decision about P2P services; any ruling on seeding as "distribution" (Kadrey is pending).
- IWF membership fees; PhotoDNA eligibility for a very small operator; PDQ's licence.
- EU-US transfer status for US-based trackers and STUN servers (adequacy challenge), and GDPR Art. 3(2) "targeting" for a global English-language loader (EDPB Guidelines 3/2018 not read).

**Genuinely unknown (no authority found):**
- Who is the DSA "provider" of a decentralised, owner-moderated ledger, and whether a hub that stores nothing but causes browsers to fetch and render third-party content fits Arts. 4-6.
- Whether any DPA treats a Service Worker cache as strictly necessary, or treats WebRTC peer IP exposure as needing consent rather than legitimate interest. PeerTube's notice-plus-switch-off is practice, not endorsement.
- Whether monitoring firms or rights-holders join WebRTC-only WebTorrent swarms, and what notices result. A cheap experiment: publish a harmless canary site and look for non-browser or headless peers over a month.
- Whether Safe Browsing and similar systems scope PSL-listed wildcard labels separately (R4 test).
- Whether a Canadian hub that stores no content is within s.41.25(1)'s three categories, and the Quebec Commission d'acces a l'information's view on IP addresses and peer exposure under s.8.1.

**Questions for counsel (package for R19):**
1. Which entity and jurisdiction should operate a hub, and is media-liability cover obtainable?
2. Does the two-action card (`Share and load` / `Load from host only`) plus Settings withdrawal meet ePrivacy Art. 5(3), GDPR consent, PECR Sch. A1 and Quebec s.8.1/s.9.1 for the intended audiences?
3. Controller allocation between site owner, hub operator and third-party tracker/STUN operators (Fashion ID); do we need Art. 26 arrangements?
4. OSA and DSA provider status of an owner who runs `writers:'owner'` versus `open`.
5. DMCA agent, repeat-infringer policy wording keyed on owner key and contact, and counter-notice procedure.
6. EU representative scope under DSA Art. 13, GDPR Art. 27, e-evidence Directive Art. 3, and TCO contact points.
7. NCMEC ESP registration and Canadian designated-organization process for a hub that never holds bytes.
8. Quebec privacy impact assessment scope and officer designation.

## Appendix A. Operations checklist

Written for a **hub operator**; a site owner running their own domain does the same items for their own site. Times are recommendations unless a legal source is cited. The only hard clock found is the EU terrorist-content one hour (Reg. 2021/784 Art. 3(3)); the rest are "expeditiously" (DMCA, DSA Art. 6, UK ECR reg 19) or "as soon as feasible" (Canada s.41.26).

### A1. Before launch

- [ ] Operating entity chosen (not an individual); counsel engaged; insurance quote asked (R19).
- [ ] Mailboxes live and monitored: `abuse@`, `dmca@`, `privacy@`, `security@`; a test message to each was acknowledged by a human within one business day (RFC 2142).
- [ ] `/.well-known/security.txt` published with `Contact`, `Expires` (under one year), `Canonical`, `Policy` (RFC 9116).
- [ ] US: DMCA designated agent registered online; agent contact published; renewal reminder set for 2 years 11 months from registration.
- [ ] Published and linked from the card, gate, Settings and footer: Terms and AUP (B4), Copyright and abuse policy with repeat-infringer and counter-notice sections (B5), Privacy notice (B3), Transparency page (B8), children statement.
- [ ] DSA basics, if the service reaches the EU: authority contact and recipient contact with languages (Arts. 11-12); legal representative if non-EU (Art. 13); terms describe moderation measures, tools and the complaint route (Art. 14(1)).
- [ ] Hub: allowlist mode on; apex serves the gate only; no directory or search; wildcard certificate; PSL listing; Search Console and Safe Browsing monitoring; "Report this site" in the banner (R4).
- [ ] Denylist: signing key generated offline; public key pinned in the loader build; publish procedure rehearsed; second reviewer configured for host-level entries (R3).
- [ ] Case log in an access-controlled, encrypted store; retention schedule adopted (A5).
- [ ] Consent: card text reviewed by counsel; `consentVersion` set; CMP bridge documented (R1).
- [ ] DPIA, ROPA, recipients register and, if Quebec is served, privacy impact assessment completed and dated (R6).
- [ ] Tracker and STUN lists reviewed; each operator appears in the recipients register (R16).
- [ ] Contacts directory filled: NCMEC CyberTipline (US) or the Canadian designated organization and police liaison; IWF or national INHOPE hotline; EU TCO competent authority; data-protection authority; counsel on call.
- [ ] **Takedown drill done:** a test notice measured to (a) denylist published, (b) a running loader stops seeding, (c) the gate refuses; P0 under 60 minutes, P2 under 24 hours; result written to DEMO-RESULTS.md (R7).
- [ ] Safety protocol for harmful material: nobody opens suspected CSAM; nobody reviews alone; support contact available.

### A2. Recurring

| Cadence | Task |
|---|---|
| Daily | Triage `abuse@` and `dmca@`; acknowledge within one business day |
| Weekly | Open-case review; review denylist changes; check Safe Browsing and Search Console status |
| Monthly | Denylist expiry and false-positive review; vendor abuse-policy check; back up the case log |
| Quarterly | Privacy review (tracker or STUN change means bump `consentVersion`); kill-switch drill (DESIGN-REVIEW 20); contact-directory check |
| Yearly | Transparency report (by end of February for the prior calendar year); DMCA agent renewal check; refresh `security.txt` `Expires`; counsel review of Terms, policies, DPIA; staff refresher |
| On event | New law or case (R22); new tracker, STUN or hosting vendor; new target jurisdiction; any incident |

### A3. Notice runbook

| Class | Examples | Acknowledge | Act | Notes |
|---|---|---|---|---|
| P0 | CSAM, terrorist content, imminent threat to life or safety | Within 1 hour (on-call or automated) | Block (gate, pointer, denylist) within 1 hour of a credible report; report to the authority the same day | Do not open or copy the material. Preserve the report contents (US 1 year; Canada 21 days, 1 year when 2026 c. 19 is in force). EU removal orders: one hour. |
| P1 | Court or regulator order; law-enforcement request | Same business day | By the deadline in the order; tell the issuing authority "without undue delay" what was done (DSA Art. 9) | Counsel before any disclosure of user data. |
| P2 | Copyright (DMCA, DSA, Canadian notice), phishing and malware, privacy erasure, defamation | Within 1 business day | Phishing and malware within 24 hours; others within 2 business days | Statement of reasons to the owner (B7); counter-notice route open. |
| P3 | Terms violations, spam, other | Within 3 business days | Within 5 business days | Keep the record anyway. |

Steps for every class:
1. **Log:** case id, received-at (UTC), channel, the raw notice stored unmodified with a SHA-256.
2. **Acknowledge:** B6(a).
3. **Validate** against the F31 table. If deficient, send B6(b) and wait, **except P0**: act on any credible report and ask for detail afterwards.
4. **Identify the tuple:** hub label or hostname, `btih`, file path, ledger block hash. No tuple, no action.
5. **Pick the lever** (section 4): owner contact, pointer/gate block (L1), denylist (L2), host action (L3), ledger moderation (L5). Prefer the narrowest lever that stops the harm.
6. **Apply** and record the denylist `ref` and `seq`.
7. **Tell the owner** with a statement of reasons (B7) and the redress routes.
8. **Counter-notice:** US, forward to the claimant and restore after "not less than 10, nor more than 14, business days" unless suit is filed; EU, run the complaint route and a human review; Canada, record only.
9. **Close:** record time to act and outcome; update the repeat-infringer ledger; add to the yearly statistics.
10. **Escalate to counsel** when: any order; law-enforcement contact; any CSAM or terror case; a request to identify visitors; threatened litigation; the same claimant sends repeated bulk notices; a notice looks abusive (s.512(f) misrepresentation).

### A4. Privacy requests and incidents

- Access or erasure request: search what the operator actually holds (host logs if enabled; tracker logs if self-run); for ledger posts the author can tombstone their own block and moderators can redact; tell the requester plainly that cooperating nodes will purge and others may keep copies. Respond within the statutory period (one month under the GDPR, from memory, not re-read this run).
- Personal-data breach: assess risk; notify the supervisory authority without undue delay and where feasible within **72 hours** (GDPR Art. 33(1)); Quebec confidentiality-incident duties sit in ss. 3.5-3.8 of the private-sector Act (commenced 2022-09-22 per s.175 of the enacted Act; content not read).

### A5. Retention (suggested unless a source is cited)

| Record | Keep | Source or basis |
|---|---|---|
| CyberTipline report contents and related data | 1 year minimum | 18 U.S.C. 2258A(h) |
| Canadian reported data | 21 days (1 year once 2026 c. 19 is in force) | S.C. 2011, c. 4 s.4 |
| Canadian notice-and-notice identifying records | 6 months; 1 year if proceedings are notified | Copyright Act s.41.26(1)(b) |
| Case files and notices | 3 years after closure | suggested |
| Denylist change log and audit log | life of the entry plus 3 years | suggested |
| Operator access logs, if any | 7 to 30 days, then delete | suggested; disclose in the privacy notice |
| Tracker logs | none (do not log infohash plus IP) | suggested |
| Consent records | on the visitor's device only | R1(c) |

## Appendix B. Template text (drafts for counsel review, not legal advice)

Placeholders are in `<angle brackets>`. Replace every one before use. Where a template makes a factual statement (for example "we do not log visitor IP addresses") it must be true for your deployment.

### B1. First-run card (replaces the `[Settings][OK]` notice when a web seed exists)

> **This site is delivered peer-to-peer.**
> If you choose to share, your browser connects to other visitors and to connection servers run by third parties. They can see your IP address and that you are viewing this site, and anyone who knows this site's address can join and see who is online. While this page is open your browser may upload this site's files and posts to other visitors, which uses bandwidth and battery. This site also keeps its files and settings on this device so it loads faster and works offline.
> You can load the site from its host only, with no peer connections, and change your mind any time in Settings.
> **[Share and load]  [Load from host only]**  [Settings]  [Privacy and contact]

Settings strings: "Sharing with other visitors: On / Off. Off stops uploads and peer connections." "Forget this site: deletes the files and settings this device holds for this site and stops sharing it." Host-only mode label: "Host only: no peer connections. Slower, and shared data will not sync."

### B2. Removal or withdrawal page

> **This content is no longer available here.**
> Reason: `<reason code in plain words>`. Reference: `<case or notice id>`.
> Your browser has stopped sharing it and has deleted its copy. Other visitors or other software may still hold copies that we cannot reach.
> If you think this is a mistake, contact `<ct>`. [Appeal]

### B3. Privacy notice skeleton

1. **Who we are.** `<Entity>`, `<postal address>`, `<privacy@…>`. Privacy lead / DPO: `<name or role>`. EU or UK representative, if any: `<name, address>`. Quebec person in charge of personal information: `<name, contact>`.
2. **What this service does.** It loads `<site>` from other visitors' browsers and from `<host>`, and keeps a shared message log for the site.
3. **Who receives your data, and why.**

| Recipient | What they see | Why | Basis | Kept |
|---|---|---|---|---|
| `<Static host>` | IP address, requested URL, browser details | Serve the loader and files | Necessity to provide the site; security | `<N days>` or none |
| `<Web-seed host>` | IP address, requested byte ranges | Serve files when no peers are online | Same | `<N days>` or none |
| Connection servers (WebSocket trackers) `<names>` | IP address, the site's infohash, time | Introduce you to other visitors | Your consent | Set by the operator: `<link>` |
| STUN servers `<names>` | IP address | Work out how peers can reach you | Your consent | Set by the operator: `<link>` |
| DNS-over-HTTPS resolver `<name>` | The name `_magnet.<your site>` | Look up the site's pointer | `<basis>` | Set by the operator: `<link>` |
| Other visitors | IP address, that you view this site, your posting key and posts, the files you upload | Share the site and its log | Your consent | Until they delete it |
| The site owner | Posts you write | Run the site | Your request | As the site states |

4. **What is stored on your device.** The loader (a service worker), the site's files, a cached pointer, your sharing choice and its version, and, only if you write, a signing key. How to delete: Settings, Forget this site, or clear site data.
5. **Your choice.** Peer connections and sharing happen only if you choose "Share and load". You can withdraw at any time in Settings. Choosing "Load from host only" never connects you to peers.
6. **Public by design.** Posts and your posting key are visible to everyone in the swarm and are copied by other visitors. You can delete your own posts, and cooperating visitors will remove them, but we cannot force every copy to be deleted.
7. **Others may record IP addresses.** Anyone can join a swarm and record the addresses they see, including copyright holders and researchers. We do not control this.
8. **Children.** `<Statement: not directed to children / child-directed sites run host-only>`.
9. **Transfers.** `<Where hosts, trackers, STUN and resolvers are located and the transfer mechanism>`.
10. **Your rights.** Access, correction, erasure, objection, withdrawal of consent, and a complaint to `<supervisory authority>`. Contact `<privacy@…>`. We hold little about you; we will tell you what we hold.
11. **Changes.** If this notice or the recipients change, we ask for your choice again.

### B4. Terms and acceptable use for a hub operator (clause skeleton)

1. **Our role.** `<Hub>` is a technical gateway that fetches and displays sites published by third parties. We do not create, select, edit or promote Sites and we do not store Site content. The **Site Owner**, meaning whoever holds the key that signs the Site's pointer, is the publisher and is responsible for the Site and its message log.
2. **Allowed and not allowed.** No content that is unlawful where the Site Owner or visitors are; no infringing content; no child sexual abuse material and no terrorist content; no malware or phishing; no doxxing or threats; no Site directed to children in peer-to-peer mode; no attempt to get around a block.
3. **Site Owners must:** have the right to publish the content; publish a privacy notice and a working contact (`ct`); answer notices within `<2>` business days; moderate their message log; honour erasure requests; keep their signing key secure.
4. **Notices and removal.** We act on notices as described in our Copyright and Abuse Policy (B5). We may block a label, hostname, infohash or file hash at any time, remove a Site from the allowlist, and end access for repeat infringers. We tell Site Owners why, when we can lawfully do so (B7).
5. **Moderation we use (DSA Art. 14(1)).** Allowlist review of new Sites; a signed block list; notices from the public; human review of every removal; no automated ranking or recommendation; a complaint and appeal route at `<URL>`.
6. **Visitors.** Sharing is optional. If you choose it, your browser uploads pieces of the Site to other visitors and they can see your IP address. Content on a Site is the Owner's, not ours.
7. **What removal can and cannot do.** We can stop this gateway and cooperating browsers from loading or sharing something. We cannot delete copies held by other software or visitors who do not cooperate, and we cannot stop someone publishing the same material under a new address.
8. **No promotion of infringement.** We do not market this service for infringing use.
9. **Liability, governing law, changes, contact.** `<counsel to complete>`.

### B5. Copyright and abuse policy

> **Reporting content.** Send a notice to `<dmca@…>` or to our designated agent: `<name>`, `<address>`, `<email>`, `<phone>`. A notice should include:
> 1. Your physical or electronic signature.
> 2. What you say is protected (the work) and your right in it.
> 3. Where the material is: the hub address or label, the infohash (`btih`), the file path, and for a message-log post the block hash. A title alone is not enough for us to find it.
> 4. Your name, address and email.
> 5. A statement that you believe in good faith that the use is not authorised by the owner, its agent or the law.
> 6. A statement, under penalty of perjury, that the notice is accurate and that you are authorised to act for the owner.
> 7. For the EU: a sufficiently substantiated explanation of why the content is illegal and a statement that you believe the information and allegations are accurate and complete.
> Notices that contain an offer to settle or a demand for payment or personal information do not comply with Canadian rules and may be returned. Knowingly false notices can lead to liability.
>
> **Counter-notice.** If we removed or blocked something and you think that was a mistake, send: your signature; what was removed and where it was; a statement under penalty of perjury that you believe in good faith it was removed by mistake or misidentification; your name, address and phone; and consent to the jurisdiction required by 17 U.S.C. 512(g)(3). Unless the claimant tells us it has started court action, we restore access between 10 and 14 business days after receiving a valid counter-notice.
>
> **Repeat infringers.** In appropriate circumstances we end the access of Site Owners who repeatedly infringe. We treat a Site Owner as a repeat infringer after `<3>` valid notices within `<24>` months that were not successfully counter-noticed, counted by signing key, registered domain and verified contact. We may block the key and domain.

### B6. Emails

**(a) Acknowledgement.** "We received your notice on `<date>` (case `<id>`). We will review it and tell you what we decide. If anything required is missing we will say what."

**(b) Deficient notice.** "We could not act on notice `<id>` because it does not yet identify `<missing item>`. We need the hub address or label, the infohash, and the file path or post hash. A work title on its own does not let us find content. `<If Canada: Your notice contains an offer to settle or a demand for payment or personal information, which section 41.25(3) of the Copyright Act does not allow. Please resend it without that.>`"

**(c) Reply to a rights-holder about visitors.** "`<Hub>` is a gateway. We do not store or host the files of Sites; visitors' browsers exchange pieces with each other. We do not log visitor IP addresses on our services and cannot identify individual visitors `<verify this is true>`. We have blocked `<label or hash>` on `<date>` (reference `<id>`). Please send further notices to `<dmca@…>`."

**(d) Forward to the owner (Canada and general).** "We received the attached notice about `<tuple>` on `<date>`. We are forwarding it as required. `<If action taken: We have blocked access pending your response.>` You can answer at `<contact>` within `<N>` business days. Your options are in the attached statement."

**(e) Counter-notice received.** "We received your counter-notice on `<date>`. We have sent it to the claimant. Unless they tell us they have started court action, we will restore access between `<date range>`."

### B7. Statement of reasons to a Site Owner (DSA Art. 17(3) fields)

1. Decision: `<removed / access disabled / demoted / suspended / terminated>`; scope `<territory>`; duration `<permanent / until …>`.
2. Facts and circumstances: `<what and when>`; based on `<a notice (sender withheld unless strictly necessary) / our own review>`.
3. Automated means used: `<none>`.
4. Legal ground and why: `<law and explanation>` **or** contractual ground and why: `<clause and explanation>`.
5. How to challenge: internal review at `<URL>`; out-of-court dispute settlement `<if available>`; the courts.

### B8. Transparency report skeleton (per DSA Art. 15 and Implementing Regulation 2024/2835; period 1 January-31 December)

| Item | Count / value |
|---|---|
| Orders from authorities, by type and Member State; median time to inform and to act | |
| Notices received, by alleged illegal content type; from trusted flaggers; action taken (law vs terms); automated handling; median time to act | |
| Own-initiative moderation: measures, tools, detection method, restriction type | |
| Complaints received, decisions, median time, reversals | |
| Use of automated means: purpose, accuracy, safeguards | none |
| Denylist: entries added, removed, total; reasons | |
| Repeat-infringer terminations | |
| Notices forwarded under Canadian rules | |

### B9. Pointer additions and denylist file (proposal, R2 and R3)

Pointer (extra keys are signed and ignored by older loaders):

    v=mw1; btih=<hex>; ws=<url>; xs=<url>; tr=<wss>; owner=<key>; seq=<n>; exp=<unix>;
    consent=gate; ct=mailto:abuse@example.com; lg=https://example.com/legal; aud=general; sig=<…>

Withdrawn:

    v=mw1; btih=0000000000000000000000000000000000000000; st=withdrawn; why=copyright;
    ct=mailto:abuse@example.com; owner=<key>; seq=<n+1>; exp=<unix>; sig=<…>

Denylist (`/_mw/deny.json`, ECDSA P-256 signature over the canonical JSON):

    { "v": 1, "seq": 42, "exp": 1792000000, "entries": [
      { "k": "btih",  "h": "<sha256 of lowercase btih>",     "r": "copyright", "ref": "case-2026-0113", "t": 1791000000 },
      { "k": "file",  "h": "<sha256 of file bytes>",          "r": "malware",   "ref": "case-2026-0120", "t": 1791100000 },
      { "k": "label", "h": "<sha256 of lowercase hub label>", "r": "phishing",  "ref": "case-2026-0121", "t": 1791200000 } ],
      "sig": "<b64url>" }

### B10. Contact page and `security.txt`

> **Report abuse:** `abuse@<domain>`, or use `/report`. **Copyright notices:** `dmca@<domain>`; designated agent `<name, address>`. **Privacy:** `privacy@<domain>`. **Security:** `security@<domain>`. Orders from authorities: `<authority contact>`; languages: `<list>`. We acknowledge every report within one business day. Emergencies involving a threat to life: contact local emergency services first.

    Contact: mailto:security@example.com
    Expires: 2027-06-30T00:00:00.000Z
    Preferred-Languages: en, fr
    Canonical: https://example.com/.well-known/security.txt
    Policy: https://example.com/legal/security

### B11. README paragraph on takedown (honesty layer)

> There is no central place to delete a site. To remove content, the owner publishes a withdrawal; loaders that see it stop sharing and delete their copy, and gateways keep a signed block list that loaders honour. Devices that are offline keep their copy until they reconnect. Software that ignores these signals can still hold and share the files, and the same files can be published again under a new address. Peers, trackers and STUN servers can see visitors' IP addresses. We do not promote this service for infringing use.

## Appendix C. Sources actually read

Read mode: **local** = downloaded and read as text on this machine (verbatim); **summ** = read through the WebFetch summariser (short fragments, treat paraphrase as unverified); **snippet** = search-result blurb only, not opened (used only for corroboration, never as the sole basis). Dates are the source's own where shown; `OLD` = more than about four years old.

**United States**
- 17 U.S.C. 512, https://www.law.cornell.edu/uscode/text/17/512 (summ; last amendment shown 2010). 17 U.S.C. 504, https://www.law.cornell.edu/uscode/text/17/504 (summ). 18 U.S.C. 2258A, https://www.law.cornell.edu/uscode/text/18/2258A (summ; amended 2024-05-07 and 2025-12-18).
- Cox v. Sony, No. 24-171 (2026-03-25), https://caselaw.findlaw.com/court/us-supreme-court/24-171.html (summ). Corroboration: AIPLA 2026-03-25, Quinn Emanuel, Holland & Knight 2026-04, Ballard Spahr 2026-04, Berkeley BCLT (snippet).
- Copyright Office: https://www.copyright.gov/dmca-directory/ (summ), https://www.copyright.gov/about/fees.html (summ), Library of Congress blog 2019-10-17 https://blogs.loc.gov/copyright/2019/10/it-may-be-time-to-renew-your-dmca-agent-registration/ (summ, OLD).
- Kadrey v. Meta: https://torrentfreak.com/judge-allows-bittorrent-seeding-claims-against-meta-despite-lawyers-lame-excuses/ (summ, 2026-03-30); trackers (snippet).
- 16 CFR Part 312, https://www.ecfr.gov/current/title-16/part-312 (local; amended 90 FR 16977, 2025-04-22). FTC release 2025-01-16 https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data (summ).
- CCPA text, https://cppa.ca.gov/regulations/pdf/cppa_act.pdf (local; "effective 7/15/2024", posted August 2024).
- UW study, https://dmca.cs.washington.edu/ (summ; 2008, OLD).

**European Union**
- DSA articles 3-19 and index, preamble recitals 21-30: https://www.eu-digital-services-act.com/ (local; unofficial verbatim mirror). Implementing Regulation (EU) 2024/2835, Reg. (EU) 2021/784, Reg. (EU) 2023/1543, Dir. (EU) 2023/1544 on EUR-Lex (local; CELEX 32024R2835, 32021R0784, 32023R1543, 32023L1544).
- CJEU on EUR-Lex (local): C-610/15 Ziggo (2017-06-14, OLD), C-582/14 Breyer (2016-10-19, OLD), C-40/17 Fashion ID (2019-07-29), C-597/19 Mircom (2021-06-17), C-682/18 and C-683/18 YouTube/Cyando (2021-06-22), C-621/22 KNLTB (2024-10-04), C-492/23 Russmedia (2025-12-02).
- EDPB Guidelines 2/2023 v2.0 (2024-10-07), 02/2025 v1.1 (2025-04-08), 1/2024 v1.0 (2024-10-08) (local PDFs); WP29 Opinion 04/2012 WP194 (2012-06-07, OLD) and WP248 rev.01 (2017) (local PDFs).
- GDPR Arts. 4, 7, 8, 13, 27, 33 and recital 32, https://gdpr-info.eu/ (local).
- Digital Omnibus status: https://research.eutechreg.com/dossiers/gdpr-reform-digital-omnibus/ (summ; 2026-10-11). EU interim CSAM rules: LexisNexis, dig.watch, Euronews 2026-07-28, nicfab.eu (snippet only).

**United Kingdom**
- PECR reg 6 and Schedule A1, ECR 2002 reg 19, Online Safety Act 2023 ss. 3, 4, 226 on legislation.gov.uk (local; PECR substituted 2026-02-05). ICO guidance https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/ (summ; updated 2026-04-29). DUAA commentary: kukie.io, bratby.law, consenttrail.co.uk (snippet).

**Canada**
- Copyright Act ss. 27, 31.1, 38.1, 41.25, 41.26 (local for 27, 31.1, 41.25; summ for 38.1, 41.26), https://laws-lois.justice.gc.ca/eng/acts/C-42/ (current to 2026-09-30). CASL s.10, https://laws-lois.justice.gc.ca/eng/acts/E-1.6/section-10.html (summ; current to 2026-09-30). Mandatory-reporting Act S.C. 2011 c. 4, https://laws-lois.justice.gc.ca/eng/acts/I-20.7/FullText.html (summ; current to 2026-09-30).
- Quebec Bill 64 as enacted (S.Q. 2021, c. 25), https://www.publicationsduquebec.gouv.qc.ca/fileadmin/Fichiers_client/lois_et_reglements/LoisAnnuelles/en/2021/2021C25A.PDF (local; 2021-09-22).

**Decentralised-web precedent and platforms**
- Sokoto et al., USENIX Security 2024, https://usenix.org/system/files/usenixsecurity24-sokoto.pdf (local). IPFS blog https://blog.ipfs.tech/2023-content-blocking-for-the-ipfs-stack/ (summ, 2023-04-26). Kubo docs https://raw.githubusercontent.com/ipfs/kubo/master/docs/content-blocking.md (summ).
- PeerTube admin privacy guide https://docs.joinpeertube.org/admin/privacy-guide (summ). Tor/EFF https://community.torproject.org/relay/community-resources/eff-tor-legal-faq/ and .../tor-abuse-templates/ (local).
- Nostr NIP-09 and NIP-56 (summ). Matrix spec v1.19 contents https://spec.matrix.org/v1.19/client-server-api/ (summ; body not read). ar.io moderation (snippet).
- Google Safe Browsing https://developers.google.com/safe-browsing/v4/urls-hashing (summ). GitHub DMCA policy https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy (summ). Cloudflare https://www.cloudflare.com/trust-hub/abuse-approach/ (summ) and https://developers.cloudflare.com/cache/reference/csam-scanning/ (summ; 2026-05-01). ICANN https://www.icann.org/resources/pages/global-amendment-2024-en (summ; 2024-02-05).
- Microsoft PhotoDNA https://www.microsoft.com/en-us/photodna (summ), IWF https://www.iwf.org.uk/membership/ (summ), Meta PDQ https://raw.githubusercontent.com/facebook/ThreatExchange/main/pdq/README.md (summ), Lumen https://lumendatabase.org/pages/about (summ).
- RFC 2142 (1997, OLD) and RFC 9116 (2022) on rfc-editor.org (local).

## Appendix D. Cross-references to local documents

- `docs/ARCHITECTURE.md` v1: s3.2-3.4 (modes, gate, drop-in), s4 (pointer v1, `consent=`), s5.7-5.8 (consent, takedown), s6.2 (owner, moderators), s7.3 (verify before serve or upload), s8 (policy and consent), s12 (tests, release gate), s13.
- `docs/review/DESIGN-REVIEW.md`: items 1 (redactable blocks), 4 (owner-write default), 12 (third parties and consent), 20 (kill switch), 21 (takedown), 24 (honesty layer), 25 (release gate), wording 4.5 (IP exposure strings).
- `docs/review/security.md` M6 (third-party exposure), M8 (retention and takedown); `docs/research/02-wss-trackers.md` F12 (no tracker abuse policies); `docs/research/03-webrtc-nat-privacy.md` R-11 (earlier disclosure draft; B1 supersedes it for the choice layer); `docs/research/06-browser-chain-vs-crdt.md` 3.1.5 (moderation ops); `docs/research/w2c-02-chain-production-features.md` G10-G16 (redaction by commitment, erasure, controller question).
