import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AvatarPicker } from '@/features/profile/AvatarPicker';
import {
  normalizeSocialLink,
  SOCIAL_FIELD_HINTS,
  SOCIAL_FIELD_LABELS,
  SOCIAL_NETWORKS,
  type SocialNetwork,
} from '@/features/profile/social-links';
import { useAccountWrites } from '@/features/settings/use-account';
import { queryKeys } from '@/lib/query';
import { Button, Field, KeyboardScreen, Screen, SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** The bio's ceiling, matching `profiles.bio_shape`. */
const BIO_MAX = 120;

type LinkDraft = Record<SocialNetwork, string>;

/**
 * Edit Profile — one form, one save.
 *
 * What this replaced had a Save button for the name and a separate control for the
 * handle, and told the reader about ninety-day redirects and reserved names underneath.
 * Two things were wrong with it, and the founder named both.
 *
 * **It exposed a seam a reader does not have.** "My profile" is one thing. A screen
 * with two saves can leave the name written and the handle refused, which is a
 * half-saved profile somebody has to reason about. `save_profile` is one transaction,
 * so the screen can be one form.
 *
 * **It explained the implementation.** Redirect windows, reservations, what happens to
 * old links — all true, all backend behaviour, and none of it a decision the person
 * typing a handle is making. What they need to know is the rule that binds them: the
 * shape, and that they can do it again in thirty days. The protections stay; the
 * lecture goes.
 *
 * The Bio is the founder's subheading concept as real data. There is a column now, it
 * is one line under the handle on every profile, and nothing here is hardcoded.
 *
 * ---------------------------------------------------------------------------
 * SOCIAL LINKS (20260921000100)
 *
 * Five optional boxes in a section of their own, and they are part of the same one
 * save for the reason the bio is: a person editing their profile is editing one thing.
 *
 * **The boxes take whatever somebody has on their clipboard.** A username, an @name, a
 * profile URL with or without a scheme, `twitter.com` for X. The normalising lives in
 * `features/profile/social-links.ts`, which is also what the header reads back, so the
 * two cannot drift into a form that accepts a shape the profile cannot draw.
 *
 * **Errors appear on blur or on a refused save, never while somebody is typing.** A
 * field that turns red at `h` of `https://` is a field arguing with you mid-sentence.
 * And Save stays *enabled* while a link is wrong: `Button`'s `disabledReason` is an
 * accessibility hint rather than visible copy, so a disabled Save would be a control
 * that had stopped working without saying so. Pressing it reveals every error instead,
 * which is the version where the screen answers the tap.
 */
export default function EditProfileScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { saveProfile, busy } = useAccountWrites();

  const [name, setName] = useState(profile.display_name || '');
  const [handle, setHandle] = useState(profile.username);
  const [bio, setBio] = useState(profile.bio ?? '');
  const [error, setError] = useState<string | null>(null);

  /**
   * The stored handles, shown as they are stored.
   *
   * Not the URL the header builds. Somebody looking at their own Instagram box should
   * see `suraj`, which is what they will type next time — a box pre-filled with
   * `https://www.instagram.com/suraj/` is the "UI accumulating messy URLs" this feature
   * exists to avoid, reintroduced at the one place it would be most visible.
   */
  const [links, setLinks] = useState<LinkDraft>({
    instagram: profile.link_instagram ?? '',
    tiktok: profile.link_tiktok ?? '',
    youtube: profile.link_youtube ?? '',
    x: profile.link_x ?? '',
    website: profile.link_website ?? '',
  });
  /** Which boxes have been left, so an error is a verdict rather than a running commentary. */
  const [touched, setTouched] = useState<Partial<Record<SocialNetwork, boolean>>>({});

  const trimmedName = name.trim();
  const trimmedHandle = handle.trim().toLowerCase();
  const trimmedBio = bio.trim();

  const nameChanged = trimmedName !== (profile.display_name || '');
  const handleChanged = trimmedHandle !== profile.username.toLowerCase();
  const bioChanged = trimmedBio !== (profile.bio ?? '');

  const stored: LinkDraft = {
    instagram: profile.link_instagram ?? '',
    tiktok: profile.link_tiktok ?? '',
    youtube: profile.link_youtube ?? '',
    x: profile.link_x ?? '',
    website: profile.link_website ?? '',
  };

  /**
   * Every box normalised, once per render.
   *
   * Pure, so there is nothing to keep in step — the error shown under a field, whether
   * Save may proceed, and what is actually sent all read the same answer rather than
   * three computations of it.
   */
  const normalized = Object.fromEntries(
    SOCIAL_NETWORKS.map((network) => [network, normalizeSocialLink(network, links[network])]),
  ) as Record<SocialNetwork, ReturnType<typeof normalizeSocialLink>>;

  const linkChanged = (network: SocialNetwork) => {
    const result = normalized[network];
    // A box whose contents cannot be normalised has not changed *the stored value* yet,
    // and treating it as a change would enable Save on a refusal.
    return result.ok && (result.value ?? '') !== stored[network];
  };

  const changedLinks = SOCIAL_NETWORKS.filter(linkChanged);
  const badLinks = SOCIAL_NETWORKS.filter((network) => !normalized[network].ok);

  /**
   * A refusable link counts as a change, and that is not a slip.
   *
   * Save has to be reachable while a box is wrong, because pressing it is what reveals
   * the errors — a Save disabled on invalid input would leave somebody with a dead
   * button, a box that looks fine because it has not been blurred, and nothing to tap
   * that would explain either.
   *
   * A box that normalises to what is already stored — `@suraj` over `suraj` — is
   * correctly *not* a change, and Save stays disabled. Nothing has changed.
   */
  const changed =
    nameChanged ||
    handleChanged ||
    bioChanged ||
    changedLinks.length > 0 ||
    badLinks.length > 0;
  const valid =
    trimmedName.length > 0 && trimmedHandle.length >= 3 && trimmedBio.length <= BIO_MAX;

  const save = async () => {
    setError(null);

    // Reveal, then refuse. The alternative is a Save that does nothing and says nothing,
    // because a disabled button's reason is only announced to a screen reader.
    if (badLinks.length > 0) {
      setTouched(Object.fromEntries(badLinks.map((network) => [network, true])));
      return;
    }

    const linkFields = Object.fromEntries(
      changedLinks.map((network) => {
        const result = normalized[network];
        // `''` rather than undefined when it has been emptied, exactly as the bio does:
        // null already means "do not touch", so clearing needs a value of its own.
        return [network, result.ok ? (result.value ?? '') : ''];
      }),
    );

    const commit = async () => {
      const result = await saveProfile({
        // Only what changed. Undefined leaves a field alone, which is what keeps a bio
        // edit from being charged the handle's thirty-day cooldown.
        displayName: nameChanged ? trimmedName : undefined,
        username: handleChanged ? trimmedHandle : undefined,
        // `''` rather than undefined when it has been emptied: null already means "do
        // not touch", so clearing needs a value of its own.
        bio: bioChanged ? trimmedBio : undefined,
        ...linkFields,
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.myProfile(profile.id) });
      router.back();
    };

    // Asked once, and only for the part that cannot be undone. A name and a bio are
    // edits; a handle is a decision, because the old one does not come back into
    // circulation and thirty days have to pass before the next one. Links are edits.
    if (handleChanged) {
      Alert.alert(
        `Change your handle to @${trimmedHandle}?`,
        'You can change it again in 30 days.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save changes', onPress: () => void commit() },
        ],
      );
      return;
    }

    await commit();
  };

  return (
    <Screen includeBottomInset>
      <Stack.Screen
        options={{ headerShown: true, title: 'Edit Profile', headerBackTitle: 'Back' }}
      />

      <KeyboardScreen contentContainerStyle={styles.page}>
        <AvatarPicker />

        <View style={styles.section}>
          <SectionHeader title="About you" />
          <View style={styles.body}>
            <Field
              label="Display name"
              value={name}
              onChangeText={setName}
              maxLength={50}
              autoCapitalize="words"
              autoCorrect={false}
              hint="What people see beside your picture."
            />

            <Field
              label="Handle"
              value={handle}
              onChangeText={(next) => setHandle(next.toLowerCase())}
              maxLength={24}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              // The rule that binds them, and nothing about how it is enforced.
              hint={
                '3–24 characters.\nLowercase letters, numbers, and underscores.\nYou can change your handle every 30 days.'
              }
            />

            <Field
              label="Bio"
              value={bio}
              onChangeText={setBio}
              maxLength={BIO_MAX}
              multiline
              autoCapitalize="sentences"
              hint="A short line about you and your taste."
            />
            {/* Only once it is worth knowing. A counter from zero is a target. */}
            {bio.length > BIO_MAX - 30 ? (
              <Text variant="caption" tone={bio.length > BIO_MAX ? 'action' : 'tertiary'}>
                {BIO_MAX - bio.length} characters left
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Social links" />
          <View style={styles.body}>
            {/* Said once, above the five, rather than five times underneath them. */}
            <Text variant="caption" tone="tertiary">
              All optional. Leave a box empty and nothing shows on your profile.
            </Text>

            {SOCIAL_NETWORKS.map((network) => {
              const result = normalized[network];
              return (
                <Field
                  key={network}
                  label={SOCIAL_FIELD_LABELS[network]}
                  value={links[network]}
                  onChangeText={(next) =>
                    setLinks((current) => ({ ...current, [network]: next }))
                  }
                  onBlur={() => setTouched((current) => ({ ...current, [network]: true }))}
                  // Generous, because a pasted profile URL with a share-sheet query
                  // string on the end is a thing people do and the normaliser handles
                  // it. What is *stored* is bounded by the column, not by this.
                  maxLength={300}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  keyboardType={network === 'website' ? 'url' : 'default'}
                  hint={SOCIAL_FIELD_HINTS[network]}
                  // Replaces the hint when it is set, which is `Field`'s own rule.
                  error={!result.ok && touched[network] ? result.message : undefined}
                />
              );
            })}
          </View>
        </View>

        <View style={styles.body}>
          {error ? (
            <Text variant="footnote" tone="action">
              {error}
            </Text>
          ) : null}

          <Button
            label={busy ? 'Saving…' : 'Save changes'}
            onPress={() => void save()}
            disabled={busy || !changed || !valid}
            disabledReason={
              !valid ? 'Fill in a name and a handle first' : 'Nothing has changed yet'
            }
          />
        </View>
      </KeyboardScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[5], gap: theme.space[1] },
  body: {
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[3],
    paddingTop: theme.space[3],
  },
});
