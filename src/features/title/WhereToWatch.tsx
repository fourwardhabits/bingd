import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

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
 * data as JustWatch."* The logos are the data, so the line travels with them — small,
 * italic and tertiary on the row, in full in the sheet. Demoting it is allowed; moving
 * it behind the sheet would leave the visible half of the feature uncredited.
 *
 * **The heading is the app's section treatment and there is no second divider**
 * (founder, physical Android, 2026-09-05). The row read as part of the Scores section
 * above it, because its label was a `callout` in full ink — a row's weight, not a
 * section's. Small maroon caps is how every other section in the app announces itself,
 * and it separates this one at no cost in height, which is the constraint: the block is
 * a row and must stay a row. A rule beneath the scores was the other candidate and was
 * not taken, because `SectionHeader` without one is the app's dominant convention and
 * the hairline in `ScoresSection` is the exception rather than the pattern.
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
      {/**
       * **The same inset hairline the Scores section draws above itself** (founder,
       * physical Android, 2026-09-06).
       *
       * The maroon heading was the right change and was not enough on the device: with
       * the two score units directly above it and nothing between them, the block still
       * read as a continuation of Scores rather than as a section after it. The rule is
       * the app's existing one, borrowed rather than invented — gutter-inset, doubled
       * hairline, because a single one rounds away to nothing on some Android densities
       * — and it costs one pixel of height.
       *
       * Decorative, and no accessibility role: a screen reader announcing a separator
       * here would put a word between the scores and the availability where the design
       * puts a pause. `ScoresSection` states the same thing about its own.
       */}
      <View testID="where-to-watch-divider" style={styles.divider} />

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
          {/**
           * **The app's section-heading treatment, not a row label** (founder, physical
           * Android, 2026-09-05).
           *
           * It was `callout` in full ink, which is the weight of a row *inside* a
           * section — so sitting directly under the two score units it read as a third
           * thing in the Scores section rather than as a section of its own. Small maroon
           * caps is what every other section on every other screen uses to say "a new
           * block starts here", and it is what separates this one at no cost in height.
           *
           * Written by hand rather than through `SectionHeader`, and this is the one
           * place in the app that does it: `SectionHeader` owns the gutter, a 44pt row
           * and a full-width flex layout, all of which would break the whole point of
           * this block — a heading and its logos on **one line**. So the token is
           * borrowed and the layout is not. `uppercase` is applied by this component for
           * the same reason `SectionHeader` does it: casing is a style, and a screen
           * reader spelling out "W H E R E" is not.
           */}
          <Text variant="sectionHeader" tone="action">
            WHERE TO WATCH
          </Text>
          {/**
           * **The attribution stays on this surface, demoted rather than hidden.**
           *
           * TMDB's terms for this data are specific and name a third party: *"In order to
           * use this data you must attribute the source of the data as JustWatch."* The
           * logos above are the data, so the credit has to travel with them — moving it
           * behind the sheet would leave the visible half of the feature uncredited.
           *
           * What it can be is quiet. Italic, tertiary, and at `caption` under a heading
           * it is now clearly subordinate to, where before it sat under a same-weight
           * label and competed with it. It is a source note, and it should read as one.
           */}
          <Text variant="caption" tone="tertiary" style={styles.attributionInline}>
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
 * **No posters here, and nothing that leaves the app.** The sheet answers "which
 * services", so a poster would be the one thing on it that is not the answer. And a logo
 * opens nothing: TMDB's payload carries no deep link into Netflix or Max, and building
 * one out of a service's name would be a guess the reader would read as a destination.
 *
 * TMDB's own watch-options page was offered as a footer action until 2026-09-05 and is
 * not any more — see the note above the foot for the founder's reasoning. So the sheet
 * is now a statement rather than a junction: the services, the market, the credit, and
 * the way out.
 */
function WhereToWatchSheet({
  titleName,
  region,
  providers,
  onClose,
}: {
  titleName: string;
  region: string;
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

      {/**
       * **There is no View watch options action, and it was removed on 2026-09-05.**
       *
       * It opened TMDB's own watch-options page for the title in the reader's market,
       * which is the only real link this data comes with — and the founder's ruling is
       * that a real link to the wrong place is still the wrong place. It sends somebody
       * out of bingd. to a web page that then sends them somewhere else, and it does not
       * do the thing its position implies: it does not open the film on the service they
       * just tapped, because TMDB publishes no such link and never has.
       *
       * **Nothing replaces it.** Manufacturing `netflix.com/title/…` out of a provider
       * name would be a guess presented as a destination, which is worse than the row
       * that went. Somebody who knows a film is on Netflix can open Netflix.
       *
       * The adapter still normalises and validates the link (`normalize.ts`), and the
       * client still carries it on `WatchAvailability`. That is deliberate: the data is
       * free, the validation is the interesting part, and re-deriving both would be the
       * cost of changing this decision back. Nothing draws it.
       */}
      <View style={styles.foot}>
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
    // Half of what it was: the rule above now carries the section's top spacing, and
    // keeping the full gap here as well would put the heading adrift below its own line.
    paddingTop: theme.space[2],
    minHeight: theme.layout.rowMinHeight,
  },
  /**
   * Inset to the gutter, at the app's hairline, and doubled — `ScoresSection`'s rule
   * verbatim, because a single `hairlineWidth` rounds away to nothing on some Android
   * densities. The top padding lives on the row below, so this sits tight to the
   * section it opens rather than floating between two.
   */
  divider: {
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.space[5],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
  copy: { flex: 1, gap: 2 },
  /** A source note, and it should read as one. See the block above it. */
  attributionInline: { fontStyle: 'italic' },
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
