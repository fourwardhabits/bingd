# Launch acquisition operating plan

Written 2026-09-05. This is the canonical go-to-market document: who bingd. is for at
launch, where those people currently are, what may honestly be said to them, and what
can and cannot be measured once they arrive.

It is an operating plan, not a pitch. Where a claim cannot be verified it says so.

**Canonical identity.** Everything outward-facing uses these and nothing else.

| | |
|---|---|
| Name | bingd. |
| Positioning | Rank what you watch, find your next binge. |
| Bio | Rank what you watch, find your next binge. Movies + TV. |
| Handle | @bingdwatch |
| Site | https://bingd.app |
| Assets | `store-assets/social/`, README in that folder |

Related documents. `docs/product/growth-instrumentation.md` is the authority on what the
invite funnel does and does not measure. `docs/product/analytics.md` is the authority on
the event set. Neither is restated here; where this plan depends on them it cites them.

---

## 1. The strategic objective

Six things, in the order they compound:

1. the post-watch habit
2. personal ranking depth
3. a dense friend graph
4. reciprocal relationships
5. community relationships
6. category association, so "rank it" means bingd.

The ritual all six hang off:

> I finished something. I want to see what score it gets and where it lands.

Every channel below is judged on whether it recruits people who will actually perform
that loop, not on how many signups it produces.

### 1.1 The post-watch reflex, and what the reveal says

The loop is watch, open bingd., rank, and then three things in this order:

| Beat | The question it answers |
|---|---|
| **Score** | How strongly did this resolve in my taste? |
| **Placement** | Where does it actually sit against everything else I have seen? |
| **Neighbours** | What did I just put this above and below? |

These are complementary and should never be pitched as competing systems. The score is
the one people anticipate during the comparisons. The placement is the one they did not
see coming. The two names either side are what turn a number into an argument, which is
the part that gets repeated to somebody else.

The external form of that third beat is the content format in section 10:

> Sicario just landed #4 in my Movies.

**Do not document the reveal's layout here.** It lives in the code and its decisions are
recorded in the commits that made them. What belongs in a GTM document is that the payoff
exists and what it feels like, because that is the thing being marketed.

---

## 2. What bingd. is, stated honestly

**It does.** Movies and TV seasons in one app. Ordinal ranking by pairwise comparison
rather than star ratings, producing a personally ranked Collection. Taste Match against
other members. Following, reactions, comments and mentions. Recommendations sent to a
person. Group Picks. Invite links.

**It does not.** Episode-by-episode progress tracking. There is no next-episode calendar,
no per-episode check-in, no per-episode comment thread. TV is ranked at the season.

**It does not, yet.** Import from any external service. Lists.

That second block is not a gap to be talked around. It is the single most important
qualifier in every TV-audience conversation below, and stating it early is what keeps
the rest credible.

---

## 3. The TV Time situation

### 3.1 What is verified

- TV Time shut down on **15 July 2026**. Whip Media announced it on 1 July, giving about
  two weeks' notice, citing a lack of sustainability as a free app and too little
  interest in a paid tier. The app was pulled from both stores and user data was deleted
  after that date.
- It had roughly **26 million lifetime installs**.
- Users could export an archive through the app's GDPR self-service tool before the
  shutdown. That tool went offline with the app.
- **Bingers** launched on **4 August 2026**, built by **Antonio Pinto**, an original
  founder of TVShow Time, which he sold to Whip Media in 2016. Bingers imports a TV Time
  archive and, per its founder, reconstructs the community comments from imported
  archives.
- A **TV Time Refugees** Discord exists, with roughly **2,500 members** as listed.
- The alternatives being recommended publicly are Showly, SeriesGuide, Simkl, BetaSeries,
  Serializd, Trakt, Moviebase and Kino. Several advertise a one-tap TV Time archive
  import.

### 3.2 What could not be verified from this environment

Reddit is not reachable from the machine this was written on. **Nothing below about
r/TVTime, r/television, r/AMCsAList, r/RegalUnlimited or r/beliapp subscriber counts,
current activity, megathreads or self-promotion rules has been confirmed.** Every Reddit
action in section 7 therefore begins with the founder reading the sidebar and the pinned
posts on the day, and no post should go up on the strength of this document alone.

