import { fireEvent, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RecommendSheet } from './RecommendSheet';
import { filterRecipients, type Recipient } from './use-recommend';

const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, { code?: string; message: string } | null> = {};

/** Rows the client would get back from `follows`, embedded profile and all. */
let mockOutgoing: unknown[] = [];
let mockIncoming: unknown[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({
        data: mockRpcResults[name] ?? null,
        error: mockRpcErrors[name] ?? null,
      });
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        order: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          if (table !== 'follows') return resolve({ data: [], error: null });
          // Which direction is being asked for is decided by which column was pinned,
          // exactly as the real query decides it.
          const data = filters.follower_id ? mockOutgoing : mockIncoming;
          return resolve({ data, error: null });
        },
      };
      return chain;
    },
  },
}));

const person = (id: string, username: string, name: string, status = 'active') => ({
  profiles: { id, username, display_name: name, avatar_path: null, status },
});

const props = {
  viewerId: 'user-1',
  mediaItemId: 'film-1',
  kind: 'movie' as const,
  title: 'Inception',
  seriesTitle: null,
  onClose: jest.fn(),
  onSent: jest.fn(),
};

beforeEach(() => {
  mockRpc.mockReset();
  mockRpcResults = {};
  mockRpcErrors = {};
  mockOutgoing = [];
  mockIncoming = [];
  props.onClose = jest.fn();
  props.onSent = jest.fn();
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('who the sheet offers', () => {
  it('offers only mutual follows', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada'), person('user-3', 'bo', 'Bo')];
    mockIncoming = [person('user-2', 'ada', 'Ada'), person('user-4', 'cy', 'Cy')];

    const view = await renderWithProviders(<RecommendSheet {...props} />);

    // Ada is in both directions. Bo is only followed *by* the viewer and Cy only
    // follows them, so neither has agreed to be recommended to.
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByText('Bo')).toBeNull();
    expect(view.queryByText('Cy')).toBeNull();
  });

  it('leaves out a suspended account that still holds its edges', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada', 'suspended')];
    mockIncoming = [person('user-2', 'ada', 'Ada', 'suspended')];

    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await waitFor(() =>
      expect(view.getByText('Nobody to recommend to yet')).toBeTruthy(),
    );
  });

  it('says what makes somebody eligible when nobody is', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await waitFor(() => expect(view.getByText('Nobody to recommend to yet')).toBeTruthy());
    // The off-Bingd path is still offered, because it is the answer to an empty list.
    expect(view.getByText('Share with someone not on Bingd')).toBeTruthy();
  });

  it('names the show a season belongs to in its heading', async () => {
    const view = await renderWithProviders(
      <RecommendSheet
        {...props}
        kind="season"
        title="Season 2"
        seriesTitle="Parks and Recreation"
      />,
    );

    expect(view.getByText(/Parks and Recreation — Season 2/)).toBeTruthy();
  });
});

describe('sending', () => {
  beforeEach(() => {
    mockOutgoing = [person('user-2', 'ada', 'Ada')];
    mockIncoming = [person('user-2', 'ada', 'Ada')];
  });

  it('sends to one person on one tap, and closes', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Recommend to Ada, @ada'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'recommend_title',
        expect.objectContaining({ p_recipient_id: 'user-2', p_media_item_id: 'film-1' }),
      ),
    );
    // The confirmation belongs to the screen underneath, which is still showing the
    // title. A second one in here would be a message nobody sees.
    expect(props.onSent).toHaveBeenCalledWith('Ada');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('explains a refusal in words rather than as a code, and stays open', async () => {
    // A refusal comes back in the body with a 200, not as an error — the server
    // returns it so that a refused attempt still costs a slot against the hourly
    // ceiling. Which means a 200 is not a success here, and the body has to be read.
    mockRpcResults.recommend_title = { status: 'refused', reason: 'not_mutual' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Recommend to Ada, @ada'));

    await waitFor(() =>
      expect(view.getByText('You can only recommend to people who follow you back.')).toBeTruthy(),
    );
    expect(props.onSent).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('names the ceiling rather than the SQLSTATE when the rate limit bites', async () => {
    mockRpcErrors.recommend_title = { code: '53400', message: 'too many' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Recommend to Ada, @ada'));

    await waitFor(() =>
      expect(
        view.getByText('You have sent a lot of recommendations today. Try again later.'),
      ).toBeTruthy(),
    );
  });

  it('does not treat a refused 200 as a send', async () => {
    mockRpcResults.recommend_title = { status: 'refused', reason: 'not_recommendable' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Recommend to Ada, @ada'));

    await waitFor(() =>
      expect(
        view.getByText('You can recommend a film or a season, not a whole series.'),
      ).toBeTruthy(),
    );
    expect(props.onSent).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('has no multi-select and no Send button', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // V1 is one recipient per send. A Send button would imply a selection step that
    // does not exist, and a checkbox would imply more than one.
    expect(view.queryByText('Send')).toBeNull();
    expect(view.queryByText('Send to all')).toBeNull();
    expect(view.queryByRole('checkbox')).toBeNull();
  });
});

describe('sharing with somebody who is not on Bingd', () => {
  it('carries the reader’s invite link and records that it was created', async () => {
    mockRpcResults.create_invite_link = { status: 'ok', token: 'abc123' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share with someone not on Bingd'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'create_invite_link',
        expect.objectContaining({ p_media_item_id: 'film-1' }),
      ),
    );

    const shared = (Share.share as jest.Mock).mock.calls[0][0] as { message: string };
    expect(shared.message).toContain('https://bingd.app/title/movie/film-1');
    expect(shared.message).toContain('https://bingd.app/i/abc123');
  });

  it('still shares the title when the link could not be minted', async () => {
    // The invite link is instrumentation; the share is the point. Failing the whole
    // share because the growth record was unavailable would be the tail wagging the dog.
    mockRpcErrors.create_invite_link = { code: '53400', message: 'too many' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share with someone not on Bingd'));

    await waitFor(() => expect(Share.share as jest.Mock).toHaveBeenCalled());
    const shared = (Share.share as jest.Mock).mock.calls[0][0] as { message: string };
    expect(shared.message).toContain('https://bingd.app/title/movie/film-1');
    expect(shared.message).not.toContain('/i/');
  });
});

describe('filtering the list', () => {
  const people: Recipient[] = [
    { id: '1', username: 'ada', name: 'Ada Lovelace', avatarUri: null },
    { id: '2', username: 'grace', name: 'Grace Hopper', avatarUri: null },
  ];

  it('matches on the name and on the handle', () => {
    expect(filterRecipients(people, 'love').map((p) => p.id)).toEqual(['1']);
    expect(filterRecipients(people, 'grace').map((p) => p.id)).toEqual(['2']);
    expect(filterRecipients(people, '  ').map((p) => p.id)).toEqual(['1', '2']);
  });
});
