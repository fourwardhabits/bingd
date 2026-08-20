import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Stack, useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { signOut, useCurrentProfile } from '@/features/auth';
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
 * The destinations are the questions somebody opens Settings to answer: *who am I
 * here* (Edit Profile), *who can see me* (Privacy), *who is waiting on me*
 * (Notifications), *what should reach me at all* (Notification Settings), *how do I
 * leave* (Account & Data), and *what is this built on* (About). There is none added
 * for the sake of symmetry and there are no placeholders: every row leads to controls
 * with real backend semantics behind them.
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

  const leave = async () => {
    await signOut();
    // Replaced rather than pushed, so Settings is not behind a back gesture on a
    // session that no longer exists.
    router.replace('/');
  };

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
          {/* Its own row rather than a control inside the inbox alone. The two are
              different questions — "who is waiting on me" and "what should reach me
              at all" — and the second is the one somebody comes to Settings for. */}
          <Row
            icon="options-outline"
            label="Notification Settings"
            onPress={() => router.push('/settings/notification-preferences')}
          />
          <Row
            icon="shield-outline"
            label="Account & Data"
            onPress={() => router.push('/settings/account')}
            last
          />
        </View>

        {/* Its own group, one gap below the rest.
            The founder's correction: signing out was inside Account & Data, beside
            permanent deletion, and the two are not the same kind of thing at all — one
            is how you finish for the day and the other cannot be undone. Separating
            them visually says that without dressing sign-out up as destructive, which
            it also is not. */}
        <View style={styles.group}>
          <Row icon="log-out-outline" label="Sign out" onPress={() => void leave()} last />
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
 * The line under the link changed on 2026-08-17. It used to explain that reviews on a
 * title were TMDB members' rather than Bingd users', which was true then and is the
 * opposite of true now: the Reviews tab is Bingd's own public Notes and TMDB's left the
 * app entirely. It now says which half of a title page is theirs, which is the thing a
 * reader would actually wonder.
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
          Artwork, cast and title details come from TMDB. Reviews and scores are Bingd
          users&apos; own.
        </Text>
      </View>
    </View>
  );
}

/**
 * The version, for somebody reporting a problem.
 *
 * **What this replaced put six rows of release identity in front of every user**:
 * runtime fingerprint, update id, channel, download time, the environment badge. All
 * of it genuinely useful — the update id is the only way to answer "have you got the
 * fix yet?" without describing symptoms — and none of it anything a person opening
 * Settings has a use for. The founder's correction is that a normal reader gets a
 * version and a build number, which is what a support conversation actually starts
 * with.
 *
 * The rest is not deleted, it is moved: `env.variant !== 'production'` still gates the
 * detailed block, so a preview build carries the diagnostics for Beta Hardening and a
 * release build shows one line. That is the same rule as before with the *default*
 * inverted — it used to show everything outside production, and now it shows the line
 * everywhere and the detail only where somebody is testing.
 */
function BuildDetails() {
  const version = Constants.expoConfig?.version ?? '?';

  /**
   * **The build number is read from the installed binary, not from the config.**
   *
   * This line used to say `Constants.expoConfig?.android?.versionCode`, and it was
   * wrong twice over. `app.config.ts` sets no `versionCode` at all — `appVersionSource`
   * is `remote`, so the number is assigned by EAS at build time and lives on EAS's
   * servers — and even where a value did appear, the key is the *Android* one, so every
   * iPhone in the beta showed `Bingd 0.1.0 (—)`. The one screen whose job is to let a
   * tester tell a support conversation which build they are on could not name it on
   * half the fleet.
   *
   * `Application.nativeBuildVersion` is `versionCode` on Android and `CFBundleVersion`
   * on iOS, read out of the package that is actually installed. It is the same source
   * `lib/release.ts` uses for the `build_number` on every analytics event and every
   * Sentry report, so what a tester reads aloud matches what the dashboards say.
   */
  const build = Application.nativeBuildVersion ?? '—';

  return (
    <View style={styles.block}>
      <View style={styles.blockBody}>
        <Text variant="caption" tone="tertiary">
          Bingd {version} ({build})
        </Text>

        {/* Only where somebody is testing. PRD §23 keeps identifiers out of anything
            user-facing, and a fingerprint is an identifier. */}
        {env.variant !== 'production' ? (
          <>
            <Text variant="caption" tone="tertiary">
              {env.variant} · {Updates.channel ?? 'no channel'}
            </Text>
            <Text variant="caption" tone="tertiary">
              runtime {short(Updates.runtimeVersion)} ·{' '}
              {Updates.isEmbeddedLaunch ? 'embedded' : `update ${short(Updates.updateId)}`}
            </Text>
            {/* Which backend this build is talking to.

                Not a secret — the project ref is the hostname the app connects to and is
                in the bundle already — and it is the one fact that cannot be inferred
                from anything else on this screen. A Preview build pointed at the wrong
                Supabase project looks identical to a right one: it signs in, and the
                collection is simply empty. `app.config.ts` refuses to build against a
                project that is not on its allowlist, and this is how the founder
                confirms which one it chose without opening a dashboard. */}
            <Text variant="caption" tone="tertiary">
              backend {backendRef(env.supabaseUrl)}
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

/** `https://abheeqyjzekiowkztfxv.supabase.co` reads as `abheeqyjzekiowkztfxv`. */
function backendRef(url: string) {
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return '—';
  }
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
  pressed: { opacity: 0.7 },
});
