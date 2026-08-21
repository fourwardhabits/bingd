import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { hintFor, hrefFor, targetFor } from '@/features/notifications/routing';
import {
  canFollowBack,
  useMarkNotificationsRead,
  useNotifications,
  verbFor,
  type Notification,
} from '@/features/notifications/use-notifications';
import { useRelationships, useSocialWrites } from '@/features/profile/use-social';
import { compactName } from '@/lib/titles';
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
 *
 * **Read is something the reader does, not something opening the screen does to them.**
 * This screen used to mark everything read on its first render, which made `read_at` a
 * column with exactly one observable value: by the time anybody could look, nothing was
 * unread. The founder's correction asks for read/unread *and* a Mark all read control,
 * and the two only mean anything together — so the rows now say which they are, and the
 * control is the only thing that changes it.
 */
/**
 * The gear in the navigation bar, as its own component so it can be looked at.
 *
 * `headerRight` is a function React Navigation calls, not something a screen renders,
 * so an inline element here is unreachable from a test of the screen — which is how a
 * control ends up shipping with no accessible name. Nothing else about it wants to be
 * separate; being nameable is the whole reason.
 */
export function NotificationSettingsButton() {
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Notification settings"
      onPress={() => router.push('/settings/notification-preferences')}
      style={({ pressed }) => [styles.gear, pressed && styles.gearPressed]}
    >
      <Ionicons
        name="settings-outline"
        size={theme.layout.icon.md}
        color={theme.semantic.action}
      />
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const notifications = useNotifications(profile.id);
  const markRead = useMarkNotificationsRead(profile.id);
  const { follow, respondToRequest, busy } = useSocialWrites(profile.id, 'notifications');

  const rows = notifications.data ?? [];
  const requests = rows.filter((row) => row.kind === 'follow_request');
  const rest = rows.filter((row) => row.kind !== 'follow_request');
  const unreadCount = rows.filter((row) => !row.readAt).length;

  /**
   * Whether the reader already follows the people who followed them.
   *
   * Asked once for the whole screen rather than per row, and only about the actors on
   * `follow` rows — `follow_state_with` is security invoker, so it reports the
   * caller's own edges and nothing else, but a list of ids is still a list of ids and
   * there is no reason to send the ones no control depends on.
   */
  const followActors = [
    ...new Set(
      rows.filter((row) => row.kind === 'follow').map((row) => row.actorId).filter(Boolean),
    ),
  ] as string[];
  const relationships = useRelationships(followActors, profile.id);

  const followBack = async (row: Notification) => {
    if (!row.actorId) return;
    // Three states, not two: `relationships` may not have resolved, and "nobody has
    // looked" is not "there was no edge". Unknown emits nothing (`use-social.ts`).
    const known = relationships.data?.get(row.actorId);
    const result = await follow({
      userId: row.actorId,
      priorState: !relationships.data ? 'unknown' : known?.following ? 'existing' : 'none',
    });
    if (!result.ok) {
      Alert.alert('Could not follow', result.message);
      return;
    }
    await Promise.all([notifications.refetch(), relationships.refetch()]);
  };

  const answer = async (row: Notification, approve: boolean) => {
    if (!row.actorId) return;
    const result = await respondToRequest({ userId: row.actorId, approve });
    if (!result.ok) {
      Alert.alert(approve ? 'Could not approve' : 'Could not decline', result.message);
      return;
    }
    await notifications.refetch();
  };

  /**
   * Where the row leads.
   *
   * Every destination comes from `routing.ts` rather than from a condition here. What
   * this replaced was one rule — a recommendation opened the title, everything else
   * opened the actor — with no answer at all for the case that matters: by the time
   * somebody taps a notification, the thing it points at may have been deleted,
   * blocked, or made private. The resolver returns an ordered chain whose last link
   * always survives, so a tap can land on a useful parent but never on a blank screen.
   */
  const openRow = (row: Notification) => {
    const target = targetFor(row);
    const href = hrefFor(target);

    // Nothing survived. Say so rather than absorbing the tap: a press that does
    // nothing is indistinguishable from one the app missed, and the reader repeats it.
    if (!href) {
      Alert.alert(
        'No longer available',
        target.kind === 'unavailable' ? target.reason : 'This is no longer available.',
      );
      return;
    }
    router.push(href);
  };

  /** The person on a follow request, which is the same chain by another entry point. */
  const openActor = (row: Notification) => openRow(row);

  return (
    <Screen includeBottomInset>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Notifications',
          headerBackTitle: 'Back',
          /**
           * Where somebody looks the moment they decide they are getting too many of
           * these, which is here rather than back in the Settings list.
           *
           * A gear rather than the word, which the founder asked for off the device.
           * “Settings” in a navigation bar reads as a second destination competing with
           * the title beside it — two labels of similar weight and no hierarchy between
           * them — and it is the one control in the app whose meaning a glyph carries
           * completely. The word survives for a screen reader, which is where it was
           * doing the work.
           *
           * The `Pressable` is the full 44pt square and the glyph is 24 inside it. Not
           * `hitSlop`: Android clips touches outside a parent's box, so slop around an
           * icon is a target that measures right on iOS and is a 24pt tap on Android
           * (`ActivityRow`, review 29a).
           */
          headerRight: () => <NotificationSettingsButton />,
        }}
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
          body="Follows, reactions, comments and recommendations land here."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.page}>
          {/* In the list rather than in the navigation bar, and only while it would do
              something. A control that clears a state has to sit where that state is
              visible, or the reader cannot tell what they just changed. */}
          {unreadCount > 0 ? (
            <View style={styles.markAll}>
              <Text variant="footnote" tone="secondary" style={styles.markAllCount}>
                {unreadCount === 1 ? '1 unread' : `${unreadCount} unread`}
              </Text>
              <Button
                label={markRead.isPending ? 'Marking…' : 'Mark all read'}
                kind="tertiary"
                onPress={() => markRead.mutate()}
                disabled={markRead.isPending}
                disabledReason="Marking your notifications read."
              />
            </View>
          ) : null}

          {requests.length ? (
            <View style={styles.section}>
              <SectionHeader title="Follow requests" />
              {requests.map((row) => (
                <View key={row.id} style={[styles.request, !row.readAt && styles.unread]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${row.readAt ? '' : 'Unread. '}${row.actorName}, @${row.actorUsername}, wants to follow you`}
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
                    <UnreadDot show={!row.readAt} />
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
              {rest.map((row) => {
                // The subject, named the way the rest of the app names it: a season
                // says which show it belongs to, because its own title is "Season 2".
                const subject = row.mediaItemId
                  ? compactName({
                      kind: row.mediaKind,
                      title: row.mediaTitle,
                      seriesTitle: row.seriesTitle,
                    })
                  : null;
                const offerFollowBack = canFollowBack(
                  row,
                  relationships.data?.get(row.actorId ?? '')?.following,
                );

                return (
                  <View key={row.id} style={[styles.entry, !row.readAt && styles.unread]}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${row.readAt ? '' : 'Unread. '}${row.actorName} ${verbFor(
                        row.kind,
                        row.mediaKind,
                      )}${subject ? `, ${subject}` : ''}`}
                      // From the same chain the tap uses, so the hint cannot promise a
                      // title and then open a profile.
                      accessibilityHint={hintFor(row)}
                      onPress={() => openRow(row)}
                      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    >
                      <Avatar size="sm" uri={row.actorAvatarUri} name={row.actorName ?? ''} />
                      <View style={styles.rowCopy}>
                        <Text variant="callout" numberOfLines={2}>
                          <Text variant="callout">{row.actorName}</Text>
                          <Text variant="callout" tone="secondary">{` ${verbFor(
                            row.kind,
                            row.mediaKind,
                          )}`}</Text>
                        </Text>
                        {/* The title on its own line rather than after a separator.
                            "Suraj recommended a movie" and then "Inception" is the
                            founder's shape, and it is also what stops a long name
                            pushing the verb off the row. */}
                        {subject ? (
                          <Text variant="callout" tone="secondary" numberOfLines={1}>
                            {subject}
                          </Text>
                        ) : null}
                        <Text variant="caption" tone="tertiary">
                          {new Date(row.createdAt).toLocaleDateString()}
                        </Text>
                      </View>
                      <UnreadDot show={!row.readAt} />
                    </Pressable>
                    {/* Follow back, on the row that announced the follow and nowhere
                        else. Absent once the reader follows them, because a control
                        for a relationship that already exists is a control that can
                        only mislead. */}
                    {offerFollowBack ? (
                      <View style={styles.answers}>
                        <Button
                          label="Follow back"
                          kind="secondary"
                          onPress={() => void followBack(row)}
                          disabled={busy}
                          disabledReason="One at a time"
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

/**
 * Unread, as a mark rather than as a colour alone.
 *
 * The tinted row is the thing somebody notices while scanning; the dot is what makes it
 * readable for anyone who cannot see the tint, and the word "Unread" opens the label
 * for anyone who is listening rather than looking. Three signals for one bit of state,
 * which is the accessibility rule the score system already follows.
 */
function UnreadDot({ show }: { show: boolean }) {
  if (!show) return null;
  return <View style={styles.dot} accessibilityElementsHidden importantForAccessibility="no" />;
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  /**
   * A square the size of the minimum target, with the glyph centred in it. The
   * negative right margin pulls the box back to the bar's own edge: the square is
   * wider than the glyph, so without it the gear sits a gutter's width in from where
   * the word “Settings” used to end and looks unaligned with the title opposite.
   */
  gear: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -theme.space[3],
  },
  gearPressed: { opacity: 0.6 },
  unread: { backgroundColor: theme.surface.raised },
  markAll: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  markAllCount: { flex: 1 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.action,
  },
  section: { paddingTop: theme.space[4], gap: theme.space[1] },
  // The tint belongs to the whole entry, including a Follow back button underneath,
  // or the unread state would stop halfway down the row it describes.
  entry: { gap: theme.space[1] },
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
