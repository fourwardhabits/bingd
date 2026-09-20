import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { VISIBILITY_ICON, VISIBILITY_OPTION, type ListVisibility } from './types';

/**
 * The §F.5 consent copy, as a function of whose profile is asking.
 *
 * The second line appears **only when the owner's profile is private**, where it is the
 * true and reassuring fact: link-only is an object-level share, so it grants this list
 * and unlocks nothing else about the account. On a public profile it would be saying
 * "they won't see your profile" to somebody whose profile anybody can already open,
 * which reads as either a mistake or a promise the product is not making.
 */
export function linkConsentBody(profilePrivate: boolean): string {
  const first = 'Anyone with this link can view this list.';
  return profilePrivate
    ? `${first}\nThey won't see your profile, ratings or other lists.`
    : first;
}

export const LINK_CONSENT_TITLE = 'Anyone with this link can view this list.';

export type VisibilityPickerProps = {
  value: ListVisibility;
  onChange: (next: ListVisibility) => void;
  /** Disables **On your profile** and says why. §F.3: public requires a public profile. */
  profilePrivate: boolean;
  /**
   * Freezes every option and says an operator has hidden the list (§F.10). A hidden
   * list's mode cannot change until the hide is cleared, and the control has to say so
   * rather than fail on press.
   */
  hidden?: boolean;
};

/**
 * Who can see it — three options, one of which is sometimes unavailable.
 *
 * ---------------------------------------------------------------------------
 * WHY "ON YOUR PROFILE" IS DISABLED RATHER THAN ABSENT
 *
 * A private-profile owner who cannot see the option concludes that lists cannot be
 * published at all. The same owner who sees it greyed with one sentence under it learns
 * the actual rule — and where to go and change it. `SheetRow`'s `disabledReason` exists
 * for exactly this: a control worth keeping visible, provided it says out loud why it is
 * not available.
 *
 * The link consent copy sits **inline, under the option**, rather than in a confirmation
 * over the sheet. It is a fact about the choice, and a person deciding between three
 * options should be able to read it while deciding rather than after having decided.
 * The *conversion* of an already-private list — Share on a private list — is a
 * different act and does get the prompt, because there the person asked to share and
 * the visibility change is a consequence they did not name.
 */
export function VisibilityPicker({
  value,
  onChange,
  profilePrivate,
  hidden = false,
}: VisibilityPickerProps) {
  const options: ListVisibility[] = ['private', 'link', 'public'];

  return (
    <View style={styles.group} accessibilityRole="radiogroup">
      <Text variant="subhead" tone="secondary" style={styles.groupLabel}>
        Who can see it
      </Text>

      {options.map((option) => {
        const unavailable = hidden || (option === 'public' && profilePrivate);
        const selected = value === option;

        return (
          <View key={option}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled: unavailable }}
              accessibilityLabel={VISIBILITY_OPTION[option]}
              accessibilityHint={
                unavailable
                  ? hidden
                    ? 'This list is hidden while it is reviewed.'
                    : 'Make your profile public to publish lists on it.'
                  : undefined
              }
              disabled={unavailable}
              onPress={() => onChange(option)}
              style={({ pressed }) => [styles.option, pressed && styles.pressed]}
            >
              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={theme.layout.icon.md}
                color={
                  unavailable
                    ? theme.text.tertiary
                    : selected
                      ? theme.semantic.action
                      : theme.text.secondary
                }
              />
              <Ionicons
                name={VISIBILITY_ICON[option]}
                size={theme.layout.icon.sm}
                color={unavailable ? theme.text.tertiary : theme.text.secondary}
              />
              <Text variant="callout" tone={unavailable ? 'tertiary' : 'primary'}>
                {VISIBILITY_OPTION[option]}
              </Text>
            </Pressable>

            {option === 'public' && profilePrivate && !hidden ? (
              <Text variant="footnote" tone="tertiary" style={styles.note}>
                Make your profile public to publish lists on it.
              </Text>
            ) : null}

            {/* The consent copy, where the decision is being made. */}
            {option === 'link' && selected ? (
              <Text variant="footnote" tone="secondary" style={styles.note}>
                {linkConsentBody(profilePrivate)}
              </Text>
            ) : null}
          </View>
        );
      })}

      {hidden ? (
        <Text variant="footnote" tone="tertiary" style={styles.note}>
          This list is hidden while it is reviewed. You can still edit it.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: theme.space[1] },
  groupLabel: { marginBottom: theme.space[1] },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
  },
  // Indented to the option's text, so the sentence reads as belonging to the row above
  // it rather than as a new item in the group.
  note: { marginLeft: theme.layout.icon.md + theme.layout.icon.sm + theme.space[4] },
  pressed: { opacity: 0.7 },
});
