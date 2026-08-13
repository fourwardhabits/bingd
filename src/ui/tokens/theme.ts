import { border, bucket, semantic, surface, text } from './color';
import {
  duration,
  elevation,
  layout,
  poster,
  radius,
  space,
} from './layout';
import { typography } from './typography';

/**
 * Components consume tokens through this object rather than importing color
 * directly, so the Midnight dark theme in PRD §5 is purely additive later — a
 * second theme object, not a search-and-replace across the app.
 *
 * See docs/architecture/client.md §4.
 */
const parchment = {
  name: 'parchment',
  surface,
  border,
  text,
  semantic,
  bucket,
  typography,
  space,
  layout,
  radius,
  elevation,
  duration,
  poster,
} as const;

export type Theme = typeof parchment;

/** v1 is Parchment light only (PRD §5). Midnight is reserved, not built. */
export const theme = parchment;

/**
 * A hook rather than a bare export so adding Midnight later means adding a
 * provider, not rewriting every call site.
 */
export const useTheme = (): Theme => theme;
