import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { diagnose } from '@/lib/diagnose';
import { supabase } from '@/lib/supabase';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';

/**
 * The eight categories, exactly as `_notification_categories()` names them.
 *
 * The union is the enforcement. A string here that the database does not know is a
 * 22023 at runtime; a member missing from `SECTIONS` is a compile error, because
 * `SECTION_CATEGORIES` below is asserted to cover the union.
 */
export type NotificationCategory =
  | 'follows'
  | 'follow_accepted'
  | 'comments'
  | 'reactions'
  | 'watch_tags'
  | 'recommendations'
  | 'invites'
  | 'awards';

export type NotificationPreferences = Record<NotificationCategory, boolean>;

export type NotificationSectionKey = 'social' | 'recommendations' | 'achievements';

export type NotificationSetting = {
  key: NotificationCategory;
  label: string;
  /** What arrives if this is on, in the terms the event actually happens in. */
  description: string;
  /**
   * True where the category is defined, silenceable and routed, but **nothing writes
   * it yet**. The screen says so rather than presenting a switch that implies traffic
   * the app does not produce.
   *
   * It is also what decides the default. A category nothing writes defaults off, so the
   * app is not claiming a feature it does not have; every category that works defaults
   * on. `awards` is the only one left — `invites` lost this flag on 2026-08-20, having
   * had a writer since `20260819000500`.
   */
  pending?: boolean;
};

export type NotificationSection = {
  key: NotificationSectionKey;
  title: string;
  /** The master's own label. "All Social notifications", per the founder's brief. */
  masterLabel: string;
  settings: NotificationSetting[];
  /** A fact about the section that is not a switch — see `follow_request`. */
  footnote?: string;
};

/**
 * The screen's structure, declared once.
 *
 * The order is the founder's: what other people do to you, what they send you, what
 * you did yourself.
 */
export const SECTIONS: readonly NotificationSection[] = [
  {
    key: 'social',
    title: 'Social',
    masterLabel: 'All Social notifications',
    settings: [
      {
        key: 'follows',
        label: 'Follows',
        description: 'Somebody starts following you.',
      },
      {
        key: 'follow_accepted',
        label: 'Follow accepted',
        description: 'Somebody approves your request to follow them.',
      },
      {
        key: 'comments',
        label: 'Comments',
        description: 'Somebody comments on something you logged.',
      },
      {
        key: 'reactions',
        label: 'Reactions',
        description: 'Somebody reacts to something you logged.',
      },
      {
        key: 'watch_tags',
        label: 'Watched with',
        description: 'Somebody says they watched something with you.',
      },
    ],
    /**
     * Stated on the screen, not discovered by a reader who wonders where their
     * requests went. `_apply_notification_preference` exempts `follow_request` as its
     * own condition and there is no category that maps to it: an account that could
     * silence requests would receive ones it can never see and never answer, and the
     * person waiting would wait for ever.
     */
    footnote:
      'Follow requests always come through. They are waiting on you to answer, so there is no switch that could hide one.',
  },
  {
    key: 'recommendations',
    title: 'Recommendations & invites',
    masterLabel: 'All Recommendations & invites notifications',
    settings: [
      {
        key: 'recommendations',
        label: 'Recommendations',
        description: 'Somebody recommends you a film or a season.',
      },
      {
        key: 'invites',
        label: 'Friend joined via invite',
        // No longer `pending`. `20260819000500` gave `invite_activated` a writer, so
        // this switch governs real traffic — the flag was left behind by the migration
        // that made it work, and the screen was telling readers a working feature was
        // not built yet.
        description: 'Somebody you invited joins Bingd and ranks their first ten titles.',
      },
    ],
  },
  {
    key: 'achievements',
    title: 'Achievements',
    masterLabel: 'All Achievement notifications',
    settings: [
      {
        key: 'awards',
        label: 'Bingd Awards',
        description: 'You reach a new tier on an Award.',
        pending: true,
      },
    ],
  },
];

/** Every category in a section, which is what a master switch writes. */
export function categoriesIn(section: NotificationSection): NotificationCategory[] {
  return section.settings.map((s) => s.key);
}

/**
 * The union, written out once so the compiler enforces it.
 *
 * `Record<NotificationCategory, true>` fails to typecheck the moment a category is
 * added to the union and not to this map — which is the half a test cannot cover,
 * because a test can only read the categories that exist.
 *
 * The other half — that `SECTIONS` covers every one of them exactly once — is a
 * property of data rather than of types, so it is asserted in
 * `use-notification-preferences.test.ts` over `SECTION_COVERAGE`. A category the
 * screen forgot would be a setting nobody can reach and an event nobody can stop; one
 * listed twice would give a single switch two masters.
 */
const COVERED = SECTIONS.flatMap(categoriesIn);
const _exhaustive: Record<NotificationCategory, true> = {
  follows: true,
  follow_accepted: true,
  comments: true,
  reactions: true,
  watch_tags: true,
  recommendations: true,
  invites: true,
  awards: true,
};
export const ALL_CATEGORIES = Object.keys(_exhaustive) as NotificationCategory[];

/** Exported so a test can assert it rather than trusting the constant above. */
export const SECTION_COVERAGE = COVERED;

