import { render } from '@testing-library/react-native';

import { LoadingScreen } from './LoadingScreen';
import { SkeletonRow } from './SkeletonRow';

describe('LoadingScreen', () => {
  it('announces itself as progress rather than as nothing', async () => {
    // An unlabelled full-screen wait is silence to a screen reader: the app
    // has replaced the whole page and said nothing about why.
    const view = await render(<LoadingScreen />);
    expect(view.getByRole('progressbar')).toBeTruthy();
  });

  it('uses the reason for the wait as its label when there is one', async () => {
    const view = await render(<LoadingScreen message="Signing you in" />);
    expect(view.getByLabelText('Signing you in')).toBeTruthy();
  });
});

describe('SkeletonRow', () => {
  const hidden = { includeHiddenElements: true } as const;

  it('renders the number of placeholders asked for', async () => {
    const view = await render(<SkeletonRow count={3} />);
    expect(view.getAllByTestId('skeleton-row', hidden)).toHaveLength(3);
  });

  it('is hidden from screen readers', async () => {
    // Placeholders describe nothing. Announcing them means reading out six
    // empty rows before the content that is about to replace them. The query
    // below has to opt into hidden elements precisely because it worked.
    const view = await render(<SkeletonRow count={2} />);
    expect(view.queryByTestId('skeleton')).toBeNull();
    expect(view.getByTestId('skeleton', hidden)).toBeTruthy();
  });
});
