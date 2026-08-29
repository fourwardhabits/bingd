/**
 * The text half of @mentions: what the composer is currently typing, and which people a
 * finished comment names.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PURE, AND WHY IT IS DELIBERATELY NOT THE SOURCE OF TRUTH
 *
 * The server stores mentions as a relation on ids (`comment_mentions`), not as a regex
 * over the body, for three reasons its own header sets out — handles move, an edit is
 * not a new statement, and text has no memory of who has already been told. Nothing in
 * this file is allowed to weaken that.
 *
 * So the rule these functions implement is narrow and stated here once:
 *
 *   **a mention is a handle the author picked from the suggestions, which is still
 *   present in the text when they post.**
 *
 * Both halves matter. Picking is what supplies the id — this file never resolves a
 * handle to an account, and there is no lookup it could do that would not be the
 * arbitrary-user search the founder ruled out. Still-present is what makes an edit
 * honest: type `@ravi`, think better of it, delete it, and Ravi is not mentioned, with
 * no separate "remove" gesture to remember.
 *
 * A hand-typed `@somebody` that was never chosen from the list is therefore not a
 * mention. It renders as ordinary text and notifies nobody, which is the safe direction:
 * the alternative is a client that turns arbitrary strings into lookups against the
 * whole user table.
 *
 * ---------------------------------------------------------------------------
 * THE CHARSET IS THE DATABASE'S
 *
 * `username_format` (20260813000200) is `^[a-z0-9_]{3,24}$`, so a handle cannot contain
 * a dot, a dash or a capital. That is what lets `@ravi.` end at the `i`: the full stop
 * is punctuation after a mention rather than part of one, and a comment that ends in a
 * name still reads as a sentence.
 */

/** The database's handle charset, in one place. */
const HANDLE = '[a-z0-9_]';

/**
 * What the reader is typing right now, if it is a mention.
 *
 * Returns the `@`'s index and the fragment after it — `''` immediately after typing the
 * `@` itself, which is the moment the list should first appear.
 *
 * Null when there is no live fragment, which is what closes the suggestions. The three
 * ways that happens are all one rule: the `@` must be at the start of the text or
 * preceded by whitespace (so an email address is not a mention), the run between it and
 * the cursor must be handle characters only (so a space ends it), and the cursor must be
 * at the end of that run (so moving away from a half-typed name dismisses the list
 * rather than leaving it hovering over text nobody is editing).
 *
 * Case is not folded here. The fragment goes to the server, which matches with `ilike`.
 */
export function mentionFragment(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  if (cursor < 0 || cursor > text.length) return null;

  const before = text.slice(0, cursor);
  // The last `@` that opens a still-valid fragment: preceded by nothing or by
  // whitespace, and followed by handle characters all the way to the cursor.
  const match = before.match(new RegExp(`(?:^|\\s)@(${HANDLE}*)$`, 'i'));
  if (!match) return null;

  // The group always participates — `${HANDLE}*` matches the empty string — so the
  // fallback is for the type checker rather than for a case that can happen.
  const query = match[1] ?? '';
  // 24 is the longest a handle can be. Past that the reader is not naming anybody and
  // the list should get out of the way.
  if (query.length > 24) return null;

  return { start: cursor - query.length - 1, query };
}

/**
 * The text with the fragment replaced by a chosen handle, and where the cursor goes.
 *
 * A trailing space, because the next thing anybody types after a name is a word — and
 * because without it the fragment is still live and the suggestion list would reopen on
 * the handle it has just inserted.
 *
 * The tail is preserved rather than truncated: a mention added in the middle of a
 * finished sentence leaves the rest of the sentence alone.
 */
export function applyMention(
  text: string,
  fragment: { start: number; query: string },
  handle: string,
): { text: string; cursor: number } {
  const head = text.slice(0, fragment.start);
  const tail = text.slice(fragment.start + 1 + fragment.query.length);
  const inserted = `@${handle} `;
  // Not two spaces. Inserting before existing text that already begins with one would
  // otherwise widen the gap every time somebody corrected a name.
  const joined = tail.startsWith(' ') ? tail.slice(1) : tail;

  return { text: `${head}${inserted}${joined}`, cursor: head.length + inserted.length };
}

/**
 * Every handle the text names, lowercased and deduplicated.
 *
 * The same boundary rule `mentionFragment` uses, so what the composer offered and what
 * the post sends cannot disagree: preceded by start-of-text or whitespace, and ending
 * where the handle charset does.
 */
export function handlesIn(text: string): string[] {
  const found = new Set<string>();
  /**
   * The trailing lookahead is not decoration. Without it `@<24 chars>x` matches its first
   * twenty-four characters and resolves to a person whose handle is no longer in the text
   * at all — the author typed past the name and it counted anyway. Independent review 68
   * found it. The database's own bound is 24, so this is where the two meet.
   */
  for (const match of text.matchAll(new RegExp(`(?:^|\\s)@(${HANDLE}{3,24})(?!${HANDLE})`, 'gi'))) {
    // Same as above: the group is not optional, and this satisfies the checker.
    if (match[1]) found.add(match[1].toLowerCase());
  }
  return [...found];
}

/**
 * Which ids to send, given what the author picked at some point and what the text still
 * says.
 *
 * The intersection, and the two directions it protects are different:
 *
 *   - a handle in the text that was never picked has no id, so it is dropped — this is
 *     the "no arbitrary user lookup" rule;
 *   - a person picked and then deleted from the text is dropped too, which is what makes
 *     removing a mention work without a second control.
 *
 * `known` accumulates across a composing session *and* across an edit: the thread read
 * hands back what the comment already names (`activity_comments.mentions`), so reopening
 * a comment to fix a typo does not silently drop everybody in it.
 */
export function resolveMentions(text: string, known: Map<string, string>): string[] {
  const ids = new Set<string>();
  for (const handle of handlesIn(text)) {
    const id = known.get(handle);
    if (id) ids.add(id);
  }
  return [...ids];
}
