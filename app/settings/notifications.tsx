import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AwardBadge } from '@/features/awards/AwardBadge';
import { badgeFor } from '@/features/awards/badges';
import { GOAL_LABEL } from '@/features/goals/goals';
import { hintFor, hrefFor, targetFor } from '@/features/notifications/routing';
import {
  canRankFromRow,
  relationshipActionFor,
  sectionFor,
  useMarkNotificationsRead,
  useNotifications,
  verbFor,
  type InboxSection,
  type Notification,
} from '@/features/notifications/use-notifications';
import { useRelationships, useSocialWrites } from '@/features/profile/use-social';
import { relativeTime } from '@/features/recommendations/use-sent-to-you';
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
 * The control in the navigation bar, as its own component so it can be looked at.
 *
 * `headerRight` is a function React Navigation calls, not something a screen renders,
 * so an inline element here is unreachable from a test of the screen — which is how a
 * control ends up shipping with no accessible name. Nothing else about it wants to be
 * separate; being nameable is the whole reason.
 *
 * **A bell wearing a small gear, not a bare gear.** A bare gear in this corner read as
 * the app's settings — the same glyph the Profile header carries — when what it opens
 * is the notification preferences alone. The bell names the subject and the gear names
 * the action, the way the unread badge already annotates the bell in `AppHeader`. The
 * gear sits directly on the bell's shoulder — no disc behind it: the founder's device
 * read the Paper bubble as a badge background, and at this weight the two glyphs
 * separate on their own. Same neutral ink and `icon.md` weight as the Profile gear,
 * so the two settings controls are visibly kin without being the same claim.
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
      <View style={styles.bellWrap}>
        <Ionicons
          name="notifications-outline"
          size={theme.layout.icon.md}
          color={theme.text.secondary}
        />
        {/* The filled cut, not the outline: at this size an outlined gear is a
            smudge. */}
        <Ionicons
          name="settings-sharp"
          size={GEAR_BADGE_SIZE}
          color={theme.text.secondary}
          style={styles.gearGlyph}
        />
      </View>
    </Pressable>
  );
}

/** Small enough to read as an annotation on the bell, large enough to still be a gear. */
const GEAR_BADGE_SIZE = 12;

/** How far the gear pokes past the bell's lower-right corner. */
const GEAR_OVERHANG = { x: 3, y: 2 };

/**
 * The three shelves, in the small-caps maroon voice every section on this surface
 * already speaks — "Earlier" was here first, as the one heading under the requests.
 */
const SECTION_TITLES: Record<InboxSection, string> = {
  today: 'Today',
  week: 'This week',
  earlier: 'Earlier',
};

