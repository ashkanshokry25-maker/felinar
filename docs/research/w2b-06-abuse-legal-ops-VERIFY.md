# w2b-06 VERIFY: skeptical re-check of eight design-critical claims (abuse, legal and privacy operations)

**Project:** magnet-web (static loader + WebTorrent/WebRTC + Service Worker + per-site signed log)
**Target of this check:** `docs/research/w2b-06-abuse-legal-ops.md` (701 lines, written 2026-10-17 17:29). That file was **not edited**; section 11 lists proposed replacement wording.
**Run date:** 2026-10-17. **Run type:** resumed after an interruption. Before starting I checked `docs/research/`, the session scratchpad and a project-wide `find`: no earlier VERIFY file or partial output existed, so nothing could be lost or overwritten, and this is a clean run.
**This is not legal advice.** It re-checks what sources say; it does not tell anyone what the law requires of a particular operator.

## 0. Method, limits and labels

**Method.** For every claim I downloaded the primary source directly (curl; EUR-Lex answered on the first try, no WAF retries were needed), extracted text (`pdftotext`, or a small stdlib HTML-to-text script run with `python3 -I`), and compared the claim's quotations, paragraph numbers and figures with the verbatim text. Where the original report had read a source "through a summariser", I read the full text instead (notably the Cox opinion: the FindLaw copy named in the claim returns an HTTP 403 Cloudflare challenge, "Just a moment...", to non-browser clients, so I used the Supreme Court's own PDF). Downloaded files are untrusted data: each sat in its own directory outside the project tree, and my scripts lived in a separate directory. Hashes of everything used are in Appendix A.