### 3.3 What TV Time users actually valued

Reading across the shutdown coverage and the alternatives write-ups, the things users
named as losses cluster into three, and they are not equally weighted:

1. **The post-episode community.** A comment, meme and GIF thread scoped to the exact
   episode you had just finished, spoiler-gated to your own progress. This is named first
   and most often in the coverage.
2. **The historical corpus.** A decade of watch history, deleted.
3. **Episode progress tracking and the calendar.** Named, but as plumbing. It is what
   made 1 and 2 possible rather than the thing people were attached to.

### 3.4 What made it sticky, as behaviour

The loop was: finish an episode, open the app to mark it, and find a room full of people
who had just finished the same episode. Marking watched was not the reward. It was the
ticket into the room, and the room refreshed weekly with the release schedule.

Two properties made that work and are worth naming because bingd. shares only one of
them. The reward was **immediate**, in the same minute as the watch. And it was
**synchronous with other people**, because a weekly episode drop puts thousands of
people at the same point on the same night.

bingd. has the first. It does not have the second, and cannot without episode-level
scope.

### 3.5 What bingd. can honestly serve a displaced TV Time user today

- A place to keep a record of what they watch, movies and TV together, which most of the
  pure TV trackers do not do in one list.
- A stronger opinion than a checkmark: an actual ordered list of everything they have
  seen, which no tracker in the list above produces.
- A social layer around titles, with friends, taste comparison, recommendations and
  Group Picks.

### 3.6 What it cannot serve

- Anyone whose core need is episode-by-episode progress, a next-episode calendar, or a
  per-episode discussion thread. That is most of the r/TVTime population and it should
  be conceded immediately rather than argued with.
- Anyone who wants their TV Time archive back. bingd. has no import.

### 3.7 Bingers, stated plainly

Bingers has advantages bingd. cannot compete with and should not try to:

- The original founder's name and the credibility that carries with the community.
- Archive import, which restores the corpus.
- Reconstruction of the old community comments, which restores the room.
- An explicit promise to rebuild the thing people are grieving.

**Do not position against Bingers.** A former TV Time user who wants TV Time back should
use Bingers, and saying so is both true and the fastest way to be trusted by the people
who do not want that.

The opportunity is not the loyalists. It is the fraction of that population who were
never really episode-trackers: people who used TV Time to keep a record and to talk
about what they watched, who also watch films, and who are now shopping. They are a
minority of 26 million installs and a minority is a very large number.

### 3.8 The wedge

Not a TV Time replacement. The line to work from, adapted per channel:

> If what you miss is having a record of what you watch and somewhere social to put it,
> bingd. is a different shape of that. You rank movies and TV seasons against each other
> instead of rating them, so you end up with an actual ordered list, and you can see
> where your taste overlaps with your friends'. It ranks TV by season and does not track
> individual episodes, so if per-episode progress is the part you need, it is not this.

The disclosure is not a footnote. It goes in the same breath as the pitch, every time.

### 3.9 Competitive note: Letterboxd

Letterboxd has publicly said TV support is coming and reconfirmed it after the TV Time
shutdown. It has been promised for some time and has not shipped as of writing, and no
reliable date is available. Treat it as a standing risk to the "movies and TV in one
place" half of the wedge rather than as an imminent event.

It does not threaten the other half. Letterboxd rates out of five stars; bingd. produces
an ordered list. Those are different products even on the same catalogue.

---

## 4. Growth posture

Multiple high-fit lanes in controlled parallel bursts. Not one channel at a time.

| Stage | Target | Gate to the next |
|---|---|---|
| Wave 0 | warm contacts | product survives real strangers |
| Wave 1 | ~100 to 200 signups | ~50 activated outsiders, no blocker |
| Wave 2 | 300 to 500 | retention and connection rates hold |
| Wave 3 | 1,000+ | deliberate, once the loop is proven |

