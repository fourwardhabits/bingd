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
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <View style={[styles.frame, { width: edge, height: edge, borderRadius: edge / 2 }]}>
      {uri ? (
        <Image source={{ uri }} style={styles.fill} contentFit="cover" />
      ) : (
        <Text variant="footnote" tone="tertiary">
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
