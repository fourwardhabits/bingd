import { useLocalSearchParams } from 'expo-router';

import { MyLists } from '@/features/lists/MyLists';
import type { MyListsEntry } from '@/lib/analytics';
import { Screen } from '@/ui/components';

/** The two doors, and the only two. Anything else is a typo in a `router.push`. */
const ENTRIES: readonly MyListsEntry[] = ['collection', 'profile_manage'];

/**
 * `My lists` — every list the caller owns, as a pushed screen.
 *
 * Collection shows the same body inline as its **Lists** mode (founder QA, 2026-09-21);
 * this route remains for Profile's manage link and any older push.
 *
 * ---------------------------------------------------------------------------
 * IT IS APP-ONLY, AND THAT IS A URL DECISION
 *
 * The deep-link claim is `/lists/*`, and `listIdFromPath` on the web accepts a uuid
 * shape and nothing else — so `bingd.app/lists` keeps its generic install page and this
 * screen needs no claim and no web route. A management screen is not a thing anybody
 * shares.
 *
 * An unrecognised `entry` falls back to `collection` rather than being sent through: the
 * event's vocabulary is closed, and a typo must not open it.
 */
export default function MyListsScreen() {
  const { entry } = useLocalSearchParams<{ entry?: string }>();

  return (
    <Screen includeBottomInset>
      <MyLists
        entry={ENTRIES.includes(entry as MyListsEntry) ? (entry as MyListsEntry) : 'collection'}
      />
    </Screen>
  );
}
