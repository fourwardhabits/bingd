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

/**
 * How far the lockup sits below the centre of whatever row it is centred in: its top
 * margin, of which a centred row gives back half. Exported so a control beside it in the
 * app header can sit on the logo's centre line rather than the row's.
 */
export const LOCKUP_TOP_MARGIN = theme.space[1];

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: LOCKUP_TOP_MARGIN,
  },
});
