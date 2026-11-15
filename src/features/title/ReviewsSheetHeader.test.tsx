import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ReviewsSheetHeader, reviewCountHeading, reviewOrderLabel } from './TitleReviews';

/**
 * **The Reviews sheet's heading row** (founder QA, 2026-11-16): "N reviews" and the order the
 * sheet is in, with the orders grouped as Sort by and Show.
 */
const draw = async (props: Partial<Parameters<typeof ReviewsSheetHeader>[0]> = {}) => {
  const onChange = jest.fn();
  const view = await renderWithProviders(
    <ReviewsSheetHeader
      total={2}
      order="top_desc"
      ratingAvailable={false}
      onChange={onChange}
      {...props}
    />,
  );
  return { view, onChange };
};

describe('the count', () => {
  it('is said in words, singular and plural', () => {
    expect(reviewCountHeading(1)).toBe('1 review');
    expect(reviewCountHeading(2)).toBe('2 reviews');
    expect(reviewCountHeading(6)).toBe('6 reviews');
  });

  it('heads the row, with the current order beside it', async () => {
    const { view } = await draw({ total: 6 });
    expect(view.getByRole('header', { name: '6 reviews' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Sort reviews, Most helpful' })).toBeTruthy();
    expect(view.getByText('Most helpful')).toBeTruthy();
  });
});

describe('the order', () => {
  it('opens Sort by and Show in place, with the current order ticked', async () => {
    const { view } = await draw();
    expect(view.queryByTestId('reviews-sort-menu')).toBeNull();
    await fireEvent.press(view.getByTestId('reviews-sort-control'));
    expect(view.getByTestId('reviews-sort-menu')).toBeTruthy();
    expect(view.getByLabelText('Sort by')).toBeTruthy();
    expect(view.getByLabelText('Show')).toBeTruthy();
    expect(
      view.getByRole('radio', { name: 'Most helpful' }).props.accessibilityState,
    ).toMatchObject({
      checked: true,
    });
    expect(
      view.getByRole('radio', { name: 'Everyone' }).props.accessibilityState,
    ).toMatchObject({
      checked: true,
    });
  });

  it('chooses Newest and Oldest, and closes', async () => {
    const { view, onChange } = await draw();
    await fireEvent.press(view.getByTestId('reviews-sort-control'));
    await fireEvent.press(view.getByRole('radio', { name: 'Oldest' }));
    expect(onChange).toHaveBeenCalledWith('recent_asc');
    expect(view.queryByTestId('reviews-sort-menu')).toBeNull();
  });

  it('never offers a rating order over a list that may be incomplete', async () => {
    const { view } = await draw({ ratingAvailable: false });
    await fireEvent.press(view.getByTestId('reviews-sort-control'));
    expect(view.queryByRole('radio', { name: 'Highest rated' })).toBeNull();
    expect(view.queryByRole('radio', { name: 'Lowest rated' })).toBeNull();
  });

  it('offers Highest and Lowest rated once every review is in hand', async () => {
    const { view, onChange } = await draw({ ratingAvailable: true });
    await fireEvent.press(view.getByTestId('reviews-sort-control'));
    await fireEvent.press(view.getByRole('radio', { name: 'Lowest rated' }));
    expect(onChange).toHaveBeenCalledWith('rating_asc');
  });

  it('treats People I follow as a filter, not a direction, and Everyone as its way back', async () => {
    const { view, onChange } = await draw();
    await fireEvent.press(view.getByTestId('reviews-sort-control'));
    await fireEvent.press(view.getByRole('radio', { name: 'People I follow' }));
    expect(onChange).toHaveBeenLastCalledWith('following');

    const following = await draw({ order: 'following' });
    expect(
      following.view.getByRole('button', { name: 'Sort reviews, People I follow' }),
    ).toBeTruthy();
    await fireEvent.press(following.view.getByTestId('reviews-sort-control'));
    // Inside the filter the order is Most helpful's.
    expect(
      following.view.getByRole('radio', { name: 'Most helpful' }).props.accessibilityState,
    ).toMatchObject({ checked: true });
    await fireEvent.press(following.view.getByRole('radio', { name: 'Everyone' }));
    expect(following.onChange).toHaveBeenLastCalledWith('top_desc');
  });

  it('is drawn but quiet with one review, so the row keeps its shape', async () => {
    const { view } = await draw({ total: 1 });
    expect(view.getByRole('header', { name: '1 review' })).toBeTruthy();
    const control = view.getByTestId('reviews-sort-control');
    expect(control.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('names every order in the menu’s own words', () => {
    expect(reviewOrderLabel('top_desc')).toBe('Most helpful');
    expect(reviewOrderLabel('recent_desc')).toBe('Newest');
    expect(reviewOrderLabel('recent_asc')).toBe('Oldest');
    expect(reviewOrderLabel('rating_desc')).toBe('Highest rated');
    expect(reviewOrderLabel('rating_asc')).toBe('Lowest rated');
    expect(reviewOrderLabel('following')).toBe('People I follow');
  });
});
