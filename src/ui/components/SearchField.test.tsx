import { render } from '@testing-library/react-native';
import { createRef } from 'react';
import type { TextInput } from 'react-native';

import { SearchField } from './SearchField';

/**
 * One property, and it is the one a caller depends on.
 *
 * Re-tapping the Search tab returns to an empty field **with the keyboard up**, and that
 * is a `focus()` on the input rather than anything this component can decide for itself.
 * The screen holds the ref; what this asserts is that the ref reaches the `TextInput`
 * and not the wrapper — which is the way a forwarded ref silently stops working.
 */
it('forwards its ref to the input, so a caller can focus it', async () => {
  const ref = createRef<TextInput>();

  await render(<SearchField ref={ref} accessibilityLabel="Search" value="" />);

  expect(ref.current).toBeTruthy();
  expect(typeof ref.current?.focus).toBe('function');
});
