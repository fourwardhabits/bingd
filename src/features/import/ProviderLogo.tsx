import { StyleSheet, Text as RNText, View } from 'react-native';

import { fontFamily, partnerMark, theme } from '@/ui/tokens';

import { PROVIDER_NAME, type ImportProvider } from './providers';

/**
 * The Letterboxd and IMDb marks, small and recognisable (founder spec 2026-11-10, §7).
 *
 * **Drawn, not embedded.** The app binary has no SVG renderer, and adding one would move the
 * native fingerprint and end OTA delivery for the whole import (the reason `expo-document-
 * picker` was refused in `letterboxd-import.md` §5). Both marks are geometric enough to draw
 * faithfully from Views: Letterboxd's three overlapping dots, and IMDb's gold badge with its
 * black wordmark. If the founder prefers the brand kits' official raster files, an `Image`
 * replaces the body of `ProviderLogo` and no caller changes.
 *
 * **One height for both.** `size` is the mark's height in points; the Letterboxd dots and the
 * IMDb badge share it, so two marks side by side read as a pair rather than as two sizes.
 *
 * Decorative where a label already names the service (the provider choice), and labelled
 * where it stands alone.
 */
export function ProviderLogo({
  provider,
  size = 20,
  decorative = false,
}: {
  provider: ImportProvider;
  size?: number;
  decorative?: boolean;
}) {
  const a11y = decorative
    ? {
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const,
      }
    : {
        accessible: true,
        accessibilityRole: 'image' as const,
        accessibilityLabel: PROVIDER_NAME[provider],
      };

  if (provider === 'letterboxd') {
    const dot = size * 0.72;
    const overlap = dot * 0.22;
    const colours = [
      partnerMark.letterboxd.orange,
      partnerMark.letterboxd.green,
      partnerMark.letterboxd.blue,
    ];
    return (
      <View
        {...a11y}
        testID="logo-letterboxd"
        style={[styles.row, { height: size, width: dot * 3 - overlap * 2 }]}
      >
        {colours.map((backgroundColor, index) => (
          <View
            key={backgroundColor}
            style={{
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor,
              marginLeft: index === 0 ? 0 : -overlap,
            }}
          />
        ))}
      </View>
    );
  }

  return (
    <View
      {...a11y}
      testID="logo-imdb"
      style={[
        styles.badge,
        {
          height: size,
          width: size * 2,
          borderRadius: size * 0.18,
          backgroundColor: partnerMark.imdb.gold,
        },
      ]}
    >
      <RNText
        allowFontScaling={false}
        style={[styles.wordmark, { fontSize: size * 0.58, color: partnerMark.imdb.ink }]}
      >
        IMDb
      </RNText>
    </View>
  );
}

/** Both marks, as the Settings row carries them. */
export function ProviderLogos({ size = 16 }: { size?: number }) {
  return (
    <View
      style={styles.pair}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <ProviderLogo provider="letterboxd" size={size} decorative />
      <ProviderLogo provider="imdb" size={size} decorative />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  badge: { alignItems: 'center', justifyContent: 'center' },
  // The wordmark is a heavy grotesque; Inter SemiBold is the closest face the app ships.
  wordmark: {
    fontFamily: fontFamily.sansSemibold,
    letterSpacing: -0.3,
    includeFontPadding: false,
  },
  pair: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
});