Activation is **ten ranked titles**. This is not a proposal: `_maybe_activate_invite`
already writes `invite_attributions.activated_at` at ten, so the definition is in the
database.

50 is a checkpoint, not a ceiling. Do not throttle organic pull. If a channel converts,
run the next one rather than waiting.

---

## 5. Measurement, and the hole in it

**Read `docs/product/growth-instrumentation.md` before quoting any invite number.** Two
constraints from it govern this plan:

1. **Opening a share sheet is not an invitation sent.** Nothing can observe whether the
   message was sent.
2. **A token does not survive a store install.** Someone who taps a link, installs from
   the store and opens the app from the home screen arrives with no token and is
   permanently unattributed. Every invite number is a floor. Report it as one and never
   scale it by a guessed factor.

### 5.1 Signups per source, and the decision not to buy it with invite links

`acquisition_source` exists as a nullable PostHog super-property with the values
`friend_direct`, `launch_party`, `beli`, `letterboxd`, `amc_alist`, `reddit`,
`instagram`, `organic_store`, `invite`, `other`. **It has exactly one caller:
`redeem_invite`, which sets `invite`.** No channel sets its own value. Nothing infers a
source from behaviour, and per `analytics.md` nothing may.

So per-channel attribution does not exist out of the box. There is one mechanism that
would produce it with no code: mint one invite link per channel and post that as the call
to action. `invite_link_opens` would give per-channel clicks, `invite_attributions` the
signups, and `activated_at` the activations.

**Decision, 2026-09-05: do not do this.** Redeeming an invite is not a neutral act. It
writes a one-way follow to the inviter and files an `invite_joined` notification. Running
every channel through invite links would therefore manufacture a follow edge for every
single acquired user, and those edges land in exactly the numbers section 5.2 exists to
read honestly:

- follower counts
- follow behaviour and follow-back rate
- reciprocity and mutual follows
- network density, cluster count, largest component
- retention segmented by connection count

That last one is the whole point. The question worth answering in the first waves is
whether social connection predicts retention. If every user arrives already following the
founder, there is no zero-connection cohort left to compare against and the question
cannot be asked at all. Buying attribution with invite links would cost the more valuable
measurement.

**Perfect channel attribution is not a launch blocker.** For the first waves, use:

- the timing of each outreach push, against the signup curve
- an outreach tracker kept by hand: what was posted, where, when
- platform-side click data wherever the channel gives it
- PostHog session and referrer data that is already legitimately collected
- asking people, in the research conversations in section 11

Do not infer a source from behaviour. An unattributed signup is unattributed.

#### Post-launch instrumentation follow-up, high priority

Build campaign and source attribution **independently of social invites**.

The principle that has to hold: campaign or source metadata must never create a follow,
alter social graph state, change feed eligibility, or move any network-density metric. It
is a label on an arrival, not a relationship.

A plausible shape is a query parameter on the landing page, something like
`bingd.app/?src=<campaign>`, carried into `acquisition_source` at signup. **Not designed
here.** Preserving a source across a store install is the same deferred-linking problem
described in `growth-instrumentation.md` and is not solved by this either.

### 5.2 The metric set

**Acquisition.** Signups over time against the outreach timeline, plus whatever
platform-side click data each channel gives. Per-channel signup counts are an estimate
during the first waves, deliberately, for the reason in 5.1. Say estimate when reporting
them.

**Activation.** Ten ranked titles. Already instrumented.

**Habit.** This is the one that matters most and the one to watch first.
- ranking sessions on more than one distinct day
- titles ranked that were watched after signup, as distinct from backfilled history
- Collection growth per week per active user

**Network.**
- share with at least 1 follow, at least 3 follows
- mutual follows, and follow-back rate
- number of connected clusters, and size of the largest component
- triangles and clustering coefficient, later, when the graph is large enough to mean
  anything

**Social.** Reactions, comments, recommendations sent and opened, Taste Match views,
Group Picks generations and unique participants. Event names are in `analytics.md`.

**Retention.** Return behaviour by week. 7-day retention only once the sample supports
it. Segment by connection count: 0, 1 to 2, 3+. The expected finding is that connections
predict retention, and if they do not, that changes the plan.

