# Founder QA — Lists v1 + Watch History T1–T4

**Candidate:** `integration/lists-watch-history` · app code at `6e2c040`, tests to `655f8ad`
**Backend:** bingd-staging (`fjxhcbowoxuzulwirzyr`) — all five migrations applied, `upToDate`
**Production:** untouched, still at `20261002000100`

---

## 0. BEFORE ANYTHING: there is no build you can install yet

**No preview app on any device can run this candidate today.** Do not install the preview
OTA and expect to see Lists — it will not arrive.

- The newest preview builds are **v1.0.1 (7)**, built 2026-09-11, runtimes `aa3056e7` (iOS)
  and `8e8731a2` (Android).
- The preview OTA published for this candidate targets runtimes `3e776a7d` / `c85beea6`.
  **No build of any profile has those runtimes** (0 of 40 checked).
- It was also published from a worktree whose `node_modules` is a junction — the first trap
  in `bingd-fingerprint-publish-traps` — so it will not match even a fresh build of the
  same commit. **Treat that OTA as dead.** It is harmless: preview branch, staging backend,
  and it reaches nobody.

### The build that unblocks QA

A new **preview build per platform**, from a *clean* clone at the integration head. Clean
means a real `npm ci` — not a junctioned `node_modules` — because eas-cli computes the
runtime version locally and a junction changes it.

```bash
git clone https://github.com/fourwardhabits/bingd.git bingd-qa-build
cd bingd-qa-build
git checkout integration/lists-watch-history
npm ci
cp /path/to/founder/google-services.json .      # gitignored; eas-cli needs it locally

# The four EXPO_PUBLIC_* values from the PREVIEW environment, passed inline rather than via
# a copied .env (bingd-clean-clone-build-recipe). Read them with:
#   npx eas env:list --environment preview
EXPO_PUBLIC_SUPABASE_URL=https://fjxhcbowoxuzulwirzyr.supabase.co \
EXPO_PUBLIC_SUPABASE_ANON_KEY=<from env:list> \
EXPO_PUBLIC_POSTHOG_KEY=<from env:list> \
EXPO_PUBLIC_SENTRY_DSN=<from env:list> \
  npm run build:preview -- --platform android

# same again with --platform ios
```

**Prove it before installing.** In that clone, the local fingerprint must equal the runtime
EAS put on the build record:

```bash
APP_VARIANT=preview BINGD_LANE=preview npx expo-updates fingerprint:generate --platform android
npx eas build:list --profile preview --limit 2 --json --non-interactive   # compare runtimeVersion
```

iOS preview is internal distribution: your iPhone must already be in the ad-hoc profile.
Build 7 installed, so it should be; if EAS asks to re-register, that needs your Apple login.

A preview **build** embeds the candidate's JavaScript, so once it is installed **no OTA is
needed** to test.

---

## 1. Identify what you are running

Install the new build. It is **bingd preview** — the plum icon — and sits beside the shipped
app without replacing it.

Open **Settings** and scroll to the bottom. Three small caption lines identify the build —
they appear only on non-release lanes, so their being there at all is the first check:

| Line | Expected, exactly |
|---|---|
| lane · channel | `preview · preview` |
| runtime · source | `runtime <first 8 of the new build's runtime> · embedded` |
| backend | `backend fjxhcbowoxuzulwirzyr` |

`embedded` matters: a freshly installed build runs its own bundle, and that word is the proof.
If it says `update …` instead, an OTA was applied — check which one before going on.

**If the backend line reads `abheeqyjzekiowkztfxv`, stop.** That is production and nothing
below should be run on it. (This has been checked: both the preview environment and the published
manifests resolve to staging, and `src/lib/env.ts` refuses a non-production variant pointed
at production.)

---

## 2. Accounts and data

**Sign in with the six-digit email code.** Google and Apple are *disabled* on staging, so
those buttons will fail. Email code is the only working route.

