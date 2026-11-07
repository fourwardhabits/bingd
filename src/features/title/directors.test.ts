import { directedBy } from './directors';

/** The Cinematic module's quiet director line (title-page sprint, 2026-11-06). */
describe('directedBy', () => {
  it('names one director', () => {
    expect(directedBy(['Christian Alvart'])).toEqual({
      text: 'Directed by Christian Alvart',
      label: 'Directed by Christian Alvart',
    });
  });

  it('names both of two', () => {
    expect(directedBy(['Daniel Kwan', 'Daniel Scheinert'])?.text).toBe(
      'Directed by Daniel Kwan and Daniel Scheinert',
    );
  });

  it('names two and counts the rest past two, and says everyone aloud', () => {
    expect(directedBy(['A One', 'B Two', 'C Three', 'D Four'])).toEqual({
      text: 'Directed by A One, B Two and 2 more',
      label: 'Directed by A One, B Two, C Three and D Four',
    });
  });

  it('is nothing at all without a name', () => {
    expect(directedBy([])).toBeNull();
    expect(directedBy(['  ', ''])).toBeNull();
  });
});
