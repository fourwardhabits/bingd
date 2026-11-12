import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ProviderLogo } from './ProviderLogo';
import { IMPORT_PROVIDERS, PROVIDER_NAME, type ImportProvider } from './providers';

/**
 * The two services, as one list of equal options (founder spec 2026-11-10, §7 and §9).
 *
 * Shared by Settings ▸ Import from and the onboarding question, so the two cannot drift: the
 * same rows, the same marks at the same size, the same order. Letterboxd first because it
 * is the import bingd already had; nothing else is implied by the order.
 *
 * Each row says, in a few words, what that service's file brings, so the choice is about
 * where somebody's history is rather than about formats.
 */
const DETAIL: Record<ImportProvider, string> = {
  letterboxd: 'Watched films, ratings, diary dates, and watchlist',
  imdb: 'The movies you’ve rated, from your ratings export',
};

export function ProviderChoice({ onChoose }: { onChoose: (provider: ImportProvider) => void }) {
  return (
    <View style={styles.card}>
      {IMPORT_PROVIDERS.map((provider, index) => (
        <Pressable
          key={provider}
          accessibilityRole="button"
          accessibilityLabel={`${PROVIDER_NAME[provider]}. ${DETAIL[provider]}`}
          testID={`choose-${provider}`}
          onPress={() => onChoose(provider)}
          style={({ pressed }) => [
            styles.row,
            index < IMPORT_PROVIDERS.length - 1 && styles.divided,
            pressed && styles.pressed,
          ]}
        >
          {/* A fixed box, so both names start on one edge whatever each mark's width. */}
          <View style={styles.mark}>
            <ProviderLogo provider={provider} size={22} decorative />
          </View>
          <View style={styles.words}>
            <Text variant="headline">{PROVIDER_NAME[provider]}</Text>
            <Text variant="footnote" tone="secondary">
              {DETAIL[provider]}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={theme.layout.icon.sm}
            color={theme.text.tertiary}
          />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[4],
  },
  divided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border.hairline,
  },
  pressed: { opacity: 0.7 },
  mark: { width: theme.space[10], alignItems: 'flex-start' },
  words: { flex: 1, gap: theme.space[1] },
});
