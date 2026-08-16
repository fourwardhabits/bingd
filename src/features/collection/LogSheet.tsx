import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { queryKeys } from '@/lib/query';
import { useCurrentProfile } from '@/features/auth';
import { theme } from '@/ui/tokens';
import {
  BUCKETS,
  BucketChip,
  Button,
  Poster,
  Sheet,
  SheetRow,
  Text,
  ToggleChip,
  type BucketId,
} from '@/ui/components';

import { CompanionPicker } from './CompanionPicker';
import { formatWatchDate, today } from './dates';
import { useCompanions, useSetCompanions, useTaggablePeople } from './use-companions';
import { emptyLogState, useLogState } from './use-log-state';
import { WatchDatePicker } from './WatchDatePicker';
import {
  logWatched,
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
};

export type LogSheetProps = {
  title: LoggableTitle | null;
  onClose: () => void;
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
   * in one server call, so the bucket must **not** be written here first — doing so
   * would hit `set_bucket`'s 55000 refusal.
   */
  onRank?: (bucket: BucketId, mode: 'start' | 'rebucket') => void;
};

/**
 * The log sheet (screens.md §4).
 *
 * A compact bottom sheet of stacked modules, not a full-height page. Beli 224 is the
 * structure: a header, the bucket prompt, then rows that state their value and spend
 * space only when opened. What is borrowed is density and hierarchy; the palette,
 * the serif and the poster treatment stay Bingd's (PRD §5).
 */
export function LogSheet({ title, onClose, onRank }: LogSheetProps) {
  if (!title) return null;

  // Keyed by the title, and unmounted entirely when there is none. Both matter: a sheet
  // that stays mounted between titles inherits the last one's bucket, its message and —
  // worst of all — its unsaved note, which then gets filed against whatever is on screen
  // now.
  return <Body key={title.id} title={title} onClose={onClose} onRank={onRank} />;
}

type Expanded = 'notes' | 'date' | 'who' | null;

/** PRD §14. Mirrors `watch_tags.max_per_watch`, which is what actually enforces it. */
const MAX_COMPANIONS = 10;

