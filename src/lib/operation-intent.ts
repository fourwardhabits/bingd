import * as Crypto from 'expo-crypto';
import { useCallback, useRef } from 'react';

import { classifyWrite, type ServerError } from './write-outcome';

/**
 * One operation id per **intent**, held only while the outcome is unknown.
 *
 * `collection/writes.ts`'s module header states the rule this exists to make keepable:
 * the id belongs to the intent and not to the attempt, because `_claim_operation` can
 * only refuse a replay that carries the id it already saw. Every writer in this app had
 * been breaking it — `newOperationId()` called *inside* the writer, so each attempt got a
 * fresh one and the server's ledger never got the chance to do its job.
 *
 * **It went unnoticed because the obvious test is the wrong one.** "Can a replay store a
 * duplicate row" is answered no by almost every RPC here: a follow, a reaction, a tag set,
 * a profile save and a visibility switch all assign or replace, and `recommend_title` is
 * keyed on (sender, recipient, title). Independent review 21i supplied the sharper test —
 * **does a replay change any observable at all** — and the answer is yes for every
 * rate-limited one:
 *
 *     _assert_operation_rate('add_comment' | 'change_username' | 'create_invite_link'
 *                          | 'follow' | 'recommend_title' | 'save_profile'
 *                          | 'set_profile_visibility' | 'set_reaction'
 *                          | 'set_watch_tags' | 'update_profile')
 *
 * A commit whose reply is lost is reported to the person as a failure, so they do the
 * obvious thing and press the control again — and the second attempt **spends a second
 * slot for one intent**. Nothing raises, nothing looks wrong, and the ceiling arrives
 * early: a refusal shown to somebody whose true count would still have allowed the save.
 * Independent reviews 21h, 21i and 21j, one writer at a time.
 *
 * **The release rule is asymmetric on purpose.** The id is dropped the moment the server
 * answers *anything*, and held only when the outcome was never established. Holding a
 * *spent* id is the dangerous direction: `recommend_title` returns its refusals in a 200
 * and keeps its claim deliberately (`20260817001300` — a raise would roll the claim back
 * and make refused attempts free against the ceiling), so replaying that id would be
 * answered `already_applied`, and a send that reports success and stores nothing is the
 * worst thing any of these surfaces could do.
 *
 * `CommentSheet` and `RecommendSheet` express the same rule locally rather than through
 * this hook, because their intent is a thing on screen — what is currently in the
 * composer, which recipient was tapped — with a lifecycle of its own. Here the intent is
 * the *arguments*, so the key is derived from them and nothing has to be cleared by hand.
 */
/** One attempt's id, and where it sits in the order of ids issued for its key. */
type Attempt = { id: string; generation: number };

export function useOperationIntent() {
  /** The id a retry of each key should carry, if there is one. */
  const held = useRef(new Map<string, Attempt>());
  /**
   * The highest generation ever issued per key, which is what makes `held` orderable.
   *
   * Separate from `held` on purpose: it has to survive the entry being deleted, or a
   * later mint would reuse a number a stale attempt still carries and the two would be
   * indistinguishable. Review 21m found exactly that hole in the version that compared
   * presence instead of order.
   */
  const issued = useRef(new Map<string, number>());

  /**
   * Runs one attempt at `key` under an id that survives its retries.
   *
   * `unresolved` says whether the server left the outcome open. It is required rather
   * than defaulted: every caller shapes its result differently, and a default that
   * guessed wrong would fail in the silent direction this whole module is about.
   *
   * **Stable across renders**, which is not decoration. `RankingSheet` calls this from
   * the `useEffect` that opens a session, and an identity that changed every render
   * would put it in that effect's dependency list and re-open the session on any
   * unrelated re-render — a second `rank_start`, or a second `rank_again` that unranks
   * a title twice. Every value the body reads is a ref, so there is nothing for the
   * dependency array to hold.
   */
  return useCallback(async function withIntent<T>(
    key: string,
    // `PromiseLike`, because a supabase builder is a thenable rather than a Promise.
    call: (operationId: string) => PromiseLike<T>,
    unresolved: (result: T) => boolean,
  ): Promise<T> {
    // Reuse the held attempt, id and generation together — a retry is the same attempt
    // as far as the server is concerned, and it must not climb the order by repeating.
    let attempt = held.current.get(key);
    if (!attempt) {
      const generation = (issued.current.get(key) ?? 0) + 1;
      issued.current.set(key, generation);
      attempt = { id: Crypto.randomUUID(), generation };
      held.current.set(key, attempt);
    }

    const result = await call(attempt.id);

    /**
     * **Both branches are guarded, because attempts on one key can overlap.**
     *
     * Independent review 21k found the unguarded version. Two rapid presses share id
     * A; the first is answered and deletes A; the second then comes back unknown over
     * an empty map, so the retry the person is invited to make mints B — and B claims
     * a second slot for an intent that already has one. The whole point of the
     * mechanism, lost to a race between two attempts at the same thing.
     *
     * So an unresolved attempt **re-asserts** its id rather than assuming it is still
     * there. That is safe for exactly the reason the race is possible: both attempts
     * carry A, `_claim_operation` can only grant it once, and the other is answered
     * `already_applied`. A retry under A therefore costs nothing and reports the truth
     * — the intent did land, under whichever attempt won.
     *
     * And a definitive answer releases **only its own id**. Without that, an attempt
     * resolving late — after a concurrent one settled the key and a third minted a
     * fresh id — would release somebody else's id, undoing the same protection from
     * the other direction.
     *
     * **Both writes are ordered**, which is the discipline `held` exists to keep:
     * never write over a decision a *later* attempt has already made.
     *
     * Review 21l found the unresolved branch writing unconditionally. Review 21m then
     * found that guarding it on *presence* was not enough, because presence is not
     * recency: two attempts share A, one answers and clears it, two newer attempts
     * share B, one of those answers and clears it — and a stale A resolving unresolved
     * into an empty map is then holding an id **older** than the B attempt still to
     * come back. The retry would carry a spent A and be answered `already_applied`: a
     * write that reports success and stores nothing, which is the worst outcome this
     * module can produce. So the comparison is on the generation, and `issued` is what
     * keeps that number monotonic across deletions.
     */
    const current = held.current.get(key);

    if (unresolved(result)) {
      // Nothing held, or what is held is older than this. Either way this attempt is
      // the one a retry should carry.
      if (!current || current.generation < attempt.generation) {
        held.current.set(key, attempt);
      }
    } else if (current?.id === attempt.id) {
      // Answered, and still the attempt on record. A definitive answer for an id that
      // has since been superseded says nothing about the one held now.
      held.current.delete(key);
    }

    return result;
  }, []);
}

/**
 * The common `unresolved`: a PostgREST answer this client cannot prove was a refusal.
 *
 * Typed on `code` alone, which is all `classifyWrite` reads — `PostgrestError` and the
 * shapes `postgrest-js` builds for a transport failure disagree about everything else.
 */
export const answerWasLost = (result: { error?: { code?: string | null } | null }) =>
  classifyWrite(result.error as ServerError) === 'unknown';
