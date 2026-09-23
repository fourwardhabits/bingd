/**
 * A list's public address.
 *
 * `https://bingd.app/lists/<uuid>`, which is **stable across renames** — the id is the
 * identity and the title is not — and which AASA and `assetlinks.json` have claimed
 * since 20260813001300. Nothing about this URL has to be built at share time except the
 * id, and the id is a uuid the server gave us.
 *
 * The origin is a literal here for the reason `lib/legal.ts` gives about its three: this
 * is the same address in development, in the beta and in production, because it is where
 * the site is, not a build-time choice.
 *
 * Pretty URLs (`/u/<handle>/lists/<slug>`) are a later question and would apply to
 * **public lists only** — a link-only list must never gain a handle-derived, guessable
 * address (§J).
 */
export const listUrl = (listId: string) => `https://bingd.app/lists/${listId}`;

/**
 * What the share sheet sends.
 *
 * The title, then the URL, in the shape `RecommendSheet` already uses for a title — one
 * sentence somebody can read in a message thread before they decide whether to tap. No
 * description: it can be a thousand characters, and a share body is not the place to
 * find that out.
 */
export const listShareMessage = (title: string, listId: string) =>
  `${title} on bingd\n${listUrl(listId)}`;