**Limits, stated plainly.**
- The shared WebSearch budget (200 per turn across all agents) was **already exhausted when this run began**; my one search call was refused. I did not work around it: no search engine, proxy, archive or reader service was used. Every URL I fetched was either named in a claim or reached through a link on a primary page (the supremecourt.gov slip-opinion list, EUR-Lex document-information pages, Google's own navigation, raw source files on GitHub). So "fresh searches" were not possible; "re-opening primary sources" was.
- Consequently **not checked** (listed per claim as unknown): any post-Cox lower-court decision; national transpositions and regulator guidance; Safari and other closed-source browsers' Safe Browsing behaviour; the current status of pending CJEU references.
- Chromium and Firefox source were read from their `main` branches on 2026-10-17. Code moves; file hashes are recorded.
- I read one figure (Fig. 18 of the USENIX paper) by rendering the PDF page and measuring the bars by eye at 300 dpi; those numbers are approximate (about plus or minus 2 points) and are labelled as such.

**Labels.**
- **confirmed**: every checkable statement matches the primary source; anything I add is a scope note that does not change the claim's design consequence.
- **nuanced**: at least one statement is imprecise, overstated, out of date or incomplete in a way that could change what a reader cites or decides.
- **refuted**: a central statement is contradicted by the primary source. (None this time.)
- **unverifiable**: the primary source could not be read. (None this time.)
"Inference" marks reasoning that sits on top of a source, whether the original author's or mine.

## 1. Verdicts at a glance

| # | Claim (short) | Verdict | The correction that matters most |
|---|---|---|---|
| 1 | US contributory liability needs intent: Cox v. Sony, 2026-03-25 | **confirmed** | The final sentence ("risk shifts to direct/vicarious theories") is inference; the majority says nothing on those theories. Cite supremecourt.gov, not FindLaw. |
| 2 | DSA relief for micro/small is partial; Arts. 11-14, 16-18 still apply; Impl. Reg. 2024/2835 | **confirmed** | Art. 19(1) keeps Art. 24(3); Art. 17 applies only where contact details are known (Art. 17(2)); Art. 18 is limited to threats to life or safety. |
| 3 | CJEU Ziggo (2017) and YouTube/Cyando (2021) | **confirmed** | Quotes are exact, but Ziggo is fact-bound, Cyando expressly excludes Art. 17 of Directive 2019/790, and GS Media (hyperlinks) is missing. |
| 4 | CJEU Mircom (2021): seeders, "duly informed", no safe harbour | **nuanced** | The "deliberate" holding is conditional on informed, active subscription (left to the national court); "no safe harbour" is not in the judgment. |
| 5 | Canada: s.31.1(5), s.27(2.3)-(2.4), ss.41.25-41.26, s.38.1(1)(b) | **nuanced** | s.27(2.3) is a civil infringement, not an "offence"; s.31.1(6) also removes hosting protection; s.41.26 duties do not apply to information location tools; enabler damages are deemed commercial (s.38.1(1.11)). |
| 6 | Hash denylists: Kubo/NOpfs and the USENIX 2024 IPFS study | **nuanced** | "Others filter under 20%" fails for the ipfs.tech-listed public gateways (about 54% blocked in the paper's own Fig. 18); 97.4% is from a 100-CID phishing sample; BEP 52 already defines a per-file SHA-256 root that WebTorrent does not implement. |
| 7 | Safe Browsing strips the fragment, matches host suffix and path prefix; PSL effect "untested" | **nuanced** | Mechanics right, but the cited page documents a deprecated API (v4). Chromium and Firefox source show private-section PSL entries are **not** used, so PSL-listing the hub does not stop a parent listing from covering every label. |
| 8 | EDPB Guidelines 2/2023 v2.0 and ePrivacy Art. 5(3) | **nuanced** | Every quotation verifies, but the guidelines never name Service Workers, Cache Storage, IndexedDB, WebRTC or P2P; that application is our inference, not "the EDPB says so in terms". |

## 2. Claim 1: US contributory liability now requires intent (Cox v. Sony)

**Claim.** Contributory copyright liability now requires intent, shown only by inducement ("actively encourages infringement through specific acts") or a service tailored to infringement (no substantial noninfringing uses); mere knowledge is insufficient. *Cox v. Sony*, No. 24-171, decided 2026-03-25, Thomas J.; Sotomayor and Jackson concur in judgment only. The Court did not decide whether Cox met the s.512 repeat-infringer requirement. So a general-purpose loader's risk shifts to inducement and to direct/vicarious theories.

**Verdict: confirmed.** One sentence is inference (see correction 1).

**Re-checked against.**
- Supreme Court slip-opinion list, OT2025: https://www.supremecourt.gov/opinions/slipopinion/25 (row 22: 3/25/26, No. 24-171, author "T", 607 U.S. 583).
- Preliminary print, read in full (26 pages): https://www.supremecourt.gov/opinions/25pdf/607us2r22_k4lo.pdf (marked "Page Proof Pending Publication"; its closing errata list only typographical edits that do not touch any quotation below).

**What matches (verbatim, with page of 607 U.S.).**
- Vote and date (p. 585, syllabus). "Argued December 1, 2025-Decided March 25, 2026." "Thomas, J., delivered the opinion of the Court, in which Roberts, C. J., and Alito, Kagan, Gorsuch, Kavanaugh, and Barrett, JJ., joined. Sotomayor, J., filed an opinion concurring in the judgment, in which Jackson, J., joined." Judgment: reversed and remanded.
- Rule (pp. 592-593). "The provider of a service is contributorily liable for the user's infringement only if it intended that the provided service be used for infringement. The intent required for contributory liability can be shown only if the party induced the infringement or the provided service is tailored to that infringement."
- Inducement (p. 593). "A provider induces infringement if it actively encourages infringement through specific acts." The Court's example is Grokster, where the companies "promoted and marketed their software as a tool to infringe copyrights."
- Tailored (p. 593). "A service is tailored to infringement if it is 'not capable of "substantial" or "commercially significant" noninfringing uses.'" (The claim's "no substantial noninfringing uses" is a fair compression.)
- Knowledge (p. 594). "This Court has repeatedly made clear that mere knowledge that a service will be used to infringe is insufficient to establish the required intent to infringe."
- Application (pp. 595-596). The Fourth Circuit's rule ("supplying a product with knowledge that the recipient will use it to infringe copyrights is ... sufficient") "went beyond the two forms of liability recognized in Grokster and Sony" and conflicted with the Court's admonition "that contributory liability cannot rest only on a provider's knowledge of infringement and insufficient action to prevent it." Cox "repeatedly discouraged copyright infringement by sending warnings, suspending services, and terminating accounts."
- s.512 not decided. The footnote on pp. 591-592 says Cox "could not invoke the DMCA safe-harbor defense based on its efforts to reduce infringement because an earlier decision had foreclosed that defense for the relevant period" (93 F.4th 222, 228, citing *BMG Rights Mgmt. v. Cox*, 881 F.3d 293, 301-305 (CA4 2018)). Part IV (p. 596) answers only Sony's argument that the DMCA presupposes ISP liability: "The DMCA merely creates new defenses from liability for such providers", citing s.512(l). Nothing decides whether Cox met s.512(i)(1)(A). (The Fourth Circuit's earlier adverse ruling on that point was not before the Court and is not disturbed.)

**Corrections and nuances.**
1. **Inference, not holding.** "Risk shifts to ... direct/vicarious theories" is the original author's reading (the source report's F1 labels it "Inference for us"; the relayed claim dropped the label). The majority discusses vicarious liability only in procedural history (the Fourth Circuit reversed on it; "We denied Sony's petition for a writ of certiorari regarding vicarious liability. 606 U.S. 931 (2025)") and says nothing about direct liability. The only judicial statement that other bases survive is in Sotomayor's concurrence, footnote at p. 602: "Under the majority's view, ISPs could still face secondary liability if they design their service to facilitate infringement or if they promote their service as infringement friendly." That is a concurrence in the judgment, not binding.
2. **Scope of the rule.** The holding is phrased for "the provider of a service", not ISPs only. I did not check any post-Cox lower-court decision (search budget), so how it applies to hosts with specific notices, or to P2P services, is untested here, as the original report also says.
3. **Dissent-in-substance.** Two Justices (Sotomayor, Jackson) would have kept common-law aiding-and-abetting available and criticise the two-theory limit as unexplained (pp. 596-602). Not the law, but a signal that the limit may be tested.
4. **Source hygiene.** Cite the Court's PDF above. The FindLaw URL in the claim is behind a Cloudflare challenge for non-browser clients; the original researcher's "summariser" fragments were therefore the only text they could get.

**What it changes for magnet-web.** Nothing structural. Keep marketing and examples neutral (inducement is the live route), keep the log of abuse actions (the majority treated Cox's warnings, suspensions and terminations as evidence against inducement), and do not read Cox as removing the need for the s.512 machinery.

**Still unknown.** Post-Cox lower-court applications; whether a client-side loader could be a *direct* infringer on a volitional-conduct theory (not examined).

## 3. Claim 2: DSA relief for micro and small intermediaries is partial

**Claim.** Art. 19 excludes micro/small providers only from Section 3 (Arts. 19-28) and Art. 15(2) from yearly reports, but Arts. 11-14 (contacts, legal representative if non-EU, terms describing moderation) and, for hosts, Arts. 16-18 (notice-and-action, statements of reasons, criminal-suspicion notification) still apply. Art. 6(1)(b) requires acting expeditiously on knowledge; an Art. 16 notice gives actual knowledge when no "detailed legal examination" is needed. Reports follow Implementing Regulation 2024/2835 (1 Jan-31 Dec, public within two months, Annex I templates from 2025-07-01).

**Verdict: confirmed**, with four precision fixes.

**Re-checked against.**
- Regulation (EU) 2022/2065, OJ L 277, 27.10.2022, p. 1 (EUR-Lex text): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065
- EUR-Lex document-information page for the same act: https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32022R2065 (status "In force", "No end date"; "Modified by" lists only language corrigenda and three completing acts, 32023R1127, 32024R0436, 32025R2050; no amending act, as of 2026-10-17).
- Implementing Regulation (EU) 2024/2835 of 4 November 2024: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32024R2835 (information page: entry into force 25/11/2024, "Deadline 01/07/2025 See Art 2.4", "No end date").

**What matches.**
- Structure. Chapter III Section 1 "Provisions applicable to all providers of intermediary services" (Arts. 11-15); Section 2 "Additional provisions applicable to providers of hosting services, including online platforms" (Arts. 16-18); Section 3 "Additional provisions applicable to providers of online platforms" (Arts. 19 onward).
- Art. 19(1): "This Section, with the exception of Article 24(3) thereof, shall not apply to providers of online platforms that qualify as micro or small enterprises as defined in Recommendation 2003/361/EC."
- Art. 15(2): "Paragraph 1 of this Article shall not apply to providers of intermediary services that qualify as micro or small enterprises ... and which are not very large online platforms within the meaning of Article 33".
- Arts. 11 and 12 (single points of contact; Art. 12(1): means "which shall not solely rely on automated tools"), Art. 13 (legal representative for providers "which do not have an establishment in the Union but which offer services in the Union"), Art. 14(1) (terms must include "policies, procedures, measures and tools used for the purpose of content moderation, including algorithmic decision-making and human review, as well as the rules of procedure of their internal complaint handling system").
- Art. 6(1): not liable on condition that the provider "(a) does not have actual knowledge ... or (b) upon obtaining such knowledge or awareness, acts expeditiously to remove or to disable access to the illegal content."
- Art. 16(3): notices "shall be considered to give rise to actual knowledge or awareness for the purposes of Article 6 in respect of the specific item of information concerned where they allow a diligent provider of hosting services to identify the illegality of the relevant activity or information without a detailed legal examination."
- Implementing Regulation: Art. 2(1) yearly period "from 1 January until 31 December"; Art. 2(3) public "at the latest by two months after the date of the conclusion of each reporting period"; Art. 2(4) templates "as of 1 July 2025".

**Corrections and nuances.**
1. **Art. 24(3) survives.** (The source report's F3 body already says "apart from Art. 24(3)"; the relayed claim compressed it away.) The exclusion is Section 3 "with the exception of Article 24(3)": a micro/small online platform must still give the Digital Services Coordinator and the Commission, "upon their request and without undue delay", its average-monthly-active-recipients figure. The exclusion continues for 12 months after a provider loses micro/small status (Art. 19(1), second subparagraph) and then ends, and it never applies to designated very large platforms (Art. 19(2)); Art. 15(2) likewise does not protect a VLOP.
2. **Art. 17 is narrower than "still apply" suggests.** Art. 17(2): paragraph 1 "shall only apply where the relevant electronic contact details are known to the provider" and "shall not apply where the information is deceptive high-volume commercial content". A hub that holds no site-owner contact data owes less under Art. 17 than the claim implies (Art. 16(4)-(5) acknowledgements and decisions to a notifier who gave contact details still apply).
3. **Art. 18 is not a general criminal-suspicion duty.** It covers "a criminal offence involving a threat to the life or safety of a person or persons".
4. **Reporting format.** Annex I holds the CSV/XLSX templates and Annex II the filling-in instructions (Art. 1). Recital 9: "The first full harmonised reporting cycle covers 1 January 2026 until 31 December 2026", so under Art. 2(3) the first full-cycle report is due by 28 February 2027. Reports and all versions must be retained and kept public for at least five years (Art. 3). The templates bind those who must report; a micro or small provider exempt under Art. 15(2) may use them voluntarily.
5. **Conditionality, unchanged from the source report's F4.** Arts. 16-18 apply only to a "hosting" service (Art. 3(g)(iii): "the storage of information provided by, and at the request of, a recipient of the service"). Whether a loader or a rendering hub is one is unsettled; the claim's "for hosts" is the right condition.
6. **Watch item.** EUR-Lex lists a pending reference touching Art. 6(1)(a) and 6(2): Case C-47/25 (Apple Distribution International), lodged 24 January 2025, asks among other things whether awareness can rest on "a category of content" that is hypothetically illegal in its entirety or must relate to "well-defined, individual content". Status unknown here.

**What it changes for magnet-web.** No design change. The compliance floor for even a micro hub stays: contact points, moderation text in the terms, a notice form, decisions with reasons where contact details exist, and Art. 18 for life-or-safety threats; periodic reports are optional.

**Still unknown.** How regulators classify loaders and hubs; the outcome of C-47/25.

## 4. Claim 3: CJEU Ziggo (2017) and YouTube/Cyando (2021)

**Claim.** Running a sharing platform that "by means of indexation of metadata ... and the provision of a search engine" lets users locate works shared over P2P is a communication to the public (Ziggo, 2017). An operator is liable where it has specific knowledge and fails to delete or block expeditiously, fails to deploy the technological measures expected of a reasonably diligent operator, selects content, provides tools specifically intended for illegal sharing or knowingly promotes it; general knowledge is insufficient but a rightholder warning plus inaction is different (YouTube/Cyando, 2021). Implication: no hub index/search/directory and a fast, documented notice-to-block path.

**Verdict: confirmed** (quotations exact); the "Implication" needs three scope notes.

**Re-checked against.** *Stichting Brein v Ziggo and XS4ALL*, C-610/15 (https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62015CJ0610); *YouTube and Cyando*, C-682/18 and C-683/18 (https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62018CJ0682). Also read for the scope notes: Directive (EU) 2019/790 (https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0790), *GS Media*, C-160/15 (https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62015CJ0160) and *Poland v Parliament and Council*, C-401/19 (https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62019CJ0401).

**What matches.**
- Ziggo, Second Chamber, 14 June 2017, operative part: "the making available and management, on the internet, of a sharing platform which, by means of indexation of metadata relating to protected works and the provision of a search engine, allows users of that platform to locate those works and to share them in the context of a peer-to-peer network." (Para. 48 says "referring to"; the claim's ellipsis hides nothing.)
- YouTube/Cyando, Grand Chamber, 22 June 2021, operative part 1: no communication to the public "unless it contributes, beyond merely making that platform available, to giving access to such content to the public in breach of copyright. That is the case, inter alia, where that operator has specific knowledge that protected content is available illegally on its platform and refrains from expeditiously deleting it or blocking access to it, or where that operator, despite the fact that it knows or ought to know, in a general sense, ... refrains from putting in place the appropriate technological measures that can be expected from a reasonably diligent operator ..., or where that operator participates in selecting protected content illegally communicated to the public, provides tools on its platform specifically intended for the illegal sharing of such content or knowingly promotes such sharing". Para. 85: general knowledge is not sufficient, "The situation is, however, different where that operator, despite having been warned by the rightholder ..., refrains from expeditiously taking the measures necessary to make that content inaccessible."

**Scope notes (corrections to how the claim may be used).**
1. **Ziggo is fact-bound.** The operative part says "in circumstances such as those at issue in the main proceedings". The Court relied on operators who "intervene, with full knowledge of the consequences of their conduct" (para. 36), a categorised index whose placement the operators checked, plus deletion of faulty torrents and active filtering (para. 38), operators who were informed the platform gave access to unauthorised works and "expressly display ... their purpose to make protected works available" and "encourage" copying (para. 45), and "considerable advertising revenues" (para. 46). An index or search is a strong risk factor, not a per se rule; "no hub index/search/directory" is sound risk avoidance, not something Ziggo compels.
2. **Cyando predates Article 17 of Directive 2019/790.** Para. 59: the Court's interpretations "do not concern the set of rules established by Article 17 of Directive (EU) 2019/790". For an "online content-sharing service provider" (Art. 2(6): "the main or one of the main purposes is to store and give the public access to a large amount of copyright-protected works ... uploaded by its users, which it organises and promotes for profit-making purposes"), Art. 17(1) makes the provider itself perform the act of communication, Art. 17(3) switches off the hosting limitation for those situations, Art. 17(4) imposes best-efforts duties, and Art. 17(6) lightens them for services "available to the public in the Union for less than three years" with turnover "below EUR 10 million" (stay-down efforts only above 5 million monthly unique visitors). The CJEU dismissed Poland's challenge to Art. 17 (C-401/19, Grand Chamber, 26 April 2022). Inference: a loader that stores nothing and neither organises nor promotes is unlikely to be such a provider; a hub with a promoted directory could be. That is the legal reason the "no directory" rule matters.
3. **Hyperlink case law is the closer analogue for a pointer-style hub, and the source report does not cite it.** *GS Media*, C-160/15 (8 September 2016), operative part: whether hyperlinks to freely available protected works are a communication to the public depends on whether the links "are provided without the pursuit of financial gain by a person who did not know or could not reasonably have known the illegal nature of the publication ... or whether, on the contrary, those links are provided for such a purpose, a situation in which that knowledge must be presumed." Inference: a for-profit hub is presumed to know.
4. **Exemption limb.** Cyando's operative part 2 (hosting exemption available "provided that that operator does not play an active role of such a kind as to give it knowledge of or control over the content") and paras. 111-112 (knowledge must concern "specific illegal information and activities") were decided under Art. 14 of Directive 2000/31; the DSA's Art. 6 keeps the same knowledge-or-expeditious-removal structure (see claim 2).

**What it changes for magnet-web.** Keep "no directory or search" and the fast documented notice-to-block path. Add: do not monetise the hub, keep any promotion neutral, and if curation ever appears, assess online content-sharing service provider status first.

**Still unknown.** National-law injunction practice (Art. 8(3) of Directive 2001/29, Cyando operative part 3); no post-2022 CJEU platform decision was searched for.

## 5. Claim 4: CJEU Mircom (C-597/19): seeders, "duly informed", no safe harbour

**Claim.** Uploading pieces "unusable in themselves" is irrelevant, what is made available is the file; users acting "in full knowledge of the consequences" make an act of communication; where users subscribed to the software after being "duly informed of its characteristics" the deliberate nature is "in no way negated" by automatic uploading. End-user seeders have no safe harbour; the disclosure that transparency law requires also establishes knowledge, so bound what a browser seeds (current site, signed current btih, not denylisted).

**Verdict: nuanced.** The quotations are accurate. The legal consequences drawn from them are partly inference, and one quoted holding is conditional in a way the claim drops.

**Re-checked against.** *Mircom International Content Management & Consulting v Telenet*, C-597/19, Fifth Chamber, 17 June 2021: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62019CJ0597 (read in full).

**What matches (verbatim).**
- Para. 43: "the fact that the pieces which are transmitted are unusable in themselves is irrelevant since what is made available is the file containing the work, that is to say the work in digital format." Para. 46: no minimum number of pieces need be proved.
- Para. 48: "any act whereby a user, in full knowledge of the consequences of what he or she is doing, gives access to protected work is liable to constitute an act of communication".
- Para. 49: "Provided that it is apparent, which it is for the referring court to determine, that the relevant users of that network have subscribed to that software by giving their consent to its application after having been duly informed of its characteristics, those users must be regarded as acting in full knowledge of their conduct and of the consequences which it may have. Once it is established that they have actively subscribed to such software, the deliberate nature of their conduct is in no way negated by the fact that the uploading is automatically generated by that software."
- Para. 53: "the computers of those users sharing the same file constitute the peer-to-peer network itself, called the 'swarm', in which they play the same role as the servers in the operation of the World Wide Web."
- Operative part 1 repeats the condition: "It is irrelevant that, due to the configurations of the BitTorrent client sharing software, that uploading is automatically generated by it, when the user, from whose terminal equipment that uploading takes place, has subscribed to that software by giving his or her consent to its application after having been duly informed of its characteristics."

**Corrections and nuances.**
1. **The "deliberate" holding is conditional.** The claim drops three limits: "giving their consent", "actively subscribed", and "which it is for the referring court to determine". Mircom does not hold that every seeder is deliberate; it holds that automation does not negate deliberateness once informed, active subscription is shown. A visitor whose browser starts seeding because a page loaded is not that fact pattern, and no case on it was found (the source report says the same for its F6).
2. **"End-user seeders have no safe harbour" is not in Mircom.** The judgment does not discuss safe harbours. It is an inference (the hosting, caching and conduit limitations in the E-Commerce Directive and now DSA Arts. 4-6 protect providers of intermediary services; a private peer is not one). Plausible, unsourced; keep it labelled as inference.
3. **"Disclosure establishes knowledge" is inference, and it cuts two ways.** It is consistent with para. 49 (informed, active subscription). But the operator's own exposure is a separate test (Ziggo para. 36, "full knowledge of the consequences of their conduct"; Cyando operative part 1), so a design that makes the user "informed and subscribed" does not by itself move liability off the operator who engineered the seeding.
4. **An off switch matters.** Para. 49 describes users "who ha[ve] not deactivated the upload function". Keep a prominent, persistent way to stop sharing (the source report already has pause and purge).
5. **Analogy, not application.** Mircom concerned pieces of "a media file containing a protected work" in a BitTorrent swarm; applying it to website assets reseeded from a browser is by analogy.

**What it changes for magnet-web.** The mitigation "bound what a browser seeds" is a sound response and needs no change. Present the first-run choice as an active, informed one, and keep the double-edge trade-off the source report already notes (the same disclosure is what creates the "informed" fact pattern).

**Still unknown.** Any national decision applying Mircom to browser-based or WebRTC peers.

## 6. Claim 5: Canada's Copyright Act

**Claim.** (Act current to 2026-09-30.) Hosting protection is lost only if the provider "knows of a decision of a court of competent jurisdiction" (s.31.1(5)); the s.27(2.3) "enabler" offence applies to a service provided "primarily for the purpose of enabling" infringement, with factors including marketing and "ability ... to limit acts of copyright infringement, and any action taken" (s.27(2.4)); notice-and-notice (ss.41.25-41.26) requires forwarding "as soon as feasible", records for six months (one year if proceedings are notified) and carries $5,000-$10,000 statutory damages for failing; notices may not contain settlement offers; non-commercial statutory damages are $100-$5,000 for all works (s.38.1(1)(b)).

**Verdict: nuanced.** Quotations and numbers are right; four statements need correcting.

**Re-checked against.** Justice Laws pages, each stamped "Act current to 2026-09-30 and last amended on 2024-11-07": https://laws-lois.justice.gc.ca/eng/acts/C-42/section-31.1.html, section-27.html, section-41.25.html, section-41.26.html, section-38.1.html (the five cited), plus section-41.27.html, section-42.html and the Act index page listing regulations made under it.

**What matches (verbatim).**
- s.31.1(4)-(5): hosting is covered, but "(5) Subsection (4) does not apply in respect of a work or other subject-matter if the person providing the digital memory knows of a decision of a court of competent jurisdiction to the effect that the person who has stored the work ... infringes copyright".
- s.27(2.3): "It is an infringement of copyright for a person, by means of the Internet or another digital network, to provide a service primarily for the purpose of enabling acts of copyright infringement if an actual infringement of copyright occurs by means of the Internet or another digital network as a result of the use of that service." s.27(2.4) factors (a) marketing or promotion, (b) knowledge of "a significant number of acts", (c) "significant uses other than to enable acts of copyright infringement", (d) "the person's ability, as part of providing the service, to limit acts of copyright infringement, and any action taken by the person to do so", (e) benefits received, (f) economic viability without infringement.
- s.41.26(1): "(a) as soon as feasible forward the notice electronically ... and inform the claimant of its forwarding or ... of the reason why it was not possible to forward it; and (b) retain records ... for six months beginning on the day on which the notice of claimed infringement is received or, if the claimant commences proceedings relating to the claimed infringement and so notifies the person before the end of those six months, for one year after the day on which the person receives the notice". s.41.26(3): "statutory damages ... not less than $5,000 and not more than $10,000".
- s.41.25(3)(a): a notice "shall not contain ... an offer to settle the claimed infringement".
- s.38.1(1)(b): "not less than $100 and not more than $5,000 ... with respect to all infringements involved in the proceedings for all works or other subject-matter, if the infringements are for non-commercial purposes."

**Corrections and nuances.**
1. **It is a civil infringement, not an "offence".** s.27(2.3) opens "It is an infringement of copyright" (marginal note "Infringement - provision of services"). The criminal offences are in s.42(1)-(3.2): specific knowing acts (making for sale, selling or renting, distributing, exhibiting, possessing for sale, importing, exporting; plates; performing in public for private profit; circumventing technological protection measures; altering rights management information). s.42 never refers to s.27(2.3). Use "enabler provision" or "enabler infringement".
2. **s.31.1(5) is not the only route to losing hosting protection.** s.31.1(6): "Subsections (1), (2) and (4) do not apply in relation to an act that constitutes an infringement of copyright under subsection 27(2.3)." (The source report's F8 body mentions (6); the claim as stated omits it.) Subsection (4) also covers only a person who provides "digital memory in which another person stores the work" "for the purpose of allowing the telecommunication of a work".
3. **s.41.26 duties do not reach information location tools.** s.41.26(1) binds "a person described in paragraph 41.25(1)(a) or (b)": network-access providers and hosts. Paragraph (c), "an information location tool as defined in subsection 41.27(5)" ("any tool that makes it possible to locate information that is available through the Internet or another digital network"), is outside s.41.26, so the forwarding duty and the s.41.26(3) damages attach to it only if it is also an (a) or (b) provider. ILTs fall under s.41.27 instead: injunction-only relief if the conditions in (2) are met; after a compliant notice, protection continues only for infringements before "the day that is 30 days" after receipt (s.41.27(3)); and none of it applies if providing the tool is a s.27(2.3) infringement (s.41.27(4)). Which of (a), (b) or (c) a hub is decides which regime it is under; the claim treats all three as one.
4. **The $100-$5,000 band is the non-commercial (visitor) band, not the operator's.** s.38.1(1.11): "an infringement under subsection 27(2.3) is deemed to be for a commercial purpose", so an enabler faces the commercial band (s.38.1(1)(a): $500-$20,000 "for each work"), with a proportionality reduction in s.38.1(3)(a)(ii) and a limit to works actually infringed through the service in s.38.1(1.1).
5. **Notice content.** s.41.25(3) also bars "a request or demand ... for payment or for personal information" and references (including hyperlinks) to any such offer, request or demand, not only settlement offers.
6. **Amounts.** s.41.26(4) lets the Governor in Council change the $5,000/$10,000 figures by regulation; the Act's list of regulations on Justice Laws shows none on notice-and-notice, so the printed figures stand.

**What it changes for magnet-web.** If a Canadian-run hub is in scope, decide first whether it is an (a), (b) or (c) provider; keep the cheap forwarder anyway; document actions taken to limit infringement (s.27(2.4)(d)); avoid any marketing that implies infringing use ((2.4)(a)), because an enabler finding also strips s.31.1 and s.41.27 protection and moves damages to the commercial band.

**Still unknown.** Case law applying s.27(2.3) to P2P or browser tools; Quebec-specific rules (outside this claim).

## 7. Claim 6: hash denylists (Kubo/NOpfs and the USENIX 2024 IPFS study)

**Claim.** Hash denylists are the established pattern in content-addressed systems (Kubo/NOpfs: opt-in, double-hashed entries, HTTP 410, not applied to routing, described as "whack-a-mole") but are reactive and leaky: in the USENIX Security 2024 IPFS study only Protocol Labs gateways enforced the full badbits list while others, including big CDNs, filtered under 20%; re-adding content under a different hash function evaded blocking of 97.4% of blocked CIDs on 56 of 57 filtering gateways; about 88% of flagged files were DMCA and bulk emails were mostly over-broad. For BitTorrent a re-pack changes the infohash, so a per-file SHA-256 must sit beside btih.

**Verdict: nuanced.** Every Kubo attribute and every number is in the sources, but one headline generalisation is contradicted by the paper's own figure, and two numbers need their sample stated.

**Re-checked against.**
- Kubo: https://raw.githubusercontent.com/ipfs/kubo/master/docs/content-blocking.md (read in full) and the IPFS blog post of 2023-04-26, https://blog.ipfs.tech/2023-content-blocking-for-the-ipfs-stack/.
- Sokoto et al., "Guardians of the Galaxy: Content Moderation in the InterPlanetary File System", USENIX Security 2024 (14-16 Aug 2024): https://usenix.org/system/files/usenixsecurity24-sokoto.pdf (12 pages; read in reading order, and Fig. 18 rendered and measured).
- BEP 52: https://raw.githubusercontent.com/bittorrent/bittorrent.org/master/beps/bep_0052.rst ; WebTorrent's own BEP table: https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/bep_support.md .

**What matches (verbatim).**
- Kubo: "Content blocking is an opt-in decision made by the operator of `ipfs daemon`." "Sensitive content paths can be double-hashed to block without revealing them." "requests for a denied CID return an error (HTTP 410 Gone from the gateway)". "Denylists do **not** apply to the routing system." And the tip: "Denylists are reactive: you block bad content after it appears and keep adding entries as more shows up, which turns into whack-a-mole. If your gateway only needs to serve a known set of content, an allowlist is simpler and stronger."
- Paper, introduction: "out of all the gateways, only the ones operated by Protocol Labs filter the entire badbits list. The other public gateways, including those operated by large CDNs, filter less than 20% of the content." Flagged files: 368,762, "a large fraction of copyright-protected content (~87.97% of files)". Circumvention (section 7.2): "Out of the 57 gateways blocking any of the requested content, we are able to access the blocked content on 56. For these, evasion was possible for the majority (97.4%) of usually blocked CIDs." Takedown emails: "over 60% of all email takedown requests are accepted ... In stark contrast, ... the majority of CID takedown requests are actually rejected", because "DMCA emails [include] up to eight times more CIDs than phishing takedown request emails"; agencies "'optimistically' send many requests, even though they are not verified."

**Corrections and nuances.**
1. **"Others filter under 20%" fails for one category, per the paper's own Fig. 18.** The measurement (section 7.1) was HTTP HEAD requests over January 2024, 5,000 badbits CIDs per day, across 431 gateways in five categories; "Blocked" means HTTP 410 or 451. The text says "The list is implemented, to some extent, by the public gateways that are officially listed by Protocol Labs, but not by the others" and "the CDN-operated gateways block only around 18%". Reading the bars (shares of all requests, including "Failure"; approximate, about plus or minus 2 points): Protocol Labs about 88% (the text says "nearly 100%"), **officially listed "Public" gateways about 54%**, CDN about 18%, "Others" about 17%, GaaS (Infura subdomains) about 8%. So "less than 20%" is accurate for CDN, Others and GaaS, not for the listed public gateways; the abstract's wording is broader than the data. The measurements date from January-February 2024, so they are about 2.7 years old as of this check.
2. **97.4% is from a 100-CID phishing sample.** The authors sampled "100 CIDs, selected from the set of phishing CIDs" (an ethical choice, their section 9), re-added the content under another hash function, and found evasion on 56 of the 57 gateways that blocked anything; the missing evasions "stem from unrelated issues, usually because the content is not returned completely within the timeout". It is not a DMCA-content figure. Extending it to BitTorrent re-packs is the source report's inference, and a sound one.
3. **"Mostly over-broad" is a gloss.** What the paper reports is a high share of rejected CIDs and DMCA emails carrying up to 8x more CIDs than phishing emails; "optimistically sent, unverified" is the authors' explanation.
4. **Standards note on "a per-file SHA-256 must sit beside btih".** BitTorrent v2 (BEP 52) already defines a per-file `pieces root`: "the root hash of a merkle tree ... constructed from 16KiB blocks of the file ... SHA2-256 is used as digest function", and "Note that identical files always result in the same root hash." That is a re-pack-stable per-file identifier in the standard. But WebTorrent's table lists BEP 52 as not implemented in Node or the browser (issue webtorrent#1117), so with WebTorrent 3.x a separately published per-file SHA-256 (as the project's `files.json` does) remains the practical choice. "Must" is true in practice, not as a protocol necessity.
5. **Kubo's own advice favours allowlists** where the content set is known; the claim leaves that out. Inference: it maps onto magnet-web's owner-signed pointers and a hub that only renders pointers it has been told about.

**What it changes for magnet-web.** Keep the denylist as one lever, but do not plan on third-party adoption (assume a minority of operators honour a shared list), keep the allowlist-at-the-gate option first-class, publish a per-file SHA-256 now, and revisit BEP 52 hybrid torrents only if WebTorrent implements it.

**Still unknown.** Current (2026) IPFS gateway adoption; whether any non-IPFS content-addressed system has published comparable numbers.

## 8. Claim 7: Safe Browsing strips the fragment and matches by host suffix and path prefix

**Claim.** Google Safe Browsing canonicalization removes the URL fragment and matches by host suffix and path prefix, so a hub whose pointer travels in "#..." can only be flagged per host, a parent-domain listing covers all labels, and a shared-origin hub is flagged as a unit; the IPFS study found Safe Browsing blocked 56 gateways entirely (95% already offline). Whether Public Suffix List (PSL) listing changes this is untested.

**Verdict: nuanced.** The mechanics are right. The cited page documents a deprecated API, and the closing "untested" sentence can now be answered from client source code: private-section PSL entries are not used.

**Re-checked against.**
- Google, v4 "URLs and Hashing" (the page the claim cites): https://developers.google.com/safe-browsing/v4/urls-hashing (footer: last updated 2024-09-18 UTC; the source report called it undated).
- Google, v4 overview: https://developers.google.com/safe-browsing/v4 ("Warning: The Safe Browsing APIs (v4) are deprecated. Visit the migration guide for further information."; footer last updated 2026-03-10).
- Google, v5 "URLs and Hashing": https://developers.google.com/safe-browsing/reference/URLs.and.Hashing (last updated 2025-05-23 UTC) and the migration guide https://developers.google.com/safe-browsing/reference/Migration.From.V4 (last updated 2026-03-10 UTC).
- Chromium `main`: https://raw.githubusercontent.com/chromium/chromium/main/components/safe_browsing/core/browser/db/sb_protocol_manager_util.cc , .../components/safe_browsing/core/common/features.cc , .../net/base/registry_controlled_domains/registry_controlled_domain.h .
- Firefox `main`: https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/components/url-classifier/LookupCache.cpp .
- PSL guidelines: https://raw.githubusercontent.com/wiki/publicsuffix/list/Guidelines.md .
- Sokoto et al. (USENIX Security 2024), sections 7.1 and 8.2.

**What matches (verbatim).**
- Both Google pages: "Second, if the URL ends in a fragment, remove the fragment. For example, shorten http://google.com/#frag to http://google.com/." Both build "host suffix (or full host) and a path prefix (or full path)" expressions: "up to 30 different possible host suffix and path prefix combinations", at most five host strings and six path strings.
- Paper section 8.2: "Surprisingly, we find that the GSB blocks entire gateways, rather than specific content URLs provided by them. We observe that GSB blocks 56 gateways entirely, yet it allows the downloading of all denylist content from the remaining gateways. In practice, this is extremely ineffective, particularly as 95% of blocked gateways are already offline. The remaining 5% does not implement any filtering, suggesting that they could have been serving harmful content (helping to explain why GSB blocks them)." They tested by creating "URLs from every combination of denylist CIDs and gateways" and submitting them to GSB.
- Paper section 7.1 (corroboration): gateways over-block Web2-denylisted CIDs, which the authors "suspect ... is caused by the threat of the entire domain being blocked by mechanisms such as Google Safe Browsing (GSB)".

**Corrections and nuances.**
1. **The cited page is for a deprecated API.** The v4 overview now carries the deprecation warning above. The current v5 page differs on how the host chain starts. v4: "up to four hostnames formed by starting with the last five components and successively removing the leading component. The top-level domain can be skipped." v5: "up to four hostnames formed by starting with the eTLD+1 domain and adding successive leading components. The determination of eTLD+1 should be based on the Public Suffix List", with the example that `http://example.co.uk/1` yields only `example.co.uk/1` and `example.co.uk/`.
2. **The PSL question can be answered from client code (two major open-source clients).**
   - Chromium, `GenerateHostVariantsToCheckV5`: "In v5, the base component is the eTLD+1 instead of TLD+1. We use net::registry_controlled_domains to avoid including the eTLD in the host variants, excluding private registries." It calls `GetDomainAndRegistry(host, EXCLUDE_PRIVATE_REGISTRIES)`. The header `registry_controlled_domain.h` explains the filter: the PSL's second group "contains a list of private additions for domains that enable external users to create subdomains, such as appspot.com", and the enum lets the caller choose whether to include them. A hub apex added to the PSL would be exactly such a private addition, so it is ignored.
   - Chromium's v4 variant, `GenerateHostVariantsToCheckV4`, uses no PSL at all; its comment: "we don't need to be clever about stopping at the 'real' eTLD -- the data on the server side has been filtered to ensure it will not blocklist a whole TLD".
   - Which path runs is chosen by `base::FeatureList::IsEnabled(safe_browsing::kLocalListsUseSBv5)`; in `features.cc` that feature ("SafeBrowsingLocalListsUseSBv5") is `FEATURE_DISABLED_BY_DEFAULT` in source (what field trials enable is unknown).
   - Firefox, `LookupCache::GetLookupFragments`, copies the protocol text ("The 4 hostnames formed by starting with the last 5 components and successivly removing the leading component. The top-level component can be skipped.") and contains no PSL logic.
   - **Result.** In Chromium (either path) and Firefox, a listing of the hub's registered domain still matches every label beneath it, and PSL-listing the hub apex does not change which expressions are looked up. Any benefit from a PSL entry would have to come from Google's server-side choices about what to list, which no document I found describes (unverified). Safari, Edge and other clients: not checked.
3. **PSL listing is not a free mitigation in any case.** The PSL's own non-acceptance factors include: "We do not accept entries that have the objective of getting around limitations that have been put in place by a vendor to protect internet users. The PSL is not a 'workaround'", and "projects not serving more then thousands of users are quite likely to be declined", and private-section domains must show more than two years of registration remaining. The stated eligible case is "owners of privately-registered domains who themselves issue subdomains to mutually-untrusting parties", which a subdomain hub is.
4. **Granularity.** With a fragment-only pointer the path never varies, so the finest listing a reputation service can make is the host (plus any fixed path prefix). That part of the claim stands.

**What it changes for magnet-web.** Treat the hub apex as a shared-fate asset: assume a parent listing cascades to every label and that a PSL entry will not isolate labels in Chromium or Firefox lookups. The defences that actually change what is looked up are structural: let site owners serve the loader from their own registrable domains (the drop-in/per-domain mode), or split the hub across several apex domains (inference), plus monitoring and a prepared review-request path. Keep a PSL entry, if wanted, for what it is for (cookie and storage separation between mutually untrusting labels), not as a reputation fix.

**Still unknown.** Whether Google applies PSL logic server-side when choosing what to list; Safari and Edge SmartScreen behaviour; which Chrome clients run the v5 path in the field.

## 9. Claim 8: EDPB Guidelines 2/2023 v2.0 and ePrivacy Art. 5(3)

**Claim.** ePrivacy Art. 5(3) applies to Service Worker, Cache Storage and IndexedDB storage and to reading stored pieces to send them to others: EDPB Guidelines 2/2023 v2.0 (2024-10-07) says storage does not depend on medium, duration or amount, applies to non-personal data, and that locally stored information "or any derivation of this information" leaving the device is "access"; client-side code making processed information available to a third party is access. The guidelines expressly do not analyse the exemptions.

**Verdict: nuanced.** Every quotation verifies. The guidelines never name Service Workers, Cache Storage, IndexedDB, WebRTC or P2P, so the headline application is our inference, not an EDPB statement.

**Re-checked against.**
- https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf (read in full; 15 pages, paras. 1-63).
- EDPB document pages: https://www.edpb.europa.eu/documents/guideline/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en (final version) and the consultation page, https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2023/guidelines-22023-technical-scope-art-53-eprivacy_en .

**What matches (verbatim, with paragraph).**
- Version history: "Version 1.0, 14 November 2023, Adoption of the Guidelines for public consultation; Version 2.0, 7 October 2024, Adoption of the Guidelines after public consultation".
- Para. 12: "the notion of information includes both non-personal data and personal data, regardless of how this data was stored and by whom".
- Para. 36: storage by "instructing software on the terminal equipment to generate specific information ... This includes making use of established protocols such as browser cookie storage as well as customized software, regardless of who created or installed the protocols or software on the terminal equipment."
- Para. 37: "The ePD does not place any upper or lower limit on the length of time that information must persist on a storage medium to be counted as stored, nor is there an upper or lower limit on the amount of information to be stored."
- Para. 38: "the notion of storage does not depend on the type of medium on which the information is stored."
- Para. 44: browsers using "cookies, local storage, WebSQL" do not "gain access" "as long as the information does not leave the device, but when this information or any derivation of this information is accessed, Article 5(3) ePD would apply."
- Para. 53: "If at any point and for example in the client-side code, the processed information is made available to a third-party, for example sent back over the network to a server, such an operation (instructed by the entity producing the client-side code ...) would constitute a 'gaining of access to information already stored'."
- Exemptions not analysed: para. 4 ("These Guidelines do not address the circumstances under which a processing operation may fall within the exemptions"), para. 40, and para. 56 ("the applicability of this article does not systematically mean that consent needs to be collected").

**Corrections and nuances.**
1. **Not named.** Searching the text: "service worker", "indexeddb", "cache storage", "webrtc", "p2p" each 0 hits; "local storage" once (para. 44); "peer" twice (para. 25, on ad-hoc networks). The source report's F15 heading says the EDPB "says so in terms"; it does not. The application to a Service Worker cache, IndexedDB and peer upload is inferred from paras. 36-38 (storage regardless of protocol, software, duration, amount, medium), para. 44 and para. 53. Para. 53's worked example sends data "to a server"; a peer is a third party but not a server. That is a strong analogy, and untested.
2. **"Leaving the device".** Para. 44's sentence turns on "as long as the information does not leave the device, but when this information or any derivation of this information is accessed". The claim's gloss ("leaving the device is 'access'") is a fair reading, not a quotation.
3. **A useful extra pin for P2P.** Para. 25: networks of nodes relaying information "in an ad-hoc manner" that "can at some point in time have as little as two peers communicating ... would be within the general scope of the ePD directive, as long as the network protocol allows for further inclusion of peers" (footnote 17 names Briar). A swarm is not outside the ePrivacy perimeter.
4. **Exemptions are where the real question sits.** Footnote 4 quotes the exemption: storage or access "as strictly necessary in order for the provider of an information society service explicitly requested by the subscriber or user to provide the service". A Service Worker caching the site the visitor asked for can fit national readings of "strictly necessary"; uploading pieces to strangers is the harder case (the source report's F16).
5. **Version status.** The EDPB's final-version page shows "Guidelines 2/2023 on Technical Scope of Art. 5(3) of ePrivacy Directive", dated "16 October 2024", "Final version", file "Guidelines 2/2023 - Version 2.0" (399.75 KB); the consultation-era page is marked "Obsolete version". No later version appears as of 2026-10-17. (Adopted 7 October, published 16 October 2024.)

**What it changes for magnet-web.** When citing: "EDPB Guidelines 2/2023 v2.0 paras. 36-38, 44 and 53 set the general rule; applying it to Service Worker, Cache Storage, IndexedDB and peer upload is our reading." Nothing in the design changes.

**Still unknown.** National regulator guidance (CNIL, ICO, AEPD and others) on Service Workers or P2P; any effect of the Digital Omnibus on Art. 5(3) (not examined here).

## 10. Items the original report did not have (surfaced during this check)

| Item | Bears on | What it says | How sure |
|---|---|---|---|
| Sotomayor concurrence, footnote at 607 U.S. 602 | Claim 1 | ISPs "could still face secondary liability if they design their service to facilitate infringement or if they promote their service as infringement friendly" | Verbatim, but a concurrence |
| DSA Art. 17(2) | Claim 2 | Statement-of-reasons duty applies "only where the relevant electronic contact details are known to the provider"; excludes deceptive high-volume commercial content | Verbatim |
| CJEU C-47/25 (Apple Distribution International), pending | Claim 2 | Asks whether Art. 6(1)(a) awareness can rest on a category of content or must concern well-defined individual content | Notice read; status unknown |
| *GS Media*, C-160/15 (2016) | Claim 3 | Links provided with a profit motive: knowledge of illegality "must be presumed" | Operative part read |
| Directive 2019/790 Arts. 2(6), 17 and C-401/19 (2022) | Claim 3 | Online content-sharing service providers perform the act of communication themselves; lighter regime for services under 3 years and EUR 10 million; Art. 17 upheld | Texts read |
| Canada s.41.27 and s.38.1(1.11) | Claim 5 | Information location tools: injunction-only relief, 30-day window; enabler infringement deemed commercial for damages | Verbatim |
| Kubo tip: allowlist "simpler and stronger" | Claim 6 | The maintainers themselves prefer an allowlist where the content set is known | Verbatim |
| BEP 52 `pieces root`; webtorrent#1117 | Claim 6 | Standard already has a re-pack-stable per-file SHA-256 root; WebTorrent does not implement BEP 52 | Verbatim |
| USENIX Fig. 18 bar values | Claim 6 | Listed public gateways about 54% blocked; CDN about 18% | Read by eye at 300 dpi, plus or minus 2 points |
| Safe Browsing v4 deprecated; v5 eTLD+1 and PSL wording | Claim 7 | Cited page is for the deprecated API; v5 host chain starts at eTLD+1 "based on the Public Suffix List" | Google pages, dated |
| Chromium and Firefox lookup code | Claim 7 | Private PSL entries ignored (Chromium v5: `EXCLUDE_PRIVATE_REGISTRIES`; v4 and Firefox: no PSL) | Source, `main` branches, 2026-10-17 |
| PSL non-acceptance factors | Claim 7 | "The PSL is not a 'workaround'"; small projects likely declined | Verbatim |

## 11. Proposed edits to `w2b-06-abuse-legal-ops.md` (not applied)

Each edit is small and uses wording supported by sections 2-9 above.

- **E1. Summary item 3 and F8 heading ("enabler offence").** Replace "enabler offence" with "enabler provision (s. 27(2.3); a civil infringement, not an offence; s. 42 does not mention it)".
- **E2. F8, hosting and notice bullets.** After the s.31.1(5) clause add "or where s. 31.1(6) applies (an act that infringes under s. 27(2.3))". After "as soon as feasible forward the notice electronically" add "(s. 41.26 binds persons in s. 41.25(1)(a) or (b); information location tools in (c) fall under s. 41.27: injunction-only relief, 30 days after a compliant notice, no protection for a s. 27(2.3) enabler)".
- **E3. F8, s.38.1 bullet.** Add "an infringement under s. 27(2.3) is deemed commercial (s. 38.1(1.11)): $500-$20,000 per work, reducible under s. 38.1(3)(a)(ii); the $100-$5,000 band is for non-commercial infringers such as visitors".
- **E4. F1.** Replace "read through a summariser" with "read in full from the Supreme Court PDF (607 U.S. 583, preliminary print)"; add that FindLaw is behind a Cloudflare challenge; add the Sotomayor footnote at p. 602 to support the "inducement or tailored" survivors; keep "Inference for us" on the direct/vicarious sentence.
- **E5. F3.** Add Art. 17(2) (applies only where contact details are known; excludes deceptive high-volume commercial content). Add Recital 9 of Implementing Regulation 2024/2835: first full harmonised cycle is 1 January-31 December 2026, so the first such report is due by 28 February 2027.
- **E6. F5.** Add three scope notes: Ziggo's ruling is "in circumstances such as those at issue" (knowledge, stated purpose, curation, advertising revenue); Cyando expressly does not cover Art. 17 of Directive 2019/790 (see Art. 2(6), 17(1), 17(3), 17(6) and C-401/19); and *GS Media* (profit-motivated links, knowledge presumed) is the closer analogue for a pointer hub.
- **E7. F6 and Summary item 5.** Quote para. 49's condition in full ("Provided that it is apparent, which it is for the referring court to determine ... after having been duly informed of its characteristics ... Once it is established that they have actively subscribed"). Mark "No safe harbour exists for end users" as inference (Mircom does not address safe harbours).
- **E8. F10.** After the "filter less than 20%" quotation add: "(Fig. 18, January 2024 HEAD sample, 431 gateways: Protocol Labs about 88%, ipfs.tech-listed public gateways about 54%, CDN about 18%, others about 17%, GaaS about 8%)". State that 97.4% came from 100 phishing CIDs. Add: BEP 52 `pieces root` is a re-pack-stable per-file SHA-256 root but WebTorrent does not implement BEP 52 (webtorrent#1117), so keep the separate per-file hash; Kubo's own guidance prefers an allowlist where the content set is known. State that the gateway data were measured in January-February 2024.
- **E9. F11 and Summary item 4.** Say "Google Safe Browsing v4 (now deprecated) and v5 canonicalization" and replace the PSL sentence with: "Chromium (v5 path: `GetDomainAndRegistry(..., EXCLUDE_PRIVATE_REGISTRIES)`; v4 path: no PSL) and Firefox (`GetLookupFragments`: no PSL) do not use private-section PSL entries when building lookup expressions, so a PSL entry for the hub apex does not stop a parent-domain listing from matching every label; any server-side effect is unverified. PSL listing still isolates cookies and storage, and the PSL's own rules decline entries meant as a workaround for vendor protections."
- **E10. F15 heading and Summary item 6.** Replace "the EDPB says so in terms" with "the EDPB states the general rules (paras. 36-38, 44, 53); applying them to a Service Worker cache, IndexedDB and peer upload is our inference, since the guidelines never name those technologies".
- **E11. Summary item 10 (hub hardening).** Change "PSL and reputation monitoring" to "reputation monitoring; PSL for storage and cookie isolation only (not a Safe Browsing mitigation); per-site registrable domains or multiple hub apex domains as the structural defence".

## Appendix A. Sources read, with retrieval fingerprints

All retrieved 2026-10-17, roughly 17:50-18:10 ET. Files sit outside the project tree in the session scratchpad, `/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/w2b06v/`, one directory per source group (untrusted downloads, never executed). The scratchpad is temporary; the hashes let anyone re-download and confirm they have the same bytes. Web pages (EUR-Lex, Justice Laws, Google, EDPB) can change; the GitHub files are `main`-branch snapshots.

| Source | URL | Local file (under the scratchpad root) | Bytes | SHA-256 |
|---|---|---|---|---|
| Cox v. Sony, slip-opinion list | https://www.supremecourt.gov/opinions/slipopinion/25 | `dl-cox/slipopinions.html` | 114789 | `b5dadcfdf0b912aeda8176e7e685ad2ed36a1714dd7930df00a8739793fe92a5` |
| Cox v. Sony, preliminary print | https://www.supremecourt.gov/opinions/25pdf/607us2r22_k4lo.pdf | `dl-cox/cox.pdf` | 274951 | `4b3003bcd76a3f25e1bdcfa2ad26a2bc7b326c447f07cbe9ab7a340743bdb9c9` |
| DSA text | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065 | `dl-dsa/dsa.html` | 840292 | `138625986da7da29772a2229a51b2f42254163adf5117b3f4588ab894a5c6c6a` |
| DSA information page | https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32022R2065 | `dl-dsa-meta/dsa-all.html` | 1161398 | `dd23e65d1dcdff6370f726188d3c305dbf4555b4a9de4d287f40e1f8aa8b4c4e` |
| Implementing Reg. 2024/2835 text | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32024R2835 | `dl-implreg/implreg.html` | 724206 | `500b26d92387d26072fd45ed4aa903c16efeff4b3ba5a405382398eb461ba3e2` |
| Implementing Reg. 2024/2835 info page | https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32024R2835 | `dl-implreg-meta/implreg-all.html` | 1001065 | `873aa2d9a8c4cd09c5a558f28ce41339c6095a48dd8f4fb7ad80ac3996c02383` |
| Ziggo C-610/15 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62015CJ0610 | `dl-ziggo/ziggo.html` | 77942 | `53086c3070a065bcfc1ed555162cfca4a7ac6cbf25d6f791208e0e2648b44dcb` |
| YouTube/Cyando C-682/18, C-683/18 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62018CJ0682 | `dl-cyando/cyando.html` | 226651 | `5bfdbca9e03873a04bdbfe060d6f6435a94b658e14d8463fc80fcd5eac1351e6` |
| Mircom C-597/19 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62019CJ0597 | `dl-mircom/mircom.html` | 198884 | `6eea342210570b21011789693895b3c176bdacbc9aa262ec3f45d5ac65873b6c` |
| Directive 2019/790 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0790 | `dl-dsm/dsm.html` | 275977 | `1461dfdb0b3661028c7f084f6aa3bc7db1c5448271c96d7100d5d7f6db01f470` |
| GS Media C-160/15 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62015CJ0160 | `dl-gsmedia/gsmedia.html` | 101801 | `bfa77d9dfdeb62a99381580ddf0f221cab29866a40022ed1226f9fdb73703880` |
| Poland v Parliament C-401/19 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62019CJ0401 | `dl-poland/poland.html` | 150486 | `c8fdf43b92fc7563cb6170c525684e0c052928a909cc740bdeba8c34ad920824` |
| C-47/25 notice | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62025CN0047 | `dl-c47/c47.html` | 9812 | `d87215961a809108f815d23535cd192339ec694fa2242268848f3f93dd02c843` |
| Copyright Act s.31.1 | https://laws-lois.justice.gc.ca/eng/acts/C-42/section-31.1.html | `dl-canada/s31.1.html` | 37645 | `e0b84d581938cc37d3c7efc27d24642d6e0acddb1481d50c56788722a24701c7` |
| Copyright Act s.27 | https://laws-lois.justice.gc.ca/eng/acts/C-42/section-27.html | `dl-canada/s27.html` | 42681 | `890feb24b0ebc5f4a7bc2ddaf135e9e2b89b48d268386349a2d281f05a7aeaab` |
| Copyright Act s.41.25 | https://laws-lois.justice.gc.ca/eng/acts/C-42/section-41.25.html | `dl-canada/s41.25.html` | 37745 | `b3c06989bad715d2f995e563d3876bc3ad40cb07dead7a13710ffc92a05d8c23` |
| Copyright Act s.41.26 | https://laws-lois.justice.gc.ca/eng/acts/C-42/section-41.26.html | `dl-canada/s41.26.html` | 36784 | `24cb93118bee0bac906e5d41466da3d4a389c4a9663537a0c1d68361903ea0e2` |
| Copyright Act s.41.27 | https://laws-lois.justice.gc.ca/eng/acts/C-42/section-41.27.html | `dl-canada/s41.27.html` | 40056 | `836f2c560e94dc911d092123419529b0518c8ee9ff041f864b5cb25a1fdce2ce` |
| Copyright Act s.38.1 | https://laws-lois.justice.gc.ca/eng/acts/C-42/section-38.1.html | `dl-canada/s38.1.html` | 43858 | `5fa855ecf01799f872df879ff724b6c51c2de0b2f2b2ba22fa6d3811f40ea23e` |
| Copyright Act s.42 | https://laws-lois.justice.gc.ca/eng/acts/C-42/section-42.html | `dl-canada/s42.html` | 43516 | `1780c03d20c2fa0a1c9468c91eb0d6013631a049b52d88873ef3efd6986851c7` |
| Copyright Act index (regulations list) | https://laws-lois.justice.gc.ca/eng/acts/C-42/index.html | `dl-canada/index.html` | 38414 | `c29743f4b6fbea81f72a6c55feac9c7038630187cfc286d17f7abb1e42369de6` |
| Sokoto et al., USENIX Security 2024 | https://usenix.org/system/files/usenixsecurity24-sokoto.pdf | `dl-usenix/sokoto.pdf` | 2558609 | `2e662fa9c2b7f1eda077886282aa41ceef12153ec36af64a227c8aafc1eec326` |
| Kubo content-blocking doc | https://raw.githubusercontent.com/ipfs/kubo/master/docs/content-blocking.md | `dl-kubo/content-blocking.md` | 5090 | `30ba5017e4457097f6c1dc00b9ad7151a4dcc94e3b7011aafe424a80d3040e64` |
| IPFS blog 2023-04-26 | https://blog.ipfs.tech/2023-content-blocking-for-the-ipfs-stack/ | `dl-kubo/blog-2023-content-blocking.html` | 22747 | `844a88e2a72370676112acf3cffcf7ceb4ee08ba6258a58e817bce52f5e3f0a2` |
| BEP 52 | https://raw.githubusercontent.com/bittorrent/bittorrent.org/master/beps/bep_0052.rst | `dl-bep52/bep_0052.rst` | 25513 | `ffe1ad517fdeb089e1e15e10952011086315c09330ec57c519464deed87a0e7a` |
| WebTorrent BEP support table | https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/bep_support.md | `dl-webtorrent-bep/bep_support.md` | 3101 | `8b5088327bb80248568aa15512414e9b81c7843685c7ac3d352cc98e7647b2be` |
| Safe Browsing v4 URLs and Hashing | https://developers.google.com/safe-browsing/v4/urls-hashing | `dl-gsb/urls-hashing.html` | 110109 | `3e1b5d28df99e54222e635a1271a93aa7386af9943ee031e43fdcadc1887ce2e` |
| Safe Browsing v4 overview | https://developers.google.com/safe-browsing/v4 | `dl-gsb-v5/v4-home.html` | 71549 | `c513f722dca3ba81d94d16d85c198825b4d53cc9fc93de06041de0be0590b6aa` |
| Safe Browsing v5 URLs and Hashing | https://developers.google.com/safe-browsing/reference/URLs.and.Hashing | `dl-gsb-v5/v5-urls-hashing.html` | 70691 | `bab06ff225ba22b77c3008960006a3948bcaf114df6a8199fe89ffd9e5ac4af9` |
| Safe Browsing v4 to v5 migration | https://developers.google.com/safe-browsing/reference/Migration.From.V4 | `dl-gsb-v5/migration.html` | 70813 | `215d15a40e42dd346f6d555a10d51df5574f5b0cdf68af496cad9aada6793c6c` |
| Chromium sb_protocol_manager_util.cc | https://raw.githubusercontent.com/chromium/chromium/main/components/safe_browsing/core/browser/db/sb_protocol_manager_util.cc | `dl-chromium/components_safe_browsing_core_browser_db_sb_protocol_manager_util.cc` | 34278 | `a4354b9ec708cd49736b49f43aeadd83e9380809f18ce12a86a076805c338a68` |
| Chromium features.cc | https://raw.githubusercontent.com/chromium/chromium/main/components/safe_browsing/core/common/features.cc | `dl-chromium/features.cc` | 26534 | `9a43c742088b3130ca33a02ca3162289c74a8015a03dcb3a8b5f3828c6a61848` |
| Chromium registry_controlled_domain.h | https://raw.githubusercontent.com/chromium/chromium/main/net/base/registry_controlled_domains/registry_controlled_domain.h | `dl-chromium/registry_controlled_domain.h` | 16207 | `cdc056fec1e4a34db72384267007bfd262d7830ccd2f8d01aaca8382a7fc31e4` |
| Firefox LookupCache.cpp | https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/components/url-classifier/LookupCache.cpp | `dl-gecko/LookupCache.cpp` | 34799 | `a5e3fe2214711e8c2cfca78fbe40eabcea176fc63953b49287de8f959388f631` |
| PSL guidelines | https://raw.githubusercontent.com/wiki/publicsuffix/list/Guidelines.md | `dl-psl/Guidelines.md` | 23587 | `38805dc65807af3776d791218a5dc598be2d970b92d45bb59742d0571c35658b` |
| EDPB Guidelines 2/2023 v2.0 PDF | https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf | `dl-edpb/edpb-2-2023-v2.pdf` | 409348 | `dbc1d37783e35ae8668925f92a590ae282eec24c98381a5a8f91b5c2048b5b03` |
| EDPB final-version page | https://www.edpb.europa.eu/documents/guideline/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en | `dl-edpb-page/try.html` | 44800 | `9d58d3d112f5b2f8af840ab138d1678f4ecf048850b0b70c777f0016be55b7c8` |
| EDPB consultation page | https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2023/guidelines-22023-technical-scope-art-53-eprivacy_en | `dl-edpb-page/page.html` | 39467 | `440e113e2a1d8c574a15e346023461d518a426b44a549ee1ce2579ba5761b901` |

Rendered figure pages (USENIX paper, PDF pages 11-12, and a 300 dpi crop of Fig. 18) were produced with `pdftoppm` for visual reading only and are not listed above.

## Appendix B. How to reproduce the key checks

```sh
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
# Claim 1: Cox opinion (use a fresh empty directory for downloads)
curl -sSL -A "$UA" -o cox.pdf https://www.supremecourt.gov/opinions/25pdf/607us2r22_k4lo.pdf
pdftotext -layout cox.pdf cox.txt
grep -n -E "actively encourages|mere knowl|only if it intended|Sotomayor, J\., filed|foreclosed" cox.txt

# Claims 2-4: EUR-Lex (if the reply is HTTP 202, a WAF challenge, wait and retry)
curl -sSL -A "$UA" -o dsa.html 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065'
#   then strip tags and read: Article 19 ("with the exception of Article 24(3)"), Article 15(2), Article 17(2), Article 18
curl -sSL -A "$UA" -o mircom.html 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62019CJ0597'
#   paragraphs 43, 48, 49, 53 and the operative part

# Claim 5: Justice Laws (each page states "Act current to 2026-09-30")
for s in 31.1 27 41.25 41.26 41.27 38.1 42; do curl -sSL -A "$UA" -o "s$s.html" "https://laws-lois.justice.gc.ca/eng/acts/C-42/section-$s.html"; done

# Claim 6: paper text and the Fig. 18 page
curl -sSL -A "$UA" -o sokoto.pdf https://usenix.org/system/files/usenixsecurity24-sokoto.pdf
pdftotext sokoto.pdf sokoto.txt && grep -n -E "entire badbits list|97\.4|87\.97|eight times" sokoto.txt
pdftoppm -f 12 -l 12 -r 300 -x 200 -y 1050 -W 1150 -H 560 -png sokoto.pdf fig18   # then read the bars

# Claim 7: Google v4 vs v5 pages and the two clients' lookup code
curl -sSL -A "$UA" https://developers.google.com/safe-browsing/reference/URLs.and.Hashing | grep -o 'eTLD+1[^<]\{0,160\}'
curl -sSL https://raw.githubusercontent.com/chromium/chromium/main/components/safe_browsing/core/browser/db/sb_protocol_manager_util.cc | grep -n -E 'EXCLUDE_PRIVATE_REGISTRIES|kLocalListsUseSBv5|GenerateHostVariantsToCheckV[45]'
curl -sSL https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/components/url-classifier/LookupCache.cpp | sed -n '/GetLookupFragments/,/MAX_PATH_COMPONENTS/p' | head -60

# Claim 8: EDPB text search for named technologies (expect 0 hits for the first five)
pdftotext -layout edpb.pdf edpb.txt
for t in "service worker" indexeddb "cache storage" webrtc p2p "local storage" peer; do printf '%s: ' "$t"; grep -i -c -- "$t" edpb.txt; done
```

Search tools were not used. If a later session has search budget, the open items to search first are: post-*Cox* lower-court decisions on P2P or hosting services; whether Chrome's field trials enable `SafeBrowsingLocalListsUseSBv5`; Safari and Edge lookup behaviour; any server-side Safe Browsing policy that treats PSL-listed domains differently; national regulator guidance on Service Workers and P2P under Art. 5(3); and the outcome of CJEU C-47/25.
