import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { providerLogoUri } from '@/lib/images';
import { Button, SectionHeader, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { useWatchProviders, type WatchOffer, type WatchProvider } from './use-watch-providers';

export type WhereToWatchProps = {
  mediaItemId: string | null;
  /** The title's name, for the sheet's label and nothing else. */
  titleName: string;
};

/** How many logos the collapsed row shows before it starts counting. */
const COMPACT_LOGOS = 3;

/** The three headings, in the order the sheet lists them. `SectionHeader` upper-cases. */
const OFFERS: { offer: WatchOffer; label: string }[] = [
  { offer: 'stream', label: 'Stream' },
  { offer: 'rent', label: 'Rent' },
  { offer: 'buy', label: 'Buy' },
];

/**
 * Where this title can be watched — one compact row under the scores.
 *
 * **Placed between the score block and the tabs, and deliberately not a tab.** The
 * founder's decision, and it turns on what a tab would cost on either side: a film
 * opens on Cast and a season opens on Episodes, both of which are the point of those
 * pages, and a fifth entry on a season's already-long tab row would push one of them
 * off. Availability is worth finding without a tab hunt and is not worth a hero, so
 * it is a row: label on the left, the first few services on the right, and the rest
 * behind a tap.
 *
 * **It disappears rather than explaining itself.** Loading, failed and genuinely
 * empty are one branch here, which is the whole of this feature's failure story: the
 * block is the one thing on a title page allowed to be absent, and a card saying "no
 * availability information" would be a permanent apology on every obscure film in the
 * catalogue. `useWatchProviders` does not retry for the same reason.
 *
 * **The disclosure state lives here, not on the screen.** Every other sheet on the
 * title page is opened by something outside itself — the log flow, the Following
 * unit — so the screen owns those. Nothing but this row opens this sheet, and it
 * reads data this component already holds, so lifting the state would put two lines
 * on `TitleScreen` for no one else's benefit.
 *
 * **Attribution is on both surfaces.** TMDB's terms for this data are specific and
 * not paraphrasable: *"In order to use this data you must attribute the source of the
 * data as JustWatch."* The logos are the data, so the line travels with them — small
 * and subordinate on the row, in full in the sheet.
 */
export function WhereToWatch({ mediaItemId, titleName }: WhereToWatchProps) {
  const [open, setOpen] = useState(false);
  const availability = useWatchProviders(mediaItemId);

  const providers = availability.data?.providers ?? [];
  // Pending, failed and empty, in one line. See the header: none of the three is
  // worth a shape on the page.
  if (!providers.length) return null;

  const shown = providers.slice(0, COMPACT_LOGOS);
  const overflow = providers.length - shown.length;

  return (
    <>
      <Pressable
        testID="where-to-watch"
        accessibilityRole="button"
        // The logos are decorative once this says who they are, so they are hidden
        // from the tree below and named here instead — one stop, one sentence.
        accessibilityLabel={`Where to watch. ${listOf(
          shown.map((provider) => provider.name),
          overflow,
        )}`}
        accessibilityHint="Opens the full list of services"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View style={styles.copy}>
          <Text variant="callout">Where to watch</Text>
          <Text variant="caption" tone="tertiary">
            via JustWatch
          </Text>
        </View>

        <View
          style={styles.logos}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {shown.map((provider) => (
            <ProviderLogo key={provider.provider_id} provider={provider} size={LOGO.compact} />
          ))}
          {overflow > 0 ? (
            <Text variant="caption" tone="secondary">
              +{overflow}
            </Text>
          ) : null}
        </View>

        <Ionicons
          name="chevron-forward"
          size={theme.layout.icon.sm}
          color={theme.text.tertiary}
        />
      </Pressable>

      {open ? (
        <WhereToWatchSheet
          titleName={titleName}
          region={availability.data?.region ?? ''}
          link={availability.data?.link ?? null}
          providers={providers}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Every service, grouped by how it offers the title.
 *
 * A service offered two ways appears under both headings, from the one entry that
 * carries both — which is why Apple TV can be under Rent and Buy without the row
 * above counting it twice.
 *
 * **No posters here, and no per-service link.** The sheet answers "which services",
 * so a poster would be the one thing on it that is not the answer. And a logo opens
 * nothing: TMDB's payload carries no deep link into Netflix or Max, and building one
 * out of a service's name would be a guess the reader would read as a destination.
 * The one real link is TMDB's own watch-options page, and it is labelled as that.
 */
function WhereToWatchSheet({
  titleName,
  region,
  link,
  providers,
  onClose,
}: {
  titleName: string;
  region: string;
  link: string | null;
  providers: WatchProvider[];
  onClose: () => void;
}) {
  return (
    <Sheet visible onClose={onClose} label={`Where to watch ${titleName}`}>
      <View style={styles.head}>
        <Text variant="title2">Where to watch</Text>
        {region ? (
          <Text variant="footnote" tone="secondary">
            Availability in {region}.
          </Text>
        ) : null}
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {OFFERS.map(({ offer, label }) => {
          const group = providers.filter((provider) => provider.offers.includes(offer));
          if (!group.length) return null;

          return (
            <View key={offer}>
              <SectionHeader title={label} />
              {group.map((provider) => (
                <View
                  key={provider.provider_id}
                  style={styles.providerRow}
                  accessible
                  accessibilityLabel={`${provider.name}, ${label}`}
                >
                  <ProviderLogo provider={provider} size={LOGO.sheet} />
                  {/* Two lines rather than an ellipsis. "Amazon Prime Video with Ads"
                      is a real service name and truncating it would leave the reader
                      guessing which of two similar ones this is. */}
                  <Text variant="callout" numberOfLines={2} style={styles.providerName}>
                    {provider.name}
                  </Text>
                </View>
              ))}
            </View>
          );
        })}

        {/* TMDB's terms, met where the data is. Their wording, not a paraphrase. */}
        <Text variant="caption" tone="tertiary" style={styles.attribution}>
          Availability data provided by JustWatch.
        </Text>
      </ScrollView>

      <View style={styles.foot}>
        {link ? (
          <Button
            label="View watch options"
            kind="secondary"
            // `catch` rather than `await`: a handover to the browser that the phone
            // refuses is not something this sheet can do anything about, and an
            // unhandled rejection here would be an unhandled rejection on a film page.
            onPress={() => void Linking.openURL(link).catch(() => {})}
          />
        ) : null}
        {/* The labelled way out every sheet carries — `Sheet` hides its scrim from the
            accessibility tree on the understanding that this exists. */}
        <Button label="Done" onPress={onClose} />
      </View>
    </Sheet>
  );
}

/**
 * Two sizes: one for the compact row, one for a sheet row.
 *
 * Both well under the 44pt tap target on purpose — neither is tappable. The row is
 * the control on the collapsed block, and nothing in the sheet is a control at all.
 */
const LOGO = { compact: 28, sheet: 32 } as const;

/**
 * One service's mark.
 *
 * `contentFit="contain"` inside a square box, because a provider logo is square-ish
 * but not reliably square and a `cover` fit would crop the wordmark off the ones that
 * are not. The box is 28pt, so a logo that never loads leaves a 28pt tile rather than
 * a hole — and one TMDB has no file for falls back to the service's initial, the same
 * treatment `Avatar` and the cast strip give a missing face.
 */
function ProviderLogo({ provider, size }: { provider: WatchProvider; size: number }) {
  const uri = providerLogoUri(provider.logo_path);

  return (
    <View style={[styles.logo, { width: size, height: size }]}>
      {uri ? (
        <Image
          testID={`provider-logo-${provider.provider_id}`}
          source={{ uri }}
          contentFit="contain"
          transition={theme.duration.state}
          style={styles.logoImage}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text variant="caption" tone="tertiary">
          {provider.name.trim().charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

/** "Netflix, Apple TV and 3 more." One sentence for one accessibility stop. */
function listOf(names: string[], overflow: number): string {
  const parts = [...names];
  if (overflow > 0) parts.push(`${overflow} more`);
  if (parts.length <= 1) return `${parts[0] ?? ''}.`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}

const styles = StyleSheet.create({
  // The page's own gutter and row height, so this sits on the same grid as everything
  // above and below it rather than as a card dropped onto the page.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[5],
    minHeight: theme.layout.rowMinHeight,
  },
  copy: { flex: 1, gap: 2 },
  logos: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  pressed: { opacity: 0.7 },

  logo: {
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.sunken,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoImage: { width: '100%', height: '100%' },

  head: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2], gap: 2 },
  list: { maxHeight: 420 },
  listContent: { paddingBottom: theme.space[2] },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    minHeight: theme.layout.rowMinHeight,
  },
  providerName: { flex: 1 },
  attribution: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[3] },
  foot: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2], gap: theme.space[2] },
});
