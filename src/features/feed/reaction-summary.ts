import type { ReactNode } from 'react';

import type { ActivityReaction } from '@/ui/components/ActivityRow';

import {
  REACTION_GLYPH,
  REACTION_LABEL,
  type ReactionKind,
  type ReactionSummary,
  type Reactor,
} from './use-reactions';

/**
 * The sentence under a post that says who reacted (founder, 2026-11-10: "Priya and 3
 * others like this" in place of a bare "1").
 *
 * Everything here is pure: the summary it reads is the one `useReactions` already
 * built from rows `reactions_read` let through, so a blocked or hidden reactor is
 * absent before this file sees anything, and nothing here filters a second time.
 */

/**
 * The viewer's relationship strength with each reactor, keyed by user id — the
 * Affinity Score (social interaction), never Taste Match.
 *
 * Optional, and absent today: the score is `_proactive_affinity` in draft PR #220,
 * which is not on main and is documented there as never returned to a client. Until
 * a read exists, every caller passes nothing and selection is by recency.
 */
export type AffinityLookup = ReadonlyMap<string, number>;

/**
 * Whom the summary names: the eligible reactor with the highest affinity, the most
 * recent reaction among equals, then the user id so two reads of the same data always
 * agree. Eligible means nameable and not the viewer, who is "You" instead.
 *
 * A reactor with no affinity entry ranks below every reactor with one, which is what
 * makes "no affinity at all" fall through to pure recency.
 */
export function pickHighlightedReactor(
  people: readonly Reactor[],
  viewerId: string,
  affinity?: AffinityLookup,
): Reactor | null {
  let best: Reactor | null = null;
  let bestScore = -Infinity;
  for (const person of people) {
    if (person.userId === viewerId || !person.name.trim()) continue;
    const score = affinity?.get(person.userId) ?? -Infinity;
    if (!best || isBetter(person, score, best, bestScore)) {
      best = person;
      bestScore = score;
    }
  }
  return best;
}

function isBetter(a: Reactor, aScore: number, b: Reactor, bScore: number) {
  if (aScore !== bScore) return aScore > bScore;
  const aAt = a.reactedAt ? Date.parse(a.reactedAt) : -Infinity;
  const bAt = b.reactedAt ? Date.parse(b.reactedAt) : -Infinity;
  if (aAt !== bAt) return aAt > bAt;
  return a.userId < b.userId;
}

/** `1,234` stays readable up to four digits; past that the sentence would be mostly number. */
export function formatCount(count: number) {
  // Grouped by hand: Hermes' `toLocaleString` depends on the Intl build it shipped with.
  if (count < 10_000) return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (count < 1_000_000) return `${Math.floor(count / 1_000)}K`;
  return `${Math.floor(count / 100_000) / 10}M`;
}

const plural = (count: number, one: string, many: string) =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

/**
 * Every way of saying this summary, longest first, ending in the bare aggregate.
 *
 *     Priya Raghunathan and 3 others like this
 *     Priya Raghunathan and 3 others
 *     Priya and 3 others like this
 *     Priya and 3 others
 *     4 likes
 *
 * "Like" only when every reaction is a like (`love`, which the app labels Liked); any
 * other kind present makes it "reacted" / "reactions", so a 😂 is never called a like.
 * The total is the summary's, which counts each person once — `reactions` has one row
 * per person per event — and includes anyone counted but not nameable.
 *
 * Empty for no reactions: there is nothing to say.
 */
export function summaryForms(
  summary: Pick<ReactionSummary, 'total' | 'mine' | 'kinds' | 'people'>,
  viewerId: string,
  affinity?: AffinityLookup,
): string[] {
  const { total, mine } = summary;
  if (total <= 0) return [];

  const likesOnly = summary.kinds.length > 0 && summary.kinds.every((kind) => kind === 'love');
  const aggregate = likesOnly
    ? plural(total, 'like', 'likes')
    : plural(total, 'reaction', 'reactions');

  const highlighted = pickHighlightedReactor(summary.people, viewerId, affinity);
  const subjects: { text: string; single: boolean }[] = [];

  if (mine) {
    const rest = total - 1;
    if (rest === 0) {
      subjects.push({ text: 'You', single: false });
    } else if (highlighted && rest === 1) {
      for (const name of namesFor(highlighted)) {
        subjects.push({ text: `You and ${name}`, single: false });
      }
    } else if (highlighted) {
      for (const name of namesFor(highlighted)) {
        subjects.push({ text: `You, ${name} and ${plural(rest - 1, 'other', 'others')}`, single: false });
      }
    }
    if (rest > 0) subjects.push({ text: `You and ${plural(rest, 'other', 'others')}`, single: false });
  } else if (highlighted) {
    const rest = total - 1;
    for (const name of namesFor(highlighted)) {
      subjects.push({
        text: rest === 0 ? name : `${name} and ${plural(rest, 'other', 'others')}`,
        single: rest === 0,
      });
    }
  }

  const forms: string[] = [];
  for (const subject of subjects) {
    forms.push(`${subject.text} ${verbFor(likesOnly, subject.single)}`, subject.text);
  }
  forms.push(aggregate);
  return [...new Set(forms)];
}

function verbFor(likesOnly: boolean, single: boolean) {
  if (!likesOnly) return 'reacted';
  return single ? 'likes this' : 'like this';
}

/** The full display name, then the first word of it when that is shorter. */
function namesFor(person: Reactor) {
  const full = person.name.trim();
  const first = full.split(/\s+/)[0];
  return first && first !== full ? [full, first] : [full];
}

/** The kinds' glyphs for the summary's cluster: the viewer's own first, three at most. */
export function clusterKinds(kinds: readonly ReactionKind[], mine: ReactionKind | null) {
  const ordered = mine ? [mine, ...kinds.filter((kind) => kind !== mine)] : [...kinds];
  return ordered.slice(0, 3);
}

/**
 * The reaction props for one post, built the same way on every surface that draws one
 * — the Feed card, the conversation page a notification opens, and the profile — so the
 * three cannot disagree about who is named, what the sentence says, or whether a heart
 * is offered.
 *
 * `isOwn` is the post's actor being the viewer. It removes the heart and the picker and
 * nothing else: everyone else's reactions are still summarised and still open the list.
 */
export function activityReaction({
  summary,
  viewerId,
  isOwn,
  affinity,
  onToggle,
  onOpenPicker,
  onOpenDetail,
  picker = null,
}: {
  summary: ReactionSummary | null | undefined;
  viewerId: string;
  isOwn: boolean;
  affinity?: AffinityLookup;
  onToggle: () => void;
  onOpenPicker?: () => void;
  onOpenDetail?: () => void;
  picker?: ReactNode;
}): ActivityReaction {
  const total = summary?.total ?? 0;
  const mine = isOwn ? null : (summary?.mine ?? null);
  const kinds = summary?.kinds ?? [];
  return {
    count: total,
    canReact: !isOwn,
    mineGlyph: mine ? REACTION_GLYPH[mine] : null,
    mineLabel: mine ? REACTION_LABEL[mine] : null,
    glyphs: kinds.map((kind) => REACTION_GLYPH[kind]),
    summaryGlyphs: clusterKinds(kinds, mine).map((kind) => REACTION_GLYPH[kind]),
    summaryForms: summary
      ? summaryForms({ ...summary, mine }, viewerId, affinity)
      : [],
    onPress: onToggle,
    onLongPress: isOwn ? undefined : onOpenPicker,
    onPressSummary: onOpenDetail,
    picker: isOwn ? null : picker,
  };
}
