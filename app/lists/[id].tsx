import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, Share, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { newOperationId, setWatchlist } from '@/features/collection/writes';
import { AddTitlesSheet } from '@/features/lists/AddTitlesSheet';
import { EditListSheet } from '@/features/lists/EditListSheet';
import { ChipDot, VisibilityChip } from '@/features/lists/ListChips';
import { ListItemRow } from '@/features/lists/ListItemRow';
import { listShareMessage, listUrl } from '@/features/lists/share';
import { titleCountLabel, updatedLabel } from '@/features/lists/types';
import { useListItems, useListProgress, useListView } from '@/features/lists/use-lists';
import { LINK_CONSENT_TITLE, linkConsentBody } from '@/features/lists/VisibilityPicker';
import { addListToWatchlist, bulkWatchlistMessage, updateList } from '@/features/lists/writes';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import { track, type ListOpenSurface } from '@/lib/analytics';
import { queryKeys } from '@/lib/query';
import {
  Avatar,
  Button,
  Divider,
  EmptyState,
  Screen,
  Sheet,
  SheetRow,
  SkeletonRow,
  Text,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

const SURFACES: readonly ListOpenSurface[] = [
  'my_lists',
  'profile_shelf',
  'deep_link',
  'title_menu',
];

/**
 * `https://bingd.app/lists/<id>` — one list, for whoever may read it.
 *
 * ---------------------------------------------------------------------------
 * ONE SCREEN, TWO READERS
 *
 * The owner gets Edit, Share, Who can see it and Delete, an `Add titles` button, and a
 * visibility chip. A viewer gets attribution, a Share control **only when the list is
 * public**, and Report. Everything else — the progress line, the seen marks, the
 * bookmarks, the bulk add — is identical, because all of it is about *the reader*.
 *
 * ---------------------------------------------------------------------------
 * THE HEADER READS TOP TO BOTTOM AS WHAT → HOW YOU ARE DOING → WHAT YOU CAN DO
 *
 * Name, attribution, description, facts, progress, then the actions. **`Add titles`
 * sits below the progress and bulk block, not above it** (§H): it puts the owner's two
 * actions next to each other instead of separating them with a stat line.
 *
 * ---------------------------------------------------------------------------
 * EVERY REFUSAL IS THE SAME SCREEN
 *
 * `useListView` resolves `null` for private, deleted, hidden, suspended, blocked and
 * "no such uuid" alike, and this draws one unavailable state for all of them. It never
 * says which — §F is explicit that ❌ is one answer, and a screen that distinguished
 * them would be the oracle the whole model is written to avoid.
 */
export default function ListScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const { id, surface } = useLocalSearchParams<{ id?: string; surface?: string }>();
  const listId = typeof id === 'string' ? id : null;

  const list = useListView(listId);
  const items = useListItems(listId, Boolean(list.data));
  const progress = useListProgress(listId, Boolean(list.data));

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingTitles, setAddingTitles] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Whether the options sheet was closed on its way to the report sheet.
   *
   * A ref rather than state: iOS will not present a sheet while it is dismissing
   * another from the same presenter, and the result is a transparent window that
   * swallows every touch (`Sheet.onDismissed`, and the reproduced 2026-09-10 freeze).
   * So the menu closes, this remembers where it was going, and `onDismissed` opens the
   * report sheet once UIKit has finished. Android fires no dismissal and goes straight
   * across, which is correct rather than a gap — an Android modal is a view in the same
   * window and has no presentation to serialise against.
   */
  const reportPending = useRef(false);

  const rows = useMemo(() => items.data?.pages.flat() ?? [], [items.data]);
  const presentIds = useMemo(() => new Set(rows.map((row) => row.mediaItemId)), [rows]);

  const view = list.data ?? null;

  /** Once per resolved list. The unavailable state emits nothing — it is not an open. */
  const reportedOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!view || reportedOpen.current === view.id) return;
    reportedOpen.current = view.id;
    track({
      name: 'list_opened',
      props: {
        surface: SURFACES.includes(surface as ListOpenSurface)
          ? (surface as ListOpenSurface)
          : 'deep_link',
        is_owner: view.isOwner,
        relation: view.isOwner ? 'self' : 'other',
        // Only the owner is told which of the two modes a non-private list is in, so
        // only the owner can report it. `undefined` is dropped by `sanitize`, which is
        // how "not known" is said here rather than by inventing a value.
        visibility_class:
          view.isOwner && view.visibility && view.visibility !== 'private'
            ? view.visibility
            : undefined,
      },
    });
  }, [surface, view]);

  const refetchAll = () => {
    if (!listId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.list(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.listItems(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.listProgress(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.myLists(profile.id) });
    void queryClient.invalidateQueries({ queryKey: ['profile-lists'] });
  };

  // -------------------------------------------------------------------------
  // Sharing
  // -------------------------------------------------------------------------

  const share = async (visibility: 'link' | 'public', isOwner: boolean, itemCount: number, title: string, targetId: string) => {
    track({ name: 'list_shared', props: { visibility, item_count: itemCount, is_owner: isOwner } });
    try {
      await Share.share({
        message: listShareMessage(title, targetId),
        url: listUrl(targetId),
      });
    } catch (error) {
      Alert.alert('Could not share', error instanceof Error ? error.message : 'Sharing failed.');
    }
  };

  /**
   * Share on a **private** list is a consent gate, not a share (§F.5).
   *
   * The person asked to share; converting the list to link-only is a consequence they
   * did not name, so it is confirmed before it happens. The second line appears only
   * for a private-profile owner, where it is the true and reassuring fact.
   */
  const shareOrAsk = () => {
    if (!view) return;
    const current = view;

    if (current.isOwner && current.visibility === 'private') {
      Alert.alert(LINK_CONSENT_TITLE, linkConsentBody(profile.visibility === 'private'), [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Make link-only',
          onPress: () => {
            void (async () => {
              const result = await updateList({
                operationId: newOperationId(),
                listId: current.id,
                visibility: 'link',
              });
              if (result.outcome === 'failed') {
                Alert.alert('Could not change this', result.message);
                if (result.changed) refetchAll();
                return;
              }
              if (result.outcome === 'hidden') {
                Alert.alert('This list is hidden while it is reviewed.');
                return;
              }
              track({
                name: 'list_visibility_changed',
                props: {
                  from: 'private',
                  to: 'link',
                  surface: 'share_prompt',
                  profile_private: profile.visibility === 'private',
                },
              });
              refetchAll();
              await share('link', true, current.itemCount, current.title, current.id);
            })();
          },
        },
      ]);
      return;
    }

    void share(
      current.isOwner && current.visibility === 'link' ? 'link' : 'public',
      current.isOwner,
      current.itemCount,
      current.title,
      current.id,
    );
  };

  // -------------------------------------------------------------------------
  // The Watchlist, one title and all of them
  // -------------------------------------------------------------------------

  const toggleWatchlist = async (mediaItemId: string, present: boolean) => {
    setWatchlistBusy(mediaItemId);
    const result = await setWatchlist({
      operationId: newOperationId(),
      mediaItemId,
      present: !present,
    });
    setWatchlistBusy(null);
    if (result.outcome === 'failed' && !result.changed) {
      Alert.alert('Could not update watchlist', result.message);
      return;
    }
    // Only an add is an event, and only after the server said yes. A removal is not a
    // `watchlist_added`, and the per-title event stays separate from the bulk one so
    // that one tap adding nine titles cannot read as nine deliberate saves.
    if (!present) track({ name: 'watchlist_added', props: { surface: 'list' } });
    if (listId) void queryClient.invalidateQueries({ queryKey: queryKeys.listItems(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) });
  };

  const addAllUnseen = async () => {
    if (!view) return;
    setBulkBusy(true);
    const result = await addListToWatchlist({ operationId: newOperationId(), listId: view.id });
    setBulkBusy(false);

    if (result.outcome === 'failed') {
      Alert.alert('Could not add these', result.message);
      if (result.changed) refetchAll();
      return;
    }
    if (result.outcome !== 'ok') return;

    track({
      name: 'list_watchlist_bulk_added',
      props: { added: result.added, skipped_seen: result.skippedSeen },
    });
    setNotice(bulkWatchlistMessage(result));
    if (listId) void queryClient.invalidateQueries({ queryKey: queryKeys.listItems(listId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) });
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (list.isPending) {
    return (
      <Screen includeBottomInset>
        <View style={styles.loading}>
          <SkeletonRow count={5} />
        </View>
      </Screen>
    );
  }

  if (!view) {
    return (
      <Screen includeBottomInset>
        <EmptyState
          kind="nothingYet"
          title="List unavailable"
          body="This list is private, deleted, or not available yet."
        />
      </Screen>
    );
  }

  const owner = view.owner;
  const unseenCount = rows.filter((row) => row.seen === false && !row.watchlisted).length;
  const canShare = view.shareableByViewer || (view.isOwner && view.visibility === 'private');

  return (
    <Screen includeBottomInset>
      <Stack.Screen
        options={{
          title: view.title,
          headerRight: () => (
            <View style={styles.headerActions}>
              {canShare ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Share ${view.title}`}
                  hitSlop={theme.space[2]}
                  onPress={shareOrAsk}
                >
                  <Ionicons
                    name="share-outline"
                    size={theme.layout.icon.md}
                    color={theme.text.primary}
                  />
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`More options for ${view.title}`}
                hitSlop={theme.space[2]}
                onPress={() => setMenuOpen(true)}
              >
                <Ionicons
                  name="ellipsis-horizontal"
                  size={theme.layout.icon.md}
                  color={theme.text.primary}
                />
              </Pressable>
            </View>
          ),
        }}
      />

      <FlatList
        data={rows}
        keyExtractor={(row) => row.mediaItemId}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text variant="title1">{view.title}</Text>

            {!view.isOwner && owner ? (
              <Attribution
                owner={owner}
                // A private owner's attribution still leads to their profile route,
                // which renders the existing locked shell — identity plus a follow
                // request. The list adds no path around it; the server answers every
                // profile read with `can_view_profile` exactly as it does today (§F.2).
                onPress={() => router.push(`/u/${owner.username}`)}
              />
            ) : null}

            {view.description ? (
              <Text variant="body" tone="secondary">
                {view.description}
              </Text>
            ) : null}

            <View style={styles.facts}>
              <Text variant="footnote" tone="secondary">
                {titleCountLabel(view.itemCount)}
              </Text>
              {view.orderStyle === 'ranked' ? (
                <>
                  <ChipDot />
                  <Text variant="footnote" tone="secondary">
                    Numbered
                  </Text>
                </>
              ) : null}
              {view.isOwner && view.visibility ? (
                <>
                  <ChipDot />
                  <VisibilityChip visibility={view.visibility} hidden={view.hidden} />
                </>
              ) : null}
              <ChipDot />
              <Text variant="footnote" tone="tertiary">
                {updatedLabel(view.updatedAt)}
              </Text>
            </View>

            {view.hidden ? (
              <View style={styles.banner} accessibilityRole="alert">
                <Text variant="footnote" tone="secondary">
                  This list is hidden while it is reviewed. Only you can see it.
                </Text>
              </View>
            ) : null}

            {/* Plain text, one line, no bar (§K, §Q.5). Suppressed on an empty list:
                "You've seen 0 of 0" is a fact about nothing. */}
            {progress.data && progress.data.total > 0 ? (
              <Text variant="callout" tone="secondary">
                You&rsquo;ve seen {progress.data.seen} of {progress.data.total}
              </Text>
            ) : null}

            {unseenCount > 0 ? (
              <Button
                // "my Watchlist", not "Watchlist". On somebody else's list the bare
                // noun is genuinely ambiguous about whose it is, and the one word also
                // restates the boundary in the place a reader is standing (§H).
                label={bulkBusy ? 'Adding…' : `Add ${unseenCount} unseen to my Watchlist`}
                kind="secondary"
                onPress={() => void addAllUnseen()}
                disabled={bulkBusy}
              />
            ) : null}

            {view.isOwner ? (
              <Button label="Add titles" onPress={() => setAddingTitles(true)} />
            ) : null}

            {notice ? (
              <Text
                variant="footnote"
                tone="secondary"
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                {notice}
              </Text>
            ) : null}

            <Divider />
          </View>
        }
        ListEmptyComponent={
          items.isPending ? (
            <SkeletonRow count={4} />
          ) : (
            <EmptyState
              kind="nothingYet"
              compact
              title={view.isOwner ? 'Nothing on this list yet' : 'This list is empty'}
              body={
                view.isOwner
                  ? 'Add the first title and it will show up here.'
                  : 'There is nothing here to see yet.'
              }
            />
          )
        }
        renderItem={({ item }) => (
          <ListItemRow
            item={item}
            showNumber={view.orderStyle === 'ranked'}
            busy={watchlistBusy === item.mediaItemId}
            onPress={() => router.push(`/title/${item.mediaItemId}`)}
            onToggleWatchlist={() =>
              void toggleWatchlist(item.mediaItemId, item.watchlisted === true)
            }
          />
        )}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
        }}
      />

      {menuOpen ? (
        <Sheet
          visible
          onClose={() => setMenuOpen(false)}
          label={`Options for ${view.title}`}
          onDismissed={() => {
            if (!reportPending.current) return;
            reportPending.current = false;
            setReporting(true);
          }}
        >
          <View style={styles.menu}>
            {view.isOwner ? (
              <>
                <SheetRow
                  icon="create-outline"
                  label="Edit list"
                  onPress={() => {
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                />
                {canShare ? (
                  <SheetRow
                    icon="share-outline"
                    label="Share"
                    onPress={() => {
                      setMenuOpen(false);
                      shareOrAsk();
                    }}
                  />
                ) : null}
                {/* Who can see it opens the same editor. Two rows to one place, because
                    the two intentions arrive separately — "fix the title" and "change
                    who sees this" — and a person holding the second should not have to
                    recognise it as a case of the first. */}
                <SheetRow
                  icon="eye-outline"
                  label="Who can see it"
                  onPress={() => {
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                />
                <SheetRow
                  icon="trash-outline"
                  label="Delete list"
                  onPress={() => {
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                />
              </>
            ) : (
              <SheetRow
                icon="flag-outline"
                label="Report list"
                onPress={() => {
                  if (Platform.OS === 'ios') {
                    reportPending.current = true;
                    setMenuOpen(false);
                  } else {
                    setMenuOpen(false);
                    setReporting(true);
                  }
                }}
              />
            )}
          </View>
        </Sheet>
      ) : null}

      {editing ? (
        <EditListSheet
          list={view}
          items={rows}
          profilePrivate={profile.visibility === 'private'}
          onClose={() => setEditing(false)}
          onChanged={refetchAll}
          onDeleted={() => {
            setEditing(false);
            refetchAll();
            router.back();
          }}
        />
      ) : null}

      {addingTitles ? (
        <AddTitlesSheet
          listId={view.id}
          listTitle={view.title}
          viewerId={profile.id}
          presentIds={presentIds}
          onClose={() => {
            setAddingTitles(false);
            refetchAll();
          }}
        />
      ) : null}

      {reporting ? (
        <ReportSheet
          visible
          onClose={() => setReporting(false)}
          subject="list"
          subjectId={view.id}
          noun="list"
        />
      ) : null}
    </Screen>
  );
}

/**
 * Who a list belongs to.
 *
 * A **lock glyph** when the viewer cannot see the owner's profile, which is the limited
 * identity of §F.2: avatar, display name and handle, and nothing else. The chevron still
 * opens the profile route, where a non-approved viewer meets the existing locked shell
 * rather than a dead end — and the list adds no path around it.
 *
 * There is deliberately no "more lists by…" anywhere on this screen. Holding a link
 * grants one list.
 */
function Attribution({
  owner,
  onPress,
}: {
  owner: {
    username: string;
    displayName: string;
    avatarUri: string | null;
    profileVisible: boolean;
  };
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${owner.displayName}, @${owner.username}${
        owner.profileVisible ? '' : '. Private account'
      }`}
      onPress={onPress}
      style={({ pressed }) => [styles.attribution, pressed && styles.pressed]}
    >
      <Avatar uri={owner.avatarUri} name={owner.displayName} size="sm" />
      <Text variant="footnote" numberOfLines={1} style={styles.attributionName}>
        {owner.displayName} · @{owner.username}
      </Text>
      {owner.profileVisible ? null : (
        <Ionicons
          name="lock-closed-outline"
          size={theme.layout.icon.sm - 4}
          color={theme.text.tertiary}
        />
      )}
      <Ionicons name="chevron-forward" size={theme.layout.icon.sm} color={theme.text.tertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { paddingTop: theme.space[4] },
  list: { paddingBottom: theme.space[8] },
  header: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.space[3],
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[4] },
  facts: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space[1] },
  banner: {
    padding: theme.space[3],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.sunken,
  },
  attribution: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
  },
  attributionName: { flex: 1 },
  menu: { paddingBottom: theme.space[4], paddingTop: theme.space[2] },
  pressed: { opacity: 0.7 },
});
