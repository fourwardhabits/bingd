import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionPair, Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { buildImdbOutcomes } from './outcomes';
import { Note, plural } from './PreviewSummary';
import type { ImportProvider } from './providers';
import {
  alreadyInBingd,
  importedTitles,
  resultHeadline,
  resultModel,
  resultSummary,
  type ResultModel,
} from './result-model';
import { sessionImportFor } from './session-outcomes';
import { UnmatchedDisclosure } from './UnmatchedDisclosure';
import { useUnresolvedRows } from './use-imdb-outcomes';
import type { ImportCounts } from './use-import';

/** Notes under the card, each only when its bucket is above zero. Exported for tests. */
export const matchedTvNote = (shows: number) =>
  `We found ${plural(shows, 'TV show', 'TV shows')} from your file in bingd, but TV shows from IMDb aren’t added yet.`;
export const episodeResultNote = (episodes: number) =>
  `${plural(episodes, 'TV episode', 'TV episodes')} didn’t come in because bingd doesn’t track single episodes.`;
export const otherResultNote = (other: number) =>
  other === 1
    ? '1 title didn’t come in because bingd doesn’t track that kind of title.'
    : `${other} titles didn’t come in because bingd doesn’t track those kinds of titles.`;
export const failedNote = (failed: number) =>
  `${plural(failed, 'title', 'titles')} couldn’t be saved. Importing the file again is safe: nothing is added twice.`;

/**
 * How a finished import went, one card and a way on (IMP1113-UI §D).
 *
 * **Every number is `resultModel`'s**, which is the server's counts renamed; nothing here
 * adds a bucket into another except where the model says so (*Already in bingd* is what
 * was in the collection before this run, by any route — founder QA, 2026-11-16).
 *
 *   Newly imported     `watched`: what this run added, and nothing else
 *   Already in bingd   `kept + already`: ranked or logged here, or an earlier import's
 *   Added to watchlist Letterboxd only
 *   Diary entries      Letterboxd only; held, not added
 *   Unmatched          expandable to the titles (`UnmatchedDisclosure`)
 *
 * Rows of zero, and rows the job never counted (`undefined`), are left out: a zero invites
 * the reader to wonder what went wrong. Recognised TV shows, episodes and other kinds are
 * **notes**, never rows, and never folded into *Imported* or *Unmatched*: a show the import
 * found is neither. `failed` is a warning note of its own, never folded in.
 *
 * **The way on.** *Rank titles* opens Collection on Unranked (`unrankedMovies()`), and never
 * runs the importer again; it is offered only when the import owns unranked titles. With
 * nothing to rank there is only *Done*. On the onboarding step there is only *Continue*,
 * because the flow guard would send Collection straight back.
 *
 * **Import another file** (Codex review, #289). A summary on screen is a job this screen is
 * holding: one that finished in front of the reader, or one a link named (`?job=`). Settings
 * never reopens on a finished job by itself (QA 11-14, §6), but *Done* and *Rank titles*
 * only navigate, so without a way to clear the one on screen the reader could not start
 * another import, of a newer file or from the other service, from here. A quiet tertiary
 * action under the pair calls `reset`, which drops the job from the screen (on a finished
 * job `import_discard` deletes nothing). Not on the onboarding step, whose only way is on.
 */
