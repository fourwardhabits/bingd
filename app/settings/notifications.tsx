import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import {
  useMarkNotificationsRead,
  useNotifications,
  verbFor,
  type Notification,
} from '@/features/notifications/use-notifications';
import { useSocialWrites } from '@/features/profile/use-social';
import {
  Avatar,
  Button,
  EmptyState,
  LoadingScreen,
  Screen,
  SectionHeader,
  Text,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Notifications, and the follow requests that made this screen necessary.
 *
 * `respond_follow_request` has existed and been tested since 20260817000200, and the
 * `follow_request` inbox row has been written since. **Nothing read it.** A private
 * account could receive requests and had nowhere to see them, which made the private
 * setting a way to become unreachable rather than a way to choose — and the founder's
 * two-user acceptance gate is not passable without this surface.
 *
 * Requests sit above everything else and are the only rows with controls on them,
 * because they are the only rows that are a *task*. A reaction is news; a request is
 * somebody waiting. Everything else is a line of text and a face that opens a profile.
 *
 * There is no preference matrix. `notification_preferences` exists and nothing writes
 * it; there is one delivery channel, it cannot be switched off without making requests
 * unanswerable, and a screen of switches over a table nothing reads is exactly the
 * dead control this run was told not to ship.
 */
export default function NotificationsScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const notifications = useNotifications(profile.id);
  const markRead = useMarkNotificationsRead(profile.id);
  const { respondToRequest, busy } = useSocialWrites(profile.id);

  const rows = notifications.data ?? [];
  const requests = rows.filter((row) => row.kind === 'follow_request');
  const rest = rows.filter((row) => row.kind !== 'follow_request');
  const unread = rows.some((row) => !row.readAt);

  /**
   * Opening the screen is what "read" means here.
   *
   * There is no per-row control and no useful meaning for one: this is a list somebody
   * opens, and the honest reading of `read_at` on it is "has seen this". Fired once,
   * on the first render that has something unread — `mutate` is stable and the guard
   * is the flag itself, which the invalidation clears.
   */
  useEffect(() => {
    if (unread && !markRead.isPending) markRead.mutate();
    // Deliberately not depending on the mutation object, which is a new identity each
    // render. `unread` going false after the invalidation is what stops this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  const answer = async (row: Notification, approve: boolean) => {
    if (!row.actorId) return;
    const result = await respondToRequest({ userId: row.actorId, approve });
    if (!result.ok) {
      Alert.alert(approve ? 'Could not approve' : 'Could not decline', result.message);
      return;
    }
    await notifications.refetch();
  };

  const openActor = (row: Notification) => {
    if (row.actorUsername) router.push(`/u/${row.actorUsername}`);
  };

  return (
    <Screen includeBottomInset>
      <Stack.Screen
        options={{ headerShown: true, title: 'Notifications', headerBackTitle: 'Back' }}
      />

      {notifications.isPending ? (
        <LoadingScreen />
      ) : notifications.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load your notifications"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void notifications.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          kind="nothingYet"
          title="Nothing yet"
          body="Follows, reactions and comments on your activity show up here."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.page}>
          {requests.length ? (
            <View style={styles.section}>
              <SectionHeader title="Follow requests" />
              {requests.map((row) => (
                <View key={row.id} style={styles.request}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${row.actorName}, @${row.actorUsername}, wants to follow you`}
                    accessibilityHint="Opens their profile"
                    onPress={() => openActor(row)}
                    style={styles.person}
                  >
                    <Avatar size="sm" uri={row.actorAvatarUri} name={row.actorName ?? ''} />
                    <View style={styles.personCopy}>
                      <Text variant="callout" numberOfLines={1}>
                        {row.actorName}
                      </Text>
                      <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        @{row.actorUsername} · wants to follow you
                      </Text>
                    </View>
                  </Pressable>
                  <View style={styles.answers}>
                    <Button
                      label="Approve"
                      onPress={() => void answer(row, true)}
                      disabled={busy}
                      disabledReason="One at a time"
                    />
                    {/* Declining is silent by design (20260817000200): being told you
                        were turned down is a message nobody chose to send, and it
                        invites exactly the exchange the private setting avoids. */}
                    <Button
                      label="Decline"
                      kind="secondary"
                      onPress={() => void answer(row, false)}
                      disabled={busy}
                      disabledReason="One at a time"
                    />
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {rest.length ? (
            <View style={styles.section}>
              {requests.length ? <SectionHeader title="Earlier" /> : null}
              {rest.map((row) => (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.actorName} ${verbFor(row.kind)}${
                    row.mediaTitle ? `, ${row.mediaTitle}` : ''
                  }`}
                  accessibilityHint="Opens their profile"
                  onPress={() => openActor(row)}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  <Avatar size="sm" uri={row.actorAvatarUri} name={row.actorName ?? ''} />
                  <View style={styles.rowCopy}>
                    <Text variant="callout" numberOfLines={2}>
                      <Text variant="callout">{row.actorName}</Text>
                      <Text variant="callout" tone="secondary">{` ${verbFor(row.kind)}`}</Text>
                      {/* The title, where the event had one. "Alice commented on your
                          activity" with no indication of which activity is a
                          notification that needs a second app to answer. */}
                      {row.mediaTitle ? (
                        <Text variant="callout" tone="secondary">{` · ${row.mediaTitle}`}</Text>
                      ) : null}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {new Date(row.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[4], gap: theme.space[1] },
  request: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  person: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  personCopy: { flex: 1, gap: 2 },
  answers: { flexDirection: 'row', gap: theme.space[3] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
  rowCopy: { flex: 1, gap: 2 },
  pressed: { opacity: 0.7 },
});
