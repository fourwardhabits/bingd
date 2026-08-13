# TMDB — Integration Position

**Researched:** 2026-08-13
**Status:** No blocker. Connect on the free developer key now.
**Supersedes:** an earlier draft of this file, which was a long licensing inquiry letter. The letter was unnecessary.

---

## Position

**Connect now, on a free developer key, with correct attribution.** Nothing needs to be asked, negotiated, or waited for.

**When Bingd starts charging, buy the commercial plan before the first payment lands.** TMDB staff put it at $149/month for companies under $1M revenue and describe signup as "completely self serve." That figure is not published on their pricing page, so treat it as reported, but the mechanism is a checkout rather than a negotiation.

It was recorded as a Hard Gate on the assumption that commercial access required a negotiated agreement with weeks of latency. It does not.

### What the position rests on, and what it does not

**Corrected 2026-08-13, and this distinction is the point of the section.** An earlier version of this file said Bingd "is non-commercial under TMDB's own operative test," and that claim then propagated into `decision-log.md` §10 — where it sat two rows above a Required policy line stating that a free alpha with declared subscription intent is **not** assumed to be noncommercial. The kickoff brief had named that exact assumption as one not to make. A favourable-sounding classification is the last thing that should be asserted as settled, because everything downstream then rests on it.

The gate is closed on narrower grounds that do not require the classification to be right:

1. **The downside is bounded and cheap.** If TMDB reads it the stricter way, the remedy is a published price paid on demand.
2. **A Hard Gate is for dependencies on someone else's timeline.** HG-2 through HG-6 all are. This is not, and treating it as one would block design work for weeks against a risk resolvable in an afternoon.
3. **The obligations that matter hold either way** — attribution in the first screens, retention under six months, no artwork rehosted, no credential in the client. None is deferred pending an answer.

The underlying ambiguity is real and unresolved. TMDB's written test is whether "the primary purpose is to create revenue," which someone could read as capturing a free product with declared subscription intent. Their staff's operative test is narrower and behavioural — "if you are earning revenue from our service and/or data, then it counts as commercial." **The two readings differ precisely for a pre-revenue product like this one, and nothing here settles which applies.** It does not need settling; it needs the plan bought before the first payment.

---

## What to build, so nothing needs asking

Two rules that keep Bingd inside the terms as written. Both are already supported by the architecture, so neither is new work.

### Refresh cached metadata for saved titles at least every six months

TMDB's terms restrict retaining TMDB-derived information beyond six months absent other agreement terms. PRD §18 wants a user's collection to work offline indefinitely, which reads as a conflict — but only if the cache is never refreshed.

Building to the conservative interpretation removes the question entirely:

- **Bingd's own data** — what a user logged, bucketed, ranked, listed — is Bingd's and is retained without limit.
- **TMDB-derived metadata** attached to those titles carries a fetch timestamp and is refreshed on a rolling basis under six months, or reduced to a TMDB identifier and re-fetched on demand.

[`../architecture/offline-sync.md`](../architecture/offline-sync.md) already stores these separately, and [`../architecture/README.md`](../architecture/README.md) AD-8 already makes retention a runtime config value rather than a constant.

> **This was true of the device cache and the facet cache, and false of the server's own title rows until 2026-08-13.** `media_cache` carried an `expires_at` per facet. `media_items` — title, overview, poster path, genres, the bulk of the provider data — carried only a `fetched_at`, with no index on it and no job that read it. A title in someone's ranking and untouched for seven months was retained provider data with nothing able to find it, which is the one compliance claim this whole position depends on.
>
> Fixed by a `media_refresh_due` view listing referenced rows past 150 days, drained by `tmdb-adapter`; unreferenced stale rows are pruned instead, which reaches the same compliance for less quota. Note that "reduce to a bare TMDB identifier" was not actually available as a fallback either, since `media_items.title` is `not null`.

### Posters in the app and in on-device share cards, but not in Open Graph images

**In-app poster use is unambiguous.** TMDB's terms permit displaying their images within your application, which is the API's purpose. Serve artwork from the TMDB CDN at published size variants, do not rehost it on Bingd infrastructure, and attribute correctly. Posters are central to the design ([`../design/design-system.md`](../design/design-system.md) §7) and nothing here constrains that.

**On-device share cards keep their posters.** The artwork is fetched from the provider CDN, composited on the user's phone, and shared by the user. No Bingd server touches the image, which is ordinary use of images already fetched for display.

**Open Graph link previews are typographic in v1.** *(Changed 2026-08-13, under the approved gate change.)* This file previously grouped exported cards and link previews together as "standard practice," but they are materially different: an OG image is generated by Bingd's server and served from Bingd's infrastructure to any crawler that asks, indefinitely, with no user in the loop. PRD §19 says artwork is *"never rehosted on Bingd infrastructure"* — and a server-rendered image containing a poster is rehosting it, whatever the surrounding layout does. The two statements were both in the PRD and could not both hold.

The Letterboxd comparison does not carry the argument either. Letterboxd is a TMDB **commercial licensee**, so what it ships tells you what a licensee may do rather than what a free developer key permits.

Little is lost. A preview reading `#3 · The Zone of Interest` in DM Serif Display on Parchment is more distinctly Bingd than a poster grid, since the poster is the one element every competitor's preview also has. Revisit when the commercial plan is active.

**A text-only share-card variant still exists** for a product reason rather than a legal one: artwork is often missing for obscure titles, and a Top 10 must render when three of the ten have no poster. See [`../architecture/client.md`](../architecture/client.md) §6.

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
| Wanting posters in **server-rendered** Open Graph images | Ask `sales@themoviedb.org`, include country. Not needed for on-device share cards |
| TMDB contacts Bingd about the account | Read the position above again. It was written to survive this |
| Adding streaming availability display | Confirm JustWatch attribution requirements |
| Considering any LLM or model-training use of TMDB data | Read the terms again; this is restricted |

`sales@themoviedb.org` is the route for all of the above. TMDB asks that you include your country to help them route the request.
