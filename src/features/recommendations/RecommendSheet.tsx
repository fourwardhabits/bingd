import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

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
 * The people offered are mutual follows, which is what the server accepts. If somebody
 * is refused anyway the relationship changed while the sheet was open, and the message
 * says so rather than reporting a code.
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
}: RecommendSheetProps) {
  const recipients = useRecommendRecipients(viewerId);
  const send = useRecommendTitle(viewerId);

  const [query, setQuery] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const people = recipients.data ?? [];
  const shown = filterRecipients(people, query);
  const name = compactName({ kind, title, seriesTitle, seasonNumber }) ?? title;

  const recommend = async (person: Recipient) => {
    if (sending) return;
    setSending(person.id);
    setError(null);
    const result = await send.mutateAsync({ recipientId: person.id, mediaItemId });
    setSending(null);

    if (!result.ok) {
      setError(result.message);
      return;
    }
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
    const invite = await createInviteLink(mediaItemId);
    const titleUrl = `https://bingd.app/title/${kind}/${mediaItemId}`;
    const message = invite
      ? `${name} on Bingd\n${titleUrl}\n\nJoin me on Bingd: ${invite}`
      : `${name} on Bingd\n${titleUrl}`;

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
            body="You can recommend to anyone who follows you back. Send a friend the link below to get started."
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
          label={sharing ? 'Opening…' : 'Share off Bingd'}
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
