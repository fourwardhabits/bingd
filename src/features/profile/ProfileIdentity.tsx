import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, StatRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type ProfileIdentityProps = {
  name: string;
  username: string;
  bio: string | null;
  avatarUri: string | null;
  stats: {
    followers: number | string;
    following: number | string;
    movies: number | string;
    seasons: number | string;
  };
  /**
   * What this viewer can do here.
   *
   * Self gets Share Profile and Bingd Awards; anybody else gets the follow control. The
   * *identity* above is identical either way, which is the whole point of the component.
   */
  controls?: ReactNode;
  /**
   * Sits under the avatar, in the avatar's column. Taste Match, on somebody else's
   * profile, and nothing at all on the reader's own.
   */
  badge?: ReactNode;
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
 *      [84%]     @handle
 *      Match
 *
 *     Bio, across the full width
 *
 *     Followers   Following   Movies   TV seasons
 *
 *     [ Share Profile ]  [ Bingd Awards ]
 *
 * **The bio left the identity column.** It sat under the handle, in the width the photo
 * leaves — about two thirds of the screen — so a bio of any length wrapped early and
 * competed with the name for the same narrow channel. It is a sentence about a person
 * and it now gets the width of a sentence, below the header rather than inside it. Two
 * lines still, because a profile is not a blog.
 *
 * **Taste Match moved under the avatar.** It was in the name column, where it was a
 * third thing stacked against the identity and pushed the bio further down. Under the
 * photo it reads as what it is — a small subheading about the *person* in the picture —
 * and it costs the identity column nothing. Absent entirely on the reader's own
 * profile: a 100% match with your own catalogue is a tautology.
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
  controls,
  badge,
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

      <StatRow
        stats={[
          { label: 'Followers', value: stats.followers },
          { label: 'Following', value: stats.following },
          { label: 'Movies', value: stats.movies },
          { label: 'TV seasons', value: stats.seasons },
        ]}
      />

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
