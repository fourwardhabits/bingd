/**
 * Seeded randomness. Nothing in the harness calls `Math.random`, so the same snapshot always
 * produces the same folds, the same bootstrap and the same report.
 */

/** mulberry32: small, fast and good enough for resampling. Returns a [0, 1) generator. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, as an unsigned 32-bit integer. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable [0, 1) value for a string, e.g. to order rows for fold assignment. */
export const unitHash = (text: string): number => hash32(text) / 4294967296;