function Body({ title, onClose, onRank }: LogSheetProps & { title: LoggableTitle }) {
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();
  const { data: existing } = useLogState(profile.id, title.id);
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
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [saving, setSaving] = useState(false);
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
  // Set once this sheet has created the `user_media` row itself. The query's answer
  // lags that write by an invalidation, so without it two quick taps would both read
  // `exists: false` and both try to log the watch. Only ever written from inside an
  // async callback, never during render.
  const createdRow = useRef(false);
  const stored = companions.data?.map((c) => c.id) ?? [];
  const chosen = companionEdit ?? stored;

  const bucket = bucketEdit ?? state.bucket;
  const note = noteEdit ?? state.note;
  const visibility = visibilityEdit ?? state.noteVisibility;
  const spoilers = spoilersEdit ?? state.noteSpoilers;
  const effectiveDate = dateEdit ?? state.watchedOn ?? today();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.title(title.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.logState(title.id) });
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
   *   - ranked, same bucket: do nothing at all. Re-selecting what is already chosen
   *     is not a change, and `set_bucket` would refuse it with 55000 anyway;
   *   - ranked, different bucket: ask first. `rank_rebucket` discards the position
   *     and starts fresh comparisons, so it is destructive and must not happen on a
   *     stray tap.
   */
  const choose = async (chosen: BucketId) => {
    if (saving) return;

    if (state.ranked) {
      if (chosen === state.bucket) return;
      setConfirmRebucket(chosen);
      return;
    }

    setBucketEdit(chosen);
    setSaving(true);
    setProblem(null);

    // One operation id per intent. If this call is retried it must carry the same one, or
    // the ledger cannot tell a retry from a second opinion.
    const operationId = newOperationId();
    const result = await setBucket({ operationId, mediaItemId: title.id, bucket: chosen });

    if (!report(result)) {
      setSaving(false);
      setBucketEdit(null);
      return;
    }

    // The row says "Today", so today is what must be stored. `set_bucket` writes no
    // date, and leaving it at that meant the sheet displayed a default it had never
    // saved — reopen it a week later and it would still claim "Today". Only when
    // there is no date already: a re-log must not overwrite the real one.
    if (!state.watchedOn) {
      // Failure here is not worth blocking on. The bucket is saved, the title is in
      // the collection, and the date is recoverable from this same row.
      await logWatched({
        operationId: newOperationId(),
        mediaItemId: title.id,
        watchedOn: effectiveDate,
      });
    }

    setSaving(false);
    refresh();
    onRank?.(chosen, 'start');
  };

  /**
   * Confirmed re-rank. Nothing is written here — `rank_rebucket` is one server call
   * that unranks, changes the bucket and opens the new session, and the ranking sheet
   * is what drives a session. Writing the bucket first would only earn a 55000.
   */
  const rebucket = () => {
    const chosen = confirmRebucket;
    if (!chosen || saving) return;

    setConfirmRebucket(null);
    setBucketEdit(chosen);
    onRank?.(chosen, 'rebucket');
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

    const noteChanged = trimmed !== state.note;
    const dateChanged = nextDate != null && nextDate !== state.watchedOn;
    // The two claims travel with the note and are meaningless without one, so a
    // toggle flipped against an empty field is held locally and written by the
    // save that first stores the text.
    const claimsChanged =
      Boolean(trimmed) &&
      (nextVisibility !== state.noteVisibility || nextSpoilers !== state.noteSpoilers);

    if (!noteChanged && !dateChanged && !claimsChanged) return;

    setSaving(true);
    setProblem(null);

    // The date always goes through log_watched, which upserts — and this may be the
    // call that creates the row a note then needs.
    let ok = true;
    const writesNoteHere = (noteChanged || claimsChanged) && !state.exists;
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
      ok = report(result);
    }

    // An existing note goes through save_note, which assigns rather than coalesces.
    // log_watched cannot clear one: it treats an empty string as "no change", so a
    // deleted note would reappear on the next read.
    if (ok && (noteChanged || claimsChanged) && state.exists) {
      const result = await saveNote({
        operationId: newOperationId(),
        mediaItemId: title.id,
        note: trimmed,
        baseVersion: state.noteVersion,
        // Always the value the sheet is displaying, so what the user can see is
        // what gets stored — including for a note written before notes were
        // social, which opens on `private` and stays there unless they change it.
        noteVisibility: nextVisibility,
        noteSpoilers: nextSpoilers,
      });
      ok = report(result);
    }

    setSaving(false);
    if (ok) refresh();
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
          if (created.outcome !== 'failed') createdRow.current = true;
          if (stale()) return;
          if (!report(created)) {
            setCompanionEdit(null);
            return;
          }
        }

        const result = await saveCompanions(title.id, next);
        if (stale()) return;

        if (!result.ok) {
          setProblem(result.message);
          // Back to whatever the server last confirmed, rather than to the
          // optimistic list that was just refused.
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

  const category = title.kind === 'movie' ? 'Movies' : 'TV season';
  const heading = title.seriesTitle ? `${title.seriesTitle} — ${title.title}` : title.title;
  const noteValue = note.trim() ? `${note.trim().split(/\s+/).length} words` : 'Add';

  return (
    <Sheet visible onClose={onClose} label={`Log ${heading}`}>
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
            onPress={onClose}
            hitSlop={theme.space[3]}
          >
            <Text variant="callout" tone="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <View style={styles.buckets} accessibilityRole="radiogroup">
          <Text variant="title2" style={styles.prompt}>
            How was it?
          </Text>
          <View style={styles.chips}>
            {BUCKETS.map((option) => (
              <BucketChip
                key={option.id}
                bucket={option}
                selected={bucket === option.id}
                onPress={() => void choose(option.id)}
              />
            ))}
          </View>
        </View>

        {confirmRebucket ? (
          <View style={styles.confirm}>
            <Text variant="callout">Changing this will re-rank {title.title}.</Text>
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

        <View style={styles.rows}>
          <SheetRow
            icon="people-outline"
            label="Who I watched with"
            value={loaded ? companionValue : undefined}
            expanded={expanded === 'who'}
            onPress={loaded ? () => setExpanded(expanded === 'who' ? null : 'who') : undefined}
            disabledReason={loaded ? undefined : 'Loading'}
          />
          {loaded && expanded === 'who' ? (
            <View style={styles.expanded}>
              <CompanionPicker
                people={people.data ?? []}
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
          <SheetRow
            icon="create-outline"
            label="Notes"
            value={loaded ? noteValue : undefined}
            expanded={expanded === 'notes'}
            onPress={loaded ? () => setExpanded(expanded === 'notes' ? null : 'notes') : undefined}
            disabledReason={loaded ? undefined : 'Loading'}
          />
          {loaded && expanded === 'notes' ? (
            <View style={[styles.expanded, styles.noteBox]}>
              <NoteInput
                value={note}
                onChangeText={setNoteEdit}
                onBlur={() => void saveDetails({})}
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
                <ToggleChip
                  icon={visibility === 'private' ? 'lock-closed' : 'lock-open-outline'}
                  label="Only me"
                  on={visibility === 'private'}
                  accessibilityLabel="Keep this note private"
                  onToggle={() => {
                    const next: NoteVisibility = visibility === 'private' ? 'public' : 'private';
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

          <SheetRow icon="image-outline" label="Photos" disabledReason="Coming soon" />

          {/* Gated for the same reason, and for one of its own: `log_watched`
              assigns the watch date rather than coalescing it, so a date picked
              against the default would overwrite a real one already recorded. */}
          <SheetRow
            icon="calendar-outline"
            label="Watch date"
            value={loaded ? formatWatchDate(effectiveDate) : undefined}
            expanded={expanded === 'date'}
            onPress={loaded ? () => setExpanded(expanded === 'date' ? null : 'date') : undefined}
            disabledReason={loaded ? undefined : 'Loading'}
          />
          {loaded && expanded === 'date' ? (
            <View style={styles.expanded}>
              <WatchDatePicker
                value={effectiveDate}
                onChange={(iso) => {
                  setDateEdit(iso);
                  void saveDetails({ date: iso });
                }}
              />
            </View>
          ) : null}
        </View>
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
  onChangeText,
  onBlur,
}: {
  value: string;
  onChangeText: (next: string) => void;
  onBlur: () => void;
}) {
  return (
    <TextInput
      accessibilityLabel="Notes"
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
  buckets: { gap: theme.space[3] },
  prompt: { textAlign: 'center' },
  chips: { flexDirection: 'row', gap: theme.space[3], paddingHorizontal: theme.layout.gutter },
  confirm: {
    marginHorizontal: theme.layout.gutter,
    padding: theme.space[3],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.sunken,
    gap: theme.space[2],
  },
  confirmActions: { gap: theme.space[2] },
  status: { paddingHorizontal: theme.layout.gutter, textAlign: 'center' },
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
