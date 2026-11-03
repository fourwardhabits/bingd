import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { BrandMark } from './BrandMark';
import { Wordmark } from './Wordmark';

export type BrandLockupProps = {
  size?: 'sm' | 'md' | 'lg';
  reversed?: boolean;
};

const GAP = {
  sm: 6,
  md: 8,
  lg: 12,
} as const;

export function BrandLockup({ size = 'md', reversed = false }: BrandLockupProps) {
  return (
    <View style={[styles.row, { gap: GAP[size] }]}>
      <BrandMark size={size} decorative reversed={reversed} />
      <Wordmark size={size} reversed={reversed} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.space[1],
  },
});
