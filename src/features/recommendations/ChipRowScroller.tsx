import { Ionicons } from '@expo/vector-icons';
import { useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

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
 * **The cue is a press, not a picture** (independent review, 2026-11-03). It sits over the
 * edge of whichever chip is there, and a chevron that let the tap fall through to that chip
 * would say "more this way" and then do something else. So a tap on it scrolls the row to
 * its end, and it is 44pt wide, the target floor. Screen readers skip it: they reach every
 * chip by swiping, on screen or not, and a second way to scroll would be noise.
 *
 * The fade is bands of Paper, the technique `HeaderBoundary` and `TitleHero` use, because
 * a real gradient would be `expo-linear-gradient`: a native module and a new fingerprint.
 */
export function ChipRowScroller({ children, style, testID }: ChipRowScrollerProps) {
  const scroller = useRef<ScrollView>(null);
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  const more = viewport > 0 && content - (offset + viewport) > 1;

  return (
    <View>
      <ScrollView
        ref={scroller}
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
        <Pressable
          onPress={() => scroller.current?.scrollToEnd({ animated: true })}
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
        </Pressable>
      ) : null}
    </View>
  );
}

/** Four 11pt bands, Paper going opaque towards the edge: 44pt in all, the target floor. */
const FADE = [0.3, 0.6, 0.85, 0.97];

const styles = StyleSheet.create({
  hint: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  band: { width: theme.layout.minTapTarget / FADE.length },
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
