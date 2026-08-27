import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, StatRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type ProfileIdentityProps = {
  name: string;
  username: string;
  bio: string | null;
  avatarUri: string | null;
  /**
   * Absent on a profile the viewer may not read.
   *
   * Optional rather than zeroed, because zeros are not "no answer" — they are a
   * statement that somebody has no followers and has ranked nothing, which is a lie
   * told about a private account this viewer was never entitled to count. The row is
   * omitted instead. `20260819000100` made this reachable: a private account is now
   * findable, and its identity is drawn without its numbers.
   */
  stats?: {
    followers: number | string;
    following: number | string;
    movies: number | string;
    seasons: number | string;
  };
  /**
   * What tapping Followers or Following opens.
   *
   * Optional, and both screens pass it — but it stays optional because the *stat row*
   * has a case where it must not be a control: a profile whose numbers are drawn while
   * still loading shows `—`, and a button over a dash opens a list of nothing. The two
   * numbers that lead somewhere are named individually rather than as one callback with
   * an argument, so a screen cannot wire Followers to the Following list by passing the
   * wrong string.
   */
  onPressFollowers?: () => void;
  onPressFollowing?: () => void;
  /**
   * The other two stats became controls in the external-beta polish: on somebody
   * else's profile the counts were claims the reader could not check. Optional for
   * the same loading reason as the pair above, and the own profile may leave them
   * unwired — its full collection is already a tab away.
   */
  onPressMovies?: () => void;
  onPressSeasons?: () => void;
  /**
   * Drawn in the stat row's place when the counts could not be read at all.
   *
   * A third state was needed because the two this component already had cannot say it.
   * Absent `stats` means "this viewer is not entitled to these numbers", which is a
   * statement about the account rather than about the request; and the loading `—` is a
   * promise that an answer is coming. A failed read is neither, and rendering it as
   * either one is how the founder's TestFlight build showed four dashes for as long as
   * anybody was willing to look at them.
   *
   * A slot rather than an `isError` flag, because the copy and the retry belong to the
   * screen that owns the query — this component has no query to re-run.
   *
   * Takes precedence over `stats`: the counts are stale or absent whenever it is set,
   * and a row of numbers above an apology about those numbers is worse than either.
   */
  statsFallback?: ReactNode;
  /**
   * What this viewer can do here.
   *
   * Self gets Share Profile and Bingd Awards; anybody else gets the follow control. The
   * *identity* above is identical either way, which is the whole point of the component.
   */
  controls?: ReactNode;
  /**
   * Sits under the avatar, in the avatar's column.
   *
   * Unused by both profiles since Taste Match moved under the handle — kept because the
   * slot is the right shape for anything that genuinely belongs to the *photo* rather
   * than to the name, and removing it would be a change to a shared component made for
   * one caller's convenience.
   */
  badge?: ReactNode;
  /**
   * Directly under `@handle`, inside the identity block. Taste Match, on somebody else's
   * profile.
   *
   * **The founder's placement, and the reason it moved.** Under the avatar it was a
   * number in a sixty-point column, which is why it could only ever be a figure and a
   * word — and why the states where there is no figure had to render as nothing at all,
   * so the feature was invisible on exactly the profiles a friend beta produces. Under
   * the handle it has a line's width, so it can say what it knows in all four cases
   * (`tasteMatchState`), and it reads as what it is: a fact about the reader's
   * relationship to this person, next to the two things that identify them.
   */
  match?: ReactNode;
};

