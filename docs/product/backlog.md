# Product backlog — specified, not built

Two features the founder wants recorded properly and **not implemented** in this pass.
Both are post-beta. Neither has a schema, a job, a screen or a config key in the
repository, and adding one before the beta is a scope decision the founder has already
made once.

---

## 1. Achievements

**Where it lives:** Profile → Achievements. A dedicated screen, reached from the profile
and not scattered across it.

**Why a screen rather than badges on the profile.** The founder's reference is a
collectible wall — Nike Run Club's trophy case. What makes that work is that everything,
earned and unearned, is in one grid: the locked slots are the reason to come back, and
they only read that way when they sit beside the unlocked ones. Badges sprinkled through
a profile are decoration; a wall is a collection. Bingd's profile is already settled —
identity, stats, one Top Ranked wall, activity — and inserting a badge strip into it
would push the ranked titles below the fold, which is the thing the profile is for.

### Shape

- A grid of badges, locked and unlocked shown together.
- Each badge: artwork, title, one line of what earns it, and — when unlocked — the date
  it was earned.
- Optional progress on a badge that is countable ("14 / 25 seasons").
- No social surface in V1: no comparing, no leaderboard, no notifications to other people.

### Candidate inputs

All of these are already derivable from canonical tables, which is the point — an
achievement system that needs its own event log is a second source of truth about
somebody's collection.

| Input | Source |
|---|---|
| Movies watched / ranked | `user_media`, `rankings` where category `movies` |
| TV seasons watched / ranked | `user_media`, `rankings` where category `tv_seasons` |
| Notes and Bingd Reviews written | `user_media.note` with public visibility |
| Recommendations sent | `title_recommendations` |
| Recommendation conversions | the join in `growth-instrumentation.md` §2 |
| Activated invites | `invite_attributions.activated_at` — **needs the redemption wiring first** |
| Breadth | distinct genres, distinct languages, distinct decades |
| Consistency | distinct months with a watch, from `watched_on` |

### Decisions deliberately not made now

- **Thresholds.** Ten films is trivial for one person and a milestone for another, and
  nothing in the repository yet says which the beta cohort looks like. Pick them from
  real distributions after the beta, not from intuition before it.
- **Whether achievements are retroactive.** They should be — the inputs are all historical
  — but that makes the first release hand somebody twelve badges at once, which needs a
  deliberate presentation rather than twelve notifications.
- **Artwork.** Every badge needs a drawn asset. That is a design workstream, not an
  afternoon.

### The trap to avoid

Anything rewarding *invites* becomes farmable the moment it is visible, and the schema
already anticipates that: `invite_attributions.activated_at` exists so a reward can be
gated on the invitee actually using the app rather than on a signup. **Do not ship an
invite-derived badge before redemption and activation have real writers**, or the badge
will be earned by a mechanism nobody can measure.

---

## 2. Quarterly Recap

**Priority:** high, post-beta. Two jobs at once — it gives a returning user a reason to
come back, and it produces the one thing in Bingd somebody would post unprompted.

### The product point that decides the design

At least one shareable composition must make it **obvious that Bingd tracks both movies
and TV seasons**. That is the differentiator against every film-only app, and a recap
card showing five film posters says the opposite of it. The final card should carry both
counts and both favourites, side by side.

### Shape: three to five cards

1. Total movies this quarter.
2. Total TV seasons this quarter.
3. Favourite movie — highest ranked among the quarter's watches.
4. Favourite TV season — same, in the other category.
5. A taste line: the genre or language that grew most.
6. A final shareable composition that carries both halves.

### Quarter membership uses `watched_on`

**Not `rankings.created_at` and not `user_media.created_at`.** A recap is about when
somebody *watched* things, and both other columns record when they got round to telling
Bingd. Somebody who logs a backlog in April would otherwise get a recap claiming they
watched forty films in April.

This carries a known consequence, already recorded as debt: **`watched_on` is nullable,
and there is one per title.** A watch with no date cannot be placed in a quarter, and a
rewatch overwrites the first date. Cross-year rewatch is debt item 1 in
`feature-completion-status.md`, and the standing rule there is that **no year-in-review
or past-period selector ships before it is resolved** — a recap is exactly that feature,
so resolving it is a prerequisite and not a follow-up.

### A developer period override is mandatory, not nice

The feature is testable four times a year unless the period can be set explicitly. Build
it with the quarter as a parameter from the first commit — a start date and an end date,
overridable in development — rather than deriving it from `now()` inside the query. Every
recap feature that skipped this got tested once, in production, in January.

### Not now

No cron. No scheduled job. No notification. No UI. No storage of a computed recap: it is
derivable from `user_media`, `rankings` and `media_items`, and a stored copy is a second
version of the truth that goes stale the moment somebody edits a watch date.
