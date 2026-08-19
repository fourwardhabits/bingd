import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The canonical product documents exist, and the links between them resolve.
 *
 * **Deliberately not a test of any prose.** A snapshot over a specification is a test that
 * fails every time somebody improves a sentence, which teaches people to update snapshots
 * without reading them — and it would say nothing about whether the documents are correct.
 *
 * What is worth asserting is the part that rots silently: a document renamed or moved
 * while three others still point at it. `PRD.md` now defers whole sections to
 * `analytics.md` and `deferred-roadmap.md` — "the reasoning is over there" is only true
 * while over there is somewhere. A dead link in a specification is worse than no link,
 * because the reader concludes the answer was never written down.
 *
 * `app-directory.test.ts` beside this file establishes the pattern: a structural guard
 * over the repository, in the suite that already runs, rather than a framework of its own.
 */

const ROOT = resolve(__dirname, '..', '..');
const PRODUCT = join(ROOT, 'docs', 'product');

/** The three that other documents and the code now point at by name. */
const CANONICAL = ['PRD.md', 'analytics.md', 'deferred-roadmap.md'];

const read = (file: string) => readFileSync(join(PRODUCT, file), 'utf8');

/**
 * Relative markdown links only.
 *
 * `http(s):` is somebody else's uptime, `#` is an anchor within the page, and `mailto:` is
 * not a path. Trailing `#anchor` is trimmed — the file is what this checks.
 */
const linksIn = (markdown: string): string[] =>
  [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .filter((href) => !/^(https?:|mailto:|#)/.test(href))
    .flatMap((href) => {
      const [path] = href.split('#');
      return path ? [path] : [];
    });

describe('the canonical product documents', () => {
  it.each(CANONICAL)('%s exists', (file) => {
    expect(existsSync(join(PRODUCT, file))).toBe(true);
  });

  it('the PRD points at the analytics spec and the deferred roadmap', () => {
    // Both are referenced from several sections as "the document to read instead", so a
    // PRD that stopped linking them would leave those sections claiming an answer exists
    // somewhere it does not.
    const prd = read('PRD.md');
    expect(prd).toContain('](./analytics.md)');
    expect(prd).toContain('](./deferred-roadmap.md)');
  });

  it('every relative link in docs/product resolves to a file that exists', () => {
    const broken: string[] = [];

    for (const file of readdirSync(PRODUCT).filter((name) => name.endsWith('.md'))) {
      const from = join(PRODUCT, file);
      for (const href of linksIn(readFileSync(from, 'utf8'))) {
        const target = resolve(dirname(from), href);
        if (!existsSync(target)) broken.push(`${file} → ${href}`);
      }
    }

    expect(broken).toEqual([]);
  });
});
