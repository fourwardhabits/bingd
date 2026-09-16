import {
  configuredSocialLinks,
  normalizeSocialLink,
  socialLinkUrl,
  SOCIAL_NETWORKS,
  type ProfileSocialLinks,
  type SocialNetwork,
} from './social-links';

/**
 * What a person may type, what gets stored, and where a tap goes.
 *
 * The two halves are asserted against each other rather than separately — see the
 * module docblock. A form that accepts a shape the header cannot build a link from is
 * the failure this file exists to catch, and it is silent on a device: an icon that
 * opens the network's front page.
 */

const value = (network: SocialNetwork, input: string) => {
  const result = normalizeSocialLink(network, input);
  if (!result.ok)
    throw new Error(`${network} refused ${JSON.stringify(input)}: ${result.message}`);
  return result.value;
};

const refusal = (network: SocialNetwork, input: string) => {
  const result = normalizeSocialLink(network, input);
  if (result.ok)
    throw new Error(`${network} accepted ${JSON.stringify(input)} as ${result.value}`);
  return result.message;
};

describe('an empty box', () => {
  it('is null on every network, and never an error', () => {
    // None of the five is required, and '' is how the screen says "clear this one".
    for (const network of SOCIAL_NETWORKS) {
      expect(normalizeSocialLink(network, '')).toEqual({ ok: true, value: null });
      expect(normalizeSocialLink(network, '   ')).toEqual({ ok: true, value: null });
    }
  });
});

