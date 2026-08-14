import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { BrandLockup } from './BrandLockup';

export type AppHeaderProps = {
  right?: ReactNode;
};

export function AppHeader({ right }: AppHeaderProps) {
  return (
    <View style={styles.wrap} accessibilityRole="header">
      <BrandLockup size="sm" />
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: theme.layout.control.headerHeight,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  right: {
    marginLeft: theme.space[4],
    alignItems: 'flex-end',
  },
});

