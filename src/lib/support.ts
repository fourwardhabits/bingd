import { Alert, Linking } from 'react-native';

import { track } from './analytics';
import { releaseContext } from './release';

/**
 * The two ways a person tells bingd. something, and the only place the address is written.
 *
 * ---------------------------------------------------------------------------
 * WHY EMAIL AND NOT A FORM
 *
 * A form needs a table, a policy about what is in it, a way to read it and a way to
 * reply — four things that exist the moment they are built and must then be maintained
 * for as long as the app ships. An address needs a mailbox, and the mailbox already
 * routes: `support@bingd.app` forwards through Cloudflare to the founder's inbox today.
 *
 * The second reason is the one that matters for the person writing. A reply to an email
 * lands where they can see it. A reply to a row in a table lands nowhere until somebody
 * builds the screen that shows it, and a support channel that cannot answer back is a
 * suggestion box.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BODY MAY CARRY, AND WHAT IT MAY NOT
 *
 * The prefilled body is drafted **by the app and sent by the person**, which is exactly
 * why it is written narrowly. Whatever is in it is read, and consented to, by the person
 * who taps Send — but only if they can recognise every line of it. So the report body
 * carries three facts and they are all about the *build*: version, build number,
 * platform. Nothing here reads a profile, a session, a token, a device id or an
 * analytics id, and PRD §23 is the reason: a support draft is not a channel for
 * identifiers the sender cannot see the point of.
 *
 * `releaseContext()` supplies the three, and deliberately only three of its eight
 * fields. The runtime fingerprint, the channel and the update id are omitted for the
 * same reason the Settings screen hides them in a release build — they identify a
 * build to the founder and read as a serial number to everybody else. If a support
 * conversation needs them, `Copy diagnostics` on a non-release build is where they live.
 */
export const SUPPORT_EMAIL = 'support@bingd.app';

/** Which of the two rows was tapped. Feedback is unprompted; a problem is a report. */
export type SupportTopic = 'feedback' | 'problem';

/**
 * The subjects, which are the only routing this channel has.
 *
 * One mailbox, two subjects, so a filter can separate "something is broken" from "here
 * is an idea" without a second address to publish and later have to keep alive.
 *
 * **These two strings are prefixes, and bingd.app/support extends them.** The site's
 * cards send `bingd. support - problem report` and `bingd. feedback - idea`,
 * built to start with what is here so one mail rule keeps catching both routes and
 * somebody who writes in from the app and then from the web lands in one thread.
 * Lengthening either of these splits what that rule used to catch.
 * `web/router.test.mjs` asserts the relationship from the other side, and is
 * where it is enforced.
 */
const SUBJECTS: Record<SupportTopic, string> = {
  feedback: 'bingd. feedback',
  problem: 'bingd. support',
};

/** The build facts a report may carry. Nothing here identifies a person. */
export type SupportBuild = {
  appVersion: string | null;
  buildNumber: string | null;
  platform: string;
};

/** `ios` is written `iOS` for a person reading their own draft; anything else as it comes. */
function platformName(platform: string) {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return platform;
}

/** `1.0.0 (7)`, or as much of it as the binary could actually answer for. */
function versionLine(build: SupportBuild) {
  if (!build.appVersion) return 'unknown';
  return build.buildNumber ? `${build.appVersion} (${build.buildNumber})` : build.appVersion;
}

/**
 * The draft, as text.
 *
 * The square brackets are a placeholder a person overwrites, which is the one piece of
 * this the app cannot supply: only they know what happened. Feedback gets the greeting
 * and the placeholder and nothing else — an idea does not need a build number, and a
 * diagnostic footer under a compliment reads as a bug report form.
 */
export function buildSupportBody(topic: SupportTopic, build: SupportBuild): string {
  if (topic === 'feedback') {
    return ['Hi bingd. team,', '', '[Share your feedback here]', ''].join('\n');
  }
  return [
    'Hi bingd. team,',
    '',
    '[Describe what happened here]',
    '',
    `App version: ${versionLine(build)}`,
    `Platform: ${platformName(build.platform)}`,
    '',
  ].join('\n');
}

/**
 * The `mailto:` URL, encoded.
 *
 * `encodeURIComponent` on each half rather than a template and hope: the subject
 * contains a space and the body contains newlines, and an unencoded newline in a
 * `mailto:` is where the body silently stops on some clients. Pure, and separated from
 * the opening, so the encoding is a thing a test can read rather than an effect it has
 * to intercept.
 */
export function buildSupportMailto(topic: SupportTopic, build: SupportBuild): string {
  const subject = encodeURIComponent(SUBJECTS[topic]);
  const body = encodeURIComponent(buildSupportBody(topic, build));
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

/** What the running build says about itself, narrowed to the three fields a draft may carry. */
export function currentSupportBuild(): SupportBuild {
  const release = releaseContext();
  return {
    appVersion: release.app_version,
    buildNumber: release.build_number,
    platform: release.platform,
  };
}

/**
 * Opens the device's mail client on a draft to support@bingd.app.
 *
 * **Failure is not swallowed here, and that is the difference from `openLegal`.** A
 * policy link that does not open is a document somebody can find on the web; a support
 * draft that does not open is a person who has just decided to tell you something and
 * has been given no way to. A simulator with no Mail account and a phone whose mail app
 * has been removed both land here, so the alert says the address in plain text — which
 * is the whole content of the draft they were trying to send anyway.
 *
 * The event is emitted on the tap rather than after the open resolves, because the
 * question it answers is *does anybody use this*, and somebody whose mail client failed
 * to launch still tried. It carries the topic and nothing else: no subject, no body, no
 * address, no account (`analytics.ts`).
 */
export async function openSupportEmail(
  topic: SupportTopic,
  build: SupportBuild = currentSupportBuild(),
): Promise<void> {
  track({ name: 'settings_support_email_opened', props: { type: topic } });
  try {
    await Linking.openURL(buildSupportMailto(topic, build));
  } catch {
    Alert.alert(
      'Could not open your email app',
      `Write to ${SUPPORT_EMAIL} and we will pick it up.`,
    );
  }
}
