import { titleId } from '../capture/mock/backend.mjs';

/**
 * What the capture stage shoots. One scene is one PNG, named after its id, of the real app
 * against the fictional mock in capture/mock/backend.mjs.
 *
 * `run` receives the tools from capture/browser.mjs and must end on the exact state to
 * shoot. Each scene waits for text that only that screen shows, so when a redesign moves
 * or renames something the scene fails by name instead of capturing the wrong screen.
 * Keep the strings in step with the app: they are its visible copy, not test ids.
 *
 * `focusOn` is a selector whose top edge capture records in capture.json, so compose can
 * frame a scene around it. The shared Sheet renders `sheet-body`, which is a component hook
 * rather than copy, and it held through the Visual 2.0 redesign where a fixed fraction of
 * the screen did not: the score sheet grew taller and the old crop cut through its handle.
 */
const SHEET = '[data-testid="sheet-body"]';

const FIRST_FIVE = ['The Dark Knight', 'Spirited Away', 'Barbie', 'Inception', 'Interstellar'];

/**
 * A title the mock's viewer has not ranked, so the Rank action is on the page. It has a
 * backdrop: without one the page behind the sheet is a dark blur of the poster.
 */
const RANK_SUBJECT = 'Barbie';

async function openComparison(s) {
  await s.tap(s.page.locator('text="Rank" >> visible=true').first());
  await s.tapText('I liked it');
  await s.page.locator('[aria-label^="Choose "]').first().waitFor({ state: 'visible' });
  await s.settle(800);
}

async function rankFive(s) {
  for (const name of FIRST_FIVE) {
    await s.tap(s.page.locator(`[role="button"][aria-label="${name}"]`).first());
    await s.tapText('I liked it');
    const choose = s.page.locator('[aria-label^="Choose "]').first();
    const done = s.text('Done');
    await choose.or(done).first().waitFor({ state: 'visible' });
    if (await choose.isVisible().catch(() => false)) await choose.dispatchEvent('click');
    await s.tap(done);
    await done.waitFor({ state: 'hidden' });
    await s.settle(500);
  }
  await s.waitText('Your First Five');
  await s.settle(1200);
}

export const scenes = [
  {
    id: 'compare',
    url: `/title/${titleId(RANK_SUBJECT)}`,
    focusOn: SHEET,
    run: async (s) => {
      await openComparison(s);
    },
  },
  {
    id: 'reveal',
    url: `/title/${titleId(RANK_SUBJECT)}`,
    focusOn: SHEET,
    run: async (s) => {
      await openComparison(s);
      for (let i = 0; i < 3; i += 1) {
        await s.tap(s.page.locator('[aria-label^="Choose "]').first());
        await s.settle(1000);
      }
      await s.waitText('Add details');
      await s.settle(1600);
    },
  },
  {
    id: 'first-five',
    scenario: 'newuser',
    stage: 'taste',
    phase: 'active',
    url: '/onboarding/taste',
    run: rankFive,
  },
  {
    id: 'feed',
    url: '/feed',
    run: async (s) => {
      await s.waitText('Maya Chen');
    },
  },
  {
    id: 'comments',
    url: '/activity/e1',
    run: async (s) => {
      await s.waitText('Top 3?? We need to talk.');
    },
  },
  {
    id: 'collection-movies',
    url: '/collection',
    run: async (s) => {
      await s.waitText('Watchlist');
      await s.settle(1500);
    },
  },
  {
    id: 'collection-tv',
    url: '/collection',
    run: async (s) => {
      await s.waitText('Watchlist');
      await s.tapText('Movies');
      await s.tapText('TV');
      await s.settle(1500);
    },
  },
  {
    id: 'watchlist',
    url: '/collection',
    run: async (s) => {
      await s.tapText('Watchlist');
      await s.settle(1500);
    },
  },
  {
    id: 'for-you',
    url: '/recommendations',
    run: async (s) => {
      await s.waitText('Filters');
      await s.settle(3000);
    },
  },
  {
    id: 'sent-to-you',
    url: '/recommendations',
    run: async (s) => {
      await s.tapText('Sent to you');
      await s.waitPartial('You will lose your mind');
      await s.settle(1200);
    },
  },
  {
    id: 'group-picks',
    url: '/recommendations',
    run: async (s) => {
      await s.tapText('Group Picks');
      await s.tapText('Maya Chen');
      await s.tapText('Theo Okafor');
      await s.waitPartial('Get picks for');
      await s.settle(800);
    },
  },
  {
    id: 'profile',
    url: '/profile',
    run: async (s) => {
      await s.waitText('Alex Rivera');
      await s.settle(1500);
    },
  },
  {
    id: 'awards',
    url: '/profile',
    run: async (s) => {
      await s.tapText('See all');
      await s.settle(1200);
    },
  },
];
