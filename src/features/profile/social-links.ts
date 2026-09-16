/**
 * The five links a profile may carry: what a person is allowed to type, what gets
 * stored, and where a tap goes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT TWO HALVES OF TWO SCREENS
 *
 * There are exactly two questions here and they are the same question read in opposite
 * directions. Edit Profile turns whatever somebody pasted into a handle; the profile
 * header turns a handle back into a URL. If those live in different files they will
 * disagree — the form will accept a shape the header cannot build a link from — and the
 * failure is silent: an icon that opens the network's front page.
 *
 * So `normalizeSocialLink` and `socialLinkUrl` are written against each other, and
 * `social-links.test.ts` asserts the round trip rather than each half separately.
 *
 * ---------------------------------------------------------------------------
 * WHY A HANDLE IS STORED AND NOT A URL
 *
 * The same reason `lib/images.ts` stores a poster path and a YouTube key rather than
 * either URL: the origin belongs to the provider, not to the row. `x.com` was
 * `twitter.com`, and a table of stored URLs would still be pointing at it.
 *
 * It is also what makes the link safe to build by concatenation. A handle that survives
 * `HANDLE_SHAPE` has no scheme, no slash, no whitespace and no control character, so
 * `https://x.com/${handle}` is a URL whose whole shape is known here. Nothing stored is
 * ever handed to `Linking.openURL` as-is — except the website, which is why the website
 * is the one field with a scheme rule of its own.
 *
 * ---------------------------------------------------------------------------
 * HOW FORGIVING, AND WHERE IT STOPS
 *
 * The founder's rule is forgiving and inline, not a verification system. So every shape
 * somebody plausibly has on their clipboard is accepted — a bare name, an `@name`, a
 * profile URL with or without a scheme, with or without `www.`, with a trailing slash,
 * with a query string a share sheet appended.
 *
 * It stops at a link to the *wrong place*. Pasting a Letterboxd URL into the Instagram
 * box is a mistake worth reporting, because the alternative is storing `letterboxd.com`
 * as an Instagram handle and drawing an icon that goes nowhere. The refusal names what
 * the box wants rather than what was wrong with the input.
 */

/** Canonical order, top to bottom of the founder's list and left to right on screen. */
export const SOCIAL_NETWORKS = ['instagram', 'tiktok', 'youtube', 'x', 'website'] as const;

export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/** The four that store a handle. `website` stores a URL and is handled apart throughout. */
export type HandleNetwork = Exclude<SocialNetwork, 'website'>;

export type ProfileSocialLinks = Record<SocialNetwork, string | null>;

/** Every field null — what every account that existed before 20260921000100 has. */
export const NO_SOCIAL_LINKS: ProfileSocialLinks = {
  instagram: null,
  tiktok: null,
  youtube: null,
  x: null,
  website: null,
};

/**
 * The shape a stored handle has, and the same expression as `social_handle_shape`.
 *
 * Deliberately looser than any of the four networks' own rules — Instagram stops at 30
 * characters, X at 15 and underscores only. The migration argues the case at length: a
 * constraint that is too tight is the one that breaks a real person, and these rules
 * belong to the networks and have changed. This is a *safety* shape. It says the value
 * is one path segment beginning with something real, which is what makes the URL
 * built from it a URL we chose.
 */
const HANDLE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * The shape a stored website has, and the same expression as `social_website_shape`.
 *
 * `https` is matched literally. That is the refusal of `javascript:`, `data:`, `file:`
 * and `intent:` — written once, as a shape, rather than as a list of schemes somebody
 * has to keep complete.
 */
