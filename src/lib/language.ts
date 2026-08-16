/**
 * An ISO 639-1 code as a word.
 *
 * `Intl.DisplayNames` uses the platform's own tables, so "ja" reads as "Japanese" in
 * English and "japonais" in French, and no list has to be maintained here. It was
 * inline in the title screen; the filter sheet needs the same thing, and a raw code
 * on a control is the one outcome the brief rules out — "te" is a database value, not
 * a label.
 *
 * Returns null rather than the code when it cannot resolve one, so a caller can
 * decide between falling back and dropping the option entirely. The hero's rank line
 * drops it; the filter sheet falls back, because an option that exists in the data
 * should still be selectable even if we cannot name it well.
 */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'language' }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}
