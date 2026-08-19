import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

import { env } from './env';

/**
 * Which build produced this event.
 *
 * The question this exists to answer is the founder's, and it is not abstract: during
 * the friend beta there will be an Android dev client, an iOS dev client, a Preview
 * build and later a TestFlight build all sending to the same project at the same time.
 * A funnel that mixes them is not a funnel — a crash that only happens on Preview, or a
 * step that only stalls on Android, is invisible the moment the four are pooled.
 *
 * **One helper rather than a spread at every call site.** These fields are read from
 * three native modules and two of them return null in situations that are easy to get
 * wrong (a development build has no channel; a build running its embedded bundle has no
 * update id). Reconstructing that per event is how three call sites end up disagreeing
 * about what `null` meant.
 *
 * **Nothing here is a secret.** A version, a build number, a channel name and an update
 * id are all printed on the build's own About screen by every store. There is no DSN, no
 * project token and no Supabase key in this object, and adding one would put a
 * credential in every event body.
 */

/** The fields attached to every analytics event and to every monitoring report. */
export type ReleaseContext = {
  environment: 'development' | 'preview' | 'production';
  platform: string;
  /** `expoConfig.version` as the store sees it — "0.1.0". Null off-device. */
  app_version: string | null;
  /** `versionCode` / `CFBundleVersion`. The number that actually distinguishes two builds of one version. */
  build_number: string | null;
  /** The fingerprint hash an update has to match to be offered. Null in development. */
  runtime_version: string | null;
  /** EAS channel. **Null on a development build by design** — see `build_kind`. */
  eas_channel: string | null;
  /** Null when the build is running the bundle it shipped with. */
  eas_update_id: string | null;
  /**
   * How the JavaScript on screen got there, which is the field that separates the four
   * builds when `eas_channel` cannot.
   *
   * - `dev_client` — served by Metro. `__DEV__`, so a dev client attached to a packager.
   * - `embedded` — the bundle compiled into the build. A fresh Preview or TestFlight install.
   * - `ota` — an `eas update` this build downloaded and applied.
   */
  build_kind: 'dev_client' | 'embedded' | 'ota';
};

/**
 * What the three native modules were asked for, as plain values.
 *
 * Separated from `releaseContext()` so the rules below — every one of which is a
 * decision about what null means — are testable without standing up
 * `expo-updates` in a Jest environment that has no native side.
 */
export type ReleaseSources = {
  variant: ReleaseContext['environment'];
  platform: string;
  appVersion: string | null | undefined;
  buildNumber: string | null | undefined;
  runtimeVersion: string | null | undefined;
  channel: string | null | undefined;
  updateId: string | null | undefined;
  isEmbeddedLaunch: boolean;
  isDev: boolean;
};

/**
 * An empty string is not a value.
 *
 * `expo-application` returns `''` rather than null on some Android configurations, and
 * an empty string in an analytics property is worse than an absent one: it groups, so a
 * chart shows a bar for it.
 */
const orNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function buildReleaseContext(input: ReleaseSources): ReleaseContext {
  return {
    environment: input.variant,
    platform: input.platform,
    app_version: orNull(input.appVersion),
    build_number: orNull(input.buildNumber),
    runtime_version: orNull(input.runtimeVersion),
    eas_channel: orNull(input.channel),
    eas_update_id: orNull(input.updateId),
    /**
     * `__DEV__` first, and it wins over everything else.
     *
     * A development build attached to Metro reports `isEmbeddedLaunch: true` — there is
     * no update, so the launch is technically embedded — which would file every founder
     * dev-client session under the same label as a fresh TestFlight install. That is
     * precisely the confusion this field exists to prevent, so the packager case is
     * answered before the update state is consulted at all.
     */
    build_kind: input.isDev ? 'dev_client' : input.isEmbeddedLaunch ? 'embedded' : 'ota',
  };
}

let cached: ReleaseContext | null = null;

/**
 * Read once per process.
 *
 * Every field is fixed for the life of the app: an OTA update that changes `updateId`
 * reloads the process to apply it (`lib/updates.ts`), so there is no moment where a
 * cached value is stale and a fresh read would differ.
 */
export function releaseContext(): ReleaseContext {
  cached ??= buildReleaseContext({
    variant: env.variant,
    platform: Platform.OS,
    appVersion: Application.nativeApplicationVersion,
    buildNumber: Application.nativeBuildVersion,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
    updateId: Updates.updateId,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    isDev: __DEV__,
  });
  return cached;
}

/** Exported for tests, which must not inherit the previous one's process state. */
export function resetReleaseContext() {
  cached = null;
}

/**
 * The same facts as Sentry tags.
 *
 * Deliberately **not** `release` and `dist`. The Sentry Expo plugin sets those from the
 * native build at compile time, and they are what a source map is uploaded against —
 * overriding them here with a value read at runtime is how a symbolicated stack becomes
 * an unsymbolicated one. Tags sit beside them and are searchable in the same way.
 */
export function releaseTags(): Record<string, string> {
  const context = releaseContext();
  const tags: Record<string, string> = {
    environment: context.environment,
    build_kind: context.build_kind,
  };
  if (context.app_version) tags.app_version = context.app_version;
  if (context.build_number) tags.build_number = context.build_number;
  if (context.runtime_version) tags.runtime_version = context.runtime_version;
  if (context.eas_channel) tags.eas_channel = context.eas_channel;
  if (context.eas_update_id) tags.eas_update_id = context.eas_update_id;
  return tags;
}
