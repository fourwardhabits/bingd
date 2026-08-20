import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';

export type BackdropProps = {
  uri?: string | null;
  scrim?: boolean;
};

export function Backdrop({ uri, scrim = false }: BackdropProps) {
  if (!uri) return null;

  return (
    <View style={styles.frame}>
      <Image source={{ uri }} contentFit="cover" style={styles.fill} transition={theme.duration.state} />
      {scrim ? <View style={styles.scrim} /> : null}
      <View pointerEvents="none" style={styles.hairline} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: theme.radius.card,
    aspectRatio: theme.layout.aspect.backdrop,
    overflow: 'hidden',
    backgroundColor: theme.surface.sunken,
  },
  fill: {
    ...StyleSheet.absoluteFill,
  },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: theme.border.hairline,
  },
  hairline: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    borderRadius: theme.radius.card,
  },
});
