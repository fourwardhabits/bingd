import { Linking } from 'react-native';

/**
 * The three documents bingd. publishes, and the only place their addresses are written.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY ARE URLS AND NOT SCREENS
 *
 * A policy rendered inside the app is a policy that ships on the app's release
 * schedule. Correcting a sentence in the Terms would then mean an update, a review
 * queue on one platform, and a fleet where two versions of the same document are live
 * at once — which is the state a policy document exists to avoid. The web copies are
 * the canonical ones, both stores already require a URL for the privacy policy, and
 * `web/build.mjs` generates all three from one template.
 *
 * The app therefore *links* rather than duplicates. What is in the binary is an
 * address; what is at the address can be corrected the same afternoon.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY ARE ABSOLUTE AND HARDCODED
 *
 * These are not distribution URLs. `web/distribution.config.json` exists because
 * TestFlight and Play links move between phases and must never be compiled into a
 * build — but `https://bingd.app/privacy` is the same address in development, in
 * Preview, in the friend beta and after public launch. A document that changed address
 * per lane would be a document a store reviewer could not check.
 */
export const LEGAL_URLS = {
  privacy: 'https://bingd.app/privacy',
  terms: 'https://bingd.app/terms',
  support: 'https://bingd.app/support',
} as const;

export type LegalDocument = keyof typeof LEGAL_URLS;

/**
 * Opens one of them in the system browser.
 *
 * Failure is swallowed on purpose, and this is the one decision here worth stating.
 * `openURL` rejects when no handler is registered, which on a normal device with a
 * normal https link does not happen — and the alternative is an error dialog in front
 * of somebody who tapped "Privacy Policy", which tells them nothing they can act on
 * and reads as though the policy itself were broken. There is nothing to retry and
 * nothing to fix from the app's side.
 */
export function openLegal(document: LegalDocument) {
  void Linking.openURL(LEGAL_URLS[document]).catch(() => {});
}