/**
 * One profile, wherever it is being looked at.
 *
 * The founder's correction: the own-profile and public-profile experiences had drifted
 * into two products. One led with a large avatar beside the name; the other centred a
 * stack. One had five stats and the other four. Between them, a reader could not tell
 * that the thing they see on somebody else is the thing other people see on them, which
 * is most of what a profile is *for*.
 *
 * So the identity is this component and nothing else renders one. What differs between
 * the two screens is `controls` and `badge`, which is exactly the set of things that
 * genuinely depend on who is looking.
 *
 * THE LAYOUT, AFTER THE FINAL TUNING PASS
 *
 *     [avatar]   Name
 *                @handle
 *                87% Match
 *
 *     Bio, across the full width
 *
 *     Followers   Following   Movies   TV
 *
 *     [ Share Profile ]  [ Bingd Awards ]
 *
 * **The bio left the identity column.** It sat under the handle, in the width the photo
 * leaves — about two thirds of the screen — so a bio of any length wrapped early and
 * competed with the name for the same narrow channel. It is a sentence about a person
 * and it now gets the width of a sentence, below the header rather than inside it. Two
 * lines still, because a profile is not a blog.
 *
 * **Taste Match sits under the handle**, which is the founder's final placement and a
 * reversal of the one before it.
 *
 * It was under the avatar for a good reason — in the name column it had been a third
 * thing stacked against the identity, pushing the bio down — and that move had a cost
 * nobody priced: the avatar's column is about sixty points wide, so the badge could hold
 * a figure and a word and nothing else, and every state *without* a figure had to render
 * as nothing at all. On a friend beta, where five shared rankings is a high bar, that is
 * almost every profile. The founder's report was simply that Match is missing.
 *
 * Under the handle it has a line's width, so it can say `87% Match` when there is a
 * number and say why when there is not (`tasteMatchState`). The bio's move to full width
 * is what makes the room: this is the third line of a two-line column that used to hold
 * four things.
 *
 * Absent entirely on the reader's own profile: a 100% match with your own catalogue is a
 * tautology.
 *
 * **Stats above the buttons**, which is the swap the founder asked for. Identity flows
 * into the numbers that describe it without a row of controls interrupting, and Share
 * and Awards sit next to the goals and the collection below them — the content they
 * actually lead to — rather than between a face and its counts.
 *
 * **Four stats, not five.** The own profile had Followers, Following, Ranked, Watched
 * and Watchlist crammed into one row, at which width a three-digit number wraps. These
 * four are the ones that describe *this account as a collection*. Watched and Watchlist
 * are the reader's own working state and live in Collection, where they can be acted on.
 */
export function ProfileIdentity({
  name,
  username,
  bio,
  avatarUri,
  stats,
  statsFallback,
  controls,
  badge,
  match,
  onPressFollowers,
  onPressFollowing,
  onPressMovies,
  onPressSeasons,
}: ProfileIdentityProps) {
  return (
    <View style={styles.block}>
      <View style={styles.identity}>
        {/* The photo and whatever belongs to the photo. A column rather than the avatar
            alone, so the badge under it is centred on the picture and not on the row. */}
        <View style={styles.avatar}>
          <Avatar size="lg" uri={avatarUri} name={name} />
          {badge}
        </View>

        <View style={styles.copy}>
          <Text variant="title2" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="footnote" tone="secondary" numberOfLines={1}>
            @{username}
          </Text>
          {/* Directly under the handle and nowhere else. Absent entirely on the reader's
              own profile and while the answer is still in flight, rather than holding a
              line open for something that may never arrive. */}
          {match}
        </View>
      </View>

      {/* Full width, under the header. Absent entirely rather than an empty line: a
          blank row still moves everything below it, and a profile with no bio should
          look like a profile with no bio rather than one with a gap. */}
      {bio ? (
        <View style={styles.bio}>
          <Text variant="callout" tone="secondary" numberOfLines={2}>
            {bio}
          </Text>
        </View>
      ) : null}

      {statsFallback ? (
        statsFallback
      ) : stats ? (
        <StatRow
          stats={[
            {
              label: 'Followers',
              value: stats.followers,
              onPress: onPressFollowers,
              hint: 'Opens the list',
            },
            {
              label: 'Following',
              value: stats.following,
              onPress: onPressFollowing,
              hint: 'Opens the list',
            },
            // Controls when the screen wires them (the external-beta polish): Top
            // Ranked below shows six, and these counts claim the rest. The tap opens
            // the full list, newest first.
            { label: 'Movies', value: stats.movies, onPress: onPressMovies, hint: 'Opens the list' },
            { label: 'TV', value: stats.seasons, onPress: onPressSeasons, hint: 'Opens the list' },
          ]}
        />
      ) : null}

      {controls ? <View style={styles.controls}>{controls}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[1] },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[3],
  },
  // Centred on the photo, not on the row, so a two-line badge under a 64pt avatar
  // stays under the 64pt avatar.
  avatar: { alignItems: 'center', gap: theme.space[1] },
  // Takes whatever the photo leaves, and wraps inside it rather than pushing the photo.
  copy: { flex: 1, gap: 2 },
  bio: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
  },
  controls: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
});
