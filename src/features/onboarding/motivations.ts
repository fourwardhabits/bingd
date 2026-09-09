/**
 * What somebody says they want, and the answer the product gives back.
 *
 * Steps 3 and 4 of the first-run flow (prototype `01-screen-map.md` §§3-4). Two screens
 * that are really one question: the reader picks any number of the six, and the next
 * screen answers each pick with the feature that serves it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORDER IS A CONSTANT AND NOT A SORT
 *
 * `MOTIVATIONS` is the canonical order and **is never re-sorted by what was picked**.
 * The alternative — floating the chosen ones to the top of step 4 — sounds helpful and
 * is not: the reader has just met these six in a fixed order, and reordering them one
 * screen later asks them to find their own answers again in a list that has moved. The
 * order is the same on both screens, and step 4 simply omits what was not chosen.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ANSWER IS SPLIT IN TWO
 *
 * `feature` is rendered bold and `answer` is not, which is the whole of the emphasis on
 * that card. It exists so the reader picks up the app's own vocabulary here rather than
 * meeting it cold in the product: somebody who chose "pick something with friends" has
 * now been told that the thing they want is called Group Picks, before they ever see the
 * words on a tab.
 *
 * Stored as two fields rather than as one string with markup in it, because the
 * alternative is a renderer that parses asterisks out of copy — and copy that has to be
 * parsed is copy a translator or a careless edit can silently break.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE STRINGS MAY NOT DO
 *
 * **Name a surface that does not exist.** `Trending now` and `Group Picks` are the real
 * names of real things; `Top Rated` is now real too (`20260913000100`) and lives in the
 * same For You selector, which is why the For You answer can mention the community wall
 * without naming a screen the reader would then hunt for. Onboarding copy naming a place
 * somebody cannot find is the one kind of copy error that costs trust immediately.
 *
 * **Promise a feeling.** Not one of the six says delightful, effortless or smarter. Six
 * cards of adjectives is the version of this screen that reads as advertising.
 */

/**
 * The six, as stored and as reported.
 *
 * A closed vocabulary rather than free text, because these slugs are the one thing in
 * onboarding that says anything about *why* somebody downloaded the app, and they are
 * reported to analytics. A fixed set is what makes that report readable a quarter later
 * and what keeps `ALLOWED_PROPERTY_KEYS`' promise that nothing user-written is sent.
 */
export type MotivationId =
  | 'favorites'
  | 'friends_watching'
  | 'next_watch'
  | 'group_picks'
  | 'taste_match'
  | 'collection';

export type Motivation = {
  id: MotivationId;
  /**
   * The row on step 3, and the card header on step 4.
   *
   * One string for both. `SectionHeader` upper-cases and colours it Maroon, so the card
   * header is a *treatment* of the same words rather than a second copy of them that an
   * edit could leave disagreeing with the row the reader actually tapped.
   */
  label: string;
  /** The feature's real name, bold, opening the answer. */
  feature: string;
  /** The rest of the answer, ordinary weight. */
  answer: string;
};

/** The canonical order. Fixed by the founder, and never re-sorted. See the header. */
export const MOTIVATIONS: readonly Motivation[] = [
  {
    id: 'favorites',
    label: 'Know my favorites',
    feature: 'Ranking.',
    answer:
      'Every movie finds its place through quick comparisons, so your Top 5 and Top 10 stay clear as your list grows.',
  },
  {
    id: 'friends_watching',
    label: 'See what my friends are watching',
    feature: 'Feed.',
    answer:
      'See what friends are ranking and loving, then save anything that looks worth watching.',
  },
  {
    id: 'next_watch',
    label: 'Find my next watch',
    feature: 'For You.',
    answer:
      'Recommendations shaped by what you rank, plus Trending now when you want to see what everyone else is watching.',
  },
  {
    id: 'group_picks',
    label: 'Pick something with friends',
    feature: 'Group Picks.',
    answer:
      "Choose who's watching and bingd. finds movies your group is most likely to agree on.",
  },
  {
    id: 'taste_match',
    label: 'Compare taste with friends',
    feature: 'Taste Match.',
    answer:
      "See how closely your rankings line up once you've watched enough of the same things.",
  },
  {
    id: 'collection',
    label: "Keep track of what I've watched",
    feature: 'Collection.',
    answer: "Keep everything you've watched, ranked, and saved in one place.",
  },
] as const;

/**
 * The picked motivations, in canonical order, whatever order they were tapped in.
 *
 * Step 4 renders this directly. Taking a `Set` rather than an array is deliberate: the
 * selection *is* a set, and accepting one removes the only way step 4 could ever draw
 * the same card twice.
 */
export function chosenMotivations(picked: ReadonlySet<MotivationId>): Motivation[] {
  return MOTIVATIONS.filter((motivation) => picked.has(motivation.id));
}

/**
 * The set as one analytics property.
 *
 * **A string, and that is not a shortcut.** `sanitize` in `lib/analytics.ts` accepts
 * scalars only and drops arrays outright, so that a whole row cannot reach a vendor
 * because somebody spread an object into a property bag. An array here would not be
 * rejected loudly; it would be *discarded silently*, and the event would arrive with
 * every other property intact and this one absent. That is the worst failure available:
 * a green test and no data.
 *
 * So the set is joined the way `source_mix` already reports a tally — a delimited string
 * over a closed vocabulary, in canonical order so two accounts that picked the same
 * three produce the same value and can be grouped.
 */
export function motivationsProperty(picked: ReadonlySet<MotivationId>): string {
  return chosenMotivations(picked)
    .map((motivation) => motivation.id)
    .join('|');
}
