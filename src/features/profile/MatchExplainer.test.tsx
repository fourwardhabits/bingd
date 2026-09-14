import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { MatchExplainer } from './MatchExplainer';
import type { TasteMatchLine } from './use-taste-match';

const line = {
  kind: 'match',
  label: '89% Match · 42 shared',
  explanation: {
    match: 'How similarly you and Ravi rate titles you have both ranked.',
    shared: 'Titles you have both ranked.',
    nudge: null,
  },
} satisfies TasteMatchLine;

type HostNode = { props: Record<string, unknown>; parent: HostNode | null };

/**
 * **The words sit in the sheet gutter** (2026-09-14, the same omission the founder found on
 * the genres sheet). `Sheet` pads nothing horizontally, so the body has to.
 */
it('puts the explanation inside the sheet gutter, under the handle', async () => {
  await renderWithProviders(<MatchExplainer visible onClose={() => {}} line={line} />);

  let at = screen.getByText(line.explanation.match) as unknown as HostNode | null;
  let body: Record<string, unknown> | undefined;
  for (; at; at = at.parent) {
    const style = StyleSheet.flatten(at.props?.style as never) as Record<string, unknown>;
    if (style?.paddingHorizontal !== undefined) {
      body = style;
      break;
    }
  }
  expect(body).toMatchObject({
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  });
});
