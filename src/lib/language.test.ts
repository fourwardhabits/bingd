import { languageName } from './language';

/**
 * The founder's Android Preview showed `en`, `te` and `ko` in the collection filter
 * sheet. The call site was already asking for a name; `Intl.DisplayNames` does not
 * exist on Hermes, so the lookup threw and every caller fell back to the raw code.
 *
 * **The old test suite could not have caught it.** Jest runs on Node, which has full
 * ICU, so `Intl.DisplayNames` answered correctly here and only here. That is why the
 * assertions below are against a *table* rather than against whatever the host's ICU
 * happens to say: a test that resolves through the platform is a test that agrees with
 * the platform it is run on, which was exactly the problem.
 */
describe('languageName', () => {
  it('names the three codes the founder saw as codes', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('te')).toBe('Telugu');
    expect(languageName('ko')).toBe('Korean');
  });

  it('does not depend on the host having Intl.DisplayNames', () => {
    // The device does not have it. Deleting it here is the closest a Node test can get
    // to Hermes, and the point of the whole module is that this changes nothing.
    const original = (Intl as { DisplayNames?: unknown }).DisplayNames;
    try {
      delete (Intl as { DisplayNames?: unknown }).DisplayNames;
      expect(languageName('te')).toBe('Telugu');
      expect(languageName('ja')).toBe('Japanese');
    } finally {
      (Intl as { DisplayNames?: unknown }).DisplayNames = original;
    }
  });

  it('names every language in the seeded catalogue', () => {
    // `supabase/seed/catalogue.json` carries exactly these, and a filter sheet built
    // from a fresh install can offer no others.
    const seeded = ['en', 'it', 'de', 'ko', 'ja', 'fr', 'es', 'hi', 'ru', 'pt'];
    for (const code of seeded) {
      expect(languageName(code)).toMatch(/^[A-Z]/);
      expect(languageName(code)).not.toBe(code);
    }
  });

  it('names the Indian languages TMDB enrichment brings in', () => {
    // Telugu is how the founder found this. The rest arrive by the same route and
    // would have shown as codes for the same reason.
    expect(languageName('ta')).toBe('Tamil');
    expect(languageName('ml')).toBe('Malayalam');
    expect(languageName('kn')).toBe('Kannada');
    expect(languageName('mr')).toBe('Marathi');
    expect(languageName('bn')).toBe('Bangla');
    expect(languageName('pa')).toBe('Punjabi');
  });

  it("names the two codes TMDB writes that are not ISO 639-1", () => {
    expect(languageName('cn')).toBe('Cantonese');
    expect(languageName('sh')).toBe('Serbo-Croatian');
  });

  it('drops the region, because Bingd filters on the original language alone', () => {
    expect(languageName('pt-BR')).toBe('Portuguese');
    expect(languageName('zh_TW')).toBe('Chinese');
    expect(languageName('EN')).toBe('English');
  });

  it('returns null rather than the code, so a caller chooses the fallback', () => {
    // The filter sheet falls back to the code — an option in the data stays
    // selectable. The hero's rank line and the Details row drop it instead. Returning
    // the code here would take that choice away from both.
    expect(languageName('qqq')).toBeNull();
    expect(languageName('')).toBeNull();
    expect(languageName(null)).toBeNull();
    expect(languageName(undefined)).toBeNull();
  });

  it('never returns the code it was given', () => {
    // The whole defect in one assertion: a raw code reaching a label is the failure,
    // whatever the reason for it.
    for (const code of ['en', 'te', 'ko', 'ja', 'fr', 'zh', 'cn']) {
      expect(languageName(code)).not.toBe(code);
    }
  });

  it('is not confused by a prototype key', () => {
    // `NAMES` is an object literal, so `languageName('constructor')` must not return a
    // function's name. It reads as paranoia until a genre or a language label is ever
    // taken from provider data unchecked.
    expect(languageName('constructor')).toBeNull();
    expect(languageName('toString')).toBeNull();
  });
});
