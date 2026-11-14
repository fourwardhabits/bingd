import type { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

/**
 * **Rerank's one glyph** (founder spec §5, 2026-11-13): the bidirectional left/right arrows.
 *
 * The founder named it "arrow-left-right". The app draws every glyph from Ionicons
 * (`SheetRow`'s `icon` is typed to Ionicons names), and Ionicons' left/right arrows are
 * `swap-horizontal`; the `-outline` cut matches the neighbouring menu glyphs
 * (`repeat-outline`, `list-outline`). MaterialCommunityIcons has a literal `arrow-left-right`
 * in the same package, but drawing it would need `SheetRow` to take a second icon family.
 *
 * `star-outline` stays the initial **Rank** glyph only; nothing that reranks may use it.
 */
export const RERANK_ICON: ComponentProps<typeof Ionicons>['name'] = 'swap-horizontal-outline';

/** Rerank's one word, wherever the act is offered (founder spec §5: not Edit ranking or Recompare). */
export const RERANK_LABEL = 'Rerank';