**Virality.** Links created, links opened, redemptions, activated redemptions. Floors.

**Catalogue density.**
- rankings per activated user
- share of title-detail views where the title has at least 1, at least 5, at least 10
  bingd. rankings
- share of title-detail views where the title has zero community ratings

---

## 6. Catalogue density

The catalogue is a cache: `media_items` only holds what somebody has already searched
for. Community density is therefore a function of who is recruited, not of what is
seeded.

**Prohibited.** No fake accounts. No synthetic community ratings. No TMDB, IMDb or
Rotten Tomatoes score presented as a bingd. score. A community mean below three ratings
already shows its sample size instead of a number, and that honesty is the asset.

**The strategy is cohort choice.** Recruit people whose ordinary viewing overlaps, so
density appears where it is visible. In practice that means recruiting around films and
shows that are currently in cinemas or currently airing, rather than around long-tail
catalogue.

High-value early cohorts, in rough order of density per user:

1. Heavy Letterboxd loggers. Hundreds of films each, strong overlap on recent releases,
   already in the habit of logging.
2. AMC A-List and Regal Unlimited members. They see most wide releases within a week of
   each other, which produces overlap on exactly the titles people look up.
3. Film club members. Pre-existing group, shared viewing, natural Group Picks use.
4. Frequent TV watchers who are comfortable at season level.
5. Former TV Time users in the subset described in 3.7.

Do not attempt to cover the TMDB long tail. Depth on a few hundred current titles beats
one ranking each on ten thousand.

---

## 7. Channels

Every Reddit entry is subject to 3.2: **read the current rules first.** Nothing here has
been confirmed against a live subreddit.

Universal rules. Disclose that you built it, every time, in the post itself and not only
when asked. Do not post the same text in two communities. Answer comparison questions
straight, including when the answer is another app.

### 7.1 Warm (Wave 0)

Beta users, friends, the AMC and film WhatsApp groups. No rules to check, highest
conversion, and the only cohort where a follow graph forms without any work. Do this
first and completely before anything public.

### 7.2 Beli-aware

r/beliapp and people who already use Beli. The hook is the strongest one available
because it does the explaining for free:

> I wanted Beli but for movies and TV, so I built it.

Use it only where Beli is understood. Outside that audience it is a reference to nothing.

### 7.3 Film and cinema

r/AMCsAList, r/RegalUnlimited, film clubs, Letterboxd-aware audiences. These are the
highest-density cohorts in section 6. Subscription cinema subreddits are usually tolerant
of on-topic tools and usually intolerant of anything that reads as an ad, so lead with the
specific thing the audience does: seeing everything, and having nowhere to put the
resulting opinions in order.

### 7.4 TV Time and TV

r/TVTime, TV Time refugee communities, alternatives megathreads, the TV Time Refugees
Discord. Many alternative developers are promoting in these spaces right now, so the
differentiated move is not a better pitch, it is being the one who is useful and
straight about fit. Answer comparison questions honestly, recommend Bingers where Bingers
is the right answer, and post about bingd. only where the rules allow it.

**Modmail first in r/TVTime.** This is a community in the middle of being solicited by
many developers at once, its rules may well have been tightened in response, and the cost
of asking is one message against a permanent ban. Ask before posting.

The Discord is the higher-quality room of the two: about 2,500 self-selected people who
cared enough to regroup. Same principle. Participate for a while before mentioning
anything you built, and check the server rules on self-promotion.

r/television and general TV subreddits are the weakest fit and mostly ban this outright.
Skip unless a specific thread invites it.

### 7.5 Social

Instagram and TikTok at @bingdwatch, plus a branded Reddit account. X and YouTube later.
No content calendar yet. Assets are in `store-assets/social/`.

---

## 8. Outreach copy

Verify every factual claim against the product on the day it goes out. No em dashes.

### 8.1 Warm friend message

