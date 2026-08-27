import { Ionicons } from '@expo/vector-icons';
import { DiagnosticsSheet } from '@/features/diagnostics/DiagnosticsSheet';
import { copyDiagnostics } from '@/features/diagnostics/copy';
import { buildDiagnosticsReport } from '@/features/diagnostics/report';
import * as Application from 'expo-application';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { signOut, useCurrentProfile } from '@/features/auth';
import { env, isRelease, lane } from '@/lib/env';
import { openLegal } from '@/lib/legal';
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
 * here* (Edit Profile), *who can see me* (Privacy), *what should reach me at all*
 * (Notification settings), *how do I leave* (Account & Data), and *what is this built
 * on* (About). There is none added for the sake of symmetry and there are no
 * placeholders: every row leads to controls with real backend semantics behind them.
 *
 * **The inbox is not one of the destinations, since the founder's Preview pass.** It
 * was, and it was redundant: the bell in the Feed and Profile headers opens the same
 * inbox from the screens somebody is on when they wonder who reacted, and it carries
 * the unread count — follow requests included. A second door three taps deep inside
 * Settings made one inbox read as two features. The bell, the inbox and the
 * preferences screen are all unchanged; only the duplicate route is gone.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();

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
          headerRight: () => (
            <Button label="Close" kind="tertiary" onPress={() => router.back()} />
          ),
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
          {/* **The inbox is not reachable from here, and that is the founder's
              Preview correction.** There was a Notifications row above this one going
              to `/settings/notifications`, and it was a second door to a room with a
              door already: the bell in the Feed and Profile headers opens the same
              inbox, from the screens somebody is actually on when they wonder who
              reacted. Two entry points to one inbox, one of them three taps deep inside
              Settings, made the pair read as two different features.

              The inbox itself, the bell, and this screen are all untouched. What is
              gone is the redundant route to it.

              This row stays, because it answers a different question. "Who is waiting
              on me" is the inbox; "what should reach me at all" is this, and the second
              is the one somebody opens Settings for. */}
          <Row
            icon="notifications-outline"
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
        {/* Privacy, Terms and Support, in that order.

            **Links out rather than screens**, which is `lib/legal.ts`'s reasoning: a
            policy rendered in the binary can only be corrected by shipping a build,
            and until that build reaches everybody two versions of the same document
            are live at once. The web copies are canonical, both stores already require
            a URL for the privacy policy, and one template generates all three.

            Here rather than inside About, because About is an attribution block —
            TMDB's notice, quoted in their words — and a legal document is not a
            credit. And above Sign out's group rather than below it, because a person
            looking for the Terms is reading the list, while somebody signing out is
            aiming at a row they already know the position of. */}
        <View style={styles.group}>
          <Row
            icon="lock-closed-outline"
            label="Privacy Policy"
            onPress={() => openLegal('privacy')}
            external
          />
          <Row
            icon="document-text-outline"
            label="Terms of Use"
            onPress={() => openLegal('terms')}
            external
          />
          <Row
            icon="help-circle-outline"
            label="Support"
            onPress={() => openLegal('support')}
            external
            last
          />
        </View>

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
  last = false,
  external = false,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  detail?: string;
  last?: boolean;
  /**
   * The row leaves the app for the browser. Changes the role to `link` and the
   * trailing glyph from a chevron to an open-outward mark, because "this navigates
   * within Settings" and "this closes Settings and opens Safari" are different
   * promises and the chevron only makes the first one.
   */
  external?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={external ? 'Opens in your browser' : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !last && styles.rowDivided,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={theme.layout.icon.md} color={theme.semantic.action} />
      <Text variant="body" style={styles.rowLabel}>
        {label}
      </Text>
      {detail ? (
        <Text variant="footnote" tone="secondary">
          {detail}
        </Text>
      ) : null}
      <Ionicons
        name={external ? 'open-outline' : 'chevron-forward'}
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
 * Two obligations are met elsewhere. The per-title source line is on the title screen
 * and the person screen; artwork is served from TMDB's CDN and never rehosted
 * (`src/lib/images.ts`). The logo below is TMDB's own file — the primary short (blue)
 * SVG from themoviedb.org/about/logos-attribution, committed byte-for-byte — because
 * their terms permit only approved, unmodified marks. Its rendered size keeps the
 * source aspect (190.24:81.52) and stays smaller than Bingd's own mark, which the same
 * terms require.
 */
const TMDB_LOGO = require('../../assets/brand/tmdb-logo.svg');

function About() {
  const openAttribution = () => {
    void Linking.openURL('https://www.themoviedb.org');
  };

  return (
    <View style={styles.block}>
      <SectionHeader title="About" />
      <View style={styles.blockBody}>
        <Image
          source={TMDB_LOGO}
          style={styles.tmdbLogo}
          contentFit="contain"
          accessible
          accessibilityLabel="TMDB"
        />
        <Text tone="secondary">
          This product uses the TMDB API but is not endorsed or certified by TMDB.
        </Text>
        <Pressable
          onPress={openAttribution}
          accessibilityRole="link"
          accessibilityLabel="TMDB website"
          hitSlop={theme.space[2]}
        >
          <Text tone="action">themoviedb.org</Text>
        </Pressable>
        <Text variant="caption" tone="tertiary">
          Artwork, cast and title details come from TMDB. Reviews and scores are bingd.
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
 * The rest is not deleted, it is moved: `isRelease` gates the detailed block, so every
 * build somebody is testing carries the diagnostics for Beta Hardening and a release
 * build shows one line. That is the same rule as before with the *default* inverted — it
 * used to show everything outside production, and now it shows the line everywhere and
 * the detail only where somebody is testing.
 *
 * The gate was `env.variant !== 'production'` until review 28, and that was wrong for the
 * one lane it mattered most in. Beta builds the production variant, so a friend beta —
 * production identity, nonproduction database — showed nothing but the version line.
 */
function BuildDetails() {
  /**
   * Owned here rather than by a shared signal, and rendered here rather than at the root.
   *
   * The root-mounted version could not be presented at all: this screen is a native modal,
   * and iOS will not let the controller presenting it present something else. See
   * `DiagnosticsSheet`. A boolean in the screen that opens it is both the fix and the
   * simplest thing that can be true.
   */
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // Three states, not two — review 57. Saying "Copied" when the write did not happen is
  // the silent failure this control exists to replace, reproduced in the replacement.
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  const queryClient = useQueryClient();

  /**
   * The failsafe: the report to the clipboard **without opening anything**.
   *
   * The whole reason this task exists is that a presentation failure made the recorder
   * unreachable. So the second control does not present: it builds the text and writes it,
   * and the founder can paste it even if the sheet never appears again.
   */
  const copyNow = async () => {
    let report: string;
    try {
      // The route is this screen, which does not need asking for: the copy control only
      // exists here. One fewer hook, and one fewer context this screen depends on.
      report = await buildDiagnosticsReport(queryClient, 'settings');
    } catch (error) {
      // Even a failure to assemble is worth having on the clipboard: it names the thing
      // that would otherwise be a founder saying "nothing happened" for a second time.
      report = `bingd. diagnostics could not be built: ${error instanceof Error ? error.name : 'unknown'}`;
    }
    setCopy(copyDiagnostics(report) ? 'done' : 'failed');
  };

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
          bingd. {version} ({build})
        </Text>

        {/* Only where somebody is testing. PRD §23 keeps identifiers out of anything
            user-facing, and a fingerprint is an identifier.

            Gated on the **lane**, not the variant. A Beta build carries the production
            variant — the bundle identifier cannot change between TestFlight and the App
            Store release that replaces it — while talking to the nonproduction backend,
            so `variant !== 'production'` hid these four lines from precisely the people
            running a production-looking binary against a test database. Independent
            review 28 called that the wrong trade and it was. */}
        {!isRelease ? (
          <>
            <Text variant="caption" tone="tertiary">
              {lane} · {Updates.channel ?? 'no channel'}
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
            {/* Two ways to the same report, and the second one exists because the first
                failed on a real device.

                `Diagnostics` opens the sheet, which is the readable form. `Copy
                diagnostics` never presents anything at all — it assembles the text and
                writes it to the clipboard — so a presentation failure can no longer stand
                between the recorder and the founder. Both are hidden in a release build.

                The onboarding summary keeps its own long-press entry for the case where
                Settings is unreachable, and renders the same component. */}
            <View style={styles.diagnostics}>
              <Text
                variant="caption"
                tone="action"
                accessibilityRole="button"
                accessibilityLabel="Diagnostics"
                accessibilityHint="Shows a copyable report of what the app is doing"
                onPress={() => setDiagnosticsOpen(true)}
                style={styles.diagnosticsAction}
              >
                Diagnostics
              </Text>
              <Text
                variant="caption"
                tone="action"
                accessibilityRole="button"
                accessibilityLabel={
                  copy === 'done'
                    ? 'Diagnostics copied'
                    : copy === 'failed'
                      ? 'Copying diagnostics failed'
                      : 'Copy diagnostics'
                }
                accessibilityHint="Copies the report without opening anything"
                onPress={() => void copyNow()}
                style={styles.diagnosticsAction}
              >
                {copy === 'done'
                  ? 'Copied'
                  : copy === 'failed'
                    ? 'Copy failed'
                    : 'Copy diagnostics'}
              </Text>
            </View>

            {/* Rendered inside this screen, so it presents from this screen’s own view
                controller rather than from the root’s, which is already presenting it. */}
            <DiagnosticsSheet
              visible={diagnosticsOpen}
              onClose={() => setDiagnosticsOpen(false)}
            />
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
  // A 44pt target on a caption-sized label, so the one control on this block that is a
  // control can actually be pressed.
  diagnostics: { paddingTop: theme.space[2], gap: theme.space[1] },
  // A 44pt target on a caption-sized label, so the two controls on this block that are
  // controls can actually be pressed.
  diagnosticsAction: { minHeight: theme.layout.minTapTarget },
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
  // TMDB's source aspect is 190.24:81.52, which contain-fit preserves inside this box.
  // Smaller than BrandMark's lg rendition, so the mark reads as a credit, not a co-brand.
  tmdbLogo: { width: 63, height: 27 },
});