/**
 * What the master switch reads.
 *
 * **On iff at least one child is on**, which makes "master off" mean exactly "every
 * child off" — a statement that is true rather than approximately true. It is a pure
 * function of the children, so there is no third state to store, nothing to keep in
 * step, and no way for the master to disagree with what is under it. The founder's
 * brief asked for determinism and for tri-state to be avoided unless the architecture
 * already supported it robustly; it does not, and this does not need it.
 */
export function masterOn(
  section: NotificationSection,
  prefs: NotificationPreferences | undefined,
): boolean {
  if (!prefs) return false;
  return categoriesIn(section).some((key) => prefs[key]);
}

/**
 * The caller's own switches.
 *
 * Read from `my_notification_preferences`, which returns all eight every time with
 * each one defaulted by its own category. The screen never assembles a default: a
 * default written in two places is a default that disagrees with itself, and the one
 * that differs from the rest — awards, off because nothing writes one — is exactly the
 * one a second copy would get wrong.
 *
 * Seven of the eight default on as of `20260820000100`. `reactions` was the eighth
 * until the founder's Preview pass.
 */
export function useNotificationPreferences(viewerId: string) {
  return useQuery({
    queryKey: ['notification-preferences', viewerId],
    queryFn: async (): Promise<NotificationPreferences> => {
      const { data, error } = await supabase.rpc('my_notification_preferences');
      if (error) throw error;

      const rows = (data ?? []) as { category: string; enabled: boolean }[];
      const byCategory = new Map(rows.map((r) => [r.category, r.enabled]));

      /**
       * A category this build knows and the response did not carry is an **error**,
       * not something to fill in.
       *
       * This filled the gap with `true` until independent review 23. That was wrong in
       * the one direction that matters: `reactions` and `awards` default *off*, so a
       * build talking to a backend that predates 20260819000300 would have drawn them
       * on, and a reader who then touched anything in that section would have switched
       * on a category they never chose. Guessing a default on the client is the exact
       * duplication `my_notification_preferences` exists to prevent.
       *
       * Throwing puts the screen into its Could-not-load state with a Try again, which
       * is a true statement about a backend this build cannot read.
       */
      const missing = ALL_CATEGORIES.filter((key) => !byCategory.has(key));
      if (missing.length > 0) {
        throw new Error(
          `notification preferences missing from the server: ${missing.join(', ')}`,
        );
      }

      return Object.fromEntries(
        ALL_CATEGORIES.map((key) => [key, byCategory.get(key)]),
      ) as NotificationPreferences;
    },
  });
}

export type PreferenceWriteResult = { ok: true } | { ok: false; message: string };

/**
 * Turning switches on and off.
 *
 * **No operation id, and that is not an omission.** `_claim_operation` exists for
 * writes whose second application would be a second event — a follow, a comment, a
 * recommendation. Setting a preference is not one of those: it assigns a value rather
 * than appending, so the same call twice reaches the same state as the same call once.
 * A retry after a lost reply is therefore the correct response and needs no ledger to
 * be safe. What it does need is a refetch, which is why `run` reconciles on `unknown`
 * as well as on success.
 *
 * **A section master is one call, not several.** `set_notification_preferences` takes
 * the whole section in one transaction. Five sequential single-category writes would
 * have thirty-two outcomes, most of them a master that disagrees with its own
 * children, and the fourth one's reply is the one that goes missing.
 *
 * No optimism. A switch that shows the new position and silently reverts is worse than
 * one that takes a beat, and this screen's whole subject is what the reader will and
 * will not be told.
 */
export function useNotificationPreferenceWrites(viewerId: string) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async (
    fn: () => PromiseLike<{ error: unknown }>,
  ): Promise<PreferenceWriteResult> => {
    if (busy) return { ok: false, message: 'One at a time.' };
    setBusy(true);
    try {
      const { error } = await fn();

      // Reconciled on an unknown outcome as well as a commit: a preference that was
      // written and could not say so leaves the switch showing the old position, and
      // the reader's next tap would set it back to what it already is.
      if (mustReconcile(classifyWrite(error as { code?: string }))) {
        await queryClient.invalidateQueries({
          queryKey: ['notification-preferences', viewerId],
        });
        // The gate is on creation, so a changed preference changes what the inbox
        // will contain from now on. Nothing retroactive — a row already written stays
        // written — but the badge and the list should not be a cache from before.
        await queryClient.invalidateQueries({ queryKey: ['notifications', viewerId] });
      }

      if (error) {
        const message =
          diagnose(error) ??
          (error instanceof Error ? error.message : 'Something went wrong. Try again.');
        return { ok: false, message };
      }
      return { ok: true };
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,

    /** One switch. */
    setPreference: (category: NotificationCategory, enabled: boolean) =>
      run(() =>
        supabase.rpc('set_notification_preference', {
          p_category: category,
          p_enabled: enabled,
        }),
      ),

    /**
     * A whole section, atomically.
     *
     * Master ON enables every child in the section, including one that defaults off —
     * that is what "all social notifications" says, and reading it any other way makes
     * the control's effect depend on state the reader cannot see.
     */
    setSection: (section: NotificationSection, enabled: boolean) =>
      run(() =>
        supabase.rpc('set_notification_preferences', {
          p_categories: categoriesIn(section),
          p_enabled: enabled,
        }),
      ),
  };
}
