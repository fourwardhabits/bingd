import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Stack, useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { pendingRequestCount, useNotifications } from '@/features/notifications/use-notifications';
import { env } from '@/lib/env';
import { Button, Screen, SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Settings, as an information architecture rather than a single scroll.
 *
 * What this replaced was one sentence — "Privacy, notifications, and account controls
 * are not built yet" — above an avatar picker and the TMDB notice. It was accurate,
 * which is why it survived: nothing in the database could be reached from here.
 *
 * The five destinations are the five questions somebody opens Settings to answer:
 * *who am I here* (Edit Profile), *who can see me* (Privacy), *who is waiting on me*
 * (Notifications), *how do I leave* (Account & Data), and *what is this built on*
 * (About). There is no sixth for the sake of symmetry and there are no placeholders:
 * every row leads to controls with real backend semantics behind them.
 *
 * The pending-request count is the one number on this screen. It is the only thing in
 * the app that is genuinely waiting on the reader — a reaction is news, a request is a
 * task — and before Phase F a private account could receive them with nowhere to see
 * them, which made the private setting a way to become unreachable rather than a
 * choice.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const notifications = useNotifications(profile.id);
  const pending = pendingRequestCount(notifications.data);

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
        <View style={styles.group}>
          <Row
            icon="person-outline"
            label="Edit Profile"
            detail={`@${profile.username}`}
            onPress={() => router.push('/settings/profile')}
          />
          <Row
            icon="lock-closed-outline"
            label="Privacy"
            onPress={() => router.push('/settings/privacy')}
          />
          <Row
            icon="notifications-outline"
            label="Notifications"
            detail={pending ? `${pending} waiting` : undefined}
            emphasis={pending > 0}
            onPress={() => router.push('/settings/notifications')}
          />
          <Row
            icon="shield-outline"
            label="Account & Data"
            onPress={() => router.push('/settings/account')}
            last
          />
        </View>

        <About />
        <BuildDetails />
      </ScrollView>
    </Screen>
  );
}

/**
 * One destination in the list.
 *
 * A chevron rather than a button, because these navigate rather than act — the
 * distinction matters most on Account & Data, where the destructive thing is one
 * screen further on and should not be reachable by a mistap from here.
 */
function Row({
  icon,
  label,
  detail,
  emphasis = false,
  last = false,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  detail?: string;
  emphasis?: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.rowDivided, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={theme.layout.icon.md} color={theme.semantic.action} />
      <Text variant="body" style={styles.rowLabel}>
        {label}
      </Text>
      {detail ? (
        <Text variant="footnote" tone={emphasis ? 'action' : 'secondary'}>
          {detail}
        </Text>
      ) : null}
      <Ionicons
        name="chevron-forward"
        size={theme.layout.icon.sm}
        color={theme.text.tertiary}
      />
    </Pressable>
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
 * is on the title screen and now on the person screen too; artwork is served from
 * TMDB's CDN and never rehosted (`src/lib/images.ts`). Still owed is the approved TMDB
 * logo, which has to be unmodified in colour and aspect and less prominent than
 * Bingd's own mark — it arrives with the brand asset pass rather than being
 * approximated here, because a redrawn logo would breach the same terms this section
 * exists to satisfy.
 */
function About() {
  const openAttribution = () => {
    void Linking.openURL('https://www.themoviedb.org/about/logos-attribution');
  };

  return (
    <View style={styles.block}>
      <SectionHeader title="About" />
      <View style={styles.blockBody}>
        <Text tone="secondary">
          This product uses the TMDB API but is not endorsed or certified by TMDB.
        </Text>
        <Pressable
          onPress={openAttribution}
          accessibilityRole="link"
          accessibilityLabel="TMDB attribution and logo guidelines"
          hitSlop={theme.space[2]}
        >
          <Text tone="action">themoviedb.org</Text>
        </Pressable>
        <Text variant="caption" tone="tertiary">
          Reviews shown on a title are written by TMDB members, not by Bingd users.
        </Text>
      </View>
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
      <SectionHeader title="Build" />
      <View style={styles.blockBody}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.detailRow}>
            <Text tone="secondary" style={styles.detailLabel}>
              {label}
            </Text>
            <Text style={styles.detailValue}>{value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A full fingerprint is 40 characters and unreadable aloud; the first eight identify it. */
function short(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 8 ? value.slice(0, 8) : value;
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  group: {
    marginTop: theme.space[3],
    marginHorizontal: theme.layout.gutter,
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
  },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  rowLabel: { flex: 1 },
  block: { marginTop: theme.space[6], gap: theme.space[1] },
  blockBody: {
    marginHorizontal: theme.layout.gutter,
    gap: theme.space[2],
    padding: theme.space[4],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: theme.space[4],
  },
  detailLabel: { flexShrink: 0 },
  detailValue: { flexShrink: 1, textAlign: 'right' },
  pressed: { opacity: 0.7 },
});
