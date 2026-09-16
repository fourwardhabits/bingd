import { Ionicons } from '@expo/vector-icons';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { track, type SocialLinkNetwork } from '@/lib/analytics';
import { theme } from '@/ui/tokens';

import {
  configuredSocialLinks,
  type ProfileSocialLinks,
  type SocialNetwork,
} from './social-links';

/**
 * The analytics vocabulary and the product's own are the same five words, and this is
 * where that is enforced.
 *
 * `lib/` does not import from `features/`, so `SocialLinkNetwork` is declared over there
 * independently — see its docblock for why that is deliberate rather than duplication.
 * A sixth network added to `SOCIAL_NETWORKS` and not to the event's type fails to
 * compile here, at the one place the two meet, which is the moment somebody should be
 * deciding whether the series can absorb it.
 */
const asEventNetwork = (network: SocialNetwork): SocialLinkNetwork => network;

const ICONS: Record<SocialNetwork, React.ComponentProps<typeof Ionicons>['name']> = {
  instagram: 'logo-instagram',
  tiktok: 'logo-tiktok',
  youtube: 'logo-youtube',
  x: 'logo-x',
  // The one that is not a logo, because a website is not a brand. `globe-outline` is
  // the same weight as the four beside it and says the only thing that is true of all
  // websites.
  website: 'globe-outline',
};

export type SocialLinkRowProps = {
  /** Null, undefined, or all-null for every account that predates 20260921000100. */
  links: Partial<ProfileSocialLinks> | null | undefined;
};

/**
 * The five optional links a profile may carry, as icons, under the handle.
 *
 * ---------------------------------------------------------------------------
 * WHAT ABSENT MEANS
 *
 * **Null, not empty.** A profile with no links renders no row: no icons, no reserved
 * height, no placeholder. That is the founder's rule and it is also the only way this
 * feature can ship without changing every existing profile, all of which have five
 * nulls — see `profile-social-links.test.mjs`. The bio and whatever follows it move up
 * into the space, exactly as they sit today.
 *
 * One configured link draws one icon. There are no ghosts for the four that are not
 * there, for the same reason: an empty slot is an invitation with nothing behind it.
 *
 * ---------------------------------------------------------------------------
 * WHY MONOCHROME
 *
 * Five brand colours in a row under somebody's name would be the loudest thing on the
 * profile, and none of that colour is *about the person* — it is five companies'
 * palettes fighting each other above a bio. The founder ruled it out and the ruling
 * matches what the rest of the header does: one accent (Maroon, on the Match line), and
 * everything else in the text ramp. `text.secondary` is the same tone `IconToggle` gives
 * an unselected glyph, which is what makes these read as controls rather than as logos.
 *
 * ---------------------------------------------------------------------------
 * 32 DRAWN, 44 ANSWERED
 *
 * `theme.layout.chipHitSlop` unmodified — the shared `{ top: 6, bottom: 6, left: 4,
 * right: 4 }` that `FilterChip`, `SortMenu` and the title page's genre chips carry, and
 * that design-system.md §10 documents. Vertical is `(44 − 32) / 2`; horizontal is half
 * of the `space[2]` gap between two cells, so two neighbours' slops meet without
 * crossing and a press between them belongs to the nearer one.
 *
 * **Each cell therefore answers 40 wide rather than 44**, and that is measured rather
 * than missed. Five cells have to fit the column the avatar leaves — about 200pt on the
 * 320pt screen this app supports — and 5 × 32 + 4 × 8 is 192, where cells wide enough to
 * answer 44 without crossing their neighbours would be 208 and clip the last icon on a
 * small phone. It is the same trade `IconToggle`'s middle cell makes and it is
 * acceptable here for the same reason: nothing behind these is destructive, the
 * neighbours are five links rather than five decisions, and a mis-tap costs a back
 * gesture. `touch-targets.test.tsx` pins it so it stays a decision.
 *
 * The glyph is `icon.sm` (20pt), which is the founder's 20–22 range and an existing
 * token rather than a number invented for this row.
 */
export function SocialLinkRow({ links }: SocialLinkRowProps) {
  const configured = configuredSocialLinks(links);

  // Not an empty `View`. A zero-height row still occupies a slot in a `gap` layout, so
  // returning one would put four points of nothing under every handle in the app.
  if (configured.length === 0) return null;

  return (
    <View style={styles.row}>
      {configured.map(({ network, url, label }) => (
        <Pressable
          key={network}
          accessibilityRole="link"
          accessibilityLabel={label}
          hitSlop={theme.layout.chipHitSlop}
          onPress={() => {
            // After the tap and only after it. A row that is drawn is not a row that
            // was used, and the question this event exists for is use.
            track({
              name: 'profile_social_link_opened',
              props: { network: asEventNetwork(network) },
            });
            /**
             * The URL is built by `socialLinkUrl` from a value whose shape is known, and
             * it is `https://` in every branch — never a scheme assembled from stored
             * text. See `social-links.ts`.
             *
             * `.catch` and nothing more, which is the pattern `lib/legal.ts` and the
             * Letterboxd export sheet already use: the failure mode is a phone with no
             * browser and no handler for `https`, and an alert about it would be a
             * dialog nobody can act on.
             */
            void Linking.openURL(url).catch(() => {});
          }}
          style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
        >
          <Ionicons
            name={ICONS[network]}
            size={theme.layout.icon.sm}
            color={theme.text.secondary}
          />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Left-aligned with the handle above it — `flex-start` rather than the row taking its
  // container's width, so five icons and one icon both begin at the same point and
  // neither is spread across the column.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
  },
  cell: {
    width: theme.layout.control.chipHeight,
    height: theme.layout.control.chipHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
});
