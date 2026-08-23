import { useQuery } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { newOperationId } from '@/features/collection/writes';
import { revokeInviteLink } from '@/features/invite';
import { useMyBlocks, useSocialWrites } from '@/features/profile/use-social';
import { useAccountWrites } from '@/features/settings/use-account';
import { supabase } from '@/lib/supabase';
import { EmptyState, Screen, SectionHeader, Text, UserRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Privacy.
 *
 * Three controls, each of which already had complete backend semantics and no way to
 * reach them. Nothing on this screen is a switch that does nothing, which was the
 * founder's explicit bar: `profiles.visibility` decides whether a follow is approved
 * or pending, and whether `can_view_profile` admits a stranger to the feed, the notes,
 * the rankings and the scores.
 *
 * **It no longer decides whether the account can be found.** `search_users` and
 * `profile_identity` moved to `can_discover_profile` on 2026-08-19, which reads
 * `status` and blocks and ignores `visibility` entirely — so a private account is
 * findable by handle or display name and discloses five identity columns, and nothing
 * else. This comment used to say the opposite, and so did the copy under the switch.
 *
 * Every account is public today because that is the column default rather than because
 * anybody chose it, which is why signup now says so out loud.
 *
 * The blocked list is here because blocking closes the door behind itself. Independent
 * review 12 found it: `can_view_profile` goes false in both directions, so a blocked
 * account leaves `public_profiles` and search *for the person who blocked them too*,
 * and the Unblock control lived on the profile that had just vanished. `my_blocks` is
 * definer for exactly that reason, and until this screen existed the only way to reach
 * it was to guess the handle.
 *
 * The copy under the switch says what the setting does in the terms it actually
 * operates in — who can find you, who can see what you have watched — rather than
 * "make my profile private", which is a label that describes itself.
 */
export default function PrivacyScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const { setVisibility, busy } = useAccountWrites();
  const blocks = useMyBlocks(profile.id);
  const { unblock, busy: unblocking } = useSocialWrites(profile.id, 'profile');

  /**
   * Read from `profiles` rather than from the session profile.
   *
   * The session's copy is refreshed on sign-in and by its own invalidation, and this
   * switch has to reflect the row it is about to write. A control showing the wrong
   * state for a second is the one thing a privacy switch may not do.
   */
  const visibility = useQuery({
    queryKey: ['profile', profile.id, 'visibility'],
    queryFn: async (): Promise<'public' | 'private'> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('visibility')
        .eq('id', profile.id)
        .single();
      if (error) throw error;
      return data.visibility as 'public' | 'private';
    },
  });

  /**
   * Only ever a value that has been read.
   *
   * `visibility.data === 'private'` looked right and was not: while the query is in
   * flight it is `undefined`, which reads as false and draws the switch in the public
   * position — a privacy control showing a state nobody has confirmed. Worse after an
   * error, where the switch was left *enabled* and still showing public, so a tap
   * could set the account to the value it was already displaying as if that were a
   * change. Independent review 14 found both.
   *
   * Now the row says it does not know, and the switch is unavailable until it does.
   */
  const known = visibility.data;
  const isPrivate = known === 'private';
  const unavailable = visibility.isPending || visibility.isError || known === undefined;

  const toggle = async (next: boolean) => {
    const target = next ? 'private' : 'public';

    // Going public approves everybody waiting, which is a change to other people's
    // access and should not happen behind a switch without being said first.
    if (!next) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Make your profile public?',
          'Anyone can follow you without asking, and anybody still waiting for approval will be able to see your activity straight away.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Make public', onPress: () => resolve(true) },
          ],
        );
      });
      if (!confirmed) return;
    }

    const result = await setVisibility(target);
    if (!result.ok) {
      Alert.alert('Could not change your privacy setting', result.message);
      return;
    }
    await visibility.refetch();
  };

  /**
   * One operation id per *decision*, held across the retries a failure invites.
   *
   * The rule `lib/operation-intent.ts` states, and it matters more here than most
   * places: a revocation that commits and loses its reply has already rotated the link,
   * and a retry carrying a fresh id would rotate it a **second** time — detaching
   * everybody who was given the one in between. The held id is answered
   * `already_applied` instead, with the link that is live now.
   */
  const replaceIntent = useRef<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  const replaceLink = async () => {
    if (replacing) return;
    setReplacing(true);
    try {
      const operationId = (replaceIntent.current ??= newOperationId());
      const result = await revokeInviteLink(operationId);
      if (result.outcome === 'failed') {
        Alert.alert('Could not replace your link', result.message);
        // Held only when the outcome was never established, so the retry is recognised
        // as the same decision rather than as a second rotation.
        if (!result.changed) replaceIntent.current = null;
        return;
      }
      replaceIntent.current = null;
      Alert.alert(
        'Your invite link has been replaced',
        'The old link no longer works. Share the new one from anywhere you would normally invite somebody.',
      );
    } finally {
      setReplacing(false);
    }
  };

  const confirmReplaceLink = () =>
    Alert.alert(
      'Replace your invite link?',
      'Anybody still holding the old link will not be able to use it, and there is no way to bring it back. People who already joined on it stay attributed to you.',
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: () => void replaceLink() },
      ],
    );

  return (
    <Screen includeBottomInset>
      <Stack.Screen options={{ headerShown: true, title: 'Privacy', headerBackTitle: 'Back' }} />

      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.section}>
          <SectionHeader title="Who can see you" />
          <View style={styles.card}>
            <View style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <Text variant="body">Private account</Text>
                <Text variant="footnote" tone="secondary">
                  {unavailable
                    ? visibility.isError
                      ? 'We could not read your current setting.'
                      : 'Checking your current setting…'
                    : isPrivate
                      ? 'People have to ask before they can follow you.'
                      : 'Anyone can follow you and see your activity.'}
                </Text>
              </View>
              <Switch
                value={isPrivate}
                onValueChange={(next) => void toggle(next)}
                disabled={busy || unavailable}
                accessibilityLabel="Private account"
                accessibilityState={{ disabled: busy || unavailable }}
                accessibilityHint={
                  unavailable
                    ? 'Unavailable until your current setting has been read'
                    : isPrivate
                      ? 'Turn off to let anyone follow you without asking'
                      : 'Turn on to approve followers yourself'
                }
                trackColor={{ true: theme.semantic.action, false: theme.border.strong }}
              />
            </View>

            {visibility.isError ? (
              <View style={styles.explain}>
                <Text
                  variant="callout"
                  tone="action"
                  accessibilityRole="button"
                  accessibilityLabel="Try reading your privacy setting again"
                  onPress={() => void visibility.refetch()}
                >
                  Try again
                </Text>
              </View>
            ) : null}

            {/* **Private hides what you have, not who you are.**
                This block used to say a private profile "does not appear in search",
                and that stopped being true on 2026-08-19, when `search_users` moved
                to `can_discover_profile` so that somebody can be found and asked to
                follow without any of their content being readable. A privacy screen
                that overstates the protection is worse than one that says nothing:
                it is the sentence somebody decides what to write against.

                Branching on `known` rather than on `isPrivate`, because `isPrivate`
                is false while the read is still in flight, and describing the wrong
                setting to somebody reading a privacy screen is the whole defect the
                switch above already guards against. */}
            <View style={styles.explain}>
              {known === 'private' ? (
                <Text variant="caption" tone="tertiary">
                  People can still find you by name or @handle and ask to follow — being
                  private hides what you have, not who you are. Until you approve
                  somebody, your ranked titles, watchlist, reviews and activity stay
                  hidden. People you already approved stay approved; remove them from
                  your followers if you want them gone.
                </Text>
              ) : null}
              {known === 'public' ? (
                <Text variant="caption" tone="tertiary">
                  Anyone on Bingd can see your ranked titles and their scores, your
                  watchlist and your activity, along with any note you have shared as a
                  review.
                </Text>
              ) : null}
              <Text variant="caption" tone="tertiary">
                Your watch dates are never shown to anybody, and a note stays yours
                alone unless you share it as a review. That is true on both settings.
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Blocked accounts" />
          {blocks.isPending ? null : blocks.data?.length ? (
            <>
              {blocks.data.map((account) => (
                <UserRow
                  key={account.id}
                  name={account.name}
                  username={account.username}
                  avatarUri={account.avatarUri}
                  relationship={unblocking ? 'Unblocking…' : 'Blocked'}
                  onPress={() =>
                    Alert.alert(
                      `Unblock @${account.username}?`,
                      'You will be able to see each other again. Any follow between you was removed when you blocked them, and unblocking does not restore it.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Unblock',
                          onPress: () =>
                            void (async () => {
                              const result = await unblock({ userId: account.id });
                              if (!result.ok) Alert.alert('Could not unblock', result.message);
                            })(),
                        },
                      ],
                    )
                  }
                />
              ))}
              <View style={styles.explain}>
                <Text variant="caption" tone="tertiary">
                  Blocked accounts cannot see you and you cannot see them. This list is
                  the only place they appear.
                </Text>
              </View>
            </>
          ) : (
            <EmptyState
              kind="nothingYet"
              compact
              title="Nobody blocked"
              body="You can block somebody from their profile."
            />
          )}
        </View>

        {/**
         * The safety valve for a link that has gone somewhere it should not.
         *
         * A personal invite link is reusable, never expires and is meant to be pasted
         * into group chats — so the one thing it needs and did not have is a way to
         * take it back. PRD §17's token model has promised "revoke and regenerate from
         * Settings" since v0.6; `invite_tokens.revoked_at` has existed since
         * 20260813001300 with no writer, and independent review 26 found the gap at
         * the moment it started to matter, because 20260819000500 is what made a
         * leaked link worth anything.
         *
         * Confirmed, and the confirmation names the cost rather than asking "are you
         * sure": replacing the link detaches everybody who already holds it, and that
         * is not recoverable. Same rule as blocking (api.md §3).
         */}
        <View style={styles.section}>
          <SectionHeader title="Your invite link" />
          <View style={styles.explain}>
            <Text variant="caption" tone="tertiary">
              Your personal invite link never expires and anybody can use it. Replace it
              if it has ended up somewhere you did not intend — the old link stops
              working, and people who already joined on it stay attributed to you.
            </Text>
          </View>
          <View style={styles.explain}>
            <Text
              variant="callout"
              tone="action"
              onPress={confirmReplaceLink}
              accessibilityRole="button"
              accessibilityLabel="Replace your invite link"
            >
              {replacing ? 'Replacing…' : 'Replace my invite link'}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Your profile" />
          <View style={styles.explain}>
            <Text variant="caption" tone="tertiary">
              Your public page is bingd.app/u/{profile.username}. Open it to see what a
              visitor sees.
            </Text>
          </View>
          <View style={styles.explain}>
            <Text
              variant="callout"
              tone="action"
              onPress={() => router.push(`/u/${profile.username}`)}
              accessibilityRole="button"
              accessibilityLabel="Open your public profile"
            >
              View your public profile
            </Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[5], gap: theme.space[1] },
  card: {
    marginHorizontal: theme.layout.gutter,
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
    paddingVertical: theme.space[2],
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    minHeight: theme.layout.rowMinHeight,
    paddingHorizontal: theme.space[4],
  },
  switchCopy: { flex: 1, gap: 2 },
  explain: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    gap: theme.space[2],
  },
});
