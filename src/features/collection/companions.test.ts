import { taggableWith, type Person } from './use-companions';

/**
 * The picker's list after the tagging rule narrowed to mutual follows
 * (20260817001300).
 *
 * `set_watch_tags` grandfathers a companion already on a watch, so the picker has to
 * agree — built from current mutuals alone it would draw a shorter list than the one
 * being saved, and there would be no row to untick for the one person the reader
 * actually wants to remove.
 */
const person = (id: string, name: string): Person => ({
  id,
  name,
  username: name.toLowerCase(),
  avatarUri: null,
});

describe('who the companion picker offers', () => {
  it('keeps somebody already on the watch whose follow has lapsed', () => {
    const mutuals = [person('1', 'Ada')];
    const onThisWatch = [person('2', 'Bo')];

    expect(taggableWith(mutuals, onThisWatch).map((p) => p.id)).toEqual(['1', '2']);
  });

  it('does not list a mutual twice when they are also on the watch', () => {
    const ada = person('1', 'Ada');
    expect(taggableWith([ada], [ada]).map((p) => p.id)).toEqual(['1']);
  });

  it('reads current mutuals first', () => {
    // The people still connected are the ones most likely to be tapped, and a list
    // that leads with a lapsed follow reads as though the rule had not changed.
    const result = taggableWith([person('1', 'Ada')], [person('0', 'Zed')]);
    expect(result.map((p) => p.id)).toEqual(['1', '0']);
  });

  it('is just the mutuals when the watch has no companions yet', () => {
    expect(taggableWith([person('1', 'Ada')], []).map((p) => p.id)).toEqual(['1']);
  });
});