| Use | Account |
|---|---|
| Your main tester | **`bingdtest2`** |
| Second person (to view someone else's list) | **`bingdsocial2`** |
| Existing QA cohort, public, with collections | `qa_*_g2` (eight accounts) |

**Everything here is safe to create, edit and delete.** It is staging.

**Four fixture lists already exist** on staging, labelled *Hardening fixture — safe to
delete*, owned by `qa_blockbuster_fan_g2`. Useful as "somebody else's list" without making
one:

| List | Mode | id |
|---|---|---|
| QA — public list | public, numbered | `5d3f44c2-605d-4638-a95b-1738d48d17f2` |
| QA — link-only list | link | `b69b93a6-f7da-4e52-9ed1-79dedee6019a` |
| QA — private list | private | `cfdb8b30-8195-4d89-9c8b-693559f76ff0` |
| QA — link list, private owner | link | `4f79f8e0-c5af-4ab9-9adb-714d960ff053` |

(The last one's owner is public again — flip your *own* account private in §4.6 to test the
private-owner case properly.)

**Two limits you will hit if you try:**

- **20 new lists per account per day.** A spam guard, working as designed. Past it: *"You have
  made a lot of lists today."*
- **Staging flags:** `leaderboard.monthly_from_events = true` but **`goals.count_watch_events
  = false`**. A rewatch *does* move the monthly leaderboard and does **not** move your yearly
  goal on staging. That is the flag state, not a bug.

---

## 3. MUST MANUALLY TEST — Watch History

These are the things only a person on a device can judge: whether it reads right, whether a
flow feels like one act, and whether anything visibly jumps.

**3.1 First log still feels like one act.** Log a film you have never logged, pick **Today**.
It lands in the collection, ranks as before, and the title page now shows **"Watched once"**.

**3.2 The context line is a door.** On that title, tap **Watched once ›**. It opens the Watch
History screen for that title. Back returns you to the title.

**3.3 Log another watch — Keep.** From Watch History, **Log another watch** → **Today** →
save. You are asked *Did it change your mind?* → **Keep at #N**. The title line now reads
**"Watched 2 times"** and the **ranking position did not move**.

**3.4 Log another watch — Re-check.** Same again, choose **Re-check placement** instead.
Comparisons open; finish them. Position may change. Exactly **one** new viewing is recorded
(the count goes up by one, not two).

**3.5 Earlier, and a picked date.** **Add a past watch** → **Earlier** (no date) → save. Then
another with **Pick a date** in the past. Both appear, in date order, the undated one first.
Neither moves your ranking.

**3.6 Edit and delete a viewing.** Change one viewing's date; then delete one. The count and
order update; **the ranking position does not change**; deleting the *last* dated viewing
leaves the title in your collection.

**3.7 Watchlist clears on first watch only.** Save an unwatched film to your Watchlist, then
log it: it leaves the Watchlist. Save a film you have already watched and log a rewatch: its
Watchlist state is untouched.

**3.8 A rerank is not a watch.** On a ranked title, **Update your rating** → change band →
finish. The watch count **does not** go up.

**3.9 Feed.** A rewatch **dated today** posts once to the feed. A **backdated** or **Earlier**
rewatch posts **nothing**. Check from `bingdsocial2`'s feed.

---

## 4. MUST MANUALLY TEST — Lists

**4.1 Finding it.** On **Collection**, the title row reads `Movies ▾ … My lists ›`. Check it is
there on **Watched**, **Watchlist**, and after switching to **TV**. It never moves.

**4.2 Empty My lists.** First visit: *No lists yet* with the short explanation and **New list**.

**4.3 Create from My lists.** **New list** → title *Movies for Dad*, Numbered **on**, **Only
you** → Create. You land on the **empty list** (a push, not a sheet), with **Add titles**.

**4.4 Add titles.** **Add titles** opens with **From your Watchlist** and **Recently watched**
before you type. Add three; search and add a fourth; for a series, add the **whole series**
once and one **season** via *Seasons*. Rows show `1 2 3…` because Numbered is on.

**4.5 Reorder and edit.** ⋯ → **Edit list**. Move one up, one down, use the arrows to the top.
Rename. Turn Numbered **off** — numbers vanish, **order does not change**. Save.

**4.6 The three modes, and what each shows where.**

| Do this | Then check |
|---|---|
| Set **Anyone with the link** | the consent line appears under the option |
| Share it from the list | the system sheet opens; the chip reads **🔗 Link** |
| Your **Profile** | **LISTS · Manage ›** reads *Nothing public yet* — a link list is **not** on your shelf |
| Make your profile **private** in Settings → Privacy, then open Edit | **On your profile** is disabled, with *Make your profile public to publish lists on it* |
| Still private: Share a *private* list | the prompt adds *They won't see your profile, ratings or other lists* |
| Profile public again, set **On your profile** | it now appears on your Profile shelf |

**4.7 Add to list from a title.** Open any title → **⋯**. **Add to list…** is the **first** row,
on a film you have never logged **and** on a whole series. Tap it: **+ New list** is pinned at
the top. Tick a list — a toast names it, e.g. *Added to "Movies for Dad"*, with **Undo**. Undo
removes it. Untick a list to remove the title. The sheet stays open throughout.

**4.8 Zero-lists path.** On a fresh account with no lists (`bingdsocial2` if it has none):
title ⋯ → **Add to list…** goes **straight to New list** with *Will add: <title>*.

**4.9 Someone else's list.** As `bingdtest2`, open *QA — public list* (via `qa_blockbuster_fan_g2`'s
profile → LISTS). You see attribution, **You've seen X of N** as plain text (no bar), the
per-row tick or bookmark, **Add N unseen to my Watchlist**, and ⋯ → **Report list**. No Edit.
Tap **Add N unseen to my Watchlist**: the message names how many were added and skipped, and
**your feed shows no per-title activity** from it.

