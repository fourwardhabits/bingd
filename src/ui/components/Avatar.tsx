import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type AvatarProps = {
  uri?: string | null;
  name: string;
  size?: keyof typeof theme.layout.avatar;
};

export function Avatar({ uri, name, size = 'md' }: AvatarProps) {
  const edge = theme.layout.avatar[size];

  /**
   * Below `xs` the circle cannot hold two characters.
   *
   * The placeholder was two initials at footnote size at every size. That is fine
   * from 24pt up and is not fine at the 18pt chip the feed row overlays on a poster:
   * `SK` at 13pt is wider than the circle, so `overflow: hidden` clips it and what
   * renders is a letter and a half — a rendering fault rather than a placeholder.
   *
   * One letter, one step down in size, and no Dynamic Type scaling on that letter,
   * because a fixed circle cannot grow with it and the overflow would be back.
   */
  const compact = edge < theme.layout.avatar.xs;
  const initials = name
    .split(/\s+/)
    .slice(0, compact ? 1 : 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <View style={[styles.frame, { width: edge, height: edge, borderRadius: edge / 2 }]}>
      {uri ? (
        <Image source={{ uri }} style={styles.fill} contentFit="cover" />
      ) : (
        <Text
          variant={compact ? 'caption' : 'footnote'}
          tone="tertiary"
          allowFontScaling={!compact}
        >
          {initials}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: theme.border.hairline,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.surface.sunken,
  },
  fill: {
    ...StyleSheet.absoluteFill,
  },
});
