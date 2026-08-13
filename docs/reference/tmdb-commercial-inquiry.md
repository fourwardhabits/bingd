# TMDB Commercial Use Inquiry — Draft

**Hard Gate:** HG-1
**Status:** Not sent
**Blocks:** Any revenue from Bingd — subscriptions, advertising, sponsorship, or paid access
**Does not block:** The free public alpha

---

## Before sending

1. **Send it early.** Replies commonly take weeks. This should be in flight long before paid beta is contemplated.
2. **Send from a domain address** (e.g. `founder@bingd.app`), not a personal Gmail. It materially affects how the request is triaged.
3. **Route:** the contact form or commercial-licensing address in the TMDB API documentation, from the account registered for the Bingd API key.
4. **Do not soften the commercial framing.** A free alpha for a product with declared subscription intent is not noncommercial, and describing it as a hobby project now creates a problem later.
5. **Keep the reply.** Store the response in this folder and update `decision-log.md` §10 and `open-questions.md` HG-1.

The six-month caching question in section 3 below is the one most likely to change engineering work. PRD §18 currently specifies that a user's own collection metadata persists on-device until logout, which conflicts with the API terms as written. Get a clear answer.

---

## Draft letter

> **Subject:** Commercial licensing inquiry — consumer film and TV ranking app (Bingd)
>
> Hello,
>
> I am building Bingd, a consumer mobile application for movies and television. Users log what they have watched, sort titles into three broad buckets, and then build an exact personal ranking through head-to-head comparisons. Those rankings power taste-similarity matching between users, recommendations, a social activity feed, and shareable ranking cards.
>
> I am currently pre-launch and want to confirm the terms that would apply **before** I build further, rather than seeking permission after the fact.
>
> ### 1. Commercial status
>
> The application will launch as a free public alpha, but it is intended to become a paid subscription product. I am treating this as commercial use from the outset rather than assuming the free period is noncommercial. Please confirm whether that is the correct interpretation, and what licence or agreement applies.
>
> Please also confirm whether the following are treated differently: a free product with declared future subscription intent; a product with a free tier and a paid tier; advertising or sponsorship revenue.
>
> ### 2. Surfaces
>
> Metadata and artwork would appear in an iOS and Android mobile application, and on public web pages at `bingd.app` used as a fallback destination for shared links. Please confirm whether both surfaces are covered by the same terms.
>
> ### 3. Caching and retention
>
> All TMDB requests originate from my backend. No API credential is present in the mobile client. I normalize responses into my own schema and cache them so that a user can view their own collection quickly and while offline.
>
> I understand the API terms restrict caching TMDB-derived information beyond six months absent other agreement terms. **I would like to understand how this applies to a user's own saved collection.** If a user logged a film two years ago, my application needs to display its title, year, and poster when they open their collection. Options I can see:
>
> - Refresh cached metadata for saved titles at least every six months.
> - Retain only a TMDB identifier beyond six months and re-fetch on demand.
> - Agree different retention terms as part of a commercial licence.
>
> Please advise which is acceptable, and whether an on-device cache is treated differently from a server-side cache.
>
> ### 4. Artwork
>
> I plan to serve poster and backdrop images from the TMDB CDN at the published size variants, with a bounded device cache, and no rehosting on my own infrastructure. Please confirm this is acceptable, and specifically whether TMDB artwork may appear in:
>
> - Locally rendered share cards that a user exports to a messaging or social app
> - Open Graph preview images for public `bingd.app` pages
> - Invitation preview images
>
> If artwork is not permitted in any of these, I will use a text-only branded fallback. I would rather know now.
>
> ### 5. Watch-provider availability data
>
> Please confirm whether streaming availability data may be displayed, whether the JustWatch attribution requirement applies to my use, and what specific attribution wording and placement are required.
>
> ### 6. Recommendations and derived data
>
> Bingd generates recommendations using collaborative signals from user rankings, content similarity derived from TMDB metadata such as genres, keywords, cast, and crew, and curated cold-start sets. Please confirm that deriving recommendations from TMDB metadata in this way is permitted.
>
> Separately, please confirm whether TMDB data may be used to train or evaluate machine-learning models. I have no current plans to do so and would rather know the boundary in advance.
>
> ### 7. Attribution
>
> Please confirm the required attribution wording, logo usage, and placement — both in-app and on public web pages.
>
> ### 8. Commercial terms
>
> If a commercial agreement is required, please advise on pricing or pricing tiers, rate limits and how they scale with active users, support and uptime expectations, notice periods for terms or pricing changes, and what happens to cached data on termination — specifically whether deletion is required and on what timeline.
>
> ### 9. Corrections
>
> Please advise the process for reporting metadata errors or requesting corrections.
>
> ---
>
> I am happy to provide additional detail on the application, expected request volumes, or my caching implementation. My goal is to build on terms I can rely on as the product grows.
>
> Thank you for your time.
>
> [Name]
> Bingd
> [email@bingd.app]

---

## Checklist for the reply

Record the answer to each. Anything unanswered stays open in `open-questions.md` HG-1.

- [ ] Commercial status of a free alpha with subscription intent
- [ ] Whether web and mobile are covered by the same terms
- [ ] **Cache retention for a user's own saved collection, beyond six months**
- [ ] Whether device cache differs from server cache
- [ ] Artwork in-app
- [ ] Artwork in exported share cards
- [ ] Artwork in Open Graph and invitation previews
- [ ] Watch-provider availability and JustWatch attribution
- [ ] Recommendation derivation from metadata
- [ ] Model training and evaluation
- [ ] Attribution wording and placement
- [ ] Price and rate limits
- [ ] Notice period for changes
- [ ] Termination and deletion obligations
- [ ] Correction process