export function CompletionSummary({
  counts,
  provider,
  jobId,
  onRank,
  onDone,
  onContinue,
  onReset,
}: {
  counts: ImportCounts;
  provider: ImportProvider;
  /** The finished job, for its own unresolved rows and this process's parse of the file. */
  jobId?: string;
  onRank: () => void;
  onDone: () => void;
  /** The onboarding step's way on, which replaces the pair. */
  onContinue?: () => void;
  /** Clear the finished job and open the importer again. Off onboarding only. */
  onReset?: () => void;
}) {
  const model = resultModel(counts, provider);
  const unmatched = model.unmatched ?? 0;
  const unresolved = useUnresolvedRows(jobId, unmatched);
  const session = sessionImportFor(jobId);
  const unmatchedTitles = useMemo(
    () =>
      buildImdbOutcomes({ counts, session, unresolved }).find((s) => s.id === 'unmatched')
        ?.titles ?? null,
    [counts, session, unresolved],
  );

  // Rank titles is offered for every unranked title the import owns, this run's and an
  // earlier run's: both are in the collection and both still need a ranking. The rows above
  // say which of them are new; this only decides whether there is anything to rank.
  const rankable = importedTitles(model);
  const present = alreadyInBingd(model);

  return (
    <View style={styles.block} testID="import-result">
      <Text variant="display" accessibilityRole="header">
        {resultHeadline(model, provider)}
      </Text>
      <Text variant="body" tone="secondary" testID="result-summary">
        {resultSummary(model)}
      </Text>

      {/**
       * **Three buckets that never overlap** (founder QA, 2026-11-16): what this run added,
       * what was in bingd before it (an earlier import's titles included), and what did not
       * match. A repeated file reads 0 new, N already in bingd — never "imported" again.
       * Newly imported is drawn at zero whenever something else is, so a repeat import
       * says plainly that nothing was added rather than leaving the row out.
       */}
      <ResultCard>
        {model.newlyAdded !== undefined && (model.newlyAdded > 0 || present > 0) ? (
          <Row label="Newly imported" value={model.newlyAdded} testID="result-imported" />
        ) : null}
        {present > 0 ? (
          <Row label="Already in bingd" value={present} testID="result-present" />
        ) : null}
        {model.watchlistAdded ? (
          <Row
            label="Added to watchlist"
            value={model.watchlistAdded}
            testID="result-watchlist"
          />
        ) : null}
        {model.diaryKept ? (
          <Row label="Diary entries" value={model.diaryKept} testID="result-diary" />
        ) : null}
        {unmatched > 0 ? (
          <UnmatchedDisclosure
            count={unmatched}
            titles={unmatchedTitles}
            loading={unresolved.state === 'loading'}
          />
        ) : null}
      </ResultCard>

      <ResultNotes model={model} />

      {onContinue ? (
        <Button label="Continue" onPress={onContinue} />
      ) : rankable > 0 ? (
        <ActionPair
          secondary={{ label: 'Done', onPress: onDone, testID: 'result-done' }}
          primary={{
            label: 'Rank titles',
            onPress: onRank,
            accessibilityHint: 'Opens your unranked movies in Collection',
            testID: 'result-rank',
          }}
          testID="result-actions"
        />
      ) : (
        <Button label="Done" onPress={onDone} testID="result-done" />
      )}
      {!onContinue && onReset ? (
        <Button
          label="Import another file"
          kind="tertiary"
          onPress={onReset}
          testID="result-import-another"
        />
      ) : null}
    </View>
  );
}

/** The card, drawn only when it has a row: a file that brought nothing has no empty box. */
function ResultCard({ children }: { children: ReactNode[] }) {
  if (!children.some(Boolean)) return null;
  return <View style={styles.card}>{children}</View>;
}

function ResultNotes({ model }: { model: ResultModel }) {
  return (
    <>
      {model.matchedExcluded ? <Note>{matchedTvNote(model.matchedExcluded)}</Note> : null}
      {model.unsupportedEpisode ? (
        <Note>{episodeResultNote(model.unsupportedEpisode)}</Note>
      ) : null}
      {model.unsupportedOther ? <Note>{otherResultNote(model.unsupportedOther)}</Note> : null}
      {model.failed ? <Note warning>{failedNote(model.failed)}</Note> : null}
    </>
  );
}

function Row({
  label,
  value,
  sublabel,
  testID,
}: {
  label: string;
  value: number;
  sublabel?: string;
  testID?: string;
}) {
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={[`${label}, ${value}`, sublabel].filter(Boolean).join('. ')}
      testID={testID}
    >
      <View style={styles.rowWords}>
        <Text variant="body">{label}</Text>
        {sublabel ? (
          <Text variant="footnote" tone="tertiary">
            {sublabel}
          </Text>
        ) : null}
      </View>
      <Text variant="headline">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[4] },
  card: {
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    paddingHorizontal: theme.layout.cardPadding,
    paddingVertical: theme.space[2],
  },
  // Each row the 44pt target's height, so the plain rows line up with the Unmatched
  // control, which is a button and must be at least that tall.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.minTapTarget,
    paddingVertical: theme.space[1],
  },
  rowWords: { flex: 1, gap: theme.space[1] },
});
