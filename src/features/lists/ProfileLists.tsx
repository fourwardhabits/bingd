import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ListCover } from './ListCover';
import { useProfileLists } from './use-lists';
import { titleCountLabel, type ProfileListSummary } from './types';

export type ProfileListsProps = {
  ownerId: string;
  /** True on the reader's own profile: the header carries `Manage ›` instead of `See all`. */
  isOwner: boolean;
  onOpenList: (listId: string) => void;
  /** `Manage ›`. Own profile only, and always present there. */
  onManage?: () => void;
  /** `See all`. Another profile, and only when there is more than the shelf shows. */
  onSeeAll?: () => void;
};

/**
 * A profile's public lists — **public only, read-only, on every profile including the
 * owner's** (§I, §Q.4).
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES THIS SECTION EXISTS TO KEEP
 *
 * **1. No editing controls, ever.** This is `ProfileWatchlist`'s rule, and Lists is the
 * feature that was most tempted to break it: the earlier draft of the PRD put a
 * `+ New list` tile and a two-tap Delete on this exact shelf. Collection is where the
 * full set is, for the account that owns it; a profile is what a visitor sees. `Manage ›`
 * is a door to the management screen, not management on the profile.
 *
 * **2. No empty state on anybody else's profile, ever.** `useProfileLists` returns zero
 * rows both for a profile the viewer may not read and for one with no public lists, and
 * the only way those two can look identical is if neither draws anything. A "No lists
 * yet" line would disclose that the account exists and has none, which is more than a
 * private profile is meant to say. That is also why there is no skeleton: it would
 * announce a section before knowing whether there is one.
 *
 * **3. The owner's own shelf shows what a visitor would see.** An owner holding four
 * private lists gets "Nothing public yet", and learns the privacy model by looking at
 * it. The server enforces this — `profile_lists` is public-only for every caller — so
 * there is no branch here that could widen it, only the empty line, which is safe
 * precisely because the owner already knows their own account exists.
 *
 * A clipped shelf rather than a grid, for `ProfileWatchlist`'s reason: the clip says
 * "there is more" without claiming to be the whole thing. Tapping a card pushes the
 * list directly — there is **no intermediate sheet** anywhere in this section, which is
 * what removes the sheet-then-push sequencing hazard the earlier draft carried (§Q.4).
 */
export function ProfileLists({
  ownerId,
  isOwner,
  onOpenList,
  onManage,
  onSeeAll,
}: ProfileListsProps) {
  const lists = useProfileLists(ownerId);
  const rows = lists.data ?? [];

  // Rule 2. A viewer who may not read this profile and one reading an account with no
  // public lists must meet the same nothing.
  if (!isOwner && rows.length === 0) return null;

  const showSeeAll = !isOwner && rows.length > 3 && Boolean(onSeeAll);

  return (
    <View style={styles.section}>
      <SectionHeader
        title="Lists"
        actionLabel={isOwner ? 'Manage' : showSeeAll ? 'See all' : undefined}
        actionAccessibilityLabel={isOwner ? 'Manage your lists' : 'See all lists'}
        onPressAction={isOwner ? onManage : showSeeAll ? onSeeAll : undefined}
      />

      {rows.length === 0 ? (
        <Text variant="footnote" tone="secondary" style={styles.nothingPublic}>
          Nothing public yet. Lists you publish show up here.
        </Text>
      ) : (
        <ListShelf lists={rows} onPress={onOpenList} />
      )}
    </View>
  );
}

export type ListShelfProps = {
  lists: ProfileListSummary[];
  onPress: (listId: string) => void;
};

/**
 * The horizontal shelf itself, with the last card clipped at ~70%.
 *
 * The width is solved from the screen rather than fixed, which is `PosterShelf`'s own
 * arithmetic and is here rather than borrowed because the card is a **square** cover
 * with two lines under it, not a 2:3 poster — reusing `PosterShelf` would have meant a
 * `tiles` shape that carried four images in a field named for one.
 */
export function ListShelf({ lists, onPress }: ListShelfProps) {
  const { width } = useWindowDimensions();
  const { gap, peek } = theme.layout.posterShelf;

  const available = width - theme.layout.gutter;
  const columns = Math.max(2, Math.round((available + gap) / (CARD_TARGET + gap) - peek));
  const cardWidth = Math.floor((available - columns * gap) / (columns + peek));

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.shelf, { gap }]}
    >
      {lists.map((list) => (
        <Pressable
          key={list.id}
          accessibilityRole="button"
          accessibilityLabel={`${list.title}. ${titleCountLabel(list.itemCount)}`}
          onPress={() => onPress(list.id)}
          style={({ pressed }) => [{ width: cardWidth }, pressed && styles.pressed]}
        >
          <ListCover posterUris={list.posterUris} size={cardWidth} />
          <Text variant="footnote" numberOfLines={2} style={styles.cardTitle}>
            {list.title}
          </Text>
          {/* The count and nothing else. A shelf card never carries a visibility chip:
              everything on it is public by construction, so a chip would be noise that
              implied a choice the reader cannot see the alternatives to. */}
          <Text variant="caption" tone="tertiary">
            {list.itemCount}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** About three and a half cards at normal phone width, which is what makes the clip land. */
const CARD_TARGET = 104;

const styles = StyleSheet.create({
  section: { gap: theme.space[2] },
  shelf: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  cardTitle: { marginTop: theme.space[2] },
  nothingPublic: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  pressed: { opacity: 0.7 },
});
