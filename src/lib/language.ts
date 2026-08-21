/**
 * An ISO 639-1 code as a word: `te` is Telugu, `ko` is Korean.
 *
 * ## Why this is a table and not `Intl.DisplayNames`
 *
 * It was `Intl.DisplayNames`, and the founder's Android Preview drew `en`, `te` and
 * `ko` in the collection filter sheet — raw codes, on a control, which is the one
 * outcome the design rules out.
 *
 * The call site was already right. **Hermes does not implement `Intl.DisplayNames`.**
 * React Native's engine exposes `Collator`, `DateTimeFormat` and `NumberFormat` against
 * the platform's own tables and nothing else, so `new Intl.DisplayNames(...)` throws on
 * the device. The old code caught that and returned null, and every caller fell back to
 * the code — correctly, and invisibly.
 *
 * Invisibly because **Jest runs on Node, which has full ICU**. Every test passed against
 * a resolver the phone does not have. That is the defect worth naming rather than the
 * missing names: the platform difference sat inside a `try`, so the fallback did all the
 * work in production and none of it under test.
 *
 * A polyfill was the other fix. This is deliberately not one. A table gives the same
 * answer on Hermes, on Node and in a browser, so a test now means what it says about a
 * phone; a polyfill would have left three platforms and three possible answers. It also
 * keeps this release JS-only — no dependency, no lockfile change, nothing that could
 * move a native fingerprint.
 *
 * ## What it costs
 *
 * English names only, where `Intl` would have said `japonais` to a French reader. Bingd
 * is not localised — every string in the app is English — so this loses nothing that
 * exists, and a second locale makes this one table per locale rather than a different
 * mechanism.
 *
 * The names are ICU's own, resolved from Node once and pasted, so they match what the
 * app showed on any device that could resolve them at all.
 */

/**
 * The 183 ISO 639-1 codes, plus the two TMDB writes that are not among them.
 *
 * This is the vocabulary `media_items.original_language` draws from: TMDB writes ISO
 * 639-1 there and the Wikidata seed does the same. It is not exhaustive about every
 * code a provider could invent — see {@link languageName} for what happens to one that
 * is not here.
 */
const NAMES: Record<string, string> = {
  aa: 'Afar',
  ab: 'Abkhazian',
  ae: 'Avestan',
  af: 'Afrikaans',
  ak: 'Akan',
  am: 'Amharic',
  an: 'Aragonese',
  ar: 'Arabic',
  as: 'Assamese',
  av: 'Avaric',
  ay: 'Aymara',
  az: 'Azerbaijani',
  ba: 'Bashkir',
  be: 'Belarusian',
  bg: 'Bulgarian',
  bi: 'Bislama',
  bm: 'Bambara',
  bn: 'Bangla',
  bo: 'Tibetan',
  br: 'Breton',
  bs: 'Bosnian',
  ca: 'Catalan',
  ce: 'Chechen',
  ch: 'Chamorro',
  // TMDB's own, and not ISO 639-1: it writes `cn` for Cantonese and `zh` for the rest
  // of Chinese. A code the provider actually produces has to be nameable here, or the
  // filter sheet shows it raw — which is the whole defect this module exists for.
  cn: 'Cantonese',
  co: 'Corsican',
  cr: 'Cree',
  cs: 'Czech',
  cu: 'Church Slavic',
  cv: 'Chuvash',
  cy: 'Welsh',
  da: 'Danish',
  de: 'German',
  dv: 'Divehi',
  dz: 'Dzongkha',
  ee: 'Ewe',
  el: 'Greek',
  en: 'English',
  eo: 'Esperanto',
  es: 'Spanish',
  et: 'Estonian',
  eu: 'Basque',
  fa: 'Persian',
  ff: 'Fula',
  fi: 'Finnish',
  fj: 'Fijian',
  fo: 'Faroese',
  fr: 'French',
  fy: 'Western Frisian',
  ga: 'Irish',
  gd: 'Scottish Gaelic',
  gl: 'Galician',
  gn: 'Guarani',
  gu: 'Gujarati',
  gv: 'Manx',
  ha: 'Hausa',
  he: 'Hebrew',
  hi: 'Hindi',
  ho: 'Hiri Motu',
  hr: 'Croatian',
  ht: 'Haitian Creole',
  hu: 'Hungarian',
  hy: 'Armenian',
  hz: 'Herero',
  ia: 'Interlingua',
  id: 'Indonesian',
  ie: 'Interlingue',
  ig: 'Igbo',
  ii: 'Sichuan Yi',
  ik: 'Inupiaq',
  io: 'Ido',
  is: 'Icelandic',
  it: 'Italian',
  iu: 'Inuktitut',
  ja: 'Japanese',
  jv: 'Javanese',
  ka: 'Georgian',
  kg: 'Kongo',
  ki: 'Kikuyu',
  kj: 'Kuanyama',
  kk: 'Kazakh',
  kl: 'Kalaallisut',
  km: 'Khmer',
  kn: 'Kannada',
  ko: 'Korean',
  kr: 'Kanuri',
  ks: 'Kashmiri',
  ku: 'Kurdish',
  kv: 'Komi',
  kw: 'Cornish',
  ky: 'Kyrgyz',
  la: 'Latin',
  lb: 'Luxembourgish',
  lg: 'Ganda',
  li: 'Limburgish',
  ln: 'Lingala',
  lo: 'Lao',
  lt: 'Lithuanian',
  lu: 'Luba-Katanga',
  lv: 'Latvian',
  mg: 'Malagasy',
  mh: 'Marshallese',
  mi: 'Māori',
  mk: 'Macedonian',
  ml: 'Malayalam',
  mn: 'Mongolian',
  mr: 'Marathi',
  ms: 'Malay',
  mt: 'Maltese',
  my: 'Burmese',
  na: 'Nauru',
  nb: 'Norwegian Bokmål',
  nd: 'North Ndebele',
  ne: 'Nepali',
  ng: 'Ndonga',
  nl: 'Dutch',
  nn: 'Norwegian Nynorsk',
  no: 'Norwegian',
  nr: 'South Ndebele',
  nv: 'Navajo',
  ny: 'Nyanja',
  oc: 'Occitan',
  oj: 'Ojibwa',
  om: 'Oromo',
  or: 'Odia',
  os: 'Ossetic',
  pa: 'Punjabi',
  pi: 'Pali',
  pl: 'Polish',
  ps: 'Pashto',
  pt: 'Portuguese',
  qu: 'Quechua',
  rm: 'Romansh',
  rn: 'Rundi',
  ro: 'Romanian',
  ru: 'Russian',
  rw: 'Kinyarwanda',
  sa: 'Sanskrit',
  sc: 'Sardinian',
  sd: 'Sindhi',
  se: 'Northern Sami',
  sg: 'Sango',
  // Retired from ISO 639-1, and still written by providers with older catalogues.
  sh: 'Serbo-Croatian',
  si: 'Sinhala',
  sk: 'Slovak',
  sl: 'Slovenian',
  sm: 'Samoan',
  sn: 'Shona',
  so: 'Somali',
  sq: 'Albanian',
  sr: 'Serbian',
  ss: 'Swati',
  st: 'Southern Sotho',
  su: 'Sundanese',
  sv: 'Swedish',
  sw: 'Swahili',
  ta: 'Tamil',
  te: 'Telugu',
  tg: 'Tajik',
  th: 'Thai',
  ti: 'Tigrinya',
  tk: 'Turkmen',
  tl: 'Filipino',
  tn: 'Tswana',
  to: 'Tongan',
  tr: 'Turkish',
  ts: 'Tsonga',
  tt: 'Tatar',
  tw: 'Akan',
  ty: 'Tahitian',
  ug: 'Uyghur',
  uk: 'Ukrainian',
  ur: 'Urdu',
  uz: 'Uzbek',
  ve: 'Venda',
  vi: 'Vietnamese',
  vo: 'Volapük',
  wa: 'Walloon',
  wo: 'Wolof',
  xh: 'Xhosa',
  yi: 'Yiddish',
  yo: 'Yoruba',
  za: 'Zhuang',
  zh: 'Chinese',
  zu: 'Zulu',
};

