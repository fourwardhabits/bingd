import { useRef, useState } from 'react';
import { Share, StyleSheet, View, useWindowDimensions } from 'react-native';

import { newOperationId } from '@/features/collection/writes';
import { PeoplePicker } from '@/features/people/PeoplePicker';
import { track, type Surface } from '@/lib/analytics';
import { compactName, type MediaKind } from '@/lib/titles';
import { Button, EmptyState, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { useRecommendRecipients, useRecommendTitle, type Recipient } from './use-recommend';

export type RecommendSheetProps = {
  viewerId: string;
  mediaItemId: string;
  kind: MediaKind;
  title: string;
  seriesTitle?: string | null;
  seasonNumber?: number | null;
  onClose: () => void;
  /** Called once a recommendation has actually been filed, with the recipient's name. */
  onSent: (recipientName: string) => void;
  /** Where this sheet was opened from, for `recommendation_sent` and `invite_link_created`. */
  surface: Surface;
};

/**
 * The width one of the two footer actions needs before the pair may sit side by side.
 *
 * Set by the longer label. "Share off bingd." sets to about 132pt at `headline`, and
 * `fit` adds 24 of side padding, so 156 is where it stops fitting at full size — 150
 * is that figure with the rounding taken off it rather than a number chosen to make a
 * particular phone pass. Below the pair's worth of it the buttons stack, because a
 * label shrunk toward `fit`'s 85% floor beside a short one is the imbalance this
 * constant exists to prevent, not a smaller version of a working layout.
 */
const ACTION_MIN_WIDTH = 150;

/** "Ada", "Ada and Bo", "Ada, Bo and Cy" — names the way a sentence holds them. */
const listNames = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * What the confirmation underneath is handed. Names while they fit in a toast;
 * a count once they would not.
 */
const sentSummary = (names: string[]): string =>
  names.length <= 2 ? listNames(names) : `${names.length} people`;

/**
 * Recommend, as one considered act.
 *
 * **Choose your people, then send once.** The V1 shape was one recipient per tap, sent
 * immediately; the founder's 2026-08-27 revision is a picker — tap the people (each row
 * is a checkbox now, sitting exactly where the per-row send icon used to be), then press
 * the one button that says how many. What has *not* changed is what a send is: each
 * chosen person is their own `recommend_title` call under their own held operation id,
 * so the server's view — the follow requirement, direct-versus-pending, the per-pair
 * pending cap, the rate ceilings — is exactly the view it had when the taps were
 * separate. Multi-select is a UI over N recommendations, not a broadcast primitive.
 *
 * The people offered are everybody the sender follows, which is what the server accepts.
 * Whether they follow back decides only whether it lands in their list or waits as a
 * request, and the sender is deliberately not told which — "Sent" either way. If
 * somebody is refused anyway the relationship changed while the sheet was open, and the
 * message says so rather than reporting a code.
 *
 * A batch can half-succeed, and the sheet must not lose the half that worked: the
 * refused or unanswered people stay selected with the reason on the screen, the
 * successful ones leave the selection (their recommendation is stored; a second press
 * must not resend them), and the sheet closes only when everybody chosen has been sent.
 */
export function RecommendSheet({
  viewerId,
  mediaItemId,
  kind,
  title,
  seriesTitle,
  seasonNumber,
  onClose,
  onSent,
  surface,
}: RecommendSheetProps) {
  const recipients = useRecommendRecipients(viewerId);
  const send = useRecommendTitle(viewerId);

  /**
   * Whether the two footer actions fit beside each other, decided from the viewport
   * rather than left to flexbox.
   *
   * The founder's Android screenshot is what this replaces: the row was
   * `flexWrap: 'wrap'` over two children with hand-picked `flexBasis` values and
   * `flexShrink: 1` on both. Yoga does not give a flex item CSS's automatic minimum
   * size, so "shrink" has no floor at the content's own width — the children were
   * squeezed below their labels instead of the row ever wrapping, and `Share off bingd.`
   * broke mid-word into `bi / ngd.`. Wrapping could not save it because shrinking always
   * succeeded first.
   *
   * So the decision is made here, from a width, and it is one boolean a test can pin.
   *
   * **The requirement scales with the type, rather than being gated by a second rule.**
   * A label at a 1.3 font scale needs about a third more room than the same label at 1,
   * so a fixed floor plus a "stack above 1.3" ceiling leaves exactly one bad case in the
   * middle: a 360pt phone at 1.3, where each half is still nominally wide enough and the
   * label no longer is. `fit` stops shrinking at 85%, so what it does past that is clip —
   * the crushed CTA again, arrived at from the other direction. Multiplying the floor by
   * `fontScale` covers the whole range with one rule, and the ceiling is then implied.
   */
  const { width, fontScale } = useWindowDimensions();
  const sideBySide =
    width - theme.layout.gutter * 2 >= ACTION_MIN_WIDTH * fontScale * 2 + theme.space[3];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  /**
   * Everybody sent so far across the attempts one open sheet makes.
   *
   * A batch that half-fails leaves the sheet open for a retry of the failed half, and
   * when that retry succeeds the confirmation underneath should name everybody this
   * sheet sent to — not just the stragglers of the final pass.
   */
  const sentSoFar = useRef<string[]>([]);
  /**
   * The operation id for a send, per recipient, held across attempts.
   *
   * Keyed by person because the sheet can be tapped down a list and each name is its own
   * intent. Released as soon as the server answers anything at all — see `recommend`.
   */
  const sendIntents = useRef(new Map<string, string>());

  const people = recipients.data ?? [];
  const name = compactName({ kind, title, seriesTitle, seasonNumber }) ?? title;

  const toggle = (personId: string) => {
    if (sending) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };

  const recommendSelected = async () => {
    if (sending || selected.size === 0) return;
    setSending(true);
    setError(null);

    // In list order rather than tap order, so the receipt below reads like the list.
    const chosen = people.filter((person) => selected.has(person.id));
    const sent: Recipient[] = [];
    const failed: { person: Recipient; message: string }[] = [];

    // One at a time, each its own call. The server's ceilings and the per-pair cap are
    // asked per recipient exactly as they were when each tap was its own send, and a
    // sequential walk keeps the receipt deterministic.
    for (const person of chosen) {
      /**
       * **One id per recipient, held only while the outcome is unknown.**
       *
       * Independent review 21i: `recommend_title` is keyed on (sender, recipient, title)
       * so it cannot store the same recommendation twice — but a replay with a *fresh*
       * id still spends a rate-limit slot and still moves `recommended_at`, which
       * reorders the recipient's list. Holding the id makes `_claim_operation` answer
       * `already_applied` instead, which is what that ledger is for. Multi-select is
       * where this earns its keep: a half-failed batch invites a retry press, and the
       * unanswered sends in it must replay under the ids they already spent.
       *
       * Released the moment the server answers **anything**, and that is not symmetry
       * for its own sake: a `refused` arrives as a 200 and **keeps its claim on
       * purpose** (`20260817001300` — a raise would roll the claim back and make
       * refused attempts free). Reusing a spent id would have the next attempt answered
       * `already_applied` and silently send nothing. So only `changed` — the outcome
       * nobody established — keeps it.
       */
      const held = sendIntents.current.get(person.id) ?? newOperationId();
      sendIntents.current.set(person.id, held);

      const result = await send.mutateAsync({
        operationId: held,
        recipientId: person.id,
        mediaItemId,
      });

      if (result.ok || !result.changed) sendIntents.current.delete(person.id);

      if (result.ok) {
        sent.push(person);
        /**
         * `recommendation_sent`, and only from `ok` — once per stored recommendation.
         *
         * `ok` here means the row is stored: the mutation has already separated the two
         * things a 200 can mean, since `recommend_title` returns `not_following` and
         * its siblings inside the body rather than raising them (`use-recommend.ts`).
         * A refusal and an unknown outcome emit nothing — the unknown one deliberately,
         * because that is the send whose id is being *held* for a retry, and a retry
         * that eventually succeeds is the send this event should count once.
         */
        track({
          name: 'recommendation_sent',
          props: { media_kind: kind === 'season' ? 'tv_season' : 'movie', surface },
        });
      } else {
        failed.push({ person, message: result.message });
      }
    }

    setSending(false);
    sentSoFar.current.push(...sent.map((person) => person.name));

    if (failed.length === 0) {
      // The confirmation belongs to the screen underneath, which is still showing the
      // title this was about. A second one in here would be a message nobody sees,
      // because the sheet closes on the same tick.
      onSent(sentSummary(sentSoFar.current));
      onClose();
      return;
    }

    /**
     * The half-succeeded batch, said in full.
     *
     * The people who worked leave the selection — their recommendation is stored, and
     * a retry press must not spend another attempt on them — and the people who did
     * not stay selected under a line that names them, so "try again" means exactly the
     * failed half. A success silently absorbed into a failure message is a send the
     * sender re-does by hand; a failure silently absorbed into a close is worse.
     */
    setSelected(new Set(failed.map(({ person }) => person.id)));
    const sentLine = sent.length ? `Sent to ${listNames(sent.map((p) => p.name))}. ` : '';
    setError(
      `${sentLine}Could not send to ${listNames(failed.map(({ person }) => person.name))}. ` +
        (failed[0]?.message ?? ''),
    );
  };

  const shareOffPlatform = async () => {
    if (sharing) return;
    setSharing(true);
    setError(null);

    /**
     * One share, and it is the one the person asked for.
     *
     * This used to mint the sharer's reusable invite link and append
     * `Join me on bingd. https://bingd.app/i/<token>` underneath the title — the growth
     * loop taking a ride on a message about a film. It is gone, and the reason is not
     * tidiness. Somebody sending a friend a film is vouching for the film; a second
     * link that recruits for Bingd turns their recommendation into an advertisement
     * they did not agree to send, and the person who notices that is the person who
     * stops sharing. Trust in the sender is the growth loop.
     *
     * The recruitment still happens, one step later and to the right person: a
     * recipient without the app taps the title link, and bingd.app answers with the
     * install page (`web/src/page.mjs`). Nothing is lost by taking the invite URL out
     * of this message except the pretence that the sender chose to send it.
     *
     * Inviting deliberately is still one tap, on the profile — `InviteFriendsButton` —
     * and that path is where `create_invite_link` and `invite_link_created` now live
     * exclusively.
     *
     * **The URL itself is one segment, and it used to be two.**
     *
     * This built `/title/<kind>/<id>`, and **no route serves that** — not
     * `app/title/[id].tsx`, which matches a single segment, and not the web router. So
     * every off-platform title share sent a link that opened the app onto
     * `+not-found` for anybody who had it, and onto a 404 for anybody who did not.
     * The kind was never needed: `media_items.id` identifies a film or a season on its
     * own, and the screen reads the kind from the row.
     *
     * Not renamed to something shorter, deliberately. `/title/*` is already claimed in
     * the Apple App Site Association file and already sits inside links people have
     * been sent; the fix is the segment that was wrong, and nothing else.
     */
    const titleUrl = `https://bingd.app/title/${mediaItemId}`;
    const message = `${name} on bingd.\n${titleUrl}`;

    try {
      await Share.share({ message, url: titleUrl });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sharing failed.');
    } finally {
      setSharing(false);
    }
  };

  return (
    <Sheet visible onClose={onClose} label={`Recommend ${name}`}>
      <View style={styles.header}>
        <Text variant="headline" numberOfLines={2}>
          Recommend {name}
        </Text>
      </View>

      {recipients.isPending ? (
        <Text variant="footnote" tone="tertiary" style={styles.status}>
          Finding your people…
        </Text>
      ) : recipients.isError ? (
        <View style={styles.status}>
          <EmptyState
            kind="couldNotLoad"
            compact
            title="Could not load your friends"
            body="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => void recipients.refetch() }}
          />
        </View>
      ) : people.length === 0 ? (
        <View style={styles.status}>
          <EmptyState
            kind="nothingYet"
            compact
            title="Nobody to recommend to yet"
            // The rule, in the words it is now true in: follow people to send
            // recommendations. It no longer depends on anybody following back — that
            // decides where the recommendation lands, not whether it can be sent, and
            // the sender is deliberately not told which (`20260826000400`).
            body="Follow people to send recommendations. Send a friend the link below to get started."
          />
        </View>
      ) : (
        // The picker itself lives in `features/people/PeoplePicker` since 2026-09-03,
        // extracted so Group Picks could reuse it. Neither optional addition — the
        // pinned self row, the cap — is passed here, so this sheet's behaviour is the
        // behaviour it always had.
        <PeoplePicker
          people={people}
          selected={selected}
          onToggle={toggle}
          disabled={sending}
          searchPlaceholder="Search your friends"
        />
      )}

      {error ? (
        <Text variant="footnote" tone="action" style={styles.status}>
          {error}
        </Text>
      ) : null}

      {/* The sheet's two acts, pinned under the list — the list scrolls, these do not.

          **Two equal halves, or two full-width rows.** Never one button with the row's
          spare width and the other with what is left: that is what produced the founder's
          `Share off bi / ngd.`, and equal weight is also what `ProfileActions` settled on
          for the same shape and the same reason — a fill beside a starved outline reads
          as the only real control on the surface.

          `fit` on both is load-bearing rather than defensive, exactly as it is there: it
          caps each label at one line and shrinks it a little instead of wrapping it, so
          no width can break a word.

          Recommend is the primary act and wears the fill (the button-hierarchy rule:
          filled maroon is for the social CTAs). Its label is **static** — the count moved
          out of it on the founder's instruction, because a CTA that renames itself on
          every tap is a moving target, and how many people are chosen is already said by
          the checkboxes above.

          Share off bingd. is the same off-platform share as ever — the native sheet
          carrying the reader's invite link — and it needs no selection: whether the
          somebody has the app is a detail of the address, not a different act. It is
          also still where the title page's Share button went. Outlined, because next to
          a filled Recommend it is the secondary way out.

          Recommend comes first in both layouts, so stacking reorders nothing. */}
      <View
        testID="recommend-actions"
        style={[styles.actions, sideBySide ? styles.sideBySide : styles.stacked]}
      >
        {people.length > 0 ? (
          <View style={sideBySide ? styles.half : undefined}>
            <Button
              label={sending ? 'Sending…' : 'Recommend'}
              fit
              onPress={() => void recommendSelected()}
              disabled={sending || selected.size === 0}
              disabledReason={
                sending ? 'Sending your recommendations.' : 'Choose somebody to recommend to.'
              }
            />
          </View>
        ) : null}
        <View style={sideBySide ? styles.half : undefined}>
          <Button
            label={sharing ? 'Opening…' : 'Share off bingd.'}
            kind="secondary"
            fit
            onPress={() => void shareOffPlatform()}
            disabled={sharing}
            disabledReason="Preparing your link."
          />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  status: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  actions: {
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  /**
   * The two layouts, and deliberately no `flexWrap` in either.
   *
   * Wrapping was what the row used to rely on to protect a narrow screen, and it never
   * fired: `flexShrink` has no floor at the content width in Yoga, so the children were
   * always squeezed rather than ever pushed onto a second line. The choice is made from
   * the viewport now, so these two only have to state the result.
   */
  sideBySide: { flexDirection: 'row' },
  stacked: { flexDirection: 'column' },
  // Equal halves, which is `ProfileActions`' rule for the same pair of shapes: two
  // different kinds of thing at equal weight, so the fill is not also the wide one.
  half: { flex: 1 },
});
