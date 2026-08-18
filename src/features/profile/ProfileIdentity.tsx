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
   * Self gets Share Profile; anybody else gets the follow control. The *identity* above
   * is identical either way, which is the whole point of the component.
   */
  controls?: ReactNode;
  /** Sits under the handle, above the bio. Taste Match, on somebody else's profile. */
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
 * the two screens is `controls`, which is exactly the set of things that genuinely
 * depend on who is looking.
 *
 * **Photo left, words left-aligned beside it.** The centred stack this replaced looked
 * tidy and read badly: a name, a handle and a bio all centred give three different line
 * lengths with no common edge, so the eye has nothing to run down, and a two-line bio
 * turned into a centred paragraph. Against the photo the three lines share a left edge
 * and the block reads as one person rather than as three facts. It is also the layout
 * every account header the founder cited uses, for the same reason.
 *
 * The controls sit *below* the row rather than inside it. A button beside the avatar has
 * to compete with the name for the same width, which is what pushed a handle onto two
 * lines on a narrow screen.
 *
 * **Four stats, not five.** The own profile had Followers, Following, Ranked, Watched
 * and Watchlist crammed into one row, at which width a three-digit number wraps. These
 * four are the ones that describe *this account as a collection* — the two social counts
 * and the two ranking counts. Watched and Watchlist are the reader's own working state
 * and live in Collection, where they can be acted on.
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
        <Avatar size="lg" uri={avatarUri} name={name} />

        <View style={styles.copy}>
          <Text variant="title2" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="footnote" tone="secondary" numberOfLines={1}>
            @{username}
          </Text>

          {badge}

          {/* Under the handle, which is where the founder placed the subheading concept
              this restores. Absent entirely rather than an empty line: a blank row still
              moves everything below it, and a profile with no bio should look like a
              profile with no bio rather than one with a gap. */}
          {bio ? (
            <Text variant="callout" tone="secondary" numberOfLines={2}>
              {bio}
            </Text>
          ) : null}
        </View>
      </View>

      {controls ? <View style={styles.controls}>{controls}</View> : null}

      <StatRow
        stats={[
          { label: 'Followers', value: stats.followers },
          { label: 'Following', value: stats.following },
          { label: 'Movies', value: stats.movies },
          { label: 'TV seasons', value: stats.seasons },
        ]}
      />
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
  // Takes whatever the photo leaves, and wraps inside it rather than pushing the photo.
  copy: { flex: 1, gap: 2 },
  controls: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
  },
});
