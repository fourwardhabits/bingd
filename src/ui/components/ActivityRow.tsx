import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';

import { fontFamily, theme } from '../tokens';
import { Avatar } from './Avatar';
import { Poster } from './Poster';
import { ScoreBadge } from './ScoreBadge';
import { SpoilerNote } from './SpoilerNote';
import { Text } from './Text';

export type ActivityReaction = {
  /** How many people have reacted at all. */
  count: number;
  /** The reader's own glyph, or null. Its presence is what fills the control. */
  mineGlyph?: string | null;
  /** The distinct glyphs present, most common first (PRD §14). */
  glyphs?: string[];
  /** A plain tap: toggles the default reaction on or off. */
  onPress: () => void;
  /** A long press: opens the full picker. */
  onLongPress?: () => void;
  /** Tapping the summary opens the list of who reacted. */
  onPressSummary?: () => void;
  /** Rendered inside the row, above the actions — see `ReactionPill`. */
  picker?: React.ReactNode;
};

export type ActivityRowProps = {
  actorName: string;
  actorAvatarUri?: string | null;
  /** Opens the actor's profile. Absent for the viewer's own activity. */
  onPressActor?: () => void;
  /** The verb between the actor and the title: "ranked", "watched", "finished". */
  verb: string;
  /**
   * The words after the title, for an activity whose object is not the last thing in
   * the sentence: "added Dune (2021) **to their watchlist**".
   *
   * Absent for the three that read verb-then-object, which is most of them. It exists
   * because forcing every type through one template would give "added to their
   * watchlist Dune (2021)" — the founder asked for grammatical over uniform.
   */
  tail?: string | null;
  /** Names the actor said they watched it with (PRD §14). */
  companions?: string[];
  /** Already in its compact form — "Parks and Recreation, S2" (`lib/titles.ts`). */
  title: string | null;
  year?: number | null;
  posterUri?: string | null;
  /** `PG-13 · 148m · Science Fiction · Adventure`, beneath the sentence. */
  metadata?: string | null;
  score?: number | null;
  bucket?: Bucket | null;
  note?: string | null;
  noteHasSpoilers?: boolean;
  /** Decided by `shouldMask`, never by this component. */
  noteMasked?: boolean;
  timeLabel: string;
  onPressTitle: () => void;
  onPressWatchlist?: () => void;
  inWatchlist?: boolean;
  /**
   * Opens the Recommend sheet for this title.
   *
   * This slot used to be Share, straight to the native sheet. Recommending is the
   * larger act and the sheet it opens ends in "Share off Bingd", so nothing was lost
   * by folding one into the other — and the row got back the width it was overflowing
   * by on a narrow screen, because it is one control rather than two.
   */
  onPressRecommend?: () => void;
  reaction?: ActivityReaction;
  /**
   * Opens the comment sheet. Absent means the surface has not wired comments up,
   * which is different from an activity with none.
   */
  onPressComments?: () => void;
  /**
   * How many comments this viewer may see. Deliberately a count and never a preview:
   * a comment can be marked as spoiling the title, and the only version of "no text
   * preview may leak a masked spoiler" that cannot be got wrong is one where the row
   * never holds a body at all. The bodies are fetched when the sheet opens.
   */
  commentCount?: number;
};

