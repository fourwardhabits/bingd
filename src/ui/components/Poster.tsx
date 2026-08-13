import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { posterHasShadow, posterRadius, type PosterSize } from '../tokens';
import { Text } from './Text';

export type PosterProps = {
  uri?: string | null;
  title: string;
  size?: PosterSize;
  /** Blurhash from the catalog, used as the placeholder while artwork loads. */
  blurhash?: string | null;
};

/**
 * Artwork as a printed object on a page, following Apple Wallet's model for
 * saturated cards on a light ground (design-system.md §1, §7).
 *
 * The hairline border is not decoration: without it pale posters dissolve into
 * Parchment. Never render this full-bleed, behind text, or edge to edge.
 */
export function Poster({ uri, title, size = 'sm', blurhash }: PosterProps) {
  const { width, height } = theme.poster[size];
  const radius = posterRadius(size);

  return (
    <View
      style={[
        { width, height, borderRadius: radius },
        styles.frame,
        posterHasShadow(size) && theme.elevation.e1,
      ]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          placeholder={blurhash ? { blurhash } : undefined}
          contentFit="cover"
          transition={theme.duration.state}
          style={[styles.fill, { borderRadius: radius }]}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <MissingArtwork title={title} size={size} radius={radius} />
      )}
      <View
        pointerEvents="none"
        style={[styles.hairline, { borderRadius: radius }]}
      />
    </View>
  );
}

/**
 * A designed state rather than a broken image. Common in practice, because
 * Letterboxd imports reach obscure titles the catalog has no poster for.
 */
function MissingArtwork({
  title,
  size,
  radius,
}: {
  title: string;
  size: PosterSize;
  radius: number;
}) {
  const initials = title
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <View style={[styles.fill, styles.missing, { borderRadius: radius }]}>
      <Text variant={size === 'xs' || size === 'sm' ? 'title2' : 'title1'} tone="tertiary">
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: theme.surface.sunken,
    overflow: 'visible',
  },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  missing: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface.sunken,
  },
  hairline: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
  },
});
