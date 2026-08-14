import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { ScrollView, StyleSheet, View } from 'react-native';

import { env } from '@/lib/env';
import { Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** Privacy controls, blocking, notification preferences, account deletion, and
 *  the TMDB attribution notice required by §19. */
export default function SettingsScreen() {
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.page}>
        <Text variant="headline">Settings</Text>
        <Text tone="secondary">Privacy, notifications, and account controls are not built yet.</Text>

        <BuildDetails />
      </ScrollView>
    </Screen>
  );
}

/**
 * Which build, and which JavaScript inside it.
 *
 * Over-the-air updates make the second question real: two testers on the same APK can be
 * running different code, and "have you got the fix yet?" is otherwise unanswerable except
 * by describing symptoms. The update id answers it. It is also the only way to see an
 * update actually land — the app reloads on returning to the foreground, and without
 * something on screen that changes, a successful update is indistinguishable from nothing
 * having happened.
 *
 * Hidden in production, like the environment badge: a paying user has no use for a build
 * fingerprint, and PRD §23 keeps identifiers out of anything user-facing.
 */
function BuildDetails() {
  if (env.variant === 'production') return null;

  const rows: [string, string][] = [
    ['Variant', env.variant],
    ['Version', `${Constants.expoConfig?.version ?? '?'} (${Constants.expoConfig?.android?.versionCode ?? '—'})`],
    ['Channel', Updates.channel ?? 'none'],
    // The fingerprint of everything native. An update is only offered to builds whose
    // fingerprint matches, so when a tester stops receiving updates, this is why.
    ['Runtime', short(Updates.runtimeVersion)],
    ['Update', Updates.isEmbeddedLaunch ? 'embedded (no update yet)' : short(Updates.updateId)],
    ['Downloaded', Updates.createdAt?.toLocaleString() ?? '—'],
  ];

  return (
    <View style={styles.block}>
      <Text variant="subhead">Build</Text>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.row}>
          <Text tone="secondary" style={styles.rowLabel}>
            {label}
          </Text>
          <Text style={styles.rowValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

/** A full fingerprint is 40 characters and unreadable aloud; the first eight identify it. */
function short(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 8 ? value.slice(0, 8) : value;
}

const styles = StyleSheet.create({
  page: {
    padding: theme.layout.gutter,
    gap: theme.space[3],
  },
  block: {
    marginTop: theme.space[6],
    gap: theme.space[2],
    padding: theme.space[4],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: theme.space[4],
  },
  rowLabel: { flexShrink: 0 },
  rowValue: { flexShrink: 1, textAlign: 'right' },
});