**4.10 Remove still means Remove.** On a title that is **not** in your collection, ⋯ has **no
Remove from collection**. On one that is, Remove is there and works.

**4.11 Delete.** ⋯ → **Delete list** → confirm. It leaves My lists and the Profile shelf.

---

## 5. MUST MANUALLY TEST — compact regression smoke

Five minutes, only what these tranches touched indirectly:

1. **Log → Rank → Collection** on a new film: works exactly as before.
2. **Recommend** a title to `bingdsocial2`; it arrives in their *Sent to you*.
3. **Feed** scrolls and paginates; a comment and a reaction both save.
4. **Title page** for a series opens on **Seasons**; the ⋯ now exists there too.
5. **Sign out → sign in** with the email code.

---

## 6. AUTOMATED COVERAGE — DO NOT RECREATE

All of the below is proven by machine and re-run on every change. **Do not spend device time
on it.**

**Privacy and security (`lists-security.test.mjs`, 25 assertions; `lists-mutation-check.mjs`,
14/14 defects caught).** A private list is unreachable anonymously through all six public
readers and the table. Link-only opens by id and is never enumerable, and grants *nothing
else* about its owner — not their collection, watchlist, rankings, activity or other lists.
Public follows the profile, including a later flip to private. A moderation hide beats every
mode. Writers refuse a non-owner with the same answer as "no such list". Progress is the
caller's own. No list reader returns a score, bucket, position, watch date, note or history.
The anon grant set is exactly six. Each of those gates was deliberately broken and the suite
caught every one.

**The public web data path, against real staging.** Every request the list web page and the
link-preview Function make was run against staging with the real anon key: public and
link-only resolve; private and nonexistent return nothing and leak no title; a private
owner's link list shows name and handle but **no owner id** and **no handle in the unfurl**.

**Scale, on real PostgreSQL (`races/scale-hardening.mjs`).** 1,000+ ranked titles, 40 lists, a
100-item list, 50,000 list rows and a 2,000+ event history: every large read uses an index,
My lists draws at most four posters per row, and progress is one statement.

**Cross-feature invariants.** Adding, moving, removing and renaming list items changes **no**
watched state, ranking, Watchlist entry or watch event. The one exception, *Add N unseen*,
moves only the Watchlist. Log, rewatch, edit and delete of watch events move **no** list.

**Concurrency.** Two devices reordering one list at once: serialised on the list's own lock,
positions stay unique (`races/list-move.mjs`).

**Installed-client compatibility (`legacy-client-compat.test.mjs`).** Every RPC that vc12 and
the current iOS production build call still resolves after all five migrations, and nothing
they read directly was dropped.

**Watch History's own suite.** Rerank writes no event; a rewatch writes exactly one; delete
keeps the placement; editing to *no date* brings the date cache back down; the cache cannot
drift from the events; imported, undated and dated viewings stay distinguishable; goals and
the monthly board are inert while their flags are off.

**Web.** 123 router tests and 13/13 mutation defects; `/lists/<uuid>` is the only list path
that renders, `/lists` and `/lists/by/…` keep the install page, and an XSS title is inert.

---

## 7. What is not covered here, deliberately

- **Rendering a list at `bingd.app/lists/<id>` in a browser, and a real unfurl.** Blocked on
  one Cloudflare setting: the Pages **Preview** environment has no Supabase variables, so a
  preview URL renders the generic card. The Function is proven to be deployed from the right
  directory; the data it would use is proven against staging. See `web-deployment.md`.
- **Anything in production.** No production migration, no beta or production OTA, vc12
  untouched, Release Awareness real sends off (`release.push_enabled = false`).