/**
 * One activity, as a divider-separated row (screens.md §7).
 *
 * Rebuilt on 2026-08-16 after a device test. The structure was right and the density
 * was not: an avatar line, a card line, a note and an action line each took their own
 * band of the screen, so three events filled a phone and the feed read as a stack of
 * receipts. Beli fits five or six in the same space, and the difference is not
 * smaller type — it is that the sentence, the artwork and the score occupy *one*
 * band, with everything else hanging off it.
 *
 * So: poster on the left, the sentence and the metadata stacked beside it, the score
 * on the right, all in one row. Actions become icons under it rather than labelled
 * controls, because "Watchlist" set in a footnote beside "Saved" was the widest thing
 * on the row and said the least.
 *
 * ---------------------------------------------------------------------------
 * THE SENTENCE IS ONE SENTENCE (founder Feed finalization, 2026-08-20, item 1)
 *
 * That rebuild kept the title on its own line below the actor, and the physical
 * Android review found what that costs:
 *
 *     [avatar] Suraj Kandukuri ranked
 *              21 (2008)
 *
 * The break is unconditional, so the film reads as a separate field rather than as
 * the object of the verb — and on a short title it leaves a line half empty to do it.
 * The two `Text` blocks are now one:
 *
 *     [avatar] Suraj Kandukuri ranked 21 (2008)
 *
 * **Wrapped by the layout, never by us.** There is no explicit break anywhere in
 * here; a long title runs on and the text engine breaks it where the width runs out,
 * which is why `numberOfLines` is 3 rather than 1. On the narrowest device this app
 * supports the sentence column is about 192pt — 360 less two 16pt gutters, less the
 * 40pt poster and the 40pt score badge with their 12pt gaps, less the 24pt avatar and
 * its 8pt gap — so `Keep Your Hands Off Eizouken!, S1 (2020)` takes two lines and the
 * watchlist form of it takes three. Three is where truncation starts, and it
 * truncates the tail rather than breaking the row.
 *
 * **Weight carries the structure, not size.** One type size for the whole sentence,
 * with the actor and the title in semibold Ink and the connective words in the
 * secondary tone. Mixing 13pt and 15pt inside one wrapping paragraph gives a ragged
 * baseline on the line where they meet, and the founder's own sketch —
 * `**Suraj Kandukuri** ranked **21 (2008)**` — distinguishes the two entities by
 * weight anyway. The year stays in the lighter tone so it reads as the title's
 * qualifier rather than as a third entity, and is joined to the title by a
 * **non-breaking space** so a wrap cannot strand it on a line of its own. Nesting it
 * inside the title's `Text` shares the styling and the press target but not the line
 * breaking, which is a distinction independent review had to point out.
 *
 * **The avatar aligns to the first line**, which is what `alignItems: 'flex-start'` on
 * the `who` row buys: on a three-line sentence a centred face would float beside the
 * middle of the paragraph, attached to nothing.
 *
 * The poster and the score badge stay centred on the row as a whole. That is their
 * intended position and a taller sentence does not change it.
 *
 * The poster is small on purpose and that is unchanged. Beli's feed is carried by
 * food photography that its users took; every Bingd activity for the same film shows
 * the same official poster, so artwork cannot be what distinguishes one row from the
 * next. The score badge does that work.
 */