> I finally finished the thing I have been building. It is called bingd. You rank the
> films and shows you watch against each other instead of giving them stars, so you end
> up with an actual ranked list of everything you have seen. I would like you on it
> because it is more fun when you can see what your friends think.
>
> https://bingd.app

### 8.2 Beta user message

> Thanks for putting up with the rough version. The build going out now is the one I am
> happy for other people to see.
>
> The thing I would most like from you: rank ten titles you have watched recently and
> tell me where it got annoying. I would rather hear the annoying part than the nice
> part.

### 8.3 AMC and film group message

> We see basically everything, and the only record any of us has is a group chat we
> cannot search.
>
> I built an app for it. You rank what you have watched against each other rather than
> scoring it, so you get a proper ordered list instead of forty films all rated 4 stars.
> It does movies and TV seasons. You can see whose taste actually matches yours, and it
> will pick something for a group when nobody can decide.
>
> https://bingd.app

### 8.4 r/beliapp post

> **Title:** I wanted Beli for movies and TV, so I built it
>
> I built this and I am posting it here because this community is the one that will
> immediately understand the idea.
>
> It is called bingd. Same core mechanic: you rank things against each other rather than
> rating them, so instead of a pile of 4 star reviews you get an actual ordered list of
> everything you have watched. Movies and TV seasons in the same app. You can see how
> much your taste overlaps with a friend's, send someone a recommendation, and get a pick
> for a group.
>
> Where it differs from Beli: TV is ranked by season, and there is no import yet, so the
> first stretch is you rebuilding your own list. That is the honest catch.
>
> https://bingd.app
>
> Happy to answer anything, including what it does badly.

### 8.5 r/AMCsAList post

> **Title:** Built a ranking app for people who see everything
>
> Disclosure up front: I made this.
>
> The problem I had with A-List is that after a year I could not tell you whether the
> March film was better than the September one. Letterboxd gave me a wall of 4 star
> ratings that all looked the same.
>
> So bingd. ranks instead of rates. You pick a film you just saw, it asks you a few
> head-to-head questions against films you have already ranked, and it slots into an
> ordered list. After twenty or thirty you have something that is genuinely yours and
> that you will argue about.
>
> It does TV seasons too, and it will pick something for a group.
>
> https://bingd.app
>
> Mods, remove if this is not allowed.

### 8.6 r/RegalUnlimited post

> **Title:** Anyone else lose track of what they thought about everything they saw?
>
> Disclosure: I built the thing I am about to mention.
>
> Unlimited means I see far more than I can keep straight, and my ratings had stopped
> meaning anything because everything decent got the same score.
>
> bingd. asks you to compare a film against ones you have already ranked instead of
> scoring it. You end up with a list in order, top to bottom, which turns out to be much
> harder to be lazy about and much more fun to show someone. Movies and TV seasons.
>
> https://bingd.app
>
> Removing it if the mods prefer.

### 8.7 Letterboxd community modmail

> Hello,
>
> I have built a film and TV app and I want to check what is allowed here before I post
> anything, rather than after.
>
> It is called bingd. It ranks films against each other rather than rating them, so you
> get an ordered list instead of a star distribution. It covers TV seasons as well. It is
> free, there is no ads or subscription, and it is not a Letterboxd client or scraper.
>
> There is no Letterboxd import, and I would rather say that here than have someone find
> out after signing up.
>
> Is there a form of post that would be acceptable, or would you prefer I did not? Happy
> either way.
>
> Thanks.

### 8.8 r/TVTime modmail

> Hello,
>
> I want to ask before posting, because I know this community is getting a lot of
> developers at the moment.
>
> I built an app called bingd. It is not a TV Time replacement and I would not present it
> as one. It ranks movies and TV seasons against each other to build a personal ordered
> list, and it has following, comments and taste comparison. It does not track episodes
> and it has no TV Time import. For anyone who wants TV Time back, Bingers is the
> honest answer and I would say so in the thread.
>
> I think it fits a narrow slice of this community: people who used TV Time to keep a
> record and to talk about what they watched, who also watch films, and who can live at
> season level.
>
> Would a comment in an alternatives thread be acceptable? Or a post, if you have a
> format you prefer? If the answer is no, that is completely fine and I will leave it.
>
> Thanks for running the place through a rough few months.

