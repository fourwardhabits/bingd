import { Stack } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import {
  masterOn,
  SECTIONS,
  useNotificationPreferenceWrites,
  useNotificationPreferences,
  type NotificationCategory,
  type NotificationSection,
} from '@/features/notifications/use-notification-preferences';
import { EmptyState, Screen, SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Which notifications you get.
 *
 * `notification_preferences` has existed since 20260813000900 and **nothing on the
 * client has ever read or written it**. Phase F declined to build this screen for a
 * good reason — at the time the table was consulted by nothing, and a switch that
 * changes nothing is worse than no switch. `20260817000800` made the table real by
 * putting a gate on `notifications`, and `20260819000300` gave it one category per
 * kind. Every switch here now changes what the database will write.
 *
 * **What a switch governs is creation, not delivery.** Turning something off means the
 * inbox row is never written — the trigger drops it before the insert. It is not
 * retroactive: rows already in the inbox stay. There is no second channel to reason
 * about, because push is dark (AD-10) and nothing on any client writes a device token.
 *
 * **The masters are derived, not stored.** A section's master reads as on when any
 * child under it is on, so "master off" means exactly "every child off" rather than
 * approximately that. Tapping it writes every child in the section in one
 * transaction. There is no third state to keep in step and no way for a master to
 * disagree with what is beneath it.
 */
export default function NotificationPreferencesScreen() {
  const profile = useCurrentProfile();
  const preferences = useNotificationPreferences(profile.id);
  const { setPreference, setSection, busy } = useNotificationPreferenceWrites(profile.id);

  /**
   * Only ever a value that has been read.
   *
   * The same rule the privacy switch had to learn twice: while the query is in flight
   * the answer is `undefined`, which reads as false and draws every switch in the off
   * position — a settings screen asserting a state nobody has confirmed. Independent
   * review 14 found that there; it is the same defect here, and two of these
   * categories genuinely default off, so a wrong render is indistinguishable from a
   * right one.
   */
  const prefs = preferences.data;
  const unavailable = preferences.isPending || preferences.isError || prefs === undefined;

  const toggleOne = async (category: NotificationCategory, next: boolean) => {
    const result = await setPreference(category, next);
    if (!result.ok) Alert.alert('Could not change that setting', result.message);
  };

  const toggleSection = async (section: NotificationSection, next: boolean) => {
    const result = await setSection(section, next);
    if (!result.ok) Alert.alert('Could not change those settings', result.message);
  };

  return (
    <Screen includeBottomInset>
      {/* Not "Notifications": that is the inbox, one screen away, and two titles the
          same is how somebody ends up unable to say which one they are looking at. */}
      <Stack.Screen
        options={{ headerShown: true, title: 'Notification Settings', headerBackTitle: 'Back' }}
      />

      {preferences.isError ? (
        <EmptyState
          kind="couldNotLoad"
          title="Could not load your notification settings"
          body="Check your connection and try again."
          action={{ label: 'Try again', onPress: () => void preferences.refetch() }}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.intro}>
            <Text variant="caption" tone="tertiary">
              Turning something off stops it reaching your inbox from now on. Anything
              already there stays.
            </Text>
          </View>

          {SECTIONS.map((section) => {
            const on = masterOn(section, prefs);

            return (
              <View key={section.key} style={styles.section}>
                <SectionHeader title={section.title} />

                <View style={styles.card}>
                  {/* The master, above a divider rather than beside the children, so
                      it reads as governing them rather than as one more of them. */}
                  <Row
                    label={section.masterLabel}
                    description={
                      on
                        ? 'Everything in this section is on, or some of it.'
                        : 'Everything in this section is off.'
                    }
                    value={on}
                    disabled={busy || unavailable}
                    unavailable={unavailable}
                    emphasis
                    onValueChange={(next) => void toggleSection(section, next)}
                  />

                  <View style={styles.divider} />

                  {section.settings.map((setting) => (
                    <Row
                      key={setting.key}
                      label={setting.label}
                      description={setting.description}
                      pending={setting.pending}
                      value={prefs ? prefs[setting.key] : false}
                      disabled={busy || unavailable}
                      unavailable={unavailable}
                      onValueChange={(next) => void toggleOne(setting.key, next)}
                    />
                  ))}
                </View>

                {section.footnote ? (
                  <View style={styles.explain}>
                    <Text variant="caption" tone="tertiary">
                      {section.footnote}
                    </Text>
                  </View>
                ) : null}
              </View>
            );
          })}

          {/* Said once, at the bottom, rather than under each of the two rows it
              applies to. Both are real settings over real categories — the gate
              honours them the moment anything writes one — and neither has a writer
              today: the invite resolver is not built, and award notifications are
              deferred until a tier crossing is something the server records rather
              than something a device believes. */}
          <View style={styles.explain}>
            <Text variant="caption" tone="tertiary">
              Invite and Award notifications are not being sent yet. Your choice here is
              saved and will be honoured when they start.
            </Text>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

/**
 * One switch and the sentence that says what it does.
 *
 * The description is what the event *is*, not what the switch is called — "somebody
 * reacts to something you logged" rather than "reaction notifications", which is a
 * label describing itself. Same rule the privacy copy follows.
 */
function Row({
  label,
  description,
  value,
  disabled,
  unavailable,
  emphasis = false,
  pending = false,
  onValueChange,
}: {
  label: string;
  description: string;
  value: boolean;
  disabled: boolean;
  unavailable: boolean;
  emphasis?: boolean;
  pending?: boolean;
  onValueChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchCopy}>
        <Text variant={emphasis ? 'callout' : 'body'}>{label}</Text>
        <Text variant="footnote" tone="secondary">
          {unavailable ? 'Checking your current setting…' : description}
        </Text>
        {pending && !unavailable ? (
          <Text variant="caption" tone="tertiary">
            Not being sent yet.
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        accessibilityHint={
          unavailable
            ? 'Unavailable until your current settings have been read'
            : value
              ? `Turn off to stop these reaching your inbox`
              : `Turn on to let these reach your inbox`
        }
        trackColor={{ true: theme.semantic.action, false: theme.border.strong }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  intro: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  section: { paddingTop: theme.space[5], gap: theme.space[1] },
  card: {
    marginHorizontal: theme.layout.gutter,
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
    paddingVertical: theme.space[2],
  },
  divider: {
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.border.hairline,
    marginVertical: theme.space[2],
    marginHorizontal: theme.space[4],
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    minHeight: theme.layout.rowMinHeight,
    paddingHorizontal: theme.space[4],
  },
  switchCopy: { flex: 1, gap: 2 },
  explain: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
});