/**
 * The code as it should be looked up: lower-cased, with any region dropped.
 *
 * `pt-BR` is Portuguese for this purpose. The facet Bingd filters on is the *original*
 * language of a title and no surface distinguishes a region within one, so a row that
 * arrives carrying one is still named rather than dropped.
 */
function normalise(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * The one place a language code becomes a word.
 *
 * Every user-facing surface goes through it: the collection filter sheet, the For You
 * filter sheet (the same component), the title details row, the title hero's rank line,
 * and Passport Mode's breakdown by way of the collection's own metadata.
 *
 * **The code stays the value.** This is display and nothing else. Filters, query keys
 * and `media_items.original_language` all keep the ISO code, because a label is not an
 * identity and `languages: ['Telugu']` matches no row in the database.
 *
 * Returns null rather than the code for one it cannot name, so a caller chooses between
 * falling back and dropping the option: the hero's rank line drops it, and the filter
 * sheet falls back to the code, because an option that exists in the data should stay
 * selectable even when we cannot name it well.
 */
/*
 * **A code outside the table is still drawn raw by the callers that fall back, and that
 * is deliberate — independent review 29 was right that the surrounding prose implied
 * otherwise.** This function is total over what the catalogue holds: every language in
 * `supabase/seed/catalogue.json` and every one TMDB enrichment brings in is above. It is
 * not total over what a provider *could* invent. Where that happens the filter sheet
 * shows the code rather than dropping a real option, and the rank line and Details row
 * show nothing — the same choice each made before, for the same reason.
 *
 * The founder's Preview defect was not "an unknown code appeared". It was that **every**
 * code appeared, on every device, because the resolver did not exist on Hermes. A table
 * lookup that misses a code nobody has ever written is a different and much smaller
 * thing, and it fails loudly enough to notice rather than silently everywhere.
 */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = normalise(code);
  // `hasOwnProperty` rather than a bare index, because `NAMES` is an object literal and
  // `NAMES['constructor']` is a function rather than undefined. Nothing in the app
  // passes such a code today; the guard costs one call and removes the question.
  if (!Object.prototype.hasOwnProperty.call(NAMES, key)) return null;
  return NAMES[key] ?? null;
}
