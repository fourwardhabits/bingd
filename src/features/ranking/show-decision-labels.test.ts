import fs from 'fs';
import path from 'path';

import { KEEP_SHOW_RANKING, UPDATE_SHOW_RANKING } from './show-decision-labels';

/**
 * **FU1113-D D3: no score on the parent-show decision, anywhere in its flow.**
 *
 * The labels are exactly the founder's words, and the source of both surfaces that draw
 * them carries no score-suffixed form ("Update Show 8.5", `Update Show ${…}`) — so an
 * old label cannot come back through a branch the rendering tests do not reach.
 */
describe('the show decision labels', () => {
  it('are exactly the founder’s words, with no digit', () => {
    expect(UPDATE_SHOW_RANKING).toBe('Update Show Ranking');
    expect(KEEP_SHOW_RANKING).toBe('Keep Show Ranking');
    for (const label of [UPDATE_SHOW_RANKING, KEEP_SHOW_RANKING])
      expect(label).not.toMatch(/\d/);
  });

  it.each(['src/features/ranking/RankingSheet.tsx', 'src/features/collection/LogSheet.tsx'])(
    '%s draws no score-suffixed Update Show / Keep Show label',
    (file) => {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(/(Update|Keep) Show \$\{/);
      expect(source).not.toMatch(/(Update|Keep) Show \d/);
      expect(source).not.toMatch(/showLabel\(/);
      // Every drawn label in the flow comes from the shared constants.
      expect(source).toMatch(/UPDATE_SHOW_RANKING/);
      expect(source).toMatch(/KEEP_SHOW_RANKING/);
      expect(source).not.toMatch(/label=["'{`]+(Update|Keep) Show/);
    },
  );
});
