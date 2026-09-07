import { fireEvent, render } from '@testing-library/react-native';

import { errorClassOf, errorLineFor } from '@/lib/render-errors';

import { ScreenError } from './ScreenError';

/**
 * **What a caught render error costs, and what it says.**
 *
 * The founder's report, physical Android, 2026-09-07: a title page shows the boundary,
 * and *sometimes the reader ends up back on Feed rather than on the title page*. The
 * second half is not a navigation decision anybody wrote — it is where the app's only
 * boundary sits. `RouteErrorBoundary` wraps `<Stack>`, so catching unmounts the navigator
 * and the pushed route goes with it; clearing the error mounts a fresh `<Stack>` at the
 * root index, and `nextRoute` reads the root index as `group === undefined` and returns
 * `/(tabs)/feed`.
 *
 * A route that exports `ErrorBoundary` is caught inside the navigator instead, and this
 * is the view it renders. Nothing here makes a screen less likely to throw; what it
 * changes is that a throw no longer costs the reader their place.
 *
 * The reporting half is `lib/render-errors.ts`, tested there.
 */

jest.mock('@/lib/render-errors', () => ({
  ...jest.requireActual('@/lib/render-errors'),
  recordRenderError: jest.fn(),
}));

const { recordRenderError } = jest.requireMock('@/lib/render-errors') as {
  recordRenderError: jest.Mock;
};

beforeEach(() => recordRenderError.mockClear());

describe('what the reader is told', () => {
  it('says the same calm sentence the root boundary says', async () => {
    // One apology, not two. A person should not have to learn that a title page failing
    // is a different kind of event from the app failing.
    const view = await render(<ScreenError error={new Error('boom')} retry={jest.fn()} />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(
      view.getByText('Your films are safe. This screen stopped, not your account.'),
    ).toBeTruthy();
  });

  it('offers a retry that re-renders the route rather than navigating', async () => {
    // `retry` is the router's own: it clears the error state and renders the route again,
    // in place, on the stack it is already on. Nothing here goes anywhere.
    const retry = jest.fn();
    const view = await render(<ScreenError error={new Error('boom')} retry={retry} />);

    await fireEvent.press(view.getByText('Try again'));

    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('what is reported', () => {
  it('reports once per error, and says which boundary caught it', async () => {
    const error = new Error('boom');
    await render(<ScreenError error={error} retry={jest.fn()} />);

    // `screen_render` rather than `route_render`: reading the flight log back, that is
    // the difference between "the screen stopped and the stack survived" and "the
    // navigator went with it".
    expect(recordRenderError).toHaveBeenCalledWith(error, 'screen_render');
    expect(recordRenderError).toHaveBeenCalledTimes(1);
  });

  it('does not report the same error again on a re-render', async () => {
    // A counter that exists to say "this happened twice" must not say it happened forty
    // times because the tree re-rendered while the apology was on screen.
    const error = new Error('boom');
    const view = await render(<ScreenError error={error} retry={jest.fn()} />);
    await view.rerender(<ScreenError error={error} retry={jest.fn()} />);

    expect(recordRenderError).toHaveBeenCalledTimes(1);
  });
});

describe('naming the exception', () => {
  it('reads the class off anything that was thrown', () => {
    expect(errorClassOf(new TypeError('x'))).toBe('TypeError');
    expect(errorClassOf(new RangeError('x'))).toBe('RangeError');
    // React can reject a render with something that is not an Error at all.
    expect(errorClassOf('a string')).toBe('string');
    expect(errorClassOf(undefined)).toBe('undefined');
  });

  it('gives a beta build one readable line, and a store build none', () => {
    const error = new TypeError('Cannot read properties of undefined');

    // Beta and below — the founder's own build, where the difference between "the title
    // page crashed" and a named exception is the whole of a bug report.
    expect(errorLineFor(error, true)).toBe(
      'TypeError: Cannot read properties of undefined',
    );
    // A stranger's build says the calm sentence and nothing else.
    expect(errorLineFor(error, false)).toBeNull();
  });

  it('bounds the line, because a React message can run to paragraphs', () => {
    const line = errorLineFor(new Error('x'.repeat(1000)), true);

    // A wall of component stack under an apology is not a report anybody transcribes.
    expect(line!.length).toBeLessThanOrEqual(240);
    expect(line!.endsWith('…')).toBe(true);
  });

  it('collapses the whitespace a stack trace arrives with', () => {
    expect(errorLineFor(new Error('one\n  two\n\tthree'), true)).toBe('Error: one two three');
  });
});