export function ActivityRow({
  actorName,
  actorAvatarUri,
  onPressActor,
  verb,
  tail = null,
  companions = [],
  title,
  year,
  posterUri,
  metadata,
  score,
  bucket,
  note,
  noteHasSpoilers = false,
  noteMasked = false,
  timeLabel,
  onPressTitle,
  onPressWatchlist,
  inWatchlist = false,
  onPressRecommend,
  reaction,
  onPressComments,
  commentCount = 0,
}: ActivityRowProps) {
  const filmName = title ?? 'a title';

  return (
    <View style={styles.row}>
      <View style={styles.main}>
        {/* The title, never the sentence. Poster derives its placeholder
            initials from whatever it is given, so passing the sentence in
            rendered "Someone ranked a title." as a confident-looking SR. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[filmName, year, metadata].filter(Boolean).join(', ')}
          onPress={onPressTitle}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Poster uri={posterUri} title={filmName} size="xs" />
        </Pressable>

        <View style={styles.copy}>
          {/* The avatar sits *inside* the sentence line rather than above it. That
              is the single change that bought most of the density: the header band
              it used to have was 32pt of mostly empty row, and the face is doing the
              same job at 24 beside the words it belongs to. */}
          <View style={styles.who}>
            <Pressable
              accessibilityRole={onPressActor ? 'button' : undefined}
              accessibilityLabel={onPressActor ? `${actorName}'s profile` : actorName}
              onPress={onPressActor}
              disabled={!onPressActor}
              hitSlop={theme.space[1]}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Avatar size="xs" uri={actorAvatarUri} name={actorName} />
            </Pressable>
            {/**
              * One `Text`, and everything about the activity is inside it.
              *
              * Actor, verb, title, year, companions and tail are nested runs rather
              * than sibling blocks, which is what makes this a sentence the layout
              * can wrap instead of a stack of fields with a break between them. Both
              * entities keep their `onPress`, so the sentence is still the
              * navigation — a nested `Text` is pressable in React Native and does not
              * need a `Pressable` around it, which is just as well because wrapping
              * one here would reintroduce the block that was removed.
              */}
            <Text variant="subhead" tone="secondary" numberOfLines={3} style={styles.sentence}>
              <Text variant="subhead" style={styles.entity} onPress={onPressActor}>
                {actorName}
              </Text>
              {` ${verb} `}
              {/* The title and its year in one run, joined by a **non-breaking
                  space**. Parenthesised and muted, the shape `TitleRow` prints and
                  the founder's standard everywhere a title is named compactly:
                  `The Last of Us, S1 (2023)`.

                  The NBSP is the part that is load-bearing, and nesting alone did
                  not buy it: one `Text` shares styling and press handling, but the
                  text engine still breaks at any ordinary space inside it. With a
                  plain space, a title that ends near the line width leaves `(2020)`
                  stranded on a line of its own — the year separated from what it
                  dates, which is the founder's rule and was the defect independent
                  review found here. U+00A0 removes that break opportunity, so the
                  wrap moves back into the title's own words where it belongs. */}
              <Text variant="subhead" style={styles.entity} onPress={onPressTitle}>
                {filmName}
                {year ? (
                  <Text variant="subhead" tone="secondary" style={styles.year}>
                    {` (${year})`}
                  </Text>
                ) : null}
              </Text>
              {/* After the title now, not after the verb. "Suraj watched Dune (2021)
                  with Anna" is a sentence; "Suraj watched with Anna Dune (2021)",
                  which is what the old order became once the title joined the line,
                  is not. */}
              {companions.length ? (
                <Text variant="subhead" tone="secondary">
                  {' with '}
                  <Text variant="subhead" style={styles.entity}>
                    {companionNames(companions)}
                  </Text>
                </Text>
              ) : null}
              {tail ? ` ${tail}` : null}
            </Text>
          </View>

          {metadata ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {metadata}
            </Text>
          ) : null}
        </View>

        {score != null ? (
          <View style={styles.badge}>
            <ScoreBadge score={score} bucket={bucket} size="sm" />
          </View>
        ) : null}
      </View>

      {note ? (
        <View style={styles.note}>
          <SpoilerNote
            text={note}
            hasSpoilers={noteHasSpoilers}
            masked={noteMasked}
            numberOfLines={2}
            titleForLabel={title}
          />
        </View>
      ) : null}

      {/* The glyphs people used and how many there were, and nothing else.
          Subordinate to the film by construction: footnote size, indented under the
          poster, no per-kind tally. `disagree` is countable on the activity it
          belongs to and nowhere else, which is the difference between banter and a
          scoreboard (PRD §14). The breakdown lives behind the tap. */}
      {reaction && reaction.count > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${reaction.count} ${reaction.count === 1 ? 'reaction' : 'reactions'}. See who reacted.`}
          onPress={reaction.onPressSummary}
          disabled={!reaction.onPressSummary}
          style={({ pressed }) => [styles.reactors, pressed && styles.pressed]}
        >
          {reaction.glyphs?.length ? (
            <View style={styles.glyphs} accessibilityElementsHidden>
              {/* Overlapped rather than spaced, so three glyphs read as one object
                  and cost the width of about two. */}
              {reaction.glyphs.slice(0, 3).map((glyph, index) => (
                <View key={glyph} style={[styles.glyph, index > 0 && styles.glyphOverlap]}>
                  <Text variant="footnote" allowFontScaling={false}>
                    {glyph}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <Text variant="footnote" tone="secondary">
            {reaction.count}
          </Text>
        </Pressable>
      ) : null}

      {reaction?.picker ? <View style={styles.picker}>{reaction.picker}</View> : null}

      <View style={styles.actions}>
        {reaction ? (
          /**
           * Tap toggles the default; long press opens the six.
           *
           * The control used to render the reader's own glyph, which put the same
           * emoji on the row twice — once in the summary cluster above, once here —
           * and read as a duplicate rather than as two different statements. The
           * summary is social proof; this is a control, and a control's job is to
           * say whether *I* have acted.
           *
           * So it stays an icon and changes state instead: a filled Maroon heart
           * when I have reacted, an outline when I have not. The glyph I chose is
           * still visible — it is in the cluster above, where it is counted with
           * everybody else's, which is the only place it means anything.
           */
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: Boolean(reaction.mineGlyph) }}
            accessibilityLabel={
              reaction.mineGlyph
                ? `You reacted to ${filmName}. Tap to remove, long press to change.`
                : `React to ${actorName}'s activity about ${filmName}. Long press for more reactions.`
            }
            accessibilityHint="Long press to choose a different reaction"
            onPress={reaction.onPress}
            onLongPress={reaction.onLongPress}
            hitSlop={theme.space[2]}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            {/* A filled Maroon heart and nothing else.

                The word "You" sat beside it until the founder's acceptance pass, and it
                was redundant twice over: the filled state already says the reaction is
                mine, and the aggregate above already counts it among everybody else's.
                A label that repeats what a colour has already said is a third thing in
                a row that is mostly artwork, and it made the reacted state wider than
                the unreacted one so the whole action row shifted on a tap.

                Screen readers keep the ownership — it is in the label above, where it
                is a sentence rather than a word. */}
            <Ionicons
              name={reaction.mineGlyph ? 'heart' : 'heart-outline'}
              size={theme.layout.icon.sm}
              color={reaction.mineGlyph ? theme.semantic.action : theme.text.secondary}
            />
          </Pressable>
        ) : null}

        {/* Comments V1, 2026-08-17. The rule that kept a placeholder off this row
            still holds — the icon appears only where a surface has actually wired the
            sheet up, so it is never a control that does nothing.

            The badge is the count and there is no preview beside it. See the prop's
            comment: a body on this row would be a body to mask, and the mask that
            gets forgotten is always the preview. */}
        {onPressComments ? (
          <IconAction
            icon={commentCount > 0 ? 'chatbubble' : 'chatbubble-outline'}
            active={commentCount > 0}
            label={
              commentCount > 0
                ? `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'} on ${actorName}'s activity about ${filmName}. Open them.`
                : `Comment on ${actorName}'s activity about ${filmName}`
            }
            onPress={onPressComments}
            badge={commentCount > 0 ? String(commentCount) : undefined}
          />
        ) : null}

        {onPressWatchlist ? (
          <IconAction
            icon={inWatchlist ? 'bookmark' : 'bookmark-outline'}
            active={inWatchlist}
            selected={inWatchlist}
            label={
              inWatchlist ? `${filmName} is in your watchlist` : `Add ${filmName} to your watchlist`
            }
            onPress={onPressWatchlist}
          />
        ) : null}

        {onPressRecommend ? (
          <IconAction
            icon="paper-plane-outline"
            label={`Recommend ${filmName} to a friend`}
            onPress={onPressRecommend}
          />
        ) : null}

        <Text variant="caption" tone="tertiary" style={styles.time}>
          {timeLabel}
        </Text>
      </View>
    </View>
  );
}

