import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

export type UserResult = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** Present so a caller can tell a private account it may see from a public one. */
  visibility: 'public' | 'private';
};

type UserRow = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  visibility: 'public' | 'private';
};

/**
 * What a member search actually looks for, once `@` has been accounted for.
 *
 * **`@` is a hint, not a mode.** Typing `@suraj` plainly means "the member suraj", so
 * the handle is matched without the sigil and Members lead the results — but a title
 * can legitimately begin with `@`, and a search box that stops looking for titles
 * because of one character would simply fail to find those. So there is no mode switch
 * anywhere: the sigil changes the *order* of two sections, never the presence of either.
 *
 * Returns the query to match members on, and whether they should lead.
 */
export function memberQuery(query: string): { text: string; leads: boolean } {
  const trimmed = query.trim();
  if (!trimmed.startsWith('@')) return { text: trimmed, leads: false };
  // Only the leading sigil, and only one. `@@` is not a handle and stripping greedily
  // would turn it into one.
  return { text: trimmed.slice(1).trim(), leads: true };
}

/**
 * People matching what was typed.
 *
 * Two things this hook deliberately does **not** do.
 *
 * It does not filter. `search_users` applies `can_view_profile` per row, so a blocked,
 * suspended or unfollowed-private account never arrives — and a second filter here
 * would be a second copy of the rule, which is how the two halves come to disagree.
 * Nothing in this file knows what a block is.
 *
 * And it does not debounce or cache separately from the title search. It runs on the
 * same already-debounced input, and `profiles` is one row per account rather than a
 * catalogue of millions, so there is nothing here worth the complexity `useTitleSearch`
 * needs.
 *
 * Not keyed by the viewer, which is worth justifying because almost every other key in
 * this codebase is. The results genuinely differ per viewer — that is the whole of
 * `can_view_profile` — so a shared key would be a leak. It is keyed by the query
 * *and* the viewer for exactly that reason.
 */
export function useUserSearch(query: string, viewerId: string, limit = 10) {
  // `search_users` matches handles as they are stored, which is without the `@`.
  const trimmed = memberQuery(query).text;

  return useQuery({
    queryKey: ['user-search', viewerId, trimmed, limit],
    enabled: trimmed.length > 0,
    // A list that blinks on every keystroke reads as slower than one that lags a beat
    // behind — the same choice `useTitleSearch` makes.
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<UserResult[]> => {
      const { data, error } = await supabase.rpc('search_users', {
        p_query: trimmed,
        p_limit: limit,
      });
      if (error) throw error;

      return ((data ?? []) as UserRow[]).map((row) => ({
        id: row.id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
        visibility: row.visibility,
      }));
    },
  });
}

/**
 * Whether a person is a good enough match to earn a place under **All**.
 *
 * The founder's rule for the combined tab is "a compact Users section only for
 * meaningful name/handle matches", with titles staying dominant. Without a definition
 * of *meaningful* that rule decays into "always", because `search_users` matches
 * substrings — so typing "the" would put three strangers above a page of films.
 *
 * Meaningful is: the query is the whole handle, or it starts the handle, or it starts
 * the display name. Somebody typing "ann" is plausibly looking for `anna`; somebody
 * typing "ann" is not plausibly looking for `deanna`, and `deanna` is still one tap
 * away under Users.
 *
 * Folded the same way the database folds, so "AMÉLIE" and "amelie" agree with what the
 * server matched. This is a *display* rule and never an authorisation one — every row
 * it hides is a row the viewer is entitled to see, and the Users tab shows them all.
 */
export function meaningfulMatch(user: UserResult, query: string): boolean {
  const { text, leads } = memberQuery(query);
  const q = fold(text);
  if (!q) return false;
  // An explicit `@` is somebody naming a person. The gate exists to stop strangers
  // outranking films for a query that was plainly about a title, and a query that opens
  // with a handle sigil is not that query.
  if (leads) return true;
  const handle = fold(user.username);
  return handle === q || handle.startsWith(q) || fold(user.name).startsWith(q);
}

/**
 * `media_fold`'s Latin fold, in JavaScript.
 *
 * A second implementation of a database function is normally the wrong thing, and it
 * is justified here only because of what it is used for: this decides whether a row
 * the server already returned is *shown in the All tab*. If the two folds ever
 * disagree the cost is a person appearing under Users instead of All — never a person
 * appearing who should not.
 */
const FROM = 'áàâäãåāąăæçćčđďðéèêëēęěğíìîïīıłľñńňóòôöõøōőœřšśşßťțþúùûüūůűýÿžźż';
const TO = 'aaaaaaaaaacccdddeeeeeeegiiiiiillnnnooooooooorsssstttuuuuuuuyyzzz';

function fold(value: string): string {
  const lower = value.normalize('NFC').toLowerCase();
  let out = '';
  for (const character of lower) {
    const index = FROM.indexOf(character);
    out += index === -1 ? character : TO[index];
  }
  return out;
}
