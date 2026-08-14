import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';

export function Divider() {
  return <View style={styles.rule} />;
}

const styles = StyleSheet.create({
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border.hairline,
    marginHorizontal: theme.layout.gutter,
  },
});
