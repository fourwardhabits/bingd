import { Alert, Linking } from 'react-native';

import { ALLOWED_PROPERTY_KEYS, FORBIDDEN_PROPERTY_KEYS } from './analytics';
import {
  SUPPORT_EMAIL,
  buildSupportBody,
  buildSupportMailto,
  currentSupportBuild,
  openSupportEmail,
  type SupportBuild,
} from './support';

const mockTrack = jest.fn();
jest.mock('./analytics', () => ({
  ...jest.requireActual('./analytics'),
  track: (event: unknown) => mockTrack(event),
}));

jest.mock('./release', () => ({
  releaseContext: () => ({
    environment: 'production',
    platform: 'ios',
    app_version: '1.0.0',
    build_number: '7',
    runtime_version: 'deadbeefcafe',
    eas_channel: 'production',
    eas_update_id: 'update-1',
    build_kind: 'ota',
  }),
}));

const build: SupportBuild = { appVersion: '1.0.0', buildNumber: '7', platform: 'ios' };

/** What the `mailto:` actually said, decoded once, so the assertions read as prose. */
const parse = (url: string) => {
  const [scheme = '', query] = url.split('?');
  const params = new URLSearchParams(query);
  return {
    address: scheme.replace('mailto:', ''),
    subject: params.get('subject'),
    body: params.get('body'),
  };
};

beforeEach(() => {
  mockTrack.mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('the address and the subjects', () => {
  it('sends both to the one mailbox that already routes', () => {
    expect(SUPPORT_EMAIL).toBe('support@bingd.app');
    expect(parse(buildSupportMailto('feedback', build)).address).toBe('support@bingd.app');
    expect(parse(buildSupportMailto('problem', build)).address).toBe('support@bingd.app');
  });

  it('separates the two with the subject, which is the only routing this channel has', () => {
    expect(parse(buildSupportMailto('feedback', build)).subject).toBe('bingd. feedback');
    expect(parse(buildSupportMailto('problem', build)).subject).toBe('bingd. support');
  });
});

describe('the draft', () => {
  it('asks a reporter what happened, and tells support which build it happened on', () => {
    const body = buildSupportBody('problem', build);

    expect(body).toContain('Hi bingd. team,');
    expect(body).toContain('[Describe what happened here]');
    expect(body).toContain('App version: 1.0.0 (7)');
    expect(body).toContain('Platform: iOS');
  });

  /**
   * An idea does not need a build number, and a diagnostic footer under a compliment
   * reads as a bug report form.
   */
  it('keeps feedback to the greeting and the prompt', () => {
    const body = buildSupportBody('feedback', build);

    expect(body).toContain('[Share your feedback here]');
    expect(body).not.toContain('App version');
    expect(body).not.toContain('Platform');
  });

  it('names Android as Android', () => {
    expect(buildSupportBody('problem', { ...build, platform: 'android' })).toContain(
      'Platform: Android',
    );
  });

  /**
   * `expo-application` answers null off-device and on some Android configurations. A
   * draft that says `undefined (null)` is worse than one that admits it does not know.
   */
  it('says unknown rather than printing a null', () => {
    const body = buildSupportBody('problem', {
      appVersion: null,
      buildNumber: null,
      platform: 'ios',
    });

    expect(body).toContain('App version: unknown');
    expect(body).not.toMatch(/null|undefined/);
  });

  it('reads the running build, and takes three fields of the release context', () => {
    expect(currentSupportBuild()).toEqual({
      appVersion: '1.0.0',
      buildNumber: '7',
      platform: 'ios',
    });
    // The fingerprint, the channel and the update id are identifiers, and a support
    // draft is not where they belong. `Copy diagnostics` is, on a build being tested.
    const body = buildSupportBody('problem', currentSupportBuild());
    expect(body).not.toContain('deadbeefcafe');
    expect(body).not.toContain('update-1');
  });
});

describe('the encoding', () => {
  it('percent-encodes the spaces in the subject and the newlines in the body', () => {
    const url = buildSupportMailto('problem', build);

    expect(url).toContain('subject=bingd.%20support');
    // An unencoded newline in a `mailto:` is where the body silently stops on some
    // clients, so this asserts on the raw URL rather than on the decoded body.
    expect(url).toContain('%0A');
    expect(url).not.toMatch(/[\n\r]/);
    expect(url.split('?')[1]).not.toContain(' ');
  });

  it('round-trips to exactly the body that was built', () => {
    for (const topic of ['feedback', 'problem'] as const) {
      expect(parse(buildSupportMailto(topic, build)).body).toBe(buildSupportBody(topic, build));
    }
  });
});

/**
 * The draft is written by the app and sent by the person, which is why it is written
 * narrowly: whatever is in it travels, and they can only consent to what they recognise.
 */
describe('what is never in the draft', () => {
  const account = {
    email: 'sai@example.com',
    username: 'sai',
    display_name: 'Sai',
    user_id: '11111111-2222-3333-4444-555555555555',
    access_token: 'ey.J.token',
    posthog_distinct_id: 'ph-distinct-1',
    sentry_id: 'sentry-1',
    device_id: 'device-1',
  };

  it('carries no account, session, device or vendor identifier', () => {
    for (const topic of ['feedback', 'problem'] as const) {
      const decoded = decodeURIComponent(buildSupportMailto(topic, build));
      for (const value of Object.values(account)) {
        expect(decoded).not.toContain(value);
      }
      for (const key of Object.keys(account)) {
        expect(decoded).not.toContain(key);
      }
      // Only the support mailbox appears. No sender address is filled in for them.
      expect(decoded.match(/@/g)).toEqual(['@']);
    }
  });
});

describe('opening the mail client', () => {
  it('hands the encoded draft to the platform', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    await openSupportEmail('feedback', build);

    expect(openURL).toHaveBeenCalledWith(buildSupportMailto('feedback', build));
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  /**
   * A simulator with no Mail account, and a phone whose mail app has been removed, both
   * land here. Unlike `openLegal`, the failure is not swallowed: a person who has just
   * decided to tell you something has to be left with a way to.
   */
  it('names the address in plain text when no mail client answers', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));

    await expect(openSupportEmail('problem', build)).resolves.toBeUndefined();

    expect(Alert.alert).toHaveBeenCalledWith(
      'Could not open your email app',
      expect.stringContaining('support@bingd.app'),
    );
  });
});

describe('the analytics event', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  it('says which row was tapped, and carries nothing else', async () => {
    await openSupportEmail('feedback', build);
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'settings_support_email_opened',
      props: { type: 'feedback' },
    });

    const props = mockTrack.mock.calls[0][0].props as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['type']);
    for (const key of Object.keys(props)) {
      expect(ALLOWED_PROPERTY_KEYS).toContain(key);
      expect(FORBIDDEN_PROPERTY_KEYS).not.toContain(key);
    }

    mockTrack.mockReset();
    await openSupportEmail('problem', build);
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'settings_support_email_opened',
      props: { type: 'problem' },
    });
  });

  /**
   * The tap, not a message received. Somebody whose mail client failed to launch still
   * reached for the support channel, and that is the most important reading this event
   * has.
   */
  it('is emitted even when the mail client does not open', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));

    await openSupportEmail('problem', build);

    expect(mockTrack).toHaveBeenCalledTimes(1);
  });
});
