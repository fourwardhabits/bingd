import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { newOperationId } from '@/features/collection/writes';
import { track, type Surface } from '@/lib/analytics';
import { compactName, type MediaKind } from '@/lib/titles';
import { Avatar, Button, EmptyState, SearchField, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import {
  createInviteLink,
  filterRecipients,
  useRecommendRecipients,
  useRecommendTitle,
  type Recipient,
} from './use-recommend';

export type RecommendSheetProps = {
  viewerId: string;
  mediaItemId: string;
  kind: MediaKind;
  title: string;
  seriesTitle?: string | null;
  seasonNumber?: number | null;
  onClose: () => void;
  /** Called once a recommendation has actually been filed, with the recipient's name. */
  onSent: (recipientName: string) => void;
  /** Where this sheet was opened from, for `recommendation_sent` and `invite_link_created`. */
  surface: Surface;
};

/** Above this many people, reading the list is slower than typing a name. */
const SEARCH_THRESHOLD = 8;

/**
 * Recommend, as one small act.
 *
 * **One recipient per send.** No multi-select, no send-to-all, no message. That is the
 * V1 shape the founder set, and it is also the shape that keeps this honest: a title
 * sent to one person is a recommendation, and the same title sent to everybody at once
 * is a broadcast, which is the thing people learn to ignore.
 *
 * Tapping a person sends immediately rather than selecting them for a later Send. With
 * one recipient there is nothing for a second step to confirm, and a two-tap flow with
 * a disabled button at the bottom is the pattern this sheet exists instead of.
 *
 * The people offered are everybody the sender follows, which is what the server accepts.
 * Whether they follow back decides only whether it lands in their list or waits as a
 * request, and the sender is deliberately not told which — "Sent" either way. If
 * somebody is refused anyway the relationship changed while the sheet was open, and the
 * message says so rather than reporting a code.
 */
export function RecommendSheet({
  viewerId,
  mediaItemId,
  kind,
  title,
  seriesTitle,
  seasonNumber,
  onClose,
  onSent,
  surface,
}: RecommendSheetProps) {
  const recipients = useRecommendRecipients(viewerId);
  const send = useRecommendTitle(viewerId);

  const [query, setQuery] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  /**
   * The operation id for the off-platform share, held across attempts.
   *
   * A ref rather than state because it is machinery and nothing renders from it, and
   * because it has to be right in the same tick as the press. Keyed to the sheet
   * instance, which is keyed to the title — a share of a different film mounts a new
   * one. See `shareOffPlatform` for the sequence it exists for.
   */
  const shareIntent = useRef<string | null>(null);
  /**
   * The operation id for a send, per recipient, held across attempts.
   *
   * Keyed by person because the sheet can be tapped down a list and each name is its own
   * intent. Released as soon as the server answers anything at all — see `recommend`.
   */
  const sendIntents = useRef(new Map<string, string>());

  const people = recipients.data ?? [];
  const shown = filterRecipients(people, query);
  const name = compactName({ kind, title, seriesTitle, seasonNumber }) ?? title;

  const recommend = async (person: Recipient) => {
    if (sending) return;
    setSending(person.id);
    setError(null);
    /**
     * **One id per recipient, held only while the outcome is unknown.**
     *
     * Independent review 21i: `recommend_title` is keyed on (sender, recipient, title) so
     * it cannot store the same recommendation twice — but a replay with a *fresh* id
     * still spends a rate-limit slot and still moves `recommended_at`, which reorders
     * the recipient's list. Holding the id makes `_claim_operation` answer
     * `already_applied` instead, which is what that ledger is for.
     *
     * Released the moment the server answers **anything**, and that is not symmetry for
     * its own sake: a `refused` arrives as a 200 and **keeps its claim on purpose**
     * (`20260817001300` — a raise would roll the claim back and make refused attempts
     * free). Reusing a spent id would have the next attempt answered `already_applied`
     * and silently send nothing. So only `changed` — the outcome nobody established —
     * keeps it.
     */
    const held = sendIntents.current.get(person.id) ?? newOperationId();
    sendIntents.current.set(person.id, held);

    const result = await send.mutateAsync({
      operationId: held,
      recipientId: person.id,
      mediaItemId,
    });
    setSending(null);

    if (result.ok || !result.changed) sendIntents.current.delete(person.id);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    /**
     * `recommendation_sent`, and only from `ok`.
     *
     * `ok` here means the row is stored: the mutation has already separated the two
     * things a 200 can mean, since `recommend_title` returns `not_following` and its
     * siblings inside the body rather than raising them (`use-recommend.ts`). A refusal
     * and an unknown outcome both return early above and emit nothing — the unknown one
     * deliberately, because that is the send whose id is being *held* for a retry, and a
     * retry that eventually succeeds is the send this event should count once.
     */
    track({
      name: 'recommendation_sent',
      props: { media_kind: kind === 'season' ? 'tv_season' : 'movie', surface },
    });

    // The confirmation belongs to the screen underneath, which is still showing the
    // title this was about. A second one in here would be a message nobody sees,
    // because the sheet closes on the same tick.
    onSent(person.name);
    onClose();
  };

  const shareOffPlatform = async () => {
    if (sharing) return;
    setSharing(true);
    setError(null);

    // The invite link is the growth instrumentation and the title link is the point of
    // the share, so a link that could not be minted degrades to sharing the title
    // alone rather than failing the share.
    //
    // **One id for the share, held across the retries that degradation invites.** A
    // creation that commits and loses its reply returns null here, the share goes out
    // without the link, and pressing Share again is the natural next move — with a fresh
    // id that would record a second creation for one intent (`use-recommend.ts`).
    // `??=` is what makes the second attempt carry the first one's id.
    //
    // **Released when the link is minted, not when the share goes out**, because the row
    // being protected is the *creation*. A minted link means the creation is definitely
    // recorded and the next press is a new one; a null means it may or may not be, and
    // the next press has to be able to claim the same slot. Tying it to `Share.share`
    // instead would release the id on the very path this exists for — the share still
    // goes out, without the link, and that is the case Codex named.
    //
    // The ref lives with the sheet, so closing it and opening it again mints a fresh id.
    // That is deliberate: a person who has left the sheet and come back has made a second
    // decision, and the creation log should say two. What it must not count twice is one
    // decision the client told them had failed.
    const operationId = (shareIntent.current ??= newOperationId());
    const invite = await createInviteLink(mediaItemId, operationId, surface);
    if (invite) shareIntent.current = null;
    /**
     * One segment, and it used to be two.
     *
     * This built `/title/<kind>/<id>`, and **no route serves that** — not
     * `app/title/[id].tsx`, which matches a single segment, and not the web router. So
     * every off-platform title share sent a link that opened the app onto
     * `+not-found` for anybody who had it, and onto a 404 for anybody who did not.
     * The kind was never needed: `media_items.id` identifies a film or a season on its
     * own, and the screen reads the kind from the row.
     *
     * Not renamed to something shorter, deliberately. `/title/*` is already claimed in
     * the Apple App Site Association file and already sits inside links people have
     * been sent; the fix is the segment that was wrong, and nothing else.
     */
    const titleUrl = `https://bingd.app/title/${mediaItemId}`;
    const message = invite
      ? `${name} on bingd.\n${titleUrl}\n\nJoin me on bingd. ${invite}`
      : `${name} on bingd.\n${titleUrl}`;

    try {
      await Share.share({ message, url: titleUrl });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sharing failed.');
    } finally {
      setSharing(false);
    }
  };

  return (
    <Sheet visible onClose={onClose} label={`Recommend ${name}`}>
      <View style={styles.header}>
        <Text variant="headline" numberOfLines={2}>
          Recommend {name}
        </Text>
      </View>

      {recipients.isPending ? (
        <Text variant="footnote" tone="tertiary" style={styles.status}>
          Finding your people…
        </Text>
      ) : recipients.isError ? (
        <View style={styles.status}>
          <EmptyState
            kind="couldNotLoad"
            compact
            title="Could not load your friends"
            body="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => void recipients.refetch() }}
          />
        </View>
      ) : people.length === 0 ? (
        <View style={styles.status}>
          <EmptyState
            kind="nothingYet"
            compact
            title="Nobody to recommend to yet"
            // The rule, in the words it is now true in: follow people to send
            // recommendations. It no longer depends on anybody following back — that
            // decides where the recommendation lands, not whether it can be sent, and
            // the sender is deliberately not told which (`20260826000400`).
            body="Follow people to send recommendations. Send a friend the link below to get started."
          />
        </View>
      ) : (
        <>
          {people.length > SEARCH_THRESHOLD ? (
            <View style={styles.search}>
              <SearchField
                value={query}
                onChangeText={setQuery}
                onClear={() => setQuery('')}
                placeholder="Search your friends"
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
              />
            </View>
          ) : null}

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {shown.length === 0 ? (
              <Text variant="footnote" tone="tertiary" style={styles.status}>
                Nobody by that name.
              </Text>
            ) : (
              shown.map((person) => (
                <Pressable
                  key={person.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Recommend to ${person.name}, @${person.username}`}
                  disabled={Boolean(sending)}
                  onPress={() => void recommend(person)}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  <Avatar size="sm" uri={person.avatarUri} name={person.name} />
                  <View style={styles.copy}>
                    <Text variant="callout" numberOfLines={1}>
                      {person.name}
                    </Text>
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                      @{person.username}
                    </Text>
                  </View>
                  {sending === person.id ? (
                    <Text variant="caption" tone="secondary">
                      Sending…
                    </Text>
                  ) : (
                    <Ionicons
                      name="paper-plane-outline"
                      size={theme.layout.icon.md}
                      color={theme.semantic.action}
                    />
                  )}
                </Pressable>
              ))
            )}
          </ScrollView>
        </>
      )}

      {error ? (
        <Text variant="footnote" tone="action" style={styles.status}>
          {error}
        </Text>
      ) : null}

      {/* The off-Bingd path, which is the existing native share sheet carrying the
          reader's own invite link. Kept underneath the people rather than beside them:
          it is a different act, and putting it in the same list would make the person
          at the bottom of a short list look like an option called "someone".

          This is also where the title page’s Share button went. Three labelled chips
          did not fit an action row on a narrow Android screen, and of the three this
          was the one with somewhere else to be: everyone who opens Recommend is
          already in the act of passing a film to somebody, and whether that somebody
          has the app is a detail of the address, not a separate decision. The label is
          short for the same reason — it is a row in a sheet now, not a chip competing
          for width. */}
      <View style={styles.actions}>
        <Button
          label={sharing ? 'Opening…' : 'Share off bingd.'}
          kind="secondary"
          onPress={() => void shareOffPlatform()}
          disabled={sharing}
          disabledReason="Preparing your link."
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  search: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  // Bounded, so a long list of friends does not turn the sheet into a page.
  list: { maxHeight: 300 },
  listContent: { paddingHorizontal: theme.layout.gutter },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
  },
  copy: { flex: 1, gap: 2 },
  pressed: { opacity: 0.6 },
  status: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  actions: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[3] },
});
