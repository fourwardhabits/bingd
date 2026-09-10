import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';

import { usePullRefresh } from './use-pull-refresh';

/**
 * `refreshing` means the reader pulled (founder, physical iOS 1.0.1 build 9, 2026-09-09).
 *
 * The defect this pins is the title page sliding down and back up while a review was being
 * typed into the sheet in front of it. The chain is in `use-pull-refresh.ts`; the part
 * that can be asserted here is its last link, which is the one that was wrong: a
 * `RefreshControl` whose `refreshing` came from `isRefetching` is told to begin refreshing
 * by *any* refetch, and on iOS beginning a refresh grows the scroll view's top content
 * inset and animates the content down to meet it.
 *
 * So the property is stated as an absence — **no background work can make this true** —
 * and the two ways a naive version fails are pinned beside it, because both leave a page
 * held down rather than merely a spinner turning.
 */

/**
 * A harness that shows the flag and can start a pull, with no scroll view involved.
 *
 * **Two pull controls rather than one**, which is not an accident: RNTL 14 leaves this
 * file's renderer returning empty trees after two presses on the same node, and the
 * failures then surface in unrelated tests further down. A second pull is a real case, so
 * it gets a second button.
 */
function Harness({ work }: { work: () => Promise<unknown>[] }) {
  const pull = usePullRefresh(work);
  return (
    <View>
      <Text>{pull.refreshing ? 'refreshing' : 'still'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="pull" onPress={pull.onRefresh}>
        <Text>pull</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="pull again" onPress={pull.onRefresh}>
        <Text>pull again</Text>
      </Pressable>
    </View>
  );
}

/** A promise the test finishes by hand, so "in flight" is a state it can hold. */
const deferred = () => {
  let settle: (value?: unknown) => void = () => {};
  let fail: (reason?: unknown) => void = () => {};
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Attached here rather than at the call site: an unhandled rejection in a test file is
  // a warning that outlives the test that caused it.
  promise.catch(() => {});
  return { promise, settle, fail };
};

describe('usePullRefresh', () => {
  it('is not refreshing until the reader pulls', async () => {
    const view = await render(<Harness work={() => [Promise.resolve()]} />);
    expect(view.getByText('still')).toBeTruthy();
  });

  /**
   * **The defect, as an assertion.** Work that this hook did not start cannot set the
   * flag, because there is no path into it that is not `onRefresh`. A background refetch
   * — an invalidation from an autosave, a window-focus refetch, a fresh observer — moves
   * nothing.
   */
  it('stays still while a refetch it did not start is in flight', async () => {
    const background = deferred();
    const view = await render(<Harness work={() => [background.promise]} />);

    // The query is in flight; nothing pulled.
    expect(view.getByText('still')).toBeTruthy();
    await act(async () => background.settle());
    expect(view.getByText('still')).toBeTruthy();
  });

  it('is refreshing while the pull it started is in flight, and stops when it lands', async () => {
    const work = deferred();
    const view = await render(<Harness work={() => [work.promise]} />);

    await fireEvent.press(view.getByLabelText('pull'));
    await waitFor(() => expect(view.getByText('refreshing')).toBeTruthy());

    await act(async () => work.settle());
    await waitFor(() => expect(view.getByText('still')).toBeTruthy());
  });

  /**
   * **`allSettled`, not `all`.** A failed refetch is the ordinary case on a phone with no
   * signal, and with `all` the first rejection leaves the flag true for ever — which on
   * iOS is not a spinner nobody stops, it is a page held sixty points down with a band of
   * background above the hero. Exactly the symptom being fixed, reintroduced by the fix.
   */
  it('stops even when every refetch fails', async () => {
    const one = deferred();
    const two = deferred();
    const view = await render(<Harness work={() => [one.promise, two.promise]} />);

    await fireEvent.press(view.getByLabelText('pull'));
    await waitFor(() => expect(view.getByText('refreshing')).toBeTruthy());

    await act(async () => {
      one.fail(new Error('offline'));
      two.fail(new Error('offline'));
    });

    await waitFor(() => expect(view.getByText('still')).toBeTruthy());
  });

  /**
   * A second pull is not cleared by the first one's completion.
   *
   * Two presses on two different controls, both wired to the same `onRefresh`: RNTL 14
   * leaves this file's renderer returning empty trees after a repeated press on the same
   * node, and the failures then surface in unrelated tests. The behaviour under test is
   * unchanged — a pull begins while an older one is still settling, and the older work
   * lands afterwards.
   */
  it('does not let an older pull clear a newer one', async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const view = await render(
      <Harness
        work={() => {
          call += 1;
          return [call === 1 ? first.promise : second.promise];
        }}
      />,
    );

    await fireEvent.press(view.getByLabelText('pull'));
    await waitFor(() => expect(view.getByText('refreshing')).toBeTruthy());

    // The second pull, from the control that is now spinning.
    await fireEvent.press(view.getByLabelText('pull again'));
    await act(async () => first.settle());

    // The older work landing must not stop the newer pull.
    expect(view.getByText('refreshing')).toBeTruthy();

    await act(async () => second.settle());
    await waitFor(() => expect(view.getByText('still')).toBeTruthy());
  });
});