/**
 * "Anna", "Anna and Raj", or "Anna and 3 others".
 *
 * Two names is the ceiling here as it is for reactions, and for the same reason: the
 * sentence has to stay one line at a footnote size, and ten tagged friends written
 * out would push the title off the row they are attached to.
 */
function companionNames(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 1;
  return `${names[0]} and ${rest} others`;
}

/**
 * An action as an icon.
 *
 * The label is what a screen reader gets, and it names the thing being acted on
 * rather than the glyph — "Add Sinners to your watchlist", not "Bookmark". An icon
 * row is only denser than a text row if the meaning moves into the label rather than
 * being dropped.
 */
function IconAction({
  icon,
  label,
  onPress,
  active = false,
  selected,
  badge,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
  selected?: boolean;
  badge?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={theme.space[2]}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={active ? theme.semantic.action : theme.text.secondary}
      />
      {badge ? (
        <Text variant="caption" tone={active ? 'action' : 'secondary'}>
          {badge}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  main: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { flex: 1, gap: 2 },
  /**
   * `flex-start`, so the face sits beside the first line of a sentence that may run
   * to three. Centred, it drifted to the middle of a wrapped paragraph and stopped
   * looking like the person the sentence opens with.
   */
  who: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[2] },
  sentence: { flex: 1 },
  entity: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  /**
   * The year sits inside the title's run, but it is not part of the entity: `(2008)`
   * is when the film is from, not what it is called. What stops a wrap orphaning it is
   * the non-breaking space at the join, not this nesting — see the sentence above.
   *
   * `tone="secondary"` on that nested `Text` mutes the colour and `variant` puts the
   * family back to the token's medium. This takes it one step further to the regular
   * weight, so the three weights on the row read as entity, sentence, qualifier.
   */
  year: { fontFamily: fontFamily.sans },
  badge: { alignSelf: 'center' },
  // Indented to the poster's right edge, so a note reads as belonging to the row
  // above it rather than starting a new one.
  note: { paddingLeft: theme.poster.xs.width + theme.space[3] },
  glyphs: { flexDirection: "row", alignItems: "center" },
  glyph: {
    width: 18,
    height: 18,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface.base,
  },
  // Half a glyph of overlap: enough to read as a cluster, not so much that the
  // one underneath becomes unidentifiable.
  glyphOverlap: { marginLeft: -6 },
  picker: { paddingLeft: theme.poster.xs.width + theme.space[3] },
  reactors: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    paddingLeft: theme.poster.xs.width + theme.space[3],
  },
  /**
   * Four icons and a timestamp, on the narrowest screen this app supports.
   *
   * The gap was 20 and the row ran past the edge at 360pt once the comment badge had
   * two digits in it: the timestamp takes the remaining width, so what actually gets
   * cut is whichever control is last. Sixteen is enough separation for four tap
   * targets that are already 44pt tall, and it buys back twelve points.
   */
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingLeft: theme.poster.xs.width + theme.space[3],
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
  },
  time: { flex: 1, textAlign: 'right' },
  pressed: { opacity: 0.7 },
});
