# Production release 2026-11-25: OTA 9 (`3245b91e`, Phase 1 performance and #388)

This is the performance sprint's one combined production release. The founder authorized it directly, naming `main` `3245b91e6bdd302b03003a78e333fb8a492cf0d5` and one publish (`cloud-ota.md`, "Status of this model"). It is a JS-only OTA: no migration, no dependency, configuration, workflow or native change, and no store binary.

## What shipped

| Item | PR | Merge | What |
|---|---|---|---|
| P3 | [#386](https://github.com/fourwardhabits/bingd/pull/386) | `afc9ad5d` | Release cadence: at most one routine production OTA a day, with named emergency exceptions (`cloud-ota.md`, "Release cadence"). Documentation and process only |
| P8 | [#385](https://github.com/fourwardhabits/bingd/pull/385) | `46896da2` | Feed rail and Trending posters at `w342` instead of `w500`. Rail tiles past the first screen load at low priority |
| P4 | [#387](https://github.com/fourwardhabits/bingd/pull/387) | `287dad95` | One refresh per Log → Rank → placement instead of two. The post-log refresh is held through the ranking session and released only by the session that took it |
| Person page | [#388](https://github.com/fourwardhabits/bingd/pull/388) | `3245b91e` | See the list below |

The #388 changes:
- Library decorations are requested after the filmography read.
- The tapped name and portrait show while the page loads, from an in-memory preview of public TMDB data.
- The hero holds its final 16:9 from the first frame, with a hard lower edge and no cross-fade. Title and list heroes are unchanged.

Every PR had a clean Codex review of its final head. #388's three commits (`c7141dc0`, `285d465a`, `80206a18`) were each tested on Android Preview before the merge. The last was Preview group `ce253594`, whose app code is identical to `3245b91e`.

## Gates on `3245b91e`

| Gate | Run | Result |
|---|---|---|
| CI | 45696590491 | passed |
| Release gate | 45696911057 | passed |
| Cloud runtime check (`ota-production-check.yml`) | `01a21487-9e47-744a-8895-60eb028d90ac` | passed; the log scan was clean |
| Migrations (`production-migrations.mjs check`, read-only, 2026-11-26) | | production, record and `main` agree: 217, head `20261130001300` |

The first runtime check (`01a2146f…`) was refused at preflight. CI and the release gate were still running on the commit, so the refusal was correct. It was re-run once both passed.

## Publish

- **Workflow:** `ota-production.yml`, run `01a2149a-c0b7-79a7-bfab-a1a6cac73a6f`, run once.
  - Preflight, fingerprint, runtimes and publish all succeeded.
  - The log scan was clean.
  - Sentry source maps were uploaded.
- **Published at:** 2026-11-25T21:32:12Z.
- **Served:** `release-manifest live production` serves both platforms at `3245b91e`, against backend `abheeqyjzekiowkztfxv`.

| Platform | Update | Group | Runtime |
|---|---|---|---|
| Android | `01a2149f-9589-7b68-bbfe-7479c0a3b042` | `5f210e97-b6f1-44c3-b06c-8dcf02e39d06` | `ec79e181…`, 1.1.0 (15) |
| iOS | `01a2149f-9589-7539-8634-75908a6129f2` | `295e3e33-4440-49f8-bdfe-93e772804e94` | `8ea562b7…`, 1.1.0 (15) |

**Unchanged:**
- production migrations, at 217;
- production configuration;
- the store binaries (1.1.0 (15) on both stores);
- the pending 1.2.0 (17) builds and their branch, `release/2026-11-25-store-1.2.0` at `2f9d9fbc`, which were not touched.

**Founder smoke test (production, 2026-11-25):** passed. The app looks normal, and a newly ranked title appears correctly in Collection.

## Rollback

Republish OTA 8, from `32790c48`:
- Android group `c400a5a7-093d-4a5b-a8a4-21aecbc4ab0f`;
- iOS group `cec5a2d0-53db-46b3-809d-9725b76e7b17`.

Follow `safe-update-runbook.md` §4. No database change is needed. A rollback is a production change and needs its own founder authorization.
