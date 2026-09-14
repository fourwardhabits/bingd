import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { HOW_TO_STEPS, HowToExportSheet } from './HowToExportSheet';

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

type HostNode = { props: Record<string, unknown>; parent: HostNode | null };

const ancestorsOf = (node: HostNode) => {
  const out: HostNode[] = [];
  for (let at = node.parent; at; at = at.parent) out.push(at);
  return out;
};

/**
 * The help sheet's layout (founder, physical preview QA, 2026-09-14: it ran edge to edge).
 *
 * Jest lays nothing out, so these assert the structure that decides it: prose in the sheet
 * gutter, the steps in a scroll body that shrinks inside the panel's height cap, and both
 * actions outside that scroll body, above the panel's own bottom padding. The same invariants
 * the Details sheet holds (`TitleRecallSheet.test.tsx`).
 */
describe('the help sheet', () => {
  const open = () =>
    renderWithProviders(<HowToExportSheet visible onClose={() => {}} surface="settings" />);

  it('draws the four steps, numbered, and two actions', async () => {
    const view = await open();

    HOW_TO_STEPS.forEach((step, index) => {
      expect(view.getByText(step)).toBeTruthy();
      expect(view.getByText(String(index + 1))).toBeTruthy();
    });
    expect(view.getByRole('button', { name: 'Open Letterboxd’s export page' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
    // No em dash anywhere a reader sees.
    for (const step of HOW_TO_STEPS) expect(step).not.toMatch(/\u2014/);
  });

  it('keeps every line of prose inside the sheet gutter', async () => {
    const view = await open();

    const firstStep = view.getByText(HOW_TO_STEPS[0]) as unknown as HostNode;
    const scroll = ancestorsOf(firstStep).find((node) => node.props?.contentContainerStyle);
    expect(scroll).toBeDefined();
    expect(StyleSheet.flatten(scroll!.props.contentContainerStyle as never)).toMatchObject({
      padding: theme.layout.gutter,
    });

    const done = view.getByRole('button', { name: 'Done' }) as unknown as HostNode;
    expect(StyleSheet.flatten(done.parent!.props.style as never)).toMatchObject({
      paddingHorizontal: theme.layout.gutter,
    });
  });

  it('lets the steps scroll and keeps both actions reachable above the bottom padding', async () => {
    const view = await open();

    const firstStep = view.getByText(HOW_TO_STEPS[0]) as unknown as HostNode;
    const scroll = ancestorsOf(firstStep).find((node) => node.props?.contentContainerStyle)!;
    expect(StyleSheet.flatten(scroll.props.style as never)).toMatchObject({
      flexGrow: 0,
      flexShrink: 1,
    });

    const panel = ancestorsOf(scroll).find(
      (node) => node.props?.accessibilityLabel === 'How to export from Letterboxd',
    );
    expect(panel).toBeDefined();
    for (const between of ancestorsOf(scroll)) {
      if (between === panel) break;
      if (!between.props?.style) continue;
      expect(StyleSheet.flatten(between.props.style as never)).toMatchObject({ flexShrink: 1 });
    }

    for (const name of ['Open Letterboxd’s export page', 'Done']) {
      const action = view.getByRole('button', { name }) as unknown as HostNode;
      expect(ancestorsOf(action)).not.toContain(scroll);
      expect(ancestorsOf(action)).toContain(panel);
    }
    const panelStyle = StyleSheet.flatten(panel!.props.style as never) as {
      paddingBottom?: number;
    };
    expect(panelStyle.paddingBottom ?? 0).toBeGreaterThanOrEqual(theme.space[4]);
  });
});
