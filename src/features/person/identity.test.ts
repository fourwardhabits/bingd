import { birthLine, countryOf } from './identity';

/** Founder spec §6: at most `Born YYYY · Country` under the name, and never clutter. */
describe('birthLine', () => {
  it('is the birth year and the country, and nothing else', () => {
    expect(
      birthLine({ birthday: '1974-11-11', deathday: null, placeOfBirth: 'Los Angeles, California, USA' }),
    ).toBe('Born 1974 · USA');
    expect(birthLine({ birthday: '1959-02-04', deathday: null, placeOfBirth: 'Tokyo, Japan' })).toBe(
      'Born 1959 · Japan',
    );
  });

  it('gives a life that has ended its span instead of "born"', () => {
    expect(
      birthLine({ birthday: '1931-02-08', deathday: '2019-07-21', placeOfBirth: 'Marion, Indiana, USA' }),
    ).toBe('1931–2019 · USA');
  });

  it('keeps whichever half it has', () => {
    expect(birthLine({ birthday: '1980-01-01', deathday: null, placeOfBirth: null })).toBe('Born 1980');
    expect(birthLine({ birthday: null, deathday: null, placeOfBirth: 'Nairobi, Kenya' })).toBe('Kenya');
    expect(birthLine({ birthday: null, deathday: '2001-05-05', placeOfBirth: null })).toBe('Died 2001');
  });

  it('is null when there is nothing to say, so no line is drawn', () => {
    expect(birthLine({ birthday: null, deathday: null, placeOfBirth: null })).toBeNull();
    expect(birthLine({ birthday: 'unknown', deathday: null, placeOfBirth: '  ' })).toBeNull();
  });
});

describe('countryOf', () => {
  it('reads the last part of the birthplace, trimmed', () => {
    expect(countryOf('Shawnee, Oklahoma, USA')).toBe('USA');
    expect(countryOf(' Seoul , South Korea ')).toBe('South Korea');
    expect(countryOf('Paris')).toBe('Paris');
    expect(countryOf('')).toBeNull();
    expect(countryOf(null)).toBeNull();
  });
});
