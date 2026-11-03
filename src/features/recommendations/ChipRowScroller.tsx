import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { paperAlpha, theme } from '@/ui/tokens';

export type ChipRowScrollerProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * For You's one-line chip row, and the cue that there is more of it (Visual 2.1 check,
 * 2026-11-03).
 *
 * The row scrolls sideways rather than wrapping (the founder's standing rule). On most
 * phones the last chip is cut at the edge, and the cut is the cue. But at 130% text on a
 * 320pt phone Sent to You and Group Picks end exactly at the edge, and Filters sat wholly
 * off-screen with nothing to say it was there. So while anything lies past the right edge,
 * the edge fades into Paper under a small chevron; scrolled to the end, both go.
 *
 * The fade is bands of Paper, the technique `HeaderBoundary` and `TitleHero` use, because
 * a real gradient would be `expo-linear-gradient`: a native module and a new fingerprint.
 * It is decoration, so it takes no touches and is hidden from screen readers, which reach
 * every chip by swiping whether it is on screen or not.
 */
export function ChipRowScroller({ children, style, testID }: ChipRowScrollerProps) {
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  const more = viewport > 0 && content - (offset + viewport) > 1;

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        alwaysBounceHorizontal={false}
        style={style}
        testID={testID}
        onLayout={(event) => setViewport(event.nativeEvent.layout.width)}
        onContentSizeChange={(width) => setContent(width)}
        onScroll={(event) => setOffset(event.nativeEvent.contentOffset.x)}
        scrollEventThrottle={32}
      >
        {children}
      </ScrollView>
      {more ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.hint}
          testID={testID ? `${testID}-more` : undefined}
        >
          {FADE.map((alpha) => (
            <View key={alpha} style={[styles.band, { backgroundColor: paperAlpha(alpha) }]} />
          ))}
          <View style={styles.glyph}>
            <Ionicons
              name="chevron-forward"
              size={theme.layout.icon.sm}
              color={theme.text.secondary}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Four 8pt bands, Paper going opaque towards the edge. */
const FADE = [0.3, 0.6, 0.85, 0.97];

const styles = StyleSheet.create({
  hint: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  band: { width: 8 },
  // Centred on the chips rather than on the row, which carries 12pt above them and 16pt
  // below (`filterRow`).
  glyph: {
    position: 'absolute',
    right: theme.space[1],
    top: theme.space[3],
    bottom: theme.space[4],
    justifyContent: 'center',
  },
});
