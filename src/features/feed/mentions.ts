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
 *   **a mention is a handle in the text that the server can resolve to somebody the
 *   author is allowed to name.**
 *
 * Until `20260908000100` the first half of that read "a handle the author picked from
 * the suggestions", and this file was the only thing that decided. It was too narrow in
 * the one way anybody notices: typing a friend's handle, which is what people who know
 * the handle do, posted a comment that looked like a mention, was spelled like a mention
 * and notified nobody. `_resolve_comment_mentions` now parses the body server-side and
 * resolves each handle through `_can_mention` — the same eligibility rule a picked id
 * always faced. Since `20260909000100` that rule is `can_discover_profile`, the oracle
 * People search runs on, bounded by the mentioned person being able to see the activity:
 * a handle belonging to somebody blocked, suspended, or unable to see the post resolves
 * to nobody, and one belonging to somebody the reader could simply look up resolves to
 * them.
 *
 * What that leaves this file is a *supporting* role, and it is deliberate that it is not
 * a deciding one:
 *
 *   - `resolveMentions` still sends the ids the author picked. They are not the source
 *     of truth any more, but they are what lets the server prefer a person the author
 *     explicitly chose over whoever holds that name today, and what keeps a mention
 *     working across a rename.
 *   - **this file still never resolves a handle to an account.** No lookup here, and no
 *     privacy decision either. The client's job is to offer the people the server
 *     already said were offerable, and to draw what the server already said the comment
 *     names. Which accounts those are is a question with one answer, in the database.
 *
 * Still-present in the text is what makes an edit honest, and that half is unchanged:
 * type `@ravi`, think better of it, delete it, and Ravi is not mentioned, with no
 * separate "remove" gesture to remember. The server applies the same intersection.
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
 * Where a finished handle starts and stops, built fresh each call because a `g` regex
 * carries `lastIndex` between uses.
 *
 * One definition, shared by the two places that need it — `handlesIn`, which decides who
 * a posted comment names, and `segmentMentions`, which decides what a read comment draws
 * as a link. They were written twice and immediately disagreed by one backslash, which is
 * the whole argument for this constant: a name that is sent and a name that lights up must
 * be the same name.
 *
 * The leading `(?:^|s)` is what keeps `email@example.com` out — an `@` inside a word is
 * not a mention — and the trailing lookahead is not decoration either. Without it
 * `@<24 chars>x` matches its first twenty-four characters and resolves to a person whose
 * handle is no longer in the text at all: the author typed past the name and it counted
 * anyway. Independent review 68 found that. The database's own bound is 24, so this is
 * where the two meet.
 */
const mentionPattern = () =>
  new RegExp(`(?:^|\\s)@(${HANDLE}{3,24})(?!${HANDLE})`, 'gi');

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
  for (const match of text.matchAll(mentionPattern())) {
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

/**
 * One piece of a rendered comment body: ordinary text, or a name that is a link.
 *
 * `text` is what the body actually spells including the `@`, so joining every span's
 * `text` in order reproduces the body exactly. Nothing is normalised on the way to the
 * screen; a reader must see what the author typed.
 */
export type MentionSpan =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; id: string; username: string };

/**
 * Split a comment body into what to draw plainly and what to draw as a profile link.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER DECIDES WHO IS A LINK, NOT THIS FUNCTION
 *
 * `mentions` is `activity_comments.mentions` — the ledger rows for this comment, already
 * filtered through `can_view_profile` for *this reader*. So the population here is not
 * "handles that look real", it is "people this comment provably names and this reader is
 * allowed to be shown". A handle that is not in that list stays ordinary text, and the
 * three ways it gets there are all ones we want to render as text: nobody by that name,
 * somebody this reader has blocked, and a tombstone (which reports no mentions at all).
 *
 * That is also why this is not the place to be clever. Highlighting a handle the server
 * did not confirm would draw a link to an account the reader may not see, from a string
 * the author controls.
 *
 * ---------------------------------------------------------------------------
 * BOTH SPELLINGS, AND WHY THE LINK FOLLOWS THE PERSON
 *
 * A mention row carries `username` (what they are called now) and `handle` (what this
 * body spells, frozen when the mention was applied). They differ exactly when somebody
 * has renamed since. The body still says `@ravi`, so `@ravi` is what must light up — but
 * tapping it must open `ravi_2`, because that is who was named. Hence: match on either
 * spelling, navigate on `username`.
 *
 * The boundary rule is `handlesIn`'s, character for character, so a name the composer
 * would have sent and a name the reader sees underlined cannot disagree.
 */
export function segmentMentions(
  text: string,
  mentions: readonly { id: string; username: string; handle?: string | null }[],
): MentionSpan[] {
  if (!text) return [];

  const bySpelling = new Map<string, { id: string; username: string }>();
  for (const mention of mentions) {
    const target = { id: mention.id, username: mention.username };
    if (mention.username) bySpelling.set(mention.username.toLowerCase(), target);
    // Second, so a frozen spelling never displaces a live one if a rename has made
    // somebody else's current handle equal to this comment's old one. The live owner of
    // a handle is the safer thing to point at when the two collide.
    if (mention.handle && !bySpelling.has(mention.handle.toLowerCase())) {
      bySpelling.set(mention.handle.toLowerCase(), target);
    }
  }
  if (bySpelling.size === 0) return [{ kind: 'text', text }];

  const spans: MentionSpan[] = [];
  let cut = 0;

  for (const match of text.matchAll(mentionPattern())) {
    const handle = match[1];
    if (!handle || match.index === undefined) continue;

    const target = bySpelling.get(handle.toLowerCase());
    if (!target) continue;

    // The match deliberately swallows the character before the `@` (start-of-text or
    // whitespace), so the `@` is at the end of the match minus the handle. Computed
    // rather than assumed, because the leading group is empty at index 0.
    const at = match.index + match[0].length - handle.length - 1;

    if (at > cut) spans.push({ kind: 'text', text: text.slice(cut, at) });
    spans.push({
      kind: 'mention',
      text: text.slice(at, at + handle.length + 1),
      id: target.id,
      username: target.username,
    });
    cut = at + handle.length + 1;
  }

  if (cut < text.length) spans.push({ kind: 'text', text: text.slice(cut) });
  return spans;
}
