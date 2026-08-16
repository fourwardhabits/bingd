import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Stack, useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AvatarPicker } from '@/features/profile/AvatarPicker';
import { env } from '@/lib/env';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** Privacy controls, blocking, notification preferences, account deletion, and
 *  the TMDB attribution notice required by §19. */
export default function SettingsScreen() {
  const router = useRouter();

  return (
    <Screen includeBottomInset>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Settings',
          headerRight: () => <Button label="Close" kind="tertiary" onPress={() => router.back()} />,
        }}
      />
      <ScrollView contentContainerStyle={styles.page}>
        <AvatarPicker />

        <Text tone="secondary">Privacy, notifications, and account controls are not built yet.</Text>

        <About />
        <BuildDetails />
      </ScrollView>
    </Screen>
  );
}

/**
 * The attribution TMDB's terms require, quoted exactly.
 *
 * Their FAQ asks for this notice placed prominently, in an About or Credits section,
 * and for the wording not to be paraphrased — so the sentence below is theirs and
 * should not be edited for tone. `docs/reference/tmdb-integration.md` records why
 * this ships now rather than with the commercial plan: it is cheap in an empty
 * settings screen and expensive to retrofit across a shipped app.
 *
 * Two obligations are met elsewhere and one is still owed. The per-title source line
 * is on the title screen; artwork is served from TMDB's CDN and never rehosted
 * (`src/lib/images.ts`). Still owed is the approved TMDB logo, which has to be
 * unmodified in colour and aspect and less prominent than Bingd's own mark — it
 * arrives with the brand asset pass rather than being approximated here, because a
 * redrawn logo would breach the same terms this section exists to satisfy.
 */
function About() {
  const openAttribution = () => {
    void Linking.openURL('https://www.themoviedb.org/about/logos-attribution');
  };

  return (
    <View style={styles.block}>
      <Text variant="subhead">About</Text>
      <Text tone="secondary">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </Text>
      <Pressable
        onPress={openAttribution}
        accessibilityRole="link"
        accessibilityLabel="TMDB attribution and logo guidelines"
      >
        <Text tone="action">themoviedb.org</Text>
      </Pressable>
    </View>
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
