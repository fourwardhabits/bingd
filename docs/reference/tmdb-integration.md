# TMDB — Integration Position

**Researched:** 2026-08-13
**Status:** No blocker. Connect on the free developer key now.
**Supersedes:** an earlier draft of this file, which was a long licensing inquiry letter. The letter was unnecessary.

---

## Position

**Connect now, on a free developer key, with correct attribution.** Bingd charges nobody and sells nothing, so it is non-commercial under TMDB's own operative test. Nothing needs to be asked, negotiated, or waited for.

**When Bingd starts charging, buy the commercial plan before the first payment lands.** TMDB staff put it at $149/month for companies under $1M revenue and describe signup as "completely self serve." That figure is not published on their pricing page, so treat it as reported, but the mechanism is a checkout rather than a negotiation.

That is the whole thing. It was recorded as a Hard Gate on the assumption that commercial access required a negotiated agreement with weeks of latency. It does not.

### The one caveat, stated honestly

TMDB's written test is whether "the primary purpose is to create revenue," which someone could read as capturing a free product with declared subscription intent. Their staff's operative test is narrower and behavioral — "if you are earning revenue from our service and/or data, then it counts as commercial." The two readings differ only for a pre-revenue product like this one.

The exposure is small and cheaply corrected. If TMDB reads it the stricter way, the remedy is buying a $149/month plan that is available on demand. That is not a risk worth delaying development for.

---

## What to build, so nothing needs asking

Two rules that keep Bingd inside the terms as written. Both are already supported by the architecture, so neither is new work.

### Refresh cached metadata for saved titles at least every six months

TMDB's terms restrict retaining TMDB-derived information beyond six months absent other agreement terms. PRD §18 wants a user's collection to work offline indefinitely, which reads as a conflict — but only if the cache is never refreshed.

Building to the conservative interpretation removes the question entirely:

- **Bingd's own data** — what a user logged, bucketed, ranked, listed — is Bingd's and is retained without limit.
- **TMDB-derived metadata** attached to those titles carries a fetch timestamp and is refreshed on a rolling basis under six months, or reduced to a TMDB identifier and re-fetched on demand.

[`../architecture/offline-sync.md`](../architecture/offline-sync.md) already stores these separately, and [`../architecture/README.md`](../architecture/README.md) AD-8 already makes retention a runtime config value rather than a constant. Set that value under six months and the terms are satisfied with no correspondence.

### Ship the text-first Top 10 share card as the primary artifact

The genuinely ambiguous question is whether TMDB artwork may appear in an image a user exports to a messaging app, or in an Open Graph preview. The terms permit display within an application and prohibit rehosting; an exported PNG sits between the two.

[`../architecture/client.md`](../architecture/client.md) §6 already specifies a text-only share card and insists it be "a real layout, not a degraded one." Making it the *primary* Top 10 card resolves the ambiguity by not depending on the answer — and it is the better artifact anyway. DM Serif Display on Parchment is Bingd's brand; a grid of other people's posters is not.

Poster-bearing share cards remain possible later, if and when the question is worth asking.

---

## Attribution — required, and buildable now

From TMDB's FAQ, quoted exactly:

> You shall place the following notice prominently on your application: "This product uses the TMDB API but is not endorsed or certified by TMDB."

Also required:

- Use an [approved TMDB logo](https://www.themoviedb.org/about/logos-attribution), unmodified in color, aspect ratio, or orientation.
- Keep it **less prominent** than Bingd's own mark.
- Place the attribution in an **About or Credits** section.

Bingd needs two slots: the About section in Settings, and the attribution line on title detail ([`../design/screens.md`](../design/screens.md) §6). Both are cheap now and expensive to retrofit across a shipped app.

**There is no SLA.** TMDB publishes a status page and makes reasonable efforts but commits to nothing. Worth knowing, since the catalog is a hard dependency.

---

## Revisit when

| Trigger | Action |
|---|---|
| About to charge anyone, for anything | Buy the commercial plan first |
| Wanting posters in exported share cards or link previews | Ask `sales@themoviedb.org`, include country |
| Adding streaming availability display | Confirm JustWatch attribution requirements |
| Considering any LLM or model-training use of TMDB data | Read the terms again; this is restricted |

`sales@themoviedb.org` is the route for all of the above. TMDB asks that you include your country to help them route the request.