export default function NotificationsScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const notifications = useNotifications(profile.id);
  const markRead = useMarkNotificationsRead(profile.id);
  const { follow, respondToRequest, busy } = useSocialWrites(profile.id, 'notifications');

  // Memoised because the mark-on-sight effect below depends on it, and a fresh array
  // identity every render would re-run that effect on every render.
  const rows = useMemo(() => notifications.data ?? [], [notifications.data]);
  const requests = rows.filter((row) => row.kind === 'follow_request');
  const rest = useMemo(() => rows.filter((row) => row.kind !== 'follow_request'), [rows]);
  /**
   * The founder's diagnosis of this list was that everything ran together — six
   * kinds of event as one undifferentiated column. The fix is rhythm, not
   * furniture: hairline rules between rows (below, in the render) and these three
   * age shelves, which are the only grouping this inbox gets. No tabs, no
   * per-kind categories — the list stays one list, newest first, exactly as
   * `my_notifications` returns it; the shelves just name the fold lines that were
   * already there.
   *
   * **Headings earn their place or disappear.** A single shelf under no requests
   * would be one label captioning the entire screen — noise with nothing to
   * separate — so the headings render only when there are at least two shelves,
   * or a requests section above for the first shelf to mark the end of. That
   * second case is exactly the old behaviour: "Earlier", shown only under
   * requests, was this rule with one shelf.
   */
  const { dataUpdatedAt } = notifications;
  const groupedRest = useMemo(() => {
    // Anchored to the moment the rows arrived rather than to the render — a render
    // must be pure, and the shelf a row sits on should change when the data does,
    // not when an unrelated state update happens to repaint the screen.
    const byAge: Record<InboxSection, Notification[]> = { today: [], week: [], earlier: [] };
    for (const row of rest) byAge[sectionFor(row.createdAt, dataUpdatedAt)].push(row);
    return (Object.keys(SECTION_TITLES) as InboxSection[])
      .map((age) => [age, byAge[age]] as const)
      .filter(([, list]) => list.length > 0);
  }, [rest, dataUpdatedAt]);
  const showHeadings = requests.length > 0 || groupedRest.length > 1;
  /**
   * **Seeing them is what reads them.**
   *
   * Read used to be something the reader did: no mark-on-open, and a `Mark all read`
   * control that was the only way to clear the bell. Beta feedback is that this is
   * friction with nothing on the other side of it — somebody who has just looked at
   * six rows should not have to tell the app they looked.
   *
   * The objection the old design was answering was real, and this keeps its answer:
   * `read_at` must not become a column with one observable value. It does not, because
   * the marking happens *after* the rows are on screen. The first paint of this list is
   * always the unread one — tinted rows, dots, the state the reader came to see — and
   * the refetch that follows settles it to read. What is gone is the requirement to
   * press something.
   *
   * `my_notifications` returns the whole inbox (limit 100, no pagination and no
   * cursor), so "displayed" and "fetched" are the same set and there is no later page
   * this could mark read unseen. If that ever gains pagination, this has to become
   * per-row visibility — hence the comment rather than a bare call.
   */
  /** Stable across renders, unlike `markRead` itself — see the effect below. */
  const { mutate: markAllRead } = markRead;
  const markedOnSight = useRef(false);
  useEffect(() => {
    if (notifications.isPending || notifications.isError) return;
    if (markedOnSight.current) return;
    if (!rows.some((row) => !row.readAt)) return;

    // Latched before the call, so a re-render while it is in flight does not send a
    // second one — and released again if it fails. There is no `Mark all read` any
    // more, so a failure that latched permanently would leave the reader with unread
    // rows and nothing to press: the bell would stay lit until the screen was
    // remounted.
    //
    // **The dependency is `mutate` and not the mutation.** Both halves of that were
    // found by independent review, the second only after the first was fixed: a
    // `useMutation` *result* takes a new identity every time its state changes, so
    // depending on it would re-run this effect the instant `onError` released the
    // latch — straight back into the call that just failed, for ever. `mutate` itself
    // is `useCallback`-stable, so the effect now re-runs only when the query's own
    // state or its rows change, and the retry lands on the next genuine refetch
    // (foreground, screen focus) rather than on the next render.
    markedOnSight.current = true;
    markAllRead(undefined, {
      onError: () => {
        markedOnSight.current = false;
      },
    });
    // `dataUpdatedAt` rather than `rows` alone, which was the third finding on this
    // effect. React Query shares structure between fetches, so a refetch returning the
    // same rows hands back the *same array* — and after a failed mark released the
    // latch, nothing in the dependency list would have changed on the next foreground
    // or focus, so the retry would never fire and the bell would stay lit until the
    // screen was remounted. The timestamp advances on every successful fetch whether
    // the rows moved or not, which is exactly the signal "there has been a fresh look
    // at this" needs. It cannot spin: it advances on fetches, not on renders.
  }, [
    notifications.isPending,
    notifications.isError,
    notifications.dataUpdatedAt,
    rows,
    markAllRead,
  ]);

  /**
   * Whether the reader already follows the people these rows are about.
   *
   * Asked once for the whole screen rather than per row, and only about the actors
   * whose rows can carry a follow control — `follow_state_with` is security invoker,
   * so it reports the caller's own edges and nothing else, but a list of ids is still
   * a list of ids and there is no reason to send the ones no control depends on.
   *
   * **This list and `relationshipActionFor` have to agree.** Found by independent
   * review of `20260823000100`: `invite_welcome` was added to the follow gate and not
   * here, so the inviter's state was never asked for, `relationships` had nothing under
   * their id, and "nobody has looked" was read as "there is no edge" — which offered
   * Follow on every welcome row, including the overwhelmingly common one where the
   * redemption had already created the follow a second earlier.
   *
   * The two invite rows now *depend* on that answer rather than merely being gated by
   * it: they draw Following or Requested from it, so an id missing here would show a
   * blank where the state should be instead of a wrong offer.
   */
  const CAN_OFFER_FOLLOW: readonly Notification['kind'][] = [
    'follow',
    'invite_welcome',
    // 20260831000100 — the inviter's half of the same acceptance, and it draws the
    // same three states from the same read.
    'invite_joined',
    // 20260827000200 — and added here in the same change as the follow gate, which
    // is the agreement the paragraph above exists to enforce.
    'friendship',
  ];
  const followActors = [
    ...new Set(
      rows
        .filter((row) => CAN_OFFER_FOLLOW.includes(row.kind))
        .map((row) => row.actorId)
        .filter(Boolean),
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
    /**
     * **No top edge** (founder physical finding: a large blank band between the
     * Notifications header and TODAY).
     *
     * The gap was safe-area duplication, not padding. This screen declares
     * `headerShown: true`, and a native-stack header already consumes the status-bar
     * inset before it draws — so `Screen`'s default `['top', 'left', 'right']` added the
     * *same* inset a second time, below the header, as an empty band roughly the height
     * of the status bar. Nothing in this file's own spacing was wrong: `section`'s
     * `space[4]` above the first heading is the same air every other list screen has.
     *
     * `['left', 'right']` rather than `[]`: the horizontal insets still matter in
     * landscape and under a notch, and only the top one is the header's to own. The
     * three other header-bearing screens reached the same place from the other
     * direction (`edges={[]}`, for a full-bleed hero). Nothing moves under the status
     * bar — the header is still there, at its own height, doing that job.
     */
    <Screen includeBottomInset edges={['left', 'right']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Notifications',
          headerBackTitle: 'Back',
          /**
           * Where somebody looks the moment they decide they are getting too many of
           * these, which is here rather than back in the Settings list.
           *
           * A glyph rather than the word, which the founder asked for off the device —
           * “Settings” in a navigation bar reads as a second destination competing with
           * the title beside it. And a bell wearing a small gear rather than a bare
           * gear, because a bare gear here claimed to be app settings when it opens
           * notification preferences alone. The words survive for a screen reader,
           * which is where they were doing the work.
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

          {groupedRest.map(([age, list]) => (
            <View key={age} style={styles.section}>
              {showHeadings ? <SectionHeader title={SECTION_TITLES[age]} /> : null}
              {list.map((row, index) => {
                // The subject, named the way the rest of the app names it: a season
                // says which show it belongs to, because its own title is "Season 2".
                const subject = row.mediaItemId
                  ? compactName({
                      kind: row.mediaKind,
                      title: row.mediaTitle,
                      seriesTitle: row.seriesTitle,
                    })
                  : null;
                const relationshipAction = relationshipActionFor(
                  row,
                  relationships.data?.get(row.actorId ?? ''),
                  Boolean(relationships.data),
                );

                return (
                  <Fragment key={row.id}>
                    {/* Between rows and only between them: a rule after the last row
                        would underline the section itself, which the heading above the
                        next one already does. Inset to the text edge, so the avatars
                        keep an unbroken left column — the same alignment the follow
                        request rows' full-width rule deliberately does not share,
                        because those are cards with controls and these are lines. */}
                    {index > 0 ? (
                      <View testID="notification-divider" style={styles.divider} />
                    ) : null}
                    <View style={[styles.entry, !row.readAt && styles.unread]}>
                      <Pressable
                        accessibilityRole="button"
                        // The award row is the first actorless sentence: templating a
                        // null actor into the label read "null You earned…" aloud, so
                        // the actor's name joins the sentence only when there is one.
                        accessibilityLabel={`${row.readAt ? '' : 'Unread. '}${
                          row.kind === 'invite_welcome' ? 'Welcome to bingd. ' : ''
                        }${
                          row.kind === 'award_earned'
                            ? `You earned ${row.award?.name ?? 'a new Award'}`
                            : row.kind === 'goal_completed'
                              ? // The second actorless sentence. `verbFor` returns the
                                // whole clause here, so there is no name to template in
                                // and no "null" to read aloud.
                                verbFor(row.kind, row.mediaKind, row.goal)
                              : // The watched-with sentence puts the title in the middle
                                // — "Suraj watched 100 Meters with you" — so it is spoken
                                // whole rather than assembled with the subject appended,
                                // which would say the film's name twice.
                                row.kind === 'watch_tag' && subject
                                ? `${row.actorName} watched ${subject} with you`
                                : `${row.actorName} ${verbFor(
                                    row.kind,
                                    row.mediaKind,
                                    row.goal,
                                    row.mentionInReply,
                                  )}`
                        }${
                          subject && row.kind !== 'watch_tag' ? `, ${subject}` : ''
                        }${
                          /* The preview is drawn inside this Pressable, and a label on a
                             Pressable replaces its children rather than joining them —
                             so a line a sighted reader can see would be silent without
                             this. `previewHidden` speaks for itself. */
                          row.preview
                            ? `. ${row.preview}`
                            : row.previewHidden
                              ? '. Contains spoilers'
                              : ''
                        }`}
                        // From the same chain the tap uses, so the hint cannot promise a
                        // title and then open a profile.
                        accessibilityHint={hintFor(row)}
                        onPress={() => openRow(row)}
                        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                      >
                        {/* The award's own badge where every other row has a face —
                            nobody did this to the reader, and an empty avatar chip
                            says "somebody unnameable" rather than "your award". */}
                        {row.kind === 'goal_completed' ? (
                          // The same flag the feed row leads with, at avatar size. An
                          // empty avatar chip would say "somebody unnameable" where the
                          // truth is that nobody did this to them.
                          <View style={styles.goalMark}>
                            <Ionicons
                              name="flag"
                              size={theme.layout.icon.md}
                              color={theme.semantic.action}
                            />
                          </View>
                        ) : row.kind === 'award_earned' && row.award ? (
                          <AwardBadge
                            badge={badgeFor(row.award.key, row.award.tierKey)}
                            earned
                            size={theme.layout.avatar.sm}
                          />
                        ) : (
                          <Avatar size="sm" uri={row.actorAvatarUri} name={row.actorName ?? ''} />
                        )}
                        <View style={styles.rowCopy}>
                          {/* The welcome is the one row whose sentence does not begin
                            with the actor. It is the first thing a new account ever
                            sees, so it greets before it reports, and the inviter's
                            name still carries the emphasis every other row gives the
                            person who did something.

                            The emoji lives here and not in `verbFor`, which supplies
                            the spoken label — "party popper" in the middle of that
                            sentence helps nobody, and the celebration is the part
                            that survives being dropped. */}
                          {row.kind === 'invite_welcome' ? (
                            <Text variant="callout" numberOfLines={2}>
                              <Text variant="callout" tone="secondary">
                                Welcome to bingd.{' '}
                              </Text>
                              <Text variant="callout">{row.actorName}</Text>
                              <Text variant="callout" tone="secondary">
                                {' '}
                                invited you 🎉
                              </Text>
                            </Text>
                          ) : row.kind === 'award_earned' ? (
                            /* The congratulations, named: "You earned Movie Muncher 🎉"
                             — the founder's copy. The award takes the emphasis every
                             other row gives the actor, because it is the subject; the
                             emoji stays out of the spoken label, same as the welcome's. */
                            <Text variant="callout" numberOfLines={2}>
                              <Text variant="callout" tone="secondary">
                                You earned{' '}
                              </Text>
                              <Text variant="callout">{row.award?.name ?? 'a new Award'}</Text>
                              <Text variant="callout" tone="secondary">
                                {' '}
                                🎉
                              </Text>
                            </Text>
                          ) : row.kind === 'goal_completed' ? (
                            /* "You hit your 2026 Movies goal 🎉" — the founder's copy.
                             The goal takes the emphasis every other row gives the actor,
                             because it is the subject; the emoji stays out of the spoken
                             label for the same reason the welcome's and the award's do. */
                            <Text variant="callout" numberOfLines={2}>
                              <Text variant="callout" tone="secondary">
                                You hit your{' '}
                              </Text>
                              <Text variant="callout">
                                {row.goal
                                  ? `${row.goal.year} ${GOAL_LABEL[row.goal.category]}`
                                  : 'annual'}{' '}
                                goal
                              </Text>
                              <Text variant="callout" tone="secondary">
                                {' '}
                                🎉
                              </Text>
                            </Text>
                          ) : row.kind === 'friendship' && row.mutual ? (
                            /* The mutual acceptance is the other sentence that does not
                             begin with the actor: it is about the pair, and "You and
                             Abisola are now friends" is the founder's copy for it. The
                             one-way case falls through to the ordinary shape, where
                             `verbFor` says "now follows you". */
                            <Text variant="callout" numberOfLines={2}>
                              <Text variant="callout" tone="secondary">
                                You and{' '}
                              </Text>
                              <Text variant="callout">{row.actorName}</Text>
                              <Text variant="callout" tone="secondary">
                                {' '}
                                are now friends
                              </Text>
                            </Text>
                          ) : row.kind === 'recommendation_ranked' && subject ? (
                            /* The founder's copy, with the title inline: "Suraj ranked
                             The Martian from your recommendation". The title takes the
                             same emphasis the actor does — the sentence is about the
                             two of them — and the subject line below stays out of it,
                             because saying the title twice is the clutter this pass is
                             removing. Two lines, so a long season name wraps rather
                             than eating the tail of the sentence. When the ranking
                             post is gone the title goes with it, and the row falls
                             through to `verbFor`'s "ranked your recommendation". */
                            <Text variant="callout" numberOfLines={2}>
                              <Text variant="callout">{row.actorName}</Text>
                              <Text variant="callout" tone="secondary">
                                {' '}
                                ranked{' '}
                              </Text>
                              <Text variant="callout">{subject}</Text>
                              <Text variant="callout" tone="secondary">
                                {' '}
                                from your recommendation
                              </Text>
                            </Text>
                          ) : row.kind === 'watch_tag' && subject ? (
                            /* "Suraj watched 100 Meters with you" — the founder's copy,
                             with the title inline, because "watched something with you"
                             and then the name on the next line reads as two facts a
                             reader has to join up. The title carries the same emphasis
                             the actor does: the sentence is about the two of them and
                             the film. `compactName` supplies the season form, so a TV
                             season says which show it belongs to.

                             The subject line below is suppressed for this kind, the way
                             it already is for a fulfilment — saying the title twice is
                             exactly the clutter this pass removes. When the title has
                             left the catalogue there is no `subject`, and the row falls
                             through to `verbFor`'s "watched something with you". */
                            <Text variant="callout" numberOfLines={2}>
                              <Text variant="callout">{row.actorName}</Text>
                              <Text variant="callout" tone="secondary"> watched </Text>
                              <Text variant="callout">{subject}</Text>
                              <Text variant="callout" tone="secondary"> with you</Text>
                            </Text>
                          ) : (
                            <Text variant="callout" numberOfLines={2}>
                              <Text variant="callout">{row.actorName}</Text>
                              <Text variant="callout" tone="secondary">{` ${verbFor(
                                row.kind,
                                row.mediaKind,
                                row.goal,
                                row.mentionInReply,
                              )}`}</Text>
                            </Text>
                          )}
                          {/* The title on its own line rather than after a separator.
                            "Suraj recommended a movie" and then "Inception" is the
                            founder's shape, and it is also what stops a long name
                            pushing the verb off the row. Not on a fulfilment, whose
                            sentence already carries the title inline. */}
                          {subject &&
                          row.kind !== 'recommendation_ranked' &&
                          row.kind !== 'watch_tag' ? (
                            <Text variant="callout" tone="secondary" numberOfLines={1}>
                              {subject}
                            </Text>
                          ) : null}
                          {/**
                            * **What was actually said** (founder, 2026-08-30).
                            *
                            * "Ravi commented on your activity" does not tell you whether
                            * to open it. One line does.
                            *
                            * `numberOfLines={1}` is a shape contract as much as a style:
                            * a comment is up to a thousand characters, and a row that
                            * grew with it would break the scan rhythm of the whole
                            * inbox. The server sends at most 140, so this is the last of
                            * two bounds rather than the only one.
                            *
                            * **The text is never withheld here**, and that is deliberate:
                            * a spoiler-marked or retracted comment arrives as `preview:
                            * null` from `my_notifications`, so there is no string in this
                            * component to leak. `previewHidden` is the server saying
                            * *why*, and "Contains spoilers" is a useful thing to know
                            * before tapping — where an absent second line reads as a
                            * rendering bug.
                            *
                            * Caption rather than callout, so it sits under the sentence
                            * as context and does not compete with it.
                            */}
                          {row.preview ? (
                            <Text variant="caption" tone="secondary" numberOfLines={1}>
                              {row.preview}
                            </Text>
                          ) : row.previewHidden ? (
                            <Text variant="caption" tone="tertiary" numberOfLines={1}>
                              Contains spoilers
                            </Text>
                          ) : null}
                          {/* "2d ago" rather than "23/08/2026". Recency is half of what
                            an inbox row is telling you, and a bare date makes the
                            reader do the subtraction — the same argument the
                            recommendations list already settled, through the same
                            helper so the two cannot drift. */}
                          <Text variant="caption" tone="tertiary">
                            {relativeTime(row.createdAt)}
                          </Text>
                        </View>
                        <UnreadDot show={!row.readAt} />
                      </Pressable>
                      {/* The relationship control, on the rows that name somebody the
                        reader has an edge to or could have one to, and nowhere else.

                        **On `follow` and `friendship` it is still an offer that
                        disappears once taken**, because a control for a relationship
                        that already exists is a control that can only mislead.

                        **On the two invite rows it is a statement.** Those rows exist
                        to introduce two accounts, and `redeem_invite` creates the
                        follow as part of acceptance — so a control that hides itself
                        once an edge exists hid itself on essentially every welcome ever
                        drawn, and the row that is *about* a connection said nothing
                        about it. It now reads Following or Requested from
                        `follow_state_with`, which is the same truth `FollowControl`
                        draws on the profile.

                        Settled states wear the maroon outline and the offer keeps the
                        secondary fill, which is the hierarchy `FollowControl` and the
                        recommendation requests sheet already share. They are not dead
                        controls: they open the profile the row opens, which is where
                        unfollowing and withdrawing live — deliberately not here, since
                        an inbox row is a bad place to end a relationship by mis-tap.

                        **"Follow back" is wrong on a welcome**: the inviter never
                        followed them, so there is nothing to return. It is right on a
                        join, where the invitee has just followed the inviter. */}
                      {relationshipAction ? (
                        <View style={styles.rowAction}>
                          <Button
                            label={relationshipAction.label}
                            kind={relationshipAction.actionable ? 'secondary' : 'outline'}
                            size="sm"
                            hitSlop={theme.space[2]}
                            accessibilityHint={
                              relationshipAction.actionable
                                ? `Follow ${row.actorName ?? 'them'}`
                                : hintFor(row)
                            }
                            onPress={() =>
                              relationshipAction.actionable ? void followBack(row) : openRow(row)
                            }
                            disabled={busy && relationshipAction.actionable}
                            disabledReason="One at a time"
                          />
                        </View>
                      ) : null}
                      {/**
                        * **Rank, on a watched-with row for a title the reader has not
                        * placed** (founder, 2026-08-30).
                        *
                        * Somebody has just said they watched this with you; the useful
                        * next act is to place it, and before this the row was a sentence
                        * with nothing to do about it. In the same grammar as Follow back
                        * — a small secondary button in the row's action slot — because
                        * it is the same kind of thing: one optional act, offered where
                        * the news arrives.
                        *
                        * **It opens the title page and not the ranking sheet**, which is
                        * the founder's instruction and not a shortcut. A notification is
                        * a claim about something that may have happened days ago;
                        * dropping the reader straight into a comparison session from a
                        * Bell tap is a modal state entered by accident. The title page's
                        * own Rank button is what takes the next step, and it is where
                        * every ranking in this app begins.
                        *
                        * The same destination the row itself already has, so this is a
                        * second door onto one place rather than a second behaviour —
                        * which is also why it is `openRow` and not a route built here.
                        *
                        * `canRankFromRow` reads `viewerRanked`, resolved server-side in
                        * the read that drew the row. So the control disappears on the
                        * next refetch after they rank it, with nothing to invalidate.
                        */}
                      {canRankFromRow(row) ? (
                        <View style={styles.rowAction}>
                          <Button
                            label="Rank"
                            kind="secondary"
                            size="sm"
                            hitSlop={theme.space[2]}
                            accessibilityHint="Opens the title, where you can rank it"
                            onPress={() => openRow(row)}
                          />
                        </View>
                      ) : null}
                    </View>
                  </Fragment>
                );
              })}
            </View>
          ))}
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
   * negative right margin pulls the box back to the bar's own edge — by exactly the
   * slack the square adds around the glyph, which is what centres the *glyph* on the
   * position the bar means. The old pull was a spacing token (12) rather than the
   * slack (10), so the glyph sat two points past the edge and read as off-centre.
   */
  gear: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -(theme.layout.minTapTarget - theme.layout.icon.md) / 2,
  },
  gearPressed: { opacity: 0.6 },
  // The glyph's own box, so the gear's absolute offsets measure from the bell
  // rather than from the 44pt touch square around it. The translate is half the
  // gear's overhang, so the *combined* glyph — bell plus the gear poking past its
  // lower-right corner — centres in the touch square rather than the bell alone.
  bellWrap: {
    width: theme.layout.icon.md,
    height: theme.layout.icon.md,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateX: -GEAR_OVERHANG.x / 2 }, { translateY: -GEAR_OVERHANG.y / 2 }],
  },
  /**
   * The gear, riding the bell's lower-right shoulder directly — no disc behind it.
   * The founder's device read the old Paper bubble as a badge background; at this
   * weight the filled gear separates from the bell's strokes on its own.
   */
  gearGlyph: {
    position: 'absolute',
    right: -GEAR_OVERHANG.x,
    bottom: -GEAR_OVERHANG.y,
  },
  unread: { backgroundColor: theme.surface.raised },

  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.action,
  },
  section: { paddingTop: theme.space[4], gap: theme.space[1] },
  /**
   * The rule between rows: the house hairline (`ActivityRow`, the Settings list),
   * inset to where the sentences begin so the avatar column stays unbroken. Drawn
   * as its own element rather than a border, because a border cannot be inset and
   * a full-bleed rule under every row is the "sea of boxes" this pass was told to
   * avoid — the line separates the text, and the faces separate themselves.
   */
  divider: {
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.border.hairline,
    marginLeft: theme.layout.gutter + theme.layout.avatar.sm + theme.space[3],
  },
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
  /**
   * A row's own action, aligned under the sentence it belongs to.
   *
   * `answers` is shared with the follow-request block, which sits inside `request` and
   * inherits that block's gutter — so the same style read as inset there and flush
   * against the screen edge here, under an avatar indented by 16. This one states its
   * own inset: gutter, plus the avatar, plus the row's gap, which is exactly where the
   * text above it starts. `flexDirection: 'row'` keeps the button its label's width
   * rather than the screen's.
   */
  rowAction: {
    flexDirection: 'row',
    paddingLeft: theme.layout.gutter + theme.layout.avatar.sm + theme.space[3],
    paddingRight: theme.layout.gutter,
    paddingBottom: theme.space[2],
  },
  personCopy: { flex: 1, gap: 2 },
  answers: { flexDirection: 'row', gap: theme.space[3] },
  // The avatar slot, holding a glyph instead of a face for the one actorless kind that
  // has no badge of its own to draw.
  goalMark: {
    width: theme.layout.avatar.sm,
    height: theme.layout.avatar.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