### 8.9 Alternatives megathread entry

Only if the rules permit, and only as a comment in an existing thread.

> Adding one for a narrow case, with a disclosure: I built it.
>
> **bingd.** Movies and TV in one app. It ranks titles against each other rather than
> rating them, so you get an ordered list of everything you have watched rather than a
> pile of scores. It has following, comments, taste matching and a group picker.
>
> **It does not track individual episodes and there is no TV Time import.** If episode
> progress or getting your archive back is what you are here for, Bingers or Simkl will
> serve you better and I would rather say that than waste your time.
>
> It is for the case where what you actually miss is having a record and somewhere social
> to put it, and you also watch films.
>
> https://bingd.app

### 8.10 Short message to a former TV Time user

> bingd. is not a TV Time replacement, so I will say what it is not first. No episode
> tracking, no calendar, no import. TV is ranked by season.
>
> What it is: you rank films and shows against each other and end up with an ordered list
> of everything you have watched, and there are people on it whose taste you can compare
> with your own.
>
> If the part you miss is the per-episode threads, Bingers is rebuilding that and you
> should look there first.

### 8.11 Film club email

> **Subject:** Something for the club
>
> I have built an app I think the club would get something out of, and I would rather show
> you than pitch it.
>
> It is called bingd. You rank films and TV seasons against each other rather than giving
> them scores, so each person ends up with a genuinely ordered list. Two things make it
> useful for a group like ours. You can see how closely your taste actually matches
> someone else's, which is usually funnier than anyone expects. And when several people
> cannot agree on what to watch, it will produce a shortlist from what the group has
> collectively rated.
>
> It is free and there is nothing to buy.
>
> If you want to try it: https://bingd.app
>
> Happy to come and walk anyone through it.

### 8.12 Forwardable club blurb

> bingd. is a free app for ranking films and TV. Rather than rating things out of five,
> you compare them against each other, so you end up with a proper ordered list of
> everything you have watched. You can compare your taste with other people and get a
> group shortlist when nobody can decide. Movies and TV seasons. https://bingd.app

---

## 9. Import strategy: audit only

No import is being built. This records where each stands and what would change that.

External history must never silently become bingd. community scores. The pattern to
work from, if either is ever built:

> external history becomes an imported historical corpus, held as unranked or provisional
> entries, which the user progressively converts into real bingd. rankings.

An imported star rating is not a bingd. ranking and must never be counted as one in a
community mean.

### 9.1 Letterboxd

| | |
|---|---|
| Adoption value | High. Rebuilding a 500 film history by hand is the most likely reason a heavy logger tries bingd. once and stops. |
| Complexity | Moderate. The export is a CSV, film level, with title, year, date and rating. |
| Matching risk | Moderate. Title plus year against TMDB is mostly reliable and wrong on remakes, re-releases and international titles. Needs a review step, not silent matching. |
| Integrity | The core risk. A five star rating is not a position. Import must produce unranked entries. |
| Privacy | The file is the user's own and contains their history. It must not be retained after processing. |
| Watch dates | Present and usable. |
| Watchlists | Separate export, straightforward. |
| External ratings | Import as provisional signal at most. Never as a bingd. score, never into a community mean. |
| Reviews | Present. Out of scope for a first pass. |
| Episode incompatibility | None. Letterboxd is films. |
| Mobile vs web | File upload is a web job. A mobile-only import is the harder half and should not gate the feature. |

**Trigger.** Build it when early Letterboxd-heavy users repeatedly say, unprompted, that
rebuilding their history is what stopped them. Question 11 in section 11 exists to detect
exactly that. Until several people say it, this is an assumption.

### 9.2 TV Time archive

