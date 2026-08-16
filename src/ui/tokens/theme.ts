import { border, bucket, bucketInk, semantic, surface, text } from './color';
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
const paper = {
  name: 'paper',
  surface,
  border,
  text,
  semantic,
  bucket,
  bucketInk,
  typography,
  space,
  layout,
  radius,
  elevation,
  duration,
  poster,
} as const;

export type Theme = typeof paper;

/**
 * v1 is light only. Named `paper` since 2026-08-15, when the base surface moved
 * off Parchment — Parchment is still in the ramp, as `surface.sunken`, but it is
 * no longer what the theme is (design-system.md §1).
 */
export const theme = paper;

/**
 * A hook rather than a bare export so adding Midnight later means adding a
 * provider, not rewriting every call site.
 */
export const useTheme = (): Theme => theme;