const WEBSITE_SHAPE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}([:/?#][^\s]*)?$/;

const WEBSITE_MAX = 200;

/** What a viewer's screen reader is given. The founder's wording, exactly. */
export const SOCIAL_LINK_LABELS: Record<SocialNetwork, string> = {
  instagram: 'Open Instagram profile',
  tiktok: 'Open TikTok profile',
  youtube: 'Open YouTube profile',
  x: 'Open X profile',
  website: 'Open website',
};

/** The name of the box in Edit Profile. */
export const SOCIAL_FIELD_LABELS: Record<SocialNetwork, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  website: 'Website',
};

/**
 * Under the box, permanently. An example rather than a rule, because the rule is
 * "whatever you have" and a sentence saying so teaches nobody what to paste.
 */
export const SOCIAL_FIELD_HINTS: Record<SocialNetwork, string> = {
  instagram: 'Your username, or the link to your profile.',
  tiktok: 'Your username, or the link to your profile.',
  youtube: 'Your @handle, or the link to your channel.',
  x: 'Your username, or the link to your profile. twitter.com links work too.',
  website: 'Your site. We will add https:// if you leave it off.',
};

/**
 * Hosts each box will accept a link from, after `www.` and friends are stripped.
 *
 * `twitter.com` is here because the rename did not reach anybody's bookmarks, and it
 * normalises to the same handle `x.com` would have produced — which is the point of
 * storing a handle rather than the link.
 *
 * `youtu.be` is deliberately **not** here. It is a video share link, never a channel
 * one, so the segment after it is a video id: accepting it would store something that
 * looks like a handle and resolves to nothing.
 */
const HOSTS: Record<HandleNetwork, readonly string[]> = {
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com'],
  x: ['x.com', 'twitter.com'],
};

/** Every host any box accepts, for telling `instagram.com` from `suraj.k`. */
const ALL_HOSTS = new Set(Object.values(HOSTS).flat());

/**
 * First path segments that are the site's own routes rather than anybody's name.
 *
 * **This is the case the docblock above promises to prevent and did not.** A person
 * copying "their Instagram" very often copies the post they are looking at —
 * `instagram.com/p/Cxyz123/` — and taking the first segment would store the handle `p`
 * and draw an icon that opens the site's post router. That is exactly the silent
 * failure the YouTube channel-id branch exists to refuse, and the other three networks
 * had no equivalent.
 *
 * Refused rather than repaired, because there is nothing to repair towards: a post URL
 * does not contain the account's handle in a position anything here could read. The
 * message says what the box wants instead.
 *
 * Deliberately short. It is the routes somebody plausibly has on their clipboard, not
 * an attempt at each site's full reserved list — a name that slips through is stored
 * and draws a link that does not resolve, which is the ordinary cost of a wrong handle
 * and recoverable by editing it. The values here are the ones that are *likely*.
 */
const RESERVED: Record<HandleNetwork, readonly string[]> = {
  instagram: ['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct'],
  tiktok: ['video', 'tag', 'music', 'discover', 'explore', 'foryou', 'live'],
  // 'channel' is deliberately absent: `youtubeSegment` refuses it with a sharper
  // instruction than this table can give, and the specific message is the useful one.
  youtube: ['watch', 'shorts', 'playlist', 'results', 'feed'],
  x: ['i', 'home', 'search', 'hashtag', 'intent', 'share', 'explore', 'notifications'],
};

export type Normalized =
  | { ok: true; value: string | null }
  /** Shown under the field, in the `error` slot `Field` already has. */
  | { ok: false; message: string };

/** Control characters out, ends trimmed. Everything below assumes this has run. */
const clean = (raw: string) =>
  raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();

/**
 * The scheme, if the value has one — including the ones with no `//` after the colon.
 *
 * `javascript:alert(1)` and `data:text/html,…` are exactly that shape, so a check that
 * only looked for `://` would let both through to be treated as a bare handle.
 */
const schemeOf = (value: string): string | null => {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
};

const stripSubdomain = (host: string) => host.replace(/^(www|m|mobile)\./i, '');

/**
 * A pasted value pulled apart into a host and the path segments after it.
 *
 * `host` is null when the value was never a link — a bare handle — which is the common
 * case and the one that has to stay effortless.
 */
const parse = (value: string): { host: string | null; segments: string[] } => {
  const withoutScheme = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  const pathPart = withoutScheme.split(/[?#]/)[0] ?? '';
  const parts = pathPart.split('/').filter((part) => part.length > 0);

  const [head] = parts;
  if (head === undefined) return { host: null, segments: [] };

  const candidate = stripSubdomain(head.split(':')[0] ?? head).toLowerCase();

  // A first segment with a dot in it is a host. A handle may contain a dot too
  // (`suraj.k` on TikTok), so the distinction is made by the value having been a link
  // at all — a scheme, or something after the first slash — or by the segment being a
  // host this module already knows, which is what catches a bare `instagram.com`.
  const looksLikeHost =
    (head.includes('.') && (value.includes('://') || parts.length > 1)) ||
    ALL_HOSTS.has(candidate);
  if (!looksLikeHost) return { host: null, segments: parts };

  return { host: candidate, segments: parts.slice(1) };
};

const stripAt = (value: string) => (value.startsWith('@') ? value.slice(1) : value);

/**
 * YouTube is the one network whose URLs are not all reducible to a handle.
 *
 * `/@name` is a handle. `/c/name` and `/user/name` are the legacy forms of the same
 * thing and resolve as handles in practice, so they are taken. `/channel/UC…` is a
 * channel **id** — `youtube.com/@UCxyz` does not resolve — so it is refused with the
 * one instruction that fixes it, rather than stored as a link that quietly goes
 * nowhere. That refusal is the whole of the "heavyweight verification" this feature
 * does not do.
 */
const youtubeSegment = (segments: string[]): Normalized => {
  if (segments.length === 0) return { ok: true, value: null };

  const [first, second] = segments;
  if (first === undefined) return { ok: true, value: null };

  if (first.toLowerCase() === 'channel') {
    // `youtube.com/@UCxyz` does not resolve, so a channel id cannot become a handle.
    // Named separately from `RESERVED` because this one has a specific instruction.
    return {
      ok: false,
      message: 'That is a channel ID. Use your YouTube @handle instead.',
    };
  }
  // The legacy forms of the same thing, which do resolve as handles in practice.
  if (['c', 'user'].includes(first.toLowerCase()) && second) {
    return { ok: true, value: second };
  }
  return { ok: true, value: first };
};

/**
 * Whatever somebody typed, as the value that will be stored — or the sentence to show
 * them under the box.
 *
 * An empty box is `{ ok: true, value: null }` and never an error: none of these fields
 * is required, and "" is how the screen says *clear this one*.
 */
export function normalizeSocialLink(network: SocialNetwork, raw: string): Normalized {
  const value = clean(raw);
  if (value === '') return { ok: true, value: null };

  return network === 'website' ? normalizeWebsite(value) : normalizeHandle(network, value);
}

function normalizeHandle(network: HandleNetwork, value: string): Normalized {
  const name = SOCIAL_FIELD_LABELS[network];
  const scheme = schemeOf(value);

  // Refused before anything is parsed out of it. A `javascript:` payload is not a badly
  // typed handle and must not be treated as one anywhere downstream.
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return { ok: false, message: `Enter your ${name} username, not a link.` };
  }

  const { host, segments } = parse(value);

  if (host && !HOSTS[network].includes(host)) {
    // The likeliest cause by far is pasting into the box below the one they meant.
    return { ok: false, message: `That is a link to ${host}. Enter your ${name} instead.` };
  }

  // A route of the site rather than a name. Only meaningful once the host is one this
  // box accepts: a bare `p` typed into the Instagram box is somebody's handle, and
  // refusing it would be this check inventing a rule the network does not have.
  const head = segments[0];
  if (host && head && RESERVED[network].includes(stripAt(head).toLowerCase())) {
    return {
      ok: false,
      message: `That is a link to a page, not a profile. Enter your ${name} username.`,
    };
  }

  const picked: Normalized =
    network === 'youtube' && host
      ? youtubeSegment(segments)
      : { ok: true, value: head ?? null };

  if (!picked.ok) return picked;
  if (picked.value === null) {
    return { ok: false, message: `Enter your ${name} username.` };
  }

  const handle = stripAt(picked.value);

  if (handle === '') return { ok: false, message: `Enter your ${name} username.` };
  if (!HANDLE_SHAPE.test(handle)) {
    return {
      ok: false,
      message: `A ${name} username is letters, numbers, dots, dashes or underscores.`,
    };
  }

  // Case is kept as typed. All four resolve case-insensitively, the handle is never
  // displayed — the row draws an icon — and lower-casing somebody's `SurajWatches`
  // would be a change made for tidiness that nothing reads.
  return { ok: true, value: handle };
}

function normalizeWebsite(value: string): Normalized {
  const scheme = schemeOf(value);

  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return { ok: false, message: 'A website must start with https://' };
  }

  // `http` is upgraded rather than refused, and a missing scheme is filled in. Both are
  // the founder's "normalize to a valid HTTPS URL when reasonable": somebody typing
  // `example.com` has told us everything except the part nobody types.
  const withScheme = scheme
    ? value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, 'https://')
    : `https://${value}`;

  // A bare trailing slash on the root only. Deeper paths keep theirs, because a
  // trailing slash can be meaningful there and this is tidying, not rewriting.
  const trimmed = withScheme.replace(/^(https:\/\/[^/?#]+)\/$/, '$1');

  if (trimmed.length > WEBSITE_MAX) {
    return {
      ok: false,
      message: `A website address must be ${WEBSITE_MAX} characters or fewer.`,
    };
  }
  if (!WEBSITE_SHAPE.test(trimmed)) {
    return { ok: false, message: 'That does not look like a web address.' };
  }

  return { ok: true, value: trimmed };
}

/**
 * Where a tap goes.
 *
 * **Every value is re-checked here even though the form and the database both checked
 * it.** That is not belt and braces for its own sake: this function is the last thing
 * between stored text and `Linking.openURL`, it is the only place in the app that
 * builds a URL out of another person's profile, and a row that predates a constraint —
 * or one written by a client this app has not shipped yet — must produce no link rather
 * than a link somebody else chose.
 *
 * Null for anything that fails, and the row renders no icon for a null.
 */
export function socialLinkUrl(network: SocialNetwork, value: string | null): string | null {
  if (!value) return null;

  if (network === 'website') {
    return value.length <= WEBSITE_MAX && WEBSITE_SHAPE.test(value) ? value : null;
  }

  if (!HANDLE_SHAPE.test(value)) return null;

  switch (network) {
    // The trailing slash is Instagram's own canonical form; the others have none.
    case 'instagram':
      return `https://www.instagram.com/${value}/`;
    case 'tiktok':
      return `https://www.tiktok.com/@${value}`;
    case 'youtube':
      return `https://www.youtube.com/@${value}`;
    case 'x':
      return `https://x.com/${value}`;
  }
}

export type ConfiguredSocialLink = {
  network: SocialNetwork;
  url: string;
  label: string;
};

/**
 * The links this profile actually has, in the canonical order, ready to draw.
 *
 * Empty for a profile with none — which is what lets the header render no row at all
 * rather than an empty one, and what keeps every account that existed before this
 * feature looking exactly as it did.
 */
export function configuredSocialLinks(
  links: Partial<ProfileSocialLinks> | null | undefined,
): ConfiguredSocialLink[] {
  if (!links) return [];

  const out: ConfiguredSocialLink[] = [];
  for (const network of SOCIAL_NETWORKS) {
    const url = socialLinkUrl(network, links[network] ?? null);
    if (url) out.push({ network, url, label: SOCIAL_LINK_LABELS[network] });
  }
  return out;
}
