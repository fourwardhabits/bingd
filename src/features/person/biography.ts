/**
 * A cut biography, ended somewhere a reader can stop.
 *
 * At the last full stop if that keeps most of the text, otherwise at the last space with
 * an ellipsis — never in the middle of a word.
 */
export function shortened(text: string): string {
  const body = text.trimEnd();
  const sentence = Math.max(body.lastIndexOf('. '), body.lastIndexOf('.\n'));
  if (sentence >= body.length * 0.6) return body.slice(0, sentence + 1);
  const space = body.lastIndexOf(' ');
  return `${(space > 0 ? body.slice(0, space) : body).replace(/[\s,;:–—-]+$/, '')}…`;
}