| | |
|---|---|
| Adoption value | Low to moderate, and falling. The export tool went offline with the app, so only users who exported before 15 July 2026 have a file at all. |
| Complexity | High. Episode-level data into a season-level model. |
| Matching risk | High. TV Time used TheTVDB; bingd. uses TMDB. Season and episode numbering differ between them on exactly the shows people care about. |
| Integrity | The hard problem. Collapsing watched episodes into a watched season is a judgement, not a conversion. A partially watched season has no correct answer. |
| Privacy | Same as above. |
| Watch dates | Per episode. A season would have to take a derived date. |
| Watchlists | Present. |
| External ratings | Per episode. Does not map to a season ranking. |
| Comments | Do not import. They were written for another community. |
| Episode incompatibility | This is the whole problem, not an edge case. |
| Mobile vs web | Web. |

**Trigger.** Only if all three hold: enough TV Time refugees turn out to be a genuine fit,
the export maps to seasons without inventing data, and import is demonstrably what blocks
adoption. Bingers already does archive import well and rebuilding the associated
community, so this is competing on someone else's strength. **Current recommendation: do
not build.**

---

## 10. Recorded, not built

**"Where did it land?" as an external format.**

> Sicario just landed #4 in my Movies.

This is the product's core behaviour stated as a sentence, which makes it the natural
content format: founder posts, opening-weekend reactions, creator content, friend
disagreements, and eventually share cards. Worth testing manually by posting them by
hand long before anything is built. **No content engine now.**

**The share card that could carry it.** A composition worth trying later: the newly
ranked title's poster in the centre, the titles immediately above and below it set behind
or beside it, the score, the placement, and the bingd. mark. It states the whole payoff in
one image and it is self-explanatory to somebody who has never used the app.

This was considered for the in-app reveal and deliberately ruled out there. Posters
compete with the score for the one moment that screen exists for, they make the reveal
wait on an image, and the meaning of a neighbouring poster is not obvious at a glance. The
in-app anchors are text. **A share card is the opposite case**: nobody is mid-flow, the
image has to work on its own in somebody else's feed, and visual richness is the point.

Not built, and it needs share functionality that does not exist yet. Recorded so the
distinction is not lost: restrained in the app, rich in the artifact.

**Lists.** Deferred and **not a launch blocker**, but strategically interesting: power
users, creators, curated collections, and a genuinely shareable object, which bingd.
currently lacks. The narrowest plausible entry is Group Picks gaining "save as list",
which reuses an object that already exists rather than starting a subsystem. **No
implementation.**

---

## 11. Research questions for early power users

Ask conversationally. The wrong answers are the valuable ones.

**Everyone.**

1. What did you do the last time you finished a film or a show? Walk me through the
   actual sequence.
2. What made you open bingd. the second time?
3. When did you stop, and what were you doing at the time?
4. Who do you want to see on here, and what would make you actually send it to them?
5. What did you expect it to do that it did not?

**Former TV Time users.**

6. What did you actually do most often in TV Time?
7. What did you usually do immediately after finishing an episode?
8. What do you miss most about it?
9. Is season-level tracking enough for you, or do you need individual episodes?
10. What made bingd. interesting to you, if anything did?
11. What would make bingd. the app you open without thinking after you watch something?
12. How much does importing your old history matter?
13. What other replacements are you trying, and why those?

**Letterboxd users.** Ask exactly this, and record the answer verbatim:

14. Would importing your Letterboxd history materially change how likely you are to use
    bingd. regularly?

---

## 12. Decisions

### Settled, 2026-09-05

1. **Attribution is not bought with invite links.** Unattributed channels are accepted
   for the first waves rather than contaminating the network metrics. Section 5.1, with
   the post-launch follow-up recorded there.
2. **The TV Time channels get tested, narrowly.** Not as a replacement pitch, and not at
   the expense of the film cohorts in section 6. The target is the subset who valued
   keeping a history, the social context, movies and TV in one place, and who can live at
   season level. Every message states that there is no episode-level tracking. Sections
   3.7, 3.8 and 7.4.
3. **The reveal is score, then placement, then neighbours**, and the in-app anchors are
   text rather than posters. Section 1.1, with the share-card idea kept in section 10.

### Still open

4. **Letterboxd import**, on the trigger in 9.1 rather than on instinct. Question 14 in
   section 11 is what settles it.
