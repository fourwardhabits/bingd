import type { MediaKind } from '@/lib/titles';

/**
 * The three modes, spelled as the database spells them.
 *
 * One vocabulary for the picker, the chip, the RPC argument and the analytics property,
 * for the reason `LeaderboardMetricName` gives: a second spelling of the same three
 * things is the first one to drift.
 */
export type ListVisibility = 'private' | 'link' | 'public';

/** Whether the list draws 1, 2, 3 beside each title. It never decides the order. */
export type ListOrderStyle = 'ranked' | 'unranked';

/**
 * The three words a visibility chip says, and the three the picker offers.
 *
 * **Never a bare glyph** (§I). The lock, link and globe are drawn *with* these words,
 * because a glyph names neither the thing nor the act — and a reader has to recognise
 * the chip as the choice they made in the picker, which is only possible if it uses the
 * picker's own language.
 */
export const VISIBILITY_CHIP: Record<ListVisibility, string> = {
  private: 'Only you',
  link: 'Anyone with the link',
  public: 'Public',
};

/**
 * The picker's option labels — the same three words as the chip (founder QA, 2026-09-21:
 * Only you / Anyone with the link / Public), so the metadata line and the choice that set
 * it cannot be read as two different things.
 */
export const VISIBILITY_OPTION: Record<ListVisibility, string> = VISIBILITY_CHIP;

export const VISIBILITY_ICON: Record<
  ListVisibility,
  'lock-closed-outline' | 'link-outline' | 'globe-outline'
> = {
  private: 'lock-closed-outline',
  link: 'link-outline',
  public: 'globe-outline',
};

/** One row of the My lists screen. */
export type MyListSummary = {
  id: string;
  title: string;
  itemCount: number;
  orderStyle: ListOrderStyle;
  visibility: ListVisibility;
  hidden: boolean;
  updatedAt: string;
  /** Up to four poster URIs, for the 2×2 cover. Fewer is ordinary; none is an empty list. */
  posterUris: string[];
};

/** One card of a profile's public Lists shelf. A shelf never shows visibility. */
export type ProfileListSummary = {
  id: string;
  title: string;
  itemCount: number;
  orderStyle: ListOrderStyle;
  updatedAt: string;
  posterUris: string[];
};

/**
 * Who a list belongs to, as much of it as the viewer is allowed.
 *
 * `profileVisible` false is the **limited identity** of §F.2: handle, display name and
 * avatar, which is exactly what search already discloses about a private account. `id`
 * is absent for an anonymous reader, so it is optional here rather than nullable — the
 * key is not sent at all.
 */
export type ListOwner = {
  id?: string;
  username: string;
  displayName: string;
  avatarUri: string | null;
  profileVisible: boolean;
};

/** A list's header, for whoever may read it. */
export type ListView = {
  id: string;
  title: string;
  description: string | null;
  orderStyle: ListOrderStyle;
  itemCount: number;
  updatedAt: string;
  isOwner: boolean;
  /** Whether *this* viewer gets a Share control. See `list_view`'s own comment. */
  shareableByViewer: boolean;
  /** Owner-only. A viewer has no business knowing whether a list is public or link-only. */
  visibility: ListVisibility | null;
  /** Owner-only. Drives the moderation banner and the frozen visibility row. */
  hidden: boolean;
  owner: ListOwner | null;
};

/** One row of a list. */
export type ListItem = {
  mediaItemId: string;
  kind: MediaKind;
  /** Already compacted: a season reads `Fleabag, S2`, so the row and the title page agree. */
  name: string;
  year: number | null;
  posterUri: string | null;
  /** The keyset cursor. The stored integer, never shown. */
  position: number;
  /** 1…N over the whole list, which is the number drawn when the list is numbered. */
  ordinal: number;
  /** Null for an anonymous reader: "no viewer to ask about", not "no". */
  seen: boolean | null;
  watchlisted: boolean | null;
};

/** One row of the Add-to-list sheet. */
export type ListMembership = {
  id: string;
  title: string;
  itemCount: number;
  visibility: ListVisibility;
  contains: boolean;
};

export type ListProgress = { seen: number; total: number };

/**
 * `Updated today`, `Updated Sep 12`, `Updated Sep 12, 2025`.
 *
 * The year appears only when it is not this one, which is the rule the rest of the app
 * already follows for a watch date: a year on every row is noise on the ninety-nine
 * per cent of lists that were touched this year.
 */
export function updatedLabel(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';

  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  if (sameDay) return 'Updated today';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday =
    when.getFullYear() === yesterday.getFullYear() &&
    when.getMonth() === yesterday.getMonth() &&
    when.getDate() === yesterday.getDate();
  if (wasYesterday) return 'Updated yesterday';

  const options: Intl.DateTimeFormatOptions =
    when.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };

  return `Updated ${when.toLocaleDateString(undefined, options)}`;
}

/** `14 titles`, `1 title`, `No titles yet`. */
export const titleCountLabel = (count: number) =>
  count === 0 ? 'No titles yet' : `${count} ${count === 1 ? 'title' : 'titles'}`;
