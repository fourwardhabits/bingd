import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Recommend, on every surface that renders a commentable media post** (founder, post-RC).
 *
 * The Feed offered Recommend on a media row. The profile's *Recent activity* — the same
 * `ActivityRow`, the same event, the same person — offered comments and reactions and not
 * Recommend, so the same post carried the action on one screen and lost it on another.
 * The comment sitting directly above the missing prop even said "the same interactions the
 * Feed offers, because it is the same event".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SOURCE TEST AND NOT A RENDER TEST
 *
 * What broke was a **call site omission**, not component behaviour. `ActivityRow` already
 * draws the control correctly whenever it is handed `onPressRecommend`, and
 * `ActivityRow.test.tsx` covers that. Rendering the three screens instead would mean
 * standing up three navigation stacks and a dozen queries to prove which prop was passed —
 * a great deal of machinery to assert one line each, and machinery that would keep passing
 * if a fourth surface were added tomorrow without the prop.
 *
 * So the assertion is over the call sites themselves: every screen that hands `ActivityRow`
 * an `onPressComments` must also hand it an `onPressRecommend`. A new surface added without
 * it fails here, which is the failure that actually happened.
 */

const root = join(__dirname, '..', '..', '..');

/** Every screen that renders an ActivityRow with comments attached. */
const SURFACES = ['app/(tabs)/feed.tsx', 'app/(tabs)/profile.tsx', 'app/u/[username].tsx'];

const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('every commentable media post offers Recommend', () => {
  it.each(SURFACES)('%s passes onPressRecommend wherever it passes onPressComments', (file) => {
    const source = read(file);
    expect(source).toContain('onPressComments');
    expect(source).toContain('onPressRecommend');
  });

  it.each(SURFACES)('%s gates Recommend on a real media item', (file) => {
    // The half that keeps a genuinely non-media event — an award, a goal, joining from an
    // invitation — from being handed a recommendation target it does not have.
    expect(read(file)).toMatch(/onPressRecommend=\{[\s\S]{0,400}?mediaItemId/);
  });

  it.each(SURFACES)('%s excludes a series, which the server refuses', (file) => {
    // Not a UI preference: `recommend_title` refuses anything `rankable_category` returns
    // null for, on the grounds that a series is not a thing anybody watched. Offering the
    // control there would be offering an action that cannot succeed.
    expect(read(file)).toMatch(/onPressRecommend=\{[\s\S]{0,400}?kind !== 'series'/);
  });

  it.each(SURFACES)('%s mounts a RecommendSheet for the action to open', (file) => {
    const source = read(file);
    expect(source).toContain('RecommendSheet');
    // Mounted only while something is being recommended, like every other sheet here.
    expect(source).toMatch(/recommending\?\.mediaItemId \? \(/);
  });

  it('keeps the three surfaces on one GUARD, character for character', () => {
    // Three copies that drift are how this defect happened in the first place. If the rule
    // ever needs to differ per surface, that is a deliberate edit which fails here first.
    //
    // The **guard** is compared and not the whole prop: the handler after the `?` is
    // legitimately different per surface — the Feed also clears the "Recommended to …"
    // banner before reopening the sheet — so requiring those to match would be asserting a
    // coincidence rather than the rule.
    const guards = SURFACES.map((file) => {
      const match = read(file).match(/onPressRecommend=\{([\s\S]*?)\?/);
      return match?.[1]?.replace(/\s+/g, ' ').trim();
    });
    expect(new Set(guards).size).toBe(1);
    const [shared] = guards;
    expect(shared).toBeDefined();
    expect(shared).toContain('mediaItemId');
    expect(shared).toContain("kind !== 'series'");
  });
});