describe('Instagram', () => {
  it.each([
    ['suraj', 'suraj'],
    ['@suraj', 'suraj'],
    ['  @suraj  ', 'suraj'],
    ['instagram.com/suraj', 'suraj'],
    ['www.instagram.com/suraj', 'suraj'],
    ['https://instagram.com/suraj', 'suraj'],
    ['https://www.instagram.com/suraj/', 'suraj'],
    ['https://www.instagram.com/suraj/?hl=en', 'suraj'],
    ['http://instagram.com/suraj', 'suraj'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(value('instagram', input)).toBe(expected);
  });

  it('builds the canonical profile URL', () => {
    expect(socialLinkUrl('instagram', 'suraj')).toBe('https://www.instagram.com/suraj/');
  });

  it('refuses a link to somewhere else, and names where it went', () => {
    // The likeliest cause by far is pasting into the box below the one they meant.
    expect(refusal('instagram', 'https://letterboxd.com/suraj')).toMatch(/letterboxd\.com/);
  });

  it('refuses the bare host, which carries no username', () => {
    expect(refusal('instagram', 'instagram.com')).toMatch(/username/i);
  });
});

describe('TikTok', () => {
  it.each([
    ['surajk', 'surajk'],
    ['@surajk', 'surajk'],
    ['suraj.k', 'suraj.k'],
    ['tiktok.com/@surajk', 'surajk'],
    ['https://www.tiktok.com/@surajk', 'surajk'],
    ['https://www.tiktok.com/@suraj.k?lang=en', 'suraj.k'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(value('tiktok', input)).toBe(expected);
  });

  it('keeps a dot in a handle rather than reading it as a host', () => {
    // `suraj.k` is a real TikTok handle shape, and it is why "has a dot" alone cannot
    // be what tells a host from a name.
    expect(value('tiktok', 'suraj.k')).toBe('suraj.k');
  });

  it('builds the canonical profile URL, with the @ the path needs', () => {
    expect(socialLinkUrl('tiktok', 'surajk')).toBe('https://www.tiktok.com/@surajk');
  });
});

describe('YouTube', () => {
  it.each([
    ['SurajWatches', 'SurajWatches'],
    ['@SurajWatches', 'SurajWatches'],
    ['youtube.com/@SurajWatches', 'SurajWatches'],
    ['https://www.youtube.com/@SurajWatches', 'SurajWatches'],
    ['https://www.youtube.com/c/SurajWatches', 'SurajWatches'],
    ['https://www.youtube.com/user/SurajWatches', 'SurajWatches'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(value('youtube', input)).toBe(expected);
  });

  it('keeps the case somebody typed', () => {
    // The URL resolves case-insensitively and the handle is never displayed — the row
    // draws an icon — so lower-casing it would be a change nothing reads.
    expect(value('youtube', '@SurajWatches')).toBe('SurajWatches');
  });

  it('refuses a channel ID with the one instruction that fixes it', () => {
    // `youtube.com/@UCxyz` does not resolve, so storing it would be an icon that
    // quietly goes nowhere. This refusal is the whole of the verification this
    // feature does.
    expect(refusal('youtube', 'https://www.youtube.com/channel/UCabc123')).toMatch(/@handle/i);
  });

  it('refuses a youtu.be share link, which names a video and not a channel', () => {
    expect(refusal('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toMatch(/youtu\.be/);
  });

  it('builds the canonical profile URL', () => {
    expect(socialLinkUrl('youtube', 'SurajWatches')).toBe(
      'https://www.youtube.com/@SurajWatches',
    );
  });
});

describe('X', () => {
  it.each([
    ['suraj', 'suraj'],
    ['@suraj', 'suraj'],
    ['x.com/suraj', 'suraj'],
    ['https://x.com/suraj', 'suraj'],
    ['twitter.com/suraj', 'suraj'],
    ['https://twitter.com/suraj', 'suraj'],
    ['https://www.twitter.com/suraj', 'suraj'],
    ['https://x.com/suraj/status/1234567890', 'suraj'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(value('x', input)).toBe(expected);
  });

  it('normalizes a twitter.com link to the same handle an x.com link gives', () => {
    // The whole argument for storing a handle instead of a URL: the rename did not
    // strand a single row, and it would have stranded every one of them.
    expect(value('x', 'https://twitter.com/suraj')).toBe(value('x', 'https://x.com/suraj'));
  });

  it('builds the x.com URL from either input', () => {
    expect(socialLinkUrl('x', value('x', 'https://twitter.com/suraj'))).toBe(
      'https://x.com/suraj',
    );
  });
});

describe('a website', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['www.example.com', 'https://www.example.com'],
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['http://example.com', 'https://example.com'],
    ['  example.com  ', 'https://example.com'],
    ['https://example.com/films/', 'https://example.com/films/'],
    ['https://example.com/films?sort=year', 'https://example.com/films?sort=year'],
    ['https://example.co.uk', 'https://example.co.uk'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(value('website', input)).toBe(expected);
  });

  it('upgrades http rather than refusing it', () => {
    expect(value('website', 'http://example.com/about')).toBe('https://example.com/about');
  });

  it('keeps a deeper path’s trailing slash and drops only the root’s', () => {
    // Tidying, not rewriting: a trailing slash can be meaningful on a path.
    expect(value('website', 'https://example.com/')).toBe('https://example.com');
    expect(value('website', 'https://example.com/blog/')).toBe('https://example.com/blog/');
  });

  it('returns the stored value unchanged as the link', () => {
    expect(socialLinkUrl('website', 'https://example.com/about')).toBe(
      'https://example.com/about',
    );
  });
});

describe('the schemes that must never be opened', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'jAvAsCrIpT:alert(document.cookie)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///etc/passwd',
    'intent://scan#Intent;scheme=zxing;end',
    'mailto:someone@example.com',
    'tel:+15550100',
  ])('refuses %s in the website box', (input) => {
    expect(normalizeSocialLink('website', input).ok).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
  ])('refuses %s in a handle box too', (input) => {
    // Refused before anything is parsed out of it, so a payload is never treated as a
    // badly typed handle anywhere downstream.
    for (const network of ['instagram', 'tiktok', 'youtube', 'x'] as const) {
      expect(normalizeSocialLink(network, input).ok).toBe(false);
    }
  });

  it('refuses a protocol-relative address, which has no scheme to check', () => {
    expect(normalizeSocialLink('website', '//evil.example').ok).toBe(false);
  });

  it('refuses a scheme smuggled past a control character', () => {
    // `clean` strips control characters before the scheme is read, so `java\nscript:`
    // is read as `javascript:` rather than as a hostname.
    expect(normalizeSocialLink('website', 'java\nscript:alert(1)').ok).toBe(false);
  });
});

describe('a handle that could choose its own path', () => {
  it.each(['..', '.', 'two words', '-leading-dash', '_leading_underscore'])(
    'refuses %s outright',
    (input) => {
      expect(normalizeSocialLink('instagram', input).ok).toBe(false);
    },
  );

  it.each(['suraj/../elsewhere', 'suraj/status', 'suraj//', 'suraj/'])(
    'reduces %s to the first segment rather than storing a path',
    (input) => {
      // Not cosmetic. `socialLinkUrl` builds `https://x.com/${handle}` by
      // concatenation, so a stored value with a slash in it would be choosing the rest
      // of the path. Nothing past the first segment survives normalisation — which is
      // also what makes `x.com/suraj/status/123` work, and is the same rule.
      expect(value('instagram', input)).toBe('suraj');
    },
  );

  it('never returns a value the shape would refuse', () => {
    // The property the two cases above are each an instance of: whatever comes out is
    // safe to concatenate, or nothing comes out.
    for (const input of ['suraj/../x', '@@suraj', 'https://instagram.com/suraj/tagged/']) {
      const result = normalizeSocialLink('instagram', input);
      if (result.ok && result.value !== null) {
        expect(result.value).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
      }
    }
  });

  it('refuses more than forty characters', () => {
    expect(normalizeSocialLink('instagram', 'a'.repeat(41)).ok).toBe(false);
    expect(value('instagram', 'a'.repeat(40))).toBe('a'.repeat(40));
  });
});

/**
 * **A link to a page the person was looking at, rather than to themselves.**
 *
 * This is the likeliest wrong paste there is: somebody copies "their Instagram" from
 * the post that is on screen. Taking the first segment would store the handle `p` and
 * draw an icon that opens the site's post router — the silent failure this module's
 * docblock claims to prevent, and which the YouTube branch was the only guard against
 * until an independent review found the other three had none.
 *
 * Refused rather than repaired: a post URL does not contain the account's handle
 * anywhere this code could read it, so there is nothing to normalise towards.
 */
describe('a link to a page rather than a profile', () => {
  it.each([
    ['instagram', 'https://www.instagram.com/p/Cxyz123/'],
    ['instagram', 'https://www.instagram.com/reel/Cxyz123/'],
    ['instagram', 'instagram.com/stories/suraj/123'],
    ['tiktok', 'https://www.tiktok.com/video/7123456789'],
    ['tiktok', 'https://www.tiktok.com/tag/horror'],
    ['x', 'https://x.com/i/status/1234567890'],
    ['x', 'https://twitter.com/hashtag/film'],
    ['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://www.youtube.com/shorts/abc123'],
  ] as const)('refuses %s %s', (network, input) => {
    const result = normalizeSocialLink(network, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not a profile|@handle/i);
  });

  it('still accepts the same word as a handle when it was typed as one', () => {
    // `p` is a route on instagram.com and a perfectly good username. The check only
    // fires once a host this box accepts has been recognised, so it cannot invent a
    // rule the network does not have.
    expect(value('instagram', 'p')).toBe('p');
    expect(value('x', 'i')).toBe('i');
  });

  it('still accepts a status link that does name its author', () => {
    // `x.com/suraj/status/123` leads with the handle; only `x.com/i/status/123` does not.
    expect(value('x', 'https://x.com/suraj/status/1234567890')).toBe('suraj');
  });
});

describe('socialLinkUrl as the last gate', () => {
  it('refuses a stored value that should never have been stored', () => {
    // The form checked it and the database checked it. This is checked anyway: it is
    // the only place in the app that builds a URL out of another person's profile, and
    // a row written by a client this app has not shipped must produce no link rather
    // than a link somebody else chose.
    for (const bad of ['../../evil', 'a b', 'javascript:alert(1)', 'suraj/status']) {
      expect(socialLinkUrl('x', bad)).toBeNull();
    }
    expect(socialLinkUrl('website', 'javascript:alert(1)')).toBeNull();
    expect(socialLinkUrl('website', 'http://example.com')).toBeNull();
  });

  it('is null for a null, which is how the row draws nothing', () => {
    for (const network of SOCIAL_NETWORKS) {
      expect(socialLinkUrl(network, null)).toBeNull();
    }
  });
});

describe('configuredSocialLinks', () => {
  const links = (over: Partial<ProfileSocialLinks> = {}): ProfileSocialLinks => ({
    instagram: null,
    tiktok: null,
    youtube: null,
    x: null,
    website: null,
    ...over,
  });

  it('is empty for a profile with none, so the header can render no row at all', () => {
    expect(configuredSocialLinks(links())).toEqual([]);
  });

  it('is empty for a legacy profile that has no link fields at all', () => {
    // Every account that existed before 20260921000100. Absent is not different from
    // null here, and it must not be.
    expect(configuredSocialLinks(null)).toEqual([]);
    expect(configuredSocialLinks(undefined)).toEqual([]);
    expect(configuredSocialLinks({})).toEqual([]);
  });

  it('is one entry for one configured network', () => {
    expect(configuredSocialLinks(links({ tiktok: 'surajk' }))).toEqual([
      {
        network: 'tiktok',
        url: 'https://www.tiktok.com/@surajk',
        label: 'Open TikTok profile',
      },
    ]);
  });

  it('is the founder’s order regardless of which are set', () => {
    const all = configuredSocialLinks(
      links({
        website: 'https://example.com',
        x: 'suraj',
        instagram: 'suraj',
        youtube: 'SurajWatches',
        tiktok: 'surajk',
      }),
    );
    expect(all.map((link) => link.network)).toEqual([
      'tiktok',
      'instagram',
      'x',
      'youtube',
      'website',
    ]);
  });

  it('skips a network whose stored value cannot make a link', () => {
    expect(
      configuredSocialLinks(links({ instagram: 'suraj', x: '../evil' })).map((l) => l.network),
    ).toEqual(['instagram']);
  });

  it('carries the founder’s accessibility labels verbatim', () => {
    const all = configuredSocialLinks(
      links({
        instagram: 'a',
        tiktok: 'b',
        youtube: 'c',
        x: 'd',
        website: 'https://example.com',
      }),
    );
    expect(all.map((link) => link.label)).toEqual([
      'Open TikTok profile',
      'Open Instagram profile',
      'Open X profile',
      'Open YouTube profile',
      'Open website',
    ]);
  });
});

describe('the round trip', () => {
  it.each([
    ['instagram', 'https://www.instagram.com/suraj/'],
    ['tiktok', 'https://www.tiktok.com/@suraj'],
    ['youtube', 'https://www.youtube.com/@suraj'],
    ['x', 'https://x.com/suraj'],
  ] as const)('%s survives being pasted back into its own box', (network, url) => {
    // The link the header builds has to be a link the form accepts, or a person who
    // copies their own profile link out of the app cannot paste it back in.
    const first = value(network, 'suraj');
    const built = socialLinkUrl(network, first);
    expect(built).toBe(url);
    expect(value(network, built!)).toBe(first);
  });

  it('holds for a website too', () => {
    const first = value('website', 'example.com/about');
    expect(value('website', socialLinkUrl('website', first)!)).toBe(first);
  });
});
