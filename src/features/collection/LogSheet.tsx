import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { invalidateAfterCollectionChange } from './invalidate';
import { diagnose } from '@/lib/diagnose';
import { queryKeys } from '@/lib/query';
import { track, type Surface } from '@/lib/analytics';
import { compactName } from '@/lib/titles';
import { useCurrentProfile } from '@/features/auth';
import { theme } from '@/ui/tokens';
import {
  BucketChoices,
  Button,
  Poster,
  ScoreBadge,
  Sheet,
  SheetRow,
  Text,
  ToggleChip,
  type BucketId,
} from '@/ui/components';

import { CompanionPicker } from './CompanionPicker';
import { formatWatchDate, today } from './dates';
import {
  taggableWith,
  useCompanions,
  useSetCompanions,
  useTaggablePeople,
} from './use-companions';
import { emptyLogState, useLogState, type LogState } from './use-log-state';
import { WatchDatePicker } from './WatchDatePicker';
import {
  clearWatchDate,
  logWatched,
  mustReconcile,
  newOperationId,
  saveNote,
  setBucket,
  type NoteVisibility,
  type WriteResult,
} from './writes';

export type LoggableTitle = {
  id: string;
  title: string;
  year: number | null;
  posterUri: string | null;
  /** Decides the category line. A series is not loggable — log a season (AD-1). */
  kind: 'movie' | 'season';
  /** For a season, the series it belongs to, so the header is not just "Season 3". */
  seriesTitle?: string | null;
  /** For a season, its number, so the header reads "The Last of Us, S1". */
  seasonNumber?: number | null;
};

export type LogSheetProps = {
  title: LoggableTitle | null;
  onClose: () => void;
  /**
   * What the reader came here to write, which decides only the *starting* state of
   * the visibility control on a note that does not exist yet.
   *
   * `note` — the default, and what every logging entry point means. Opens private.
   * `review` — the Reviews tab's "Write a review", which is a request to publish and
   * would be a broken promise if it quietly saved something only the author can read.
   *
   * It never overrides a stored value: a note that already exists always opens on the
   * visibility it was saved with, whichever door the reader came through.
   */
  noteIntent?: 'note' | 'review';
  /**
   * Called once a bucket is settled and the title can be ranked.
   *
   * Fired automatically — there is no longer a "Find where it lands" button. The
   * founder reversed the separate-acts rule on 2026-08-15; the reasoning is in
   * `choose` below.
   *
   * `mode` decides which RPC opens the session. `start` is a first ranking and the
   * bucket has already been saved by then. `rebucket` is a *ranked* title changing
   * bands: `rank_rebucket` does the unrank, the bucket change and the fresh session
   * in one server call. `rerank` is a ranked title keeping its band, which
   * `rank_rebucket` refuses — `rankAgain` unranks and re-opens instead.
   *
   * For both ranked modes the bucket must **not** be written here first: on a rebucket
   * the server owns the change, and on a rerank there is no change to write — either
   * way `set_bucket` answers with its 55000 refusal.
   */
  onRank?: (bucket: BucketId, mode: 'start' | 'rebucket' | 'rerank') => void;
  /**
   * Which screen opened this, for `title_logged` alone. Two screens mount this sheet
   * and the route underneath it is not the same question as where somebody decided to
   * log something.
   */
  surface: Surface;
  /**
   * Set when this sheet is being shown as the state *after* a ranking rather than
   * before one — the score the title just landed on, and where it landed.
   *
   * **This is the answer to the founder's central complaint**, which was that ranking
   * threw you out of the log. Tap a bucket, answer four comparisons, see a number, and
   * the flow was over: the review you might have written and the people you watched it
   * with were behind a second visit to a sheet you had just left, and nothing on the
   * reveal said so.
   *
   * So ranking becomes a subflow of logging and this sheet is what it returns to. It
   * is deliberately *this* sheet and not a new one: the rows below are the canonical
   * implementation of "the rest of your log", and a dedicated Finish screen would be a
   * second copy of them that could drift. What `postRank` changes is only the top of
   * the sheet — the bucket question is answered, so its place is taken by the answer —
   * and the addition of a Done at the foot.
   *
   * Null in the ordinary case, which is every entry point that is not a ranking that
   * just finished.
   */
  postRank?: PostRank | null;
  /**
   * Open the writing composer as soon as the sheet appears.
   *
   * The Ranked menu's writing row is what uses it: a row that names a piece of
   * writing should land the reader in it rather than in a sheet where they have to
   * find the row again.
   *
   * **It cannot publish anything by itself.** With one Note row the value only ever
   * opens the composer; which visibility the writing carries still resolves the way
   * it always has — a note that already exists opens on the value it was *saved*
   * with, whichever door was used, and only the named value can seed a note that
   * does not exist yet. That ordering is the whole privacy property of this sheet
   * and this prop is deliberately too weak to break it.
   */
  openWriting?: NoteVisibility | null;
  /**
   * Finishing from the post-rank state, which is a different act from dismissing.
   *
   * The caller usually wants both to close the sheet, and the reason they are two
   * props is that the ranking flow has more to unwind than a dismissal does — the
   * ranking sheet behind this one is still mounted. Falls back to `onClose`.
   */
  onDone?: () => void;
};

/**
 * What a ranking just decided, as this sheet needs to restate it.
 *
 * Passed in rather than read: the ranking session already had all three from
 * `rank_answer`'s reply, and re-querying for a number the previous screen was
 * holding would put a spinner in the middle of a finished act.
 */
export type PostRank = {
  score: number;
  position: number;
  /** The server's own word — `movies` or `tv_seasons`. */
  category: string;
};

/**
 * The log sheet (screens.md §4).
 *
 * A compact bottom sheet of stacked modules, not a full-height page. Beli 224 is the
 * structure: a header, the bucket prompt, then rows that state their value and spend
 * space only when opened. What is borrowed is density and hierarchy; the palette,
 * the serif and the poster treatment stay Bingd's (PRD §5).
 */
export function LogSheet({
  title,
  onClose,
  onRank,
  surface,
  noteIntent,
  postRank,
  openWriting,
  onDone,
}: LogSheetProps) {
  if (!title) return null;

  // Keyed by the title, and unmounted entirely when there is none. Both matter: a sheet
  // that stays mounted between titles inherits the last one's bucket, its message and —
  // worst of all — its note overlay, which would then be filed against whatever is on
  // screen now. The unmount is also what makes the autosave's last-net flush safe: the
  // flush armed by the old body still holds the old title.
  return (
    <Body
      key={title.id}
      title={title}
      onClose={onClose}
      onRank={onRank}
      surface={surface}
      noteIntent={noteIntent}
      postRank={postRank}
      openWriting={openWriting}
      onDone={onDone}
    />
  );
}

type Expanded = 'notes' | 'date' | 'who' | null;

/**
 * How long typing may rest before the note is persisted.
 *
 * Long enough that a sentence in progress is not a write per word; short enough that
 * "I typed it, then the app was killed" has a saved note behind it in almost every
 * real sequence. Every path that leaves the field — blur, collapsing the row, the
 * sheet closing, the app backgrounding, unmount — flushes immediately rather than
 * waiting this out.
 */
const AUTOSAVE_DELAY = 1200;

