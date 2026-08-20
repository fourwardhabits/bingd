import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { BrandMark } from './BrandMark';
import { Wordmark } from './Wordmark';

export type BrandLockupProps = {
  size?: 'sm' | 'md' | 'lg';
};

const GAP = {
  sm: 6,
  md: 8,
  lg: 12,
} as const;

export function BrandLockup({ size = 'md' }: BrandLockupProps) {
  return (
    <View style={[styles.row, { gap: GAP[size] }]}>
      <BrandMark size={size} decorative />
      <Wordmark size={size} />
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
