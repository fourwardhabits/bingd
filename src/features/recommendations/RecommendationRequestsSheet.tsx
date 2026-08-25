import { Ionicons } from '@expo/vector-icons';
import { useState, type MutableRefObject } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { newOperationId } from '@/features/collection/writes';
import { useRelationships, useSocialWrites, type Relationship } from '@/features/profile/use-social';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import { Avatar, Button, EmptyState, Poster, Sheet, SkeletonRow, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import {
  useRecommendationRequests,
  useRequestActions,
  type RecommendationRequest,
  type RequestGroup,
} from './use-recommendation-requests';

export type RecommendationRequestsSheetProps = {
  viewerId: string;
  onClose: () => void;
  /** Opens somebody's profile. The sheet closes on the way — see `openProfile`. */
  onPressProfile: (username: string) => void;
  /**
   * The Dismiss all operation id, **owned by the screen rather than by this sheet**.
   *
   * A ref passed in rather than held here, and that is the whole reason it is a prop:
   * the screen unmounts this component when it closes, so a ref of its own would be
   * cleared by the reader doing the most ordinary thing available to them — closing the
   * sheet after a failure and opening it again to try. The retry would then carry a
   * fresh id, walk past `_claim_operation`, and sweep whatever had arrived in between.
   *
   * The screen is a tab and outlives every open and close of this sheet, which makes it
   * the longest scope that is still honest. Leaving the app clears it, and that is
   * correct rather than a gap: an id held indefinitely would eventually be spent on a
   * sweep months later, be answered `already_applied`, and report success having
   * dismissed nothing.
   */
  sweepIntent: MutableRefObject<string | null>;
};

/**
 * Recommendation requests.
 *
 * **Presented the way Bingd Awards is**, and for the same reason: a heading, then a
 * list of rows, inside the app's one `Sheet`. This is a utility — a short list of
 * decisions to take — not a feature with a home of its own, and anything that made it
 * read as a second inbox would be wrong. No new modal, no new card, no oversized
 * avatars, no full-height page sheet.
 *
 * **Individual items, grouped by sender.** The decision is per recommendation — Sarah
 * sent two films and the reader may want one of them — so every item carries its own
 * Add and Dismiss. But the *person* is the thing that makes the decision easy, and
 * repeating a name and a Follow button beside four rows from the same person is four
 * copies of one fact. So the sender is a header and the titles hang under it.
 *
 * **Follow is at the sender, once.** It is the only control here that changes a
 * relationship, and following somebody releases everything of theirs at once — which
 * is a statement about the person and not about any one film.
 */
export function RecommendationRequestsSheet({
  viewerId,
  onClose,
  onPressProfile,
  sweepIntent,
}: RecommendationRequestsSheetProps) {
  const requests = useRecommendationRequests(viewerId);
  const actions = useRequestActions(viewerId);
  const groups = requests.data?.groups ?? [];

  const senderIds = groups.map((group) => group.senderId);
  const relationships = useRelationships(senderIds, viewerId);
  /**
   * One `useSocialWrites` for the sheet rather than one per group.
   *
   * It owns a `busy` flag and an operation-intent ref, so a hook per rendered group
   * would be a hook count that changes with the data — and five independent busy flags
   * expressing one fact, which is the reason `use-social.ts` gives for having one.
   *
   * **The release itself is the server's.** Following somebody moves every pending
   * recommendation of theirs in the same transaction (`20260826000400` §10), and this
   * component replays nothing — `useSocialWrites` invalidates the requests query and
   * the list comes back from the database already correct. That is what makes a follow
   * started on a profile page behave identically to one started here.
   */
  const social = useSocialWrites(viewerId, 'for_you');

  const [menuOpen, setMenuOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = (result: { ok: boolean; message?: string }) => {
    setError(result.ok ? null : (result.message ?? 'Something went wrong. Try again.'));
  };

  const runItem = async (id: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    report(await action());
    setBusyId(null);
  };

  const confirmDismissAll = () => {
    setMenuOpen(false);
    Alert.alert(
      'Dismiss all recommendation requests?',
      'This removes all pending recommendations. New recommendations can still arrive later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Dismiss all',
          style: 'destructive',
          onPress: () =>
            void (async () => {
              /**
               * **Held only while the outcome is unknown**, which is the asymmetry
               * `lib/operation-intent.ts` records and the first version of this got
               * wrong twice — once by clearing it unconditionally, and once by keeping
               * it in a ref this component owned, which closing the sheet reset.
               *
               * Both directions lose something. Minting a fresh id after a lost reply
               * sweeps requests that arrived since, which the reader never saw. Reusing
               * a *spent* one has the next deliberate sweep answered `already_applied`
               * — nothing dismissed, success reported.
               */
              const held = sweepIntent.current ?? newOperationId();
              sweepIntent.current = held;
              setError(null);
              const result = await actions.dismissAll({ operationId: held });
              if (result.ok || !result.changed) sweepIntent.current = null;
              report(result);
            })(),
        },
      ],
    );
  };

  /**
   * The sender's profile, which this sheet deliberately does not draw itself.
   *
   * Closing first rather than pushing over the top: a route change behind an open
   * `Modal` leaves the sheet in front of the screen it navigated to, and the profile is
   * a whole page with its own header.
   */
  const openProfile = (username: string) => {
    onClose();
    onPressProfile(username);
  };

  return (
    <Sheet visible onClose={onClose} label="Recommendation requests">
      <View style={styles.head}>
        <Text variant="title2" style={styles.heading}>
          Recommendation requests
        </Text>

        {/* An ellipsis rather than a labelled Dismiss all.

            A permanent destructive button at the top of a list of other people's
            suggestions reads as the thing to do, which is the opposite of what this
            screen is for. The same reasoning `TitleReviews` records for Report. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="More options"
          accessibilityState={{ expanded: menuOpen }}
          accessibilityHint="Dismiss all recommendation requests"
          onPress={() => setMenuOpen((open) => !open)}
          hitSlop={(theme.layout.minTapTarget - theme.layout.icon.sm) / 2}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={theme.layout.icon.sm}
            color={theme.text.secondary}
          />
        </Pressable>
      </View>

      {error ? (
        <Text variant="footnote" tone="secondary" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {requests.isPending ? (
          <View style={styles.state}>
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : requests.isError ? (
          <View style={styles.state}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load requests"
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: () => void requests.refetch() }}
            />
          </View>
        ) : groups.length === 0 ? (
          <View style={styles.state}>
            <EmptyState
              kind="nothingYet"
              compact
              title="Nothing waiting"
              body="Recommendations from people you do not follow turn up here."
            />
          </View>
        ) : (
          groups.map((group) => (
            <SenderGroup
              key={group.senderId}
              group={group}
              relationship={relationships.data?.get(group.senderId)}
              busy={actions.busy || social.busy}
              busyId={busyId}
              onOpenProfile={openProfile}
              onFollow={() =>
                void (async () => {
                  setError(null);
                  /**
                   * `priorState` is the caller's own reading *before* the press, and
                   * `unknown` is a real third value: the relationship query may still
                   * be in flight, and reporting that as "there was no edge" is how a
                   * re-follow gets counted as a new one (independent review 24).
                   */
                  const known = relationships.data?.get(group.senderId);
                  report(
                    await social.follow({
                      userId: group.senderId,
                      priorState:
                        relationships.data === undefined
                          ? 'unknown'
                          : known?.following
                            ? 'existing'
                            : 'none',
                    }),
                  );
                })()
              }
              onAdd={(item) =>
                void runItem(item.id, () => actions.add({ recommendationId: item.id }))
              }
              onDismiss={(item) =>
                void runItem(item.id, () => actions.dismiss({ recommendationId: item.id }))
              }
            />
          ))
        )}
      </ScrollView>

      {/* The way out, said in a word.

          Not decoration and not a duplicate of the backdrop: `Sheet` hides its scrim
          from the accessibility tree *on the understanding that every sheet carries its
          own labelled Close control*, so without this there is no announced way out of
          a modal for a screen-reader user. `AwardsSheet` and the filter sheet both end
          the same way, which is also what keeps this one feeling like the others. */}
      <View style={styles.foot}>
        <Button label="Done" onPress={onClose} />
      </View>

      {/* The overflow, drawn inside the sheet rather than as a second `Modal`.

          `Sheet` sets `accessibilityViewIsModal`, so a sibling modal would claim the
          accessibility tree and leave this one hidden from it — the defect
          `AwardsSheet` records about its own drill-down. A popover inside the sheet has
          one modal context and one focus order. */}
      {menuOpen ? (
        <>
          <Pressable
            style={styles.menuScrim}
            onPress={() => setMenuOpen(false)}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          <View style={styles.menu}>
            <Pressable
              accessibilityRole="menuitem"
              accessibilityLabel="Dismiss all"
              accessibilityHint="Removes every pending recommendation. Asks first."
              onPress={confirmDismissAll}
              style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
            >
              <Text variant="callout">Dismiss all</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

/**
 * One sender and everything of theirs that is waiting.
 *
 * The header is the only place a person appears, and the only place a relationship can
 * be changed. Tapping the name or the picture opens their profile — the real one, which
 * the parallel pre-RC pass owns; nothing about a profile is drawn here.
 */
function SenderGroup({
  group,
  relationship,
  busy,
  busyId,
  onOpenProfile,
  onFollow,
  onAdd,
  onDismiss,
}: {
  group: RequestGroup;
  relationship: Relationship | undefined;
  busy: boolean;
  busyId: string | null;
  onOpenProfile: (username: string) => void;
  onFollow: () => void;
  onAdd: (item: RecommendationRequest) => void;
  onDismiss: (item: RecommendationRequest) => void;
}) {
  /**
   * Three states, one control, and never "Follows you".
   *
   * `followLabel` is the app's shared answer and it is the wrong one *here*: every
   * sender in this sheet follows the reader by construction — that is what let them
   * send — so it would render "Follows you" on all of them, which is a statement rather
   * than the action this row exists to offer.
   *
   * The pre-tap label is "Follow" for a private sender too, which is what every other
   * follow control in Bingd does. The server decides approved-or-pending from the
   * target's own setting, and the label becomes "Requested" once it has — so a private
   * account's visibility is never announced to somebody who has not interacted with it.
   */
  const following = relationship?.following === 'approved';
  const requested = relationship?.following === 'pending';
  const label = following ? 'Following' : requested ? 'Requested' : 'Follow';

  return (
    <View style={styles.group}>
      <View style={styles.sender}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${group.senderName}, @${group.senderUsername}`}
          accessibilityHint="Opens their profile"
          onPress={() => onOpenProfile(group.senderUsername)}
          style={({ pressed }) => [styles.senderIdentity, pressed && styles.pressed]}
        >
          <Avatar size="sm" uri={group.senderAvatarUri} name={group.senderName} />
          <View style={styles.senderNames}>
            <Text variant="callout" numberOfLines={1} style={styles.senderName}>
              {group.senderName}
            </Text>
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              @{group.senderUsername}
            </Text>
          </View>
        </Pressable>

        <Button
          label={label}
          kind="tertiary"
          size="sm"
          // Already following, or already asked. Present rather than hidden, because a
          // control that disappears reads as a control that failed.
          disabled={busy || following || requested}
          disabledReason={
            following
              ? 'You already follow them.'
              : requested
                ? 'Waiting for them to approve.'
                : 'Saving your last change.'
          }
          accessibilityHint={
            following || requested
              ? undefined
              : 'Adds everything they have sent you to your recommendations'
          }
          onPress={onFollow}
        />
      </View>

      {group.items.map((item) => (
        <RequestItem
          key={item.id}
          item={item}
          busy={busyId !== null}
          working={busyId === item.id}
          onAdd={() => onAdd(item)}
          onDismiss={() => onDismiss(item)}
        />
      ))}
    </View>
  );
}

/**
 * One recommendation, with the two decisions it carries.
 *
 * Artwork at `row` size — the same thumbnail `TitleRow` uses — rather than a card. A
 * card per recommendation would make five requests a scroll of five posters, and the
 * thing being scanned here is titles.
 *
 * **Add is not Accept**, and the label is the founder's. Accept implies admitting the
 * sender to something; this admits one film to a list.
 */
function RequestItem({
  item,
  busy,
  working,
  onAdd,
  onDismiss,
}: {
  item: RecommendationRequest;
  busy: boolean;
  working: boolean;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const name = compactName(item) ?? item.title;
  const metadata = [item.year, item.kind === 'season' ? 'Season' : null, ...item.genres.slice(0, 2)]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.item}>
      <Poster uri={posterUri(item.posterPath, 'row')} title={name} size="row" />

      <View style={styles.itemBody}>
        <Text variant="callout" numberOfLines={2}>
          {name}
        </Text>
        {/* Built before it is rendered rather than rendered with empty parts: a title
            with no year and no genres would otherwise draw an empty line box. */}
        {metadata ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {metadata}
          </Text>
        ) : null}

        <View style={styles.itemActions}>
          <Button
            label="Add"
            kind="secondary"
            size="sm"
            disabled={busy}
            disabledReason={working ? 'Adding this.' : 'Saving your last change.'}
            accessibilityHint={`Adds ${name} to your recommendations`}
            onPress={onAdd}
          />
          <Button
            label="Dismiss"
            kind="tertiary"
            size="sm"
            tone="secondary"
            disabled={busy}
            disabledReason={working ? 'Dismissing this.' : 'Saving your last change.'}
            accessibilityHint={`Removes ${name}. ${item.senderName} is not told.`}
            onPress={onDismiss}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[3],
  },
  heading: { flex: 1 },
  error: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  list: { flexGrow: 0 },
  listContent: { paddingBottom: theme.space[2] },
  state: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[4] },

  group: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[4],
  },
  sender: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.minTapTarget,
  },
  senderIdentity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  senderNames: { flex: 1, gap: 2 },
  senderName: { fontFamily: fontFamily.sansSemibold },

  item: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  itemBody: { flex: 1, gap: 2 },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    paddingTop: theme.space[2],
  },

  /**
   * Sticky, and visibly its own band: the hairline is what tells the reader the list
   * above it is scrolled rather than ended. `Sheet` owns the space below this — it
   * guarantees a gutter under every footer whatever the device reports as its bottom
   * inset. Copied from `AwardsSheet` deliberately: two sheets that end differently read
   * as two features.
   */
  foot: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
  },

  menuScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  menu: {
    position: 'absolute',
    top: theme.space[10],
    right: theme.layout.gutter,
    minWidth: 160,
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    paddingVertical: theme.space[1],
    ...theme.elevation.e1,
  },
  menuItem: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.space[4],
  },
  pressed: { opacity: 0.6 },
});