/**
 * The ceiling on how long typing may stay unsaved, however continuous.
 *
 * A trailing debounce alone re-arms on every keystroke, so a sentence typed
 * without a 1.2s pause could ride unsaved for its whole length — review 66b's
 * correction of this file's own claim. Once dirty text has waited this long, the
 * next keystroke saves instead of re-arming, so the exposure of any crash,
 * force-quit or conflict is bounded by this number rather than by typing stamina.
 */
const AUTOSAVE_MAX_WAIT = 4000;

/**
 * Whichever of two `note_updated_at` readings is newer, by instant rather than by
 * string: both come from the same server, but one arrives through PostgREST's row
 * serialisation and the other through a jsonb reply, and assuming their text forms
 * sort identically is a bet this comparison does not need to make.
 */
const newerVersion = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

/** PRD §14. Mirrors `watch_tags.max_per_watch`, which is what actually enforces it. */
const MAX_COMPANIONS = 10;

/**
 * What a row says while it cannot be opened.
 *
 * `undefined` for `ready`, which is what makes the row live — `SheetRow` treats any
 * reason at all as a disable. "Unavailable" rather than "Failed": the row is not
 * broken, it is unusable right now, and the retry beneath says what to do about it.
 */
const GATE_REASON: Record<'loading' | 'ready' | 'unavailable', string | undefined> = {
  loading: 'Loading',
  ready: undefined,
  unavailable: 'Unavailable',
};

