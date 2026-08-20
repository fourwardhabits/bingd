import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type WordmarkProps = {
  size?: 'sm' | 'md' | 'lg';
};

const VARIANT = {
  sm: 'title2',
  md: 'title1',
  lg: 'display',
} as const;

export function Wordmark({ size = 'md' }: WordmarkProps) {
  return (
    <Text variant={VARIANT[size]} style={styles.wordmark}>
      bingd.
    </Text>
  );
}

const styles = StyleSheet.create({
  wordmark: {
    color: theme.semantic.action,
  },
});