function Body({
  title,
  onClose,
  onRank,
  surface,
  noteIntent = 'note',
  postRank = null,
  openWriting = null,
  onDone,
}: LogSheetProps & { title: LoggableTitle }) {
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();
  const logState = useLogState(profile.id, title.id);
  const { data: existing } = logState;
  const state = existing ?? emptyLogState;
  /**
   * Whether the server has said what is already stored about this title.
   *
   * The note editor is gated on it, and that gate is load-bearing rather than
   * cosmetic. Before this read lands the sheet is showing `emptyLogState` — no
   * text, and the forward-facing `public` — for a title that may already carry a
   * note written back when notes were private. Independent review, 2026-08-16,
   * found two ways that published one:
   *
   *   - type into the empty field and blur. `state.exists` is still false, so the
   *     write goes through `log_watched` carrying `public`, and the server applies
   *     it to the row that was there all along.
   *   - flip a claim while the field is empty. Nothing is written, correctly — but
   *     the edit is retained, and when the historical text arrives underneath it
   *     the next save carries a visibility chosen against a blank field.
   *
   * Both are the same defect: the editor was letting someone decide about a note
   * they had not been shown. The overlay pattern below is right for an editor whose
   * baseline is known; it cannot be right for one whose baseline is still in
   * flight. `isPending` is not used, because a background refetch after a save
   * leaves `existing` defined and must not close the editor under the user.
   */
  const loaded = existing !== undefined;

  /**
   * Three states, not two.
   *
   * The gate above was written as "loaded or not", and on the founder's device that
   * turned a backend one migration behind the client into a row that said `Loading`
   * for ever: `useLogState` selects `note_visibility`, the column was not there, the
   * query failed, and `existing` stayed undefined — which the sheet could not tell
   * apart from a slow network.
   *
   * So a failed read is now its own state, and it keeps the privacy property rather
   * than trading it away. The editor stays shut, because the reason it is shut has
   * not changed: with no answer about what is stored, we cannot know whether this
   * title carries a note written when notes were private, and opening on the
   * forward-facing `public` is exactly the publication the gate exists to prevent.
   * What changes is that the row now says so, and offers the retry.
   */
  const fieldState: 'loading' | 'ready' | 'unavailable' = loaded
    ? 'ready'
    : logState.isError
      ? 'unavailable'
      : 'loading';

  /**
   * Edits overlay what the server said, rather than being copied out of it.
   *
   * `null` means "not touched here yet", so each field falls through to the stored
   * value until the user changes it. The obvious alternative — seeding local state
   * from the query in an effect — needs a "have I hydrated" flag, races the first
   * render (the query resolves *after* it, so the fields flash empty), and discards
   * whatever is half-typed the next time an invalidation returns. An empty string is
   * a real edit and `??` passes it through, which is what makes clearing a note work.
   */
  const [bucketEdit, setBucketEdit] = useState<BucketId | null>(null);
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const [visibilityEdit, setVisibilityEdit] = useState<NoteVisibility | null>(null);
  const [spoilersEdit, setSpoilersEdit] = useState<boolean | null>(null);
  const [dateEdit, setDateEdit] = useState<string | null>(null);
  /**
   * "I watched this, I do not remember when", held separately from `dateEdit`.
   *
   * Not folded into `dateEdit` as a third value, because that field follows this
   * sheet's overlay convention exactly — null means *untouched* — and a null that
   * sometimes meant "untouched" and sometimes meant "cleared" is the ambiguity the
   * server side of this feature exists to remove (20260824000100). A separate flag
   * says which of the two happened.
   */
  const [dateCleared, setDateCleared] = useState(false);
  // Seeded rather than set in an effect: the sheet is keyed by the title and mounts
  // fresh for each one, so the initial value *is* the answer and an effect would only
  // be a second render saying the same thing.
  /**
   * **Nothing is open in the post-rank state, and that is the founder's correction of
   * 2026-08-30.**
   *
   * "Add more details" means *the whole log*: who I watched with, the note and its two
   * claims, and the watch date. All three rows have always been rendered here — but a
   * sheet that arrives with the note composer already expanded, under a keyboard, on a
   * phone, puts the other two below the fold. The founder read that off the device as
   * "Add more details only opens the Note", and they were describing what they could
   * see.
   *
   * So `openWriting` is honoured only when the sheet was opened *to write something* —
   * which is what that prop is for, and what the Ranked menu's writing row means by it.
   * A ranking that has just finished is not that: it is the reader being handed the rest
   * of their log, and the rest of their log is a list they should be looking at.
   *
   * Stated here rather than by clearing the prop at the call site, because "the post-rank
   * sheet opens on nothing" is a property of this sheet and there are two callers.
   *
   * Seeded rather than set in an effect: the sheet is keyed by the title and mounts
   * fresh for each one, so the initial value *is* the answer and an effect would only be
   * a second render saying the same thing.
   */
  const [expanded, setExpanded] = useState<Expanded>(openWriting && !postRank ? 'notes' : null);
  const [saving, setSaving] = useState(false);
  /**
   * How many writes are in flight, because "Saving…" is a claim and a boolean stopped
   * being able to keep it.
   *
   * Date writes share one lane now (`queueDateWrite`), so two of them genuinely overlap:
   * the second is queued while the first is running. With a plain flag the *first* one
   * to finish cleared it, so the indicator went away with a write still outstanding and
   * `choose` — which refuses while saving — was unblocked early. Counting depth and
   * clearing only at zero is the smallest thing that keeps the sentence true.
   */
  const savingDepth = useRef(0);
  const beginSaving = () => {
    savingDepth.current += 1;
    setSaving(true);
  };
  const endSaving = () => {
    savingDepth.current = Math.max(0, savingDepth.current - 1);
    if (savingDepth.current === 0) setSaving(false);
  };
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRebucket, setConfirmRebucket] = useState<BucketId | null>(null);

  const people = useTaggablePeople(profile.id);
  const companions = useCompanions(profile.id, title.id);
  const saveCompanions = useSetCompanions(profile.id);
  // Same overlay rule as the note: null means untouched, so the stored list shows
  // until the user changes it and an empty selection is a real edit.
  const [companionEdit, setCompanionEdit] = useState<string[] | null>(null);
  const companionRequest = useRef(0);
  const companionQueue = useRef<Promise<void>>(Promise.resolve());
  // Set once this sheet has created the `user_media` row itself — by the companion
  // path or by `saveDetails`' log_watched branch. The query's answer lags that write
  // by an invalidation, so without it two quick taps would both read `exists: false`
  // and both try to log the watch — and, review 66's finding, chained note saves
  // would keep using the coalescing writer against a row that already exists. Only
  // ever written from inside an async callback, never during render.
  const createdRow = useRef(false);
  // Single-flight for the default-date stamp. Two quick bucket taps launch two
  // detached decisions, and if both read "no date" before either write lands, both
  // write — same date almost always, but not across a midnight rollover
  // (independent review 33d). One decision in flight answers for both taps: if it
  // stamps, the second was redundant; if it finds a date, the second would too.
  const stampPending = useRef(false);
  /**
   * One lane for every write that touches `watched_on`.
   *
   * The same machinery, and the same reason, as `companionQueue` below. Two date
   * writes target one column, neither carries a version the server could reject a
   * stale one by, and the one that *lands* last decides what is stored — so
   * overlapping them makes the result a function of network timing rather than of the
   * order the reader tapped. Independent review 36 found the concrete pair: tap
   * "Don't remember", then "Today" before the first reply arrives, and whichever
   * response wins the race decides whether the date is stored, while the sheet goes on
   * displaying the second tap either way.
   *
   * Chaining is enough here. It does not need the sequence number the companion picker
   * carries, because no reply is applied to state — the local overlay already shows the
   * tap, and the queue is only deciding what reaches the server.
   *
   * A ref rather than state: it is machinery, and re-rendering on it would be a render
   * per tap for nothing on screen.
   */
  const dateQueue = useRef<Promise<void>>(Promise.resolve());
  const queueDateWrite = (run: () => Promise<void>) => {
    // Both arms, so one rejected write does not poison the lane for every later one.
    const next = dateQueue.current.then(run, run);
    dateQueue.current = next.catch(() => {});
    return next;
  };

  /**
   * The newest `note_updated_at` this sheet has seen, from either writer's reply.
   *
   * `state.noteVersion` lags every save by an invalidation round trip, so a second
   * autosave inside that window would carry the *pre-save* base version and earn the
   * 55000 conflict against this sheet's own write. The ref carries the version the
   * server just returned; `saveDetails` sends whichever of the two is newer, and a
   * real conflict — another device moved the note — still refuses, because neither
   * source knows that version.
   */
  const knownNoteVersion = useRef<string | null>(null);
  /**
   * The claims the server last acknowledged from this sheet, for the same reason:
   * `state.noteVisibility` trails a save by a refetch, and a second toggle inside
   * that window must be judged against what was actually stored, not against the
   * pre-save read. Null means "trust the query" — the reset after a conflict.
   */
  const knownClaims = useRef<{ visibility: NoteVisibility; spoilers: boolean } | null>(null);
  /**
   * And the text itself, completing the set (review 66 follow-through): "did the
   * note change" judged against `state.note` alone misses the write whose target
   * happens to equal the stale read — the named case being a clear. Type, let the
   * autosave land, clear the field: the server holds the text, the query still says
   * empty, `'' === ''` says nothing changed, and the clear never leaves the device —
   * the old text resurrects on reopen. Null means "trust the query".
   */
  const knownNote = useRef<string | null>(null);
  const stored = companions.data?.map((c) => c.id) ?? [];
  const chosen = companionEdit ?? stored;
  // Mutual follows plus whoever is already on this watch. See `taggableWith`.
  const taggable = taggableWith(people.data ?? [], companions.data ?? []);

  const bucket = bucketEdit ?? state.bucket;
  const note = noteEdit ?? state.note;
  /**
   * Three sources, in priority order: what the reader just chose, then what the note
   * was saved as, then what they came here to write.
   *
   * The middle term is the promise — a note that exists opens on its stored value and
   * nothing else, so arriving through "Write a review" can never republish something
   * the author kept private. The last term only ever decides a note that has no stored
   * value to contradict.
   */
  const visibility =
    visibilityEdit ??
    (state.note
      ? state.noteVisibility
      : openWriting ?? (noteIntent === 'review' ? 'public' : 'private'));
  const spoilers = spoilersEdit ?? state.noteSpoilers;
  const effectiveDate = dateEdit ?? state.watchedOn ?? today();
  /**
   * Whether the row is deliberately dateless, which is a different thing from having
   * no date *yet*.
   *
   * Today is a pending default and the sheet is allowed to display it as one — that is
   * what `choose`'s stamp below makes true. It stops being honest once the row exists
   * and still has no date, because by then the stamp has either run or been declined:
   * a title that has been logged and carries no date is one nobody recorded a date for,
   * and "Today" over it is the sheet claiming something it did not save.
   *
   * `dateEdit` overrides it, so a date picked in this session shows immediately rather
   * than waiting for the write and the refetch.
   */
  const datelessOnPurpose = dateCleared || (state.exists && !state.watchedOn && !dateEdit);

  // Logging is a collection change like any other: it writes a feed event, moves the
  // watchlist, and changes what this reader has watched. The same set as ranking.
  const refresh = () =>
    invalidateAfterCollectionChange(queryClient, profile.id, title.id);

  /**
   * What is stored about this title, answered only once the read is at rest.
   *
   * `choose` needs "is there a date already" as a fact, and the render closure
   * cannot supply one: the buckets are live before `useLogState` resolves, and a
   * reopened sheet shows cached data while `staleTime: 0` refetches behind it — a
   * date recorded on another device is exactly what that refetch carries
   * (independent reviews 33, 33b). A fetch still in flight is therefore *waited
   * out* rather than guessed at, so the decision is made against the truth in both
   * directions: a stored date is never overwritten, and a genuinely dateless title
   * still gets its stamp even when the tap raced an invalidation's refetch. The
   * wait is bounded by the fetch itself, which always settles; a read left
   * `paused` (offline) or `error` resolves to no answer, and no answer stamps
   * nothing.
   */
  const settledLogState = (): Promise<LogState | undefined> => {
    const key = queryKeys.logState(profile.id, title.id);
    const atRest = (): LogState | undefined | null => {
      const read = queryClient.getQueryState<LogState>(key);
      if (read?.fetchStatus === 'fetching') return null;
      return read?.status === 'success' ? read.data : undefined;
    };

    const now = atRest();
    if (now !== null) return Promise.resolve(now);
    return new Promise((resolve) => {
      const unsubscribe = queryClient.getQueryCache().subscribe(() => {
        const later = atRest();
        if (later !== null) {
          unsubscribe();
          resolve(later);
        }
      });
    });
  };

  const report = (result: WriteResult) => {
    if (result.outcome === 'ranked') {
      setProblem('Ranking owns this one. Change the bucket to re-rank it.');
      return false;
    }
    if (result.outcome === 'failed') {
      setProblem(result.message);
      return false;
    }
    return true;
  };

  /**
   * Save the bucket, then go straight into ranking.
   *
   * The button that used to sit between these two steps is gone (founder decision,
   * 2026-08-15, reversing PRD §11). Three cases have to stay distinct:
   *
   *   - not ranked yet: save, then hand off to the ranking sheet;
   *   - ranked, same bucket: **ask, then re-rank inside that same bucket.** This used
   *     to return without doing anything, on the reading that re-selecting what is
   *     already chosen is not a change. The founder found what that reading costs on
   *     the device: a Loved title, Change your rating, Loved — and the app does
   *     nothing at all, with no message saying why. The bucket is indeed not the
   *     change being asked for. The *position* is, and re-opening a rating already
   *     given is the only way anybody has to say so. No `set_bucket` call is made,
   *     which is what the old 55000 note was really about;
   *   - ranked, different bucket: ask first, then move the band.
   *
   * Both ranked branches discard the position before a comparison is answered, so both
   * confirm — what differs is the call behind the confirmation and the sentence on it.
   */
  const choose = async (chosen: BucketId) => {
    if (saving) return;

    if (state.ranked) {
      setConfirmRebucket(chosen);
      return;
    }

    setBucketEdit(chosen);
    beginSaving();
    setProblem(null);

    // One operation id per intent. If this call is retried it must carry the same one, or
    // the ledger cannot tell a retry from a second opinion.
    const operationId = newOperationId();
    const result = await setBucket({ operationId, mediaItemId: title.id, bucket: chosen });

    if (!report(result)) {
      endSaving();
      setBucketEdit(null);
      // **The revert above is a guess, so it is checked rather than trusted.**
      // `set_bucket` creates the `user_media` row, and an unknown outcome means it may
      // have. Putting the control back and refreshing means the sheet redraws from
      // whatever is actually stored instead of from what this client assumed
      // (`lib/write-outcome.ts`). Independent review 21e.
      if (mustReconcile(result)) refresh();
      return;
    }

    /**
     * `title_logged`, on `ok` and **not** on `already_applied`.
     *
     * `already_applied` is `_claim_operation` answering that this exact operation id has
     * been seen before — a replay of one intent, not a second log. Counting it would
     * turn one tap on a bad connection into two titles in the funnel.
     *
     * A `failed` outcome never reaches here at all: `report` returned false above and
     * the function returned. That includes the unknown-outcome case, which is the
     * deliberate undercount written up in `lib/analytics.ts`.
     */
    if (result.outcome === 'ok') {
      track({
        name: 'title_logged',
        props: {
          media_kind: title.kind === 'season' ? 'tv_season' : 'movie',
          surface,
          bucket: chosen === 'notForMe' ? 'not_for_me' : chosen,
        },
      });
    }

    // The row says "Today", so today is what must be stored. `set_bucket` writes no
    // date, and leaving it at that meant the sheet displayed a default it had never
    // saved — reopen it a week later and it would still claim "Today". Only when
    // there is no date already — a re-log must not overwrite the real one — and
    // "no date already" is `settledLogState`'s question, not this render's closure.
    //
    // Deliberately not awaited before the ranking handoff. The stamp is a courtesy
    // default, already "not worth blocking on", and a read stalled on a bad network
    // must not hold the ranking sheet hostage (independent review 33c); it waits
    // for the settled answer on its own and reconciles the cache when it lands.
    // What remains unclosable from this side is the instant between that answer
    // and the write — a date recorded on another device in that gap needs a
    // server-side conditional write, which the beta accepts as a residual risk.
    // And not at all once the reader has said they do not remember when. Without this
    // guard the stamp is the thing that undoes the clear: clearing leaves `watched_on`
    // null, which is exactly the condition the stamp treats as "no date yet", so the
    // next bucket tap would write today's date back over an explicit "I don't
    // remember" and nothing on screen would say it had happened.
    if (!stampPending.current && !dateCleared) {
      stampPending.current = true;
      void (async () => {
        try {
          const settled = await settledLogState();
          if (settled && !settled.watchedOn) {
            // Failure here is not worth blocking on. The bucket is saved, the title
            // is in the collection, and the date is recoverable from this same row.
            await logWatched({
              operationId: newOperationId(),
              mediaItemId: title.id,
              watchedOn: effectiveDate,
            });
            refresh();
          }
        } finally {
          stampPending.current = false;
        }
      })();
    }

    endSaving();
    refresh();
    onRank?.(chosen, 'start');
  };

  /**
   * Confirmed re-rank, in either direction.
   *
   * Nothing is written here. Each mode is one server call the ranking sheet makes when
   * it opens — `rank_rebucket` for a band change, unrank-then-`rank_start` for a
   * re-rank inside the same band — and the sheet is what drives a session. Writing the
   * bucket first would only earn a 55000.
   */
  const rebucket = () => {
    const next = confirmRebucket;
    if (!next || saving) return;

    setConfirmRebucket(null);
    setBucketEdit(next);
    onRank?.(next, next === state.bucket ? 'rerank' : 'rebucket');
  };

  /**
   * The note and the watch date, saved together.
   *
   * They travel together because they are one act of logging, but the date no longer
   * depends on the note. It used to: `log_watched` was called only when a non-empty
   * note was written, so a user could not record "I watched this last night" without
   * also typing something (screens.md §4 recorded the gap). Now the date is sent
   * whenever it has been touched or a note exists.
   */
  const saveDetails = async (next: {
    note?: string;
    date?: string | null;
    visibility?: NoteVisibility;
    spoilers?: boolean;
  }) => {
    const trimmed = (next.note ?? note).trim();
    const nextDate = next.date ?? dateEdit;
    const nextVisibility = next.visibility ?? visibility;
    const nextSpoilers = next.spoilers ?? spoilers;

    // The structural half of the gate above. The rows are not rendered before the
    // read lands, so this should be unreachable; it is here because "unreachable"
    // is a claim about the current layout, and what it guards against is writing a
    // note, or a decision about one, against a baseline nobody has seen.
    if (!loaded) return;

    const noteChanged = trimmed !== (knownNote.current ?? state.note);
    const dateChanged = nextDate != null && nextDate !== state.watchedOn;
    // The two claims travel with the note and are meaningless without one, so a
    // toggle flipped against an empty field is held locally and written by the
    // save that first stores the text.
    //
    // Judged against the freshest known stored value, not the query alone — the
    // same lag `knownNoteVersion` covers for the version. The query trails every
    // save by a refetch, so share-then-unshare inside that window used to compute
    // "private, same as stored" from a read that predated the share, write nothing,
    // and leave the sheet showing private over a server that kept public.
    const storedVisibility = knownClaims.current?.visibility ?? state.noteVisibility;
    const storedSpoilers = knownClaims.current?.spoilers ?? state.noteSpoilers;
    const claimsChanged =
      Boolean(trimmed) && (nextVisibility !== storedVisibility || nextSpoilers !== storedSpoilers);

    if (!noteChanged && !dateChanged && !claimsChanged) return;

    beginSaving();
    setProblem(null);

    /**
     * The date always goes through log_watched, which upserts — and this may be the
     * call that creates the row a note then needs.
     *
     * **Two writes with a middle, tracked separately from whether they succeeded.**
     * `ok` decides what the person is told; `touched` decides what gets refetched, and
     * they are not the same question. `log_watched` landing and `save_note` then being
     * refused left `ok` false and skipped the refresh, so the sheet went on showing the
     * old date over a row that had already moved. The same shape independent review 21c
     * found in `removeFromCollection` and 21e found in four more places.
     */
    let ok = true;
    let touched = false;
    /**
     * Whether the `user_media` row exists, answered by the freshest source — the
     * query, or this sheet's own acknowledged writes (`createdRow`, the companions
     * path's flag, now set by every acknowledged `log_watched` here too).
     *
     * Review 66's two Majors were both this staleness: after the first autosave
     * created the row, `state.exists` stayed false until the refetch, so every
     * chained save kept going through `log_watched` — which coalesces, so a
     * cleared note silently resurrected, and which checks no version, so another
     * device's edit could be overwritten inside the window. On the freshest
     * answer, the second save and everything after it goes through `save_note`,
     * which can clear and which carries the base version.
     */
    const rowExists = state.exists || createdRow.current;
    const writesNoteHere = (noteChanged || claimsChanged) && !rowExists;

    // On the shared lane, so a date written here cannot overtake — or be overtaken by —
    // a clear the reader tapped a moment earlier. See `queueDateWrite`.
    await queueDateWrite(async () => {
      if (dateChanged || writesNoteHere) {
        const result = await logWatched({
          operationId: newOperationId(),
          mediaItemId: title.id,
          // Omitting a field leaves the stored value alone — the server coalesces — so
          // an untouched date is not resent and cannot overwrite one already recorded.
          watchedOn: dateChanged ? nextDate : null,
          note: writesNoteHere ? trimmed : null,
          // Sent only alongside the text they describe. Passing them on a
          // date-only call would republish a note the user was not editing.
          noteVisibility: writesNoteHere ? nextVisibility : null,
          noteSpoilers: writesNoteHere ? nextSpoilers : null,
        });
        if (result.outcome !== 'failed') {
          // Only an acknowledged success proves the row is there — the companions
          // path's rule, applied to this writer too. An unknown outcome leaves the
          // flag alone, and `log_watched` upserts, so asking again stores it once.
          createdRow.current = true;
          if (result.noteVersion) knownNoteVersion.current = result.noteVersion;
          if (writesNoteHere) {
            knownNote.current = trimmed;
            knownClaims.current = { visibility: nextVisibility, spoilers: nextSpoilers };
          }
        }
        ok = report(result);
        touched = touched || mustReconcile(result);
        // A first note that failed to land is still unsaved writing — the same
        // re-arm the save_note branch below carries. Without it, only a note on an
        // already-existing row ever retried.
        if (!ok && writesNoteHere && noteChanged) dirtyNote.current = true;
      }

      // An existing note goes through save_note, which assigns rather than coalesces.
      // log_watched cannot clear one: it treats an empty string as "no change", so a
      // deleted note would reappear on the next read.
      if (ok && (noteChanged || claimsChanged) && rowExists) {
        const result = await saveNote({
          operationId: newOperationId(),
          mediaItemId: title.id,
          note: trimmed,
          // Whichever is newer of the query's answer and the last reply this sheet
          // received — see `knownNoteVersion`. An autosave chained behind its own
          // predecessor must not present the pre-save version as its base.
          baseVersion: newerVersion(knownNoteVersion.current, state.noteVersion ?? null),
          // Always the value the sheet is displaying, so what the user can see is
          // what gets stored — including for a note written before notes were
          // social, which opens on `private` and stays there unless they change it.
          noteVisibility: nextVisibility,
          noteSpoilers: nextSpoilers,
        });
        if (result.outcome !== 'failed') {
          if (result.noteVersion) knownNoteVersion.current = result.noteVersion;
          knownNote.current = trimmed;
          knownClaims.current = { visibility: nextVisibility, spoilers: nextSpoilers };
        }
        if (result.outcome === 'failed' && result.conflict) {
          // The stored note moved under this edit. Forget the remembered version,
          // text and claims and refetch, so the *next* save is judged against what
          // is really there. The typed text stays in the overlay — the problem line
          // says what happened, and silently discarding writing is the one thing
          // this sheet must never do.
          knownNoteVersion.current = null;
          knownNote.current = null;
          knownClaims.current = null;
          touched = true;
        }
        ok = report(result);
        touched = touched || mustReconcile(result);
        // A failed note write is still unsaved writing: re-arm the dirty flag so the
        // next flush — the next keystroke, blur or close — retries rather than
        // treating the failure as the end of the story.
        if (!ok && noteChanged) dirtyNote.current = true;
      }
    });

    endSaving();
    if (touched) refresh();
  };
  /**
   * **The autosave lane (founder correctness pass, 2026-08-27).**
   *
   * Before this, the only thing that persisted typed text was `TextInput.onBlur` —
   * and React Native does not fire blur on unmount, so the backdrop, the hardware
   * back, the header Close, the post-rank Done and a collapsed row all discarded
   * whatever was typed. The founder met it as "my review didn't save".
   *
   * Three refs, no state: this is machinery, and a render per keystroke-adjacent
   * event is exactly what it must not cost.
   *
   * - `saveDetailsRef` — the latest render's `saveDetails`, re-pointed after every
   *   commit, so a timer or unmount cleanup armed several renders ago saves what is
   *   *now* in the field rather than what was there when the closure was made. Its
   *   updating effect is declared before the effects that read it, which is the
   *   ordering `react-hooks/immutability` requires.
   * - `dirtyNote` — there is typed text the server has not been offered yet. Set on
   *   change, cleared when a flush hands the text to `saveDetails`, re-set by
   *   `saveDetails` when the note write itself fails so the next flush retries.
   * - `autosaveTimer` — the debounce. One timer, re-armed per change; typing is not
   *   a write per keystroke, resting for `AUTOSAVE_DELAY` is one write.
   *
   * `flushNote` is safe to call from anywhere, any number of times: it does nothing
   * unless text is dirty, and `saveDetails` itself refuses no-op writes. The write
   * lands on `queueDateWrite`'s lane like every other save here, so a flush racing
   * a date tap cannot interleave.
   *
   * **The accepted residuals (reviews 66 Major 3 and 66b, disposition:
   * documented).** Two windows remain, both needing a network or cross-device
   * event inside seconds of a close:
   *
   * - A conflict on the *final* flush — another device saved a newer note during
   *   this session, and this sheet closed with unsaved tail — re-arms the dirty
   *   flag on a component that has already unmounted, so the tail (bounded by
   *   `AUTOSAVE_MAX_WAIT`, since the cap keeps continuous typing saved) is lost
   *   without a visible message. The alternative — retrying without a base
   *   version — would silently overwrite the other device's newer note, which
   *   offline-sync.md §5 forbids by name.
   * - A first note whose reply was *lost* may have committed. A changed retry
   *   converges — `log_watched` assigns the new text over the old via
   *   `coalesce(excluded.note, …)` — but a **clear** in that window is judged
   *   against the stale empty read, writes nothing, and the maybe-committed text
   *   survives on the server until the refetch (already triggered by the unknown
   *   outcome) resolves the truth for the next edit.
   */
  const saveDetailsRef = useRef(saveDetails);
  useEffect(() => {
    saveDetailsRef.current = saveDetails;
  });
  const dirtyNote = useRef(false);
  const dirtySince = useRef<number | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushNote = () => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    if (!dirtyNote.current) return;
    // Event-time machinery: this runs from handlers, timers and effect cleanups,
    // never during render; the rule flags it only transitively, because the unmount
    // effect closes over this function.
    // eslint-disable-next-line react-hooks/immutability
    dirtyNote.current = false;
    dirtySince.current = null;
    void saveDetailsRef.current({});
  };
  const scheduleAutosave = () => {
    const fire = () => {
      autosaveTimer.current = null;
      if (!dirtyNote.current) return;
      dirtyNote.current = false;
      dirtySince.current = null;
      void saveDetailsRef.current({});
    };
    if (dirtySince.current == null) dirtySince.current = Date.now();
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    // The max-wait cap: dirty text that has already waited its ceiling saves now
    // rather than re-arming — a trailing debounce alone never fires under
    // continuous typing (review 66b). "Now" is a zero-delay timer, not a direct
    // call: this runs inside the keystroke's own handler, and `saveDetailsRef` is
    // re-pointed in an effect after the commit, so a synchronous save would carry
    // the field as it was one character ago.
    const waited = Date.now() - dirtySince.current;
    autosaveTimer.current = setTimeout(fire, waited >= AUTOSAVE_MAX_WAIT ? 0 : AUTOSAVE_DELAY);
  };

  // Backgrounding is a leave-the-field event like any other. `flushNote` reads only
  // refs, so the first render's closure is never stale.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') flushNote();
    });
    return () => subscription.remove();
  }, []);

  // The last net: unmount for any reason — title change, parent deciding the sheet
  // is gone — flushes. The async write outlives the component; it captured the
  // right title and the right text from the render that armed it.
  useEffect(() => {
    return () => flushNote();
  }, []);

  /**
   * "I don't remember", which is a save and not a cancel.
   *
   * Separate from `saveDetails` because it is a different call for a structural
   * reason: `log_watched` coalesces its date, so there is no argument to it that means
   * *remove*. `clear_watch_date` is the one writer that can, and it does nothing else —
   * the bucket, the note and the companions on the row are untouched, and the title
   * stays logged, because a bucket is a watch signal in its own right.
   *
   * The optimistic flag is set first and kept even if the write fails, alongside the
   * problem message. The alternative — reverting on failure — would put the date the
   * reader just said they did not remember back under their thumb while an error sat
   * above it, and the sheet's other writers all take this shape.
   *
   * **It queues rather than refusing while another date write is in flight, and it
   * does not try to decide whether there is anything to clear.** Both of those were
   * wrong in the same way, and independent review 36 found the first of them.
   *
   * Refusing on `saving` silently dropped the clear when it followed a date the reader
   * had only just picked — the one sequence where dropping it is most obviously wrong.
   * `queueDateWrite` makes the server see the taps in the order they happened instead.
   *
   * Skipping the call when `state` shows no row and no date was the same mistake one
   * step further in: `state` is a read that lags every write this sheet makes, so it
   * says "no date" for the whole window after a bucket stamp or a picked date has been
   * sent and not yet refetched — exactly the window in which somebody changes their
   * mind. The clear would be skipped and the date it was meant to remove would land a
   * moment later, with the row reading "Not recorded" over it.
   *
   * So it always calls, and the server is specified for the empty cases: a row that is
   * absent or already dateless answers `ok` and creates nothing (20260824000100). One
   * request on a rare path is the cost of not reasoning about a stale read.
   */
  const clearDate = async () => {
    setDateEdit(null);
    setDateCleared(true);
    setProblem(null);
    beginSaving();
    await queueDateWrite(async () => {
      const result = await clearWatchDate({
        operationId: newOperationId(),
        mediaItemId: title.id,
      });
      report(result);
      if (mustReconcile(result)) refresh();
    });
    endSaving();
  };

  /**
   * Companions are saved as they are ticked, not on close.
   *
   * The sheet has no Done button — it never has — so "on close" would mean saving
   * from an unmount, which is where writes go to be lost. Each tap is one call that
   * sends the whole list, so a failed one leaves the previous list intact rather
   * than half of a new one.
   *
   * Ticking two people quickly puts two saves in play, and each sends a complete
   * list, so their order decides the result. Independent review found both halves of
   * that: a late reply must not overwrite newer state, *and* a late request must not
   * overwrite a newer list on the server. The first is a sequence number; the second
   * needs the calls not to overlap at all, since nothing in the RPC carries a version
   * for the server to reject a stale one by.
   *
   * So each save is chained onto the last. The queue is a ref rather than state
   * because it is machinery, not something to render, and re-rendering on it would
   * be a render per keystroke-equivalent tap.
   */
  const toggleCompanion = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((one) => one !== id) : [...chosen, id];
    if (next.length > MAX_COMPANIONS) return;

    const ticket = companionRequest.current + 1;
    companionRequest.current = ticket;
    // Only the newest reply may touch state. An older one that returns late is a
    // fact about a list nobody is looking at any more.
    const stale = () => companionRequest.current !== ticket;

    setCompanionEdit(next);
    setProblem(null);

    companionQueue.current = companionQueue.current
      .then(async () => {
        // A tag hangs off a watch, so the row has to exist. Bucketing or a date will
        // usually have created it already; this covers tagging as the first thing
        // done. `createdRow` covers the second tap arriving before the first
        // write's invalidation has refreshed `state.exists`.
        if (!state.exists && !createdRow.current) {
          const created = await logWatched({
            operationId: newOperationId(),
            mediaItemId: title.id,
            watchedOn: effectiveDate,
          });
          // Only an acknowledged success proves the row is there. An unknown outcome
          // leaves the flag false so the next tap asks again — `log_watched` upserts,
          // so asking twice about the same watch stores it once.
          if (created.outcome !== 'failed') createdRow.current = true;

          /**
           * **Reconciled before the staleness check, not after it.**
           *
           * Independent review 21e: logging succeeds, the follow lapses, `set_watch_tags`
           * returns 42501 — and the sheet reverted the companion and never refreshed, so
           * the collection went on showing the title as unlogged while the database held
           * the watch. Whether a *newer* tap has superseded this one is a question about
           * the picker; whether this request moved the database is a question about the
           * cache, and the second does not depend on the first.
           */
          if (mustReconcile(created)) refresh();
          if (stale()) return;
          if (!report(created)) {
            setCompanionEdit(null);
            return;
          }
        }

        const result = await saveCompanions(title.id, next);
        // The tag list itself is reconciled inside `useSetCompanions`, on an unknown
        // outcome as well as on a commit, so it happens whether or not this reply is
        // still the newest one.
        if (stale()) return;

        if (!result.ok) {
          // Back to whatever the server last confirmed, rather than to the optimistic
          // list that was just refused — and when the outcome is unknown, "what the
          // server last confirmed" is being refetched underneath this, so the sentence
          // says so rather than implying nothing was saved.
          setProblem(
            result.changed
              ? 'We could not confirm that. This list has been refreshed to whatever was saved.'
              : result.message,
          );
          setCompanionEdit(null);
          return;
        }
        refresh();
      })
      // One failed save must not break the chain for every later one.
      .catch(() => {});
  };

  const companionValue = chosen.length
    ? chosen.length === 1
      ? (people.data?.find((person) => person.id === chosen[0])?.name ?? '1 person')
      : `${chosen.length} people`
    : 'Add';

  /**
   * The bucket in the database's own spelling, which is what `ScoreBadge` reads.
   *
   * The chips speak camelCase — `notForMe` — and `user_media.bucket` is `not_for_me`.
   * The badge only uses it for the spoken label ("8.7, I didn't like it"), so a null
   * here costs a clause and not a colour; it is mapped rather than cast because the two
   * vocabularies genuinely differ in one of the three values and a cast would be right
   * two thirds of the time.
   */
  const storedBucket = bucket === 'notForMe' ? 'not_for_me' : bucket;

  const category = title.kind === 'movie' ? 'Movies' : 'TV season';
  // The compact identity, which is what a sheet heading is: one line, series and
  // season joined the way every other row in the app joins them (`lib/titles.ts`).
  const heading = compactName(title) ?? title.title;
  const written = note.trim();
  const wordCount = written ? `${written.split(/\s+/).length} words` : null;
  /**
   * **One field, one row (founder simplification, 2026-08-27).**
   *
   * `user_media` holds exactly one `note` and one `note_visibility`. A review and a
   * private note are the same text under two different answers to "who may read
   * this" — which is what `20260817001100`'s "one object, two names" established.
   *
   * The previous pass drew that one field as *two* rows — Review and Private note,
   * each converting to the other — and the founder's device verdict was that it made
   * the sheet conceptually complicated: a reader had to decide which of two names
   * their writing would go under before writing anything. So it is one row now, one
   * word, private by default; "Share as a review" is a chip beside the text, an
   * explicit act on writing that already exists rather than a fork in front of it.
   * The row's value carries the shared state, so a published note says so before
   * the composer is even opened.
   */
  const noteValue = loaded
    ? wordCount
      ? visibility === 'public'
        ? `Shared · ${wordCount}`
        : wordCount
      : 'Add'
    : undefined;

  const toggleNotes = () => {
    if (expanded === 'notes') {
      // Leaving the field, so the field's contract applies: what was typed is
      // already on its way to the server before the composer is gone.
      flushNote();
      setExpanded(null);
      return;
    }
    setExpanded('notes');
  };

  // Every deliberate way out of the sheet flushes first. The unmount effect would
  // catch these too, but a flush that waits for an unmount is a flush that runs
  // while the modal is animating away — doing it on the tap is free and earlier.
  const close = () => {
    flushNote();
    onClose();
  };
  const finish = () => {
    flushNote();
    (onDone ?? onClose)();
  };

  return (
    <Sheet visible onClose={close} label={`Log ${heading}`}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        <View style={styles.header}>
          <Poster uri={title.posterUri} title={title.title} size="xs" />
          <View style={styles.headerText}>
            <Text variant="headline" numberOfLines={2}>
              {heading}
            </Text>
            <Text variant="footnote" tone="tertiary">
              {[title.year, category].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={close}
            hitSlop={theme.space[3]}
          >
            <Text variant="callout" tone="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        {postRank ? (
          /**
           * **The question, answered.**
           *
           * The reader has just come out of the comparisons, so re-asking "How was it?"
           * with a bucket already selected would be the sheet pretending the last minute
           * did not happen — and worse, offering a control whose next tap discards the
           * position they just earned. The bucket chooser is what `Change your rating`
           * is for, and it is one row away in the Ranked menu.
           *
           * The score is restated compactly rather than animated again: the reveal has
           * already had its moment, and this is a receipt at the top of a form. It is the
           * same `ScoreBadge` that appears in every list and on every title page, so the
           * number the reader meets a second later is visibly the same number.
           */
          <View style={styles.ranked} accessibilityRole="summary">
            <ScoreBadge score={postRank.score} bucket={storedBucket} size="md" />
            <View style={styles.rankedText}>
              <Text variant="headline">Ranked</Text>
              <Text variant="footnote" tone="secondary">
                {`#${postRank.position} in ${postRank.category === 'tv_seasons' ? 'TV' : 'Movies'}`}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.buckets}>
            <Text variant="title2" style={styles.prompt}>
              How was it?
            </Text>
            {/* The row itself is `BucketChoices`, which is also what the onboarding
                sheet shows. The radiogroup role travels with it, so the two surfaces
                cannot drift apart in layout or in what a screen reader is told. */}
            <BucketChoices
              selected={bucket}
              onSelect={(option) => void choose(option)}
              testID="bucket-choices"
            />
          </View>
        )}

        {confirmRebucket ? (
          <View style={styles.confirm}>
            {/* Two sentences for two different acts. “Changing this” is untrue of a
                re-rank in the same bucket — nothing about the rating changes — and a
                confirmation that misdescribes what it is confirming is worse than none.
                The second line is the same either way, because the consequence is. */}
            <Text variant="callout">
              {confirmRebucket === state.bucket
                ? `Rank ${title.title} again?`
                : `Changing this will re-rank ${title.title}.`}
            </Text>
            <Text variant="footnote" tone="secondary">
              Its current position is discarded and you will compare it again.
            </Text>
            <View style={styles.confirmActions}>
              <Button label="Re-rank" onPress={rebucket} />
              <Button
                label="Cancel"
                kind="secondary"
                onPress={() => {
                  setConfirmRebucket(null);
                  setBucketEdit(null);
                }}
              />
            </View>
          </View>
        ) : null}

        {/**
         * **The status slot keeps its height whether or not it is saying anything.**
         *
         * The founder's Android report: while typing in the Note, everything below one
         * element jumped down two or three millimetres and immediately came back. The
         * sheet frame, the top of the screen and the keyboard were all stationary — so
         * it was never keyboard avoidance, and it was never a snap point.
         *
         * It was this. "Saving…" is a `footnote`, whose line height is 18pt — about
         * 2.5mm on the founder's panel — and it *mounted and unmounted* here, above
         * `styles.rows`, which is everything: the Note composer and every row under it.
         * The autosave lane fires on a 1.2s trailing debounce with a max-wait cap, so an
         * ordinary sentence arms it several times; each firing pushed the whole lower
         * half of the sheet down by one line and the reply pulled it back. The reader
         * types, the page twitches, and nothing about the movement is information.
         *
         * Reserving the line is the fix rather than hiding, delaying or debouncing the
         * indicator: the message is honest and worth showing, and it is the *layout*
         * that had no business changing. `RankingSheet` settled the same question the
         * same way for the same reason — "the slot keeps its height either way so the
         * controls below do not jump when the sentence appears".
         *
         * One line is reserved, which is what either message costs. Both can still be
         * on screen at once — a save retrying after a failure — and the slot grows to
         * fit, which is a real event rather than a keystroke.
         */}
        <View testID="log-status-slot" style={styles.statusSlot}>
          {saving ? (
            <Text variant="footnote" tone="tertiary" style={styles.status}>
              Saving…
            </Text>
          ) : null}
          {problem ? (
            <Text variant="footnote" tone="action" style={styles.status}>
              {problem}
            </Text>
          ) : null}
        </View>

        <View style={styles.rows}>
          {/* One line for all three rows, because they share one read and would
              otherwise repeat the same sentence three times. Bucket selection and
              ranking are deliberately *not* gated on this: they go through
              `set_bucket`, which needs none of what failed here. */}
          {fieldState === 'unavailable' ? (
            <View style={styles.unavailable}>
              <Text variant="footnote" tone="secondary" style={styles.unavailableText}>
                {diagnose(logState.error) ??
                  'Your writing, companions and the watch date are unavailable.'}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry loading what you wrote and your watch date"
                onPress={() => void logState.refetch()}
                hitSlop={theme.space[2]}
              >
                <Text variant="callout" tone="action">
                  Try again
                </Text>
              </Pressable>
            </View>
          ) : null}

          <SheetRow
            icon="people-outline"
            label="Who I watched with"
            value={loaded ? companionValue : undefined}
            expanded={expanded === 'who'}
            onPress={loaded ? () => setExpanded(expanded === 'who' ? null : 'who') : undefined}
            disabledReason={GATE_REASON[fieldState]}
          />
          {loaded && expanded === 'who' ? (
            <View style={styles.expanded}>
              <CompanionPicker
                people={taggable}
                selected={chosen}
                onToggle={toggleCompanion}
                max={MAX_COMPANIONS}
                loading={people.isPending}
              />
            </View>
          ) : null}

          {/* Inert until the read lands, rather than absent: the rows are the
              sheet's shape, and having them appear a beat after the buckets would
              make the sheet resize under the thumb that just tapped one. What is
              withheld is the ability to act on a baseline that is not there yet. */}
          {/* **One row.** See `noteValue` above for what happened to the Review /
              Private note pair. */}
          <SheetRow
            icon="create-outline"
            label="Note"
            value={noteValue}
            expanded={expanded === 'notes'}
            onPress={loaded ? toggleNotes : undefined}
            disabledReason={GATE_REASON[fieldState]}
          />
          {loaded && expanded === 'notes' ? (
            <View style={[styles.expanded, styles.noteBox]}>
              <NoteInput
                value={note}
                label="Note"
                onChangeText={(next) => {
                  setNoteEdit(next);
                  // Typing is what saves — see the autosave block. The dirty flag
                  // and the timer are refs, so this costs no render beyond the
                  // overlay's own. (Disabled rule: an event handler, not render;
                  // flagged transitively via the unmount effect.)
                  // eslint-disable-next-line react-hooks/immutability
                  dirtyNote.current = true;
                  scheduleAutosave();
                }}
                onBlur={flushNote}
              />
              {/* Both claims sit with the field they describe rather than in a
                  settings screen, because both are decisions about this piece of
                  writing and are only ever made while writing it. */}
              <View style={styles.noteClaims}>
                <ToggleChip
                  icon={spoilers ? 'eye-off' : 'eye-off-outline'}
                  label="Contains spoilers"
                  on={spoilers}
                  accessibilityLabel="This note contains spoilers"
                  onToggle={() => {
                    setSpoilersEdit(!spoilers);
                    void saveDetails({ spoilers: !spoilers });
                  }}
                />
                {/* Publishing is the positive state of this control, not the absence
                    of a negative one. It read "Only me" and was off by default, so
                    the way to keep a note to yourself was to notice a chip and tick
                    it — and the way to publish was to do nothing at all. Naming the
                    act that has consequences is what makes the default safe to
                    leave alone. */}
                <ToggleChip
                  icon={visibility === 'public' ? 'people' : 'people-outline'}
                  label="Share as a review"
                  on={visibility === 'public'}
                  accessibilityLabel="Share this note as a public review"
                  onToggle={() => {
                    const next: NoteVisibility = visibility === 'public' ? 'private' : 'public';
                    setVisibilityEdit(next);
                    void saveDetails({ visibility: next });
                  }}
                />
              </View>
              <Text variant="caption" tone="tertiary">
                {visibility === 'private'
                  ? 'Only you can read this.'
                  : spoilers
                    ? 'Shown with your rating, hidden until people who have not seen it tap to reveal.'
                    : 'Shown with your rating on your profile and in your friends’ feeds.'}
              </Text>
            </View>
          ) : null}

          {/* A "Photos — Coming soon" row used to sit here. It was the last dead
              control in the app: permanently disabled, in the middle of the primary
              logging flow, for a feature nothing in the schema, the API or the PRD
              plans for V1. A row that can never be tapped is worse than no row —
              it is an invitation with nothing behind it, and it had been read as a
              promise for long enough. */}

          {/* Gated for the same reason, and for one of its own: `log_watched`
              assigns the watch date rather than coalescing it, so a date picked
              against the default would overwrite a real one already recorded. */}
          <SheetRow
            icon="calendar-outline"
            label="Watch date"
            value={
              loaded ? (datelessOnPurpose ? 'Not recorded' : formatWatchDate(effectiveDate)) : undefined
            }
            expanded={expanded === 'date'}
            onPress={loaded ? () => setExpanded(expanded === 'date' ? null : 'date') : undefined}
            disabledReason={GATE_REASON[fieldState]}
          />
          {loaded && expanded === 'date' ? (
            <View style={styles.expanded}>
              <WatchDatePicker
                value={datelessOnPurpose ? null : effectiveDate}
                // The grid still has to open on *some* month, and today is the only
                // sensible one for a title with no date to anchor it.
                anchor={effectiveDate}
                onChange={(iso) => {
                  setDateCleared(false);
                  setDateEdit(iso);
                  void saveDetails({ date: iso });
                }}
                onClear={() => void clearDate()}
              />
            </View>
          ) : null}
        </View>

        {/**
          * **The end of the flow, said out loud.**
          *
          * Only in the post-rank state, and it is the whole reason that state is not a
          * dead end: everything above it is optional, and without a control that says so
          * a form of Add rows reads as things you have to do. Done commits nothing —
          * every row above writes on its own, and the flush it carries is only the
          * autosave's leave-the-field contract applied to leaving the sheet, so text
          * typed a moment ago is not waiting out a debounce when the sheet unmounts.
          *
          * The ordinary sheet does not get one. It has a Close in its header and a
          * backdrop, and a title that has not been ranked yet has no moment this would
          * be the end of.
          */}
        {postRank ? (
          <View style={styles.done}>
            <Button label="Done" onPress={finish} />
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

/**
 * Separate so the sheet's own layout stays readable, and because the note is the one
 * control here that is a text field rather than a row.
 */
function NoteInput({
  value,
  label,
  onChangeText,
  onBlur,
}: {
  value: string;
  /** "Note". One field, one name; whether it is shared is the chip's job to say. */
  label: string;
  onChangeText: (next: string) => void;
  onBlur: () => void;
}) {
  return (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      multiline
      maxLength={2000}
      placeholder="What did you think?"
      placeholderTextColor={theme.text.tertiary}
      style={styles.noteInput}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[4], gap: theme.space[4] },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  headerText: { flex: 1, gap: 2 },
  buckets: { gap: theme.space[3], paddingHorizontal: theme.layout.gutter },
  prompt: { textAlign: 'center' },
  /**
   * The post-rank receipt: badge left, two lines beside it.
   *
   * A row rather than the reveal's centred stack, and that is the density decision. The
   * reveal is a moment and gets the whole width; this is the header of a form and has
   * three more rows and a Done underneath it, so it takes one line's worth of height.
   */
  ranked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  rankedText: { flex: 1, gap: 2 },
  done: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[3] },
  confirm: {
    marginHorizontal: theme.layout.gutter,
    padding: theme.space[3],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.sunken,
    gap: theme.space[2],
  },
  confirmActions: { gap: theme.space[2] },
  status: { paddingHorizontal: theme.layout.gutter, textAlign: 'center' },
  /**
   * One footnote line, held open. See the note at the slot: this is what stops an
   * autosave that starts and finishes mid-sentence from moving every row below it.
   *
   * `minHeight` and not `height`, so the rare case where a failure message wraps — or
   * where a retry puts "Saving…" above it — grows honestly instead of clipping.
   */
  statusSlot: { minHeight: theme.typography.footnote.lineHeight },
  unavailable: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
    gap: theme.space[1],
  },
  unavailableText: {},
  rows: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    paddingTop: theme.space[2],
  },
  expanded: { paddingBottom: theme.space[2] },
  noteBox: { paddingHorizontal: theme.layout.gutter, gap: theme.space[2] },
  noteClaims: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  noteInput: {
    minHeight: 88,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.strong,
    backgroundColor: theme.surface.raised,
    padding: theme.space[3],
    textAlignVertical: 'top',
    color: theme.text.primary,
    ...theme.typography.body,
  },
});
