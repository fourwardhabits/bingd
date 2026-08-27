import { useQueryClient } from '@tanstack/react-query';
import { useSegments } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { copyDiagnostics } from './copy';
import { buildDiagnosticsReport } from './report';

export type DiagnosticsSheetProps = {
  visible: boolean;
  onClose: () => void;
};

/**
 * The report, on screen.
 *
 * ---------------------------------------------------------------------------
 * **WHY THIS IS MOUNTED BY ITS CALLER RATHER THAN AT THE ROOT**
 *
 * The first version mounted one host in `app/_layout.tsx`, beside the navigator, on the
 * reasoning that a single surface above everything would always be reachable. On the
 * founder's device, tapping Diagnostics in Settings did nothing at all: the control
 * highlighted, the state flipped, and no sheet appeared.
 *
 * The reason is that `Settings` is a `Stack.Screen` with `presentation: 'modal'`, which
 * `react-native-screens` presents as a **native modal** — its own view controller, over the
 * root. A React Native `<Modal>` is presented *from the root view controller*, and iOS will
 * not let a controller that is already presenting present something else. So the modal was
 * refused, or presented underneath the screen that asked for it, and either way was
 * invisible. It is the only root-mounted modal in this codebase, which is exactly why it is
 * the only one that failed: every other sheet in the app is rendered inside the screen that
 * opens it, and presents from that screen's controller.
 *
 * So this component is rendered by its caller, in that caller's tree. Two call sites today —
 * the About block in Settings and the onboarding summary — and both render the same
 * component with the same content. Each owns a boolean; there is no shared signal to get out
 * of step, which also removes the indirection that made the original failure hard to read.
 *
 * ---------------------------------------------------------------------------
 * **Closed costs nothing at all**, and the split below is a gate rather than an
 * optimisation. The hooks live in the inner component, so a screen that merely *mounts* the
 * sheet shut needs neither a query client nor a router — both entry points render it
 * permanently, and neither should acquire a dependency on contexts it is not using. Open, it
 * builds the report once and once more per Refresh, and subscribes to nothing.
 */
export function DiagnosticsSheet({ visible, onClose }: DiagnosticsSheetProps) {
  if (!visible) return null;
  return <OpenDiagnosticsSheet onClose={onClose} />;
}

function OpenDiagnosticsSheet({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState('');
  /**
   * Three states, not two, and that is independent review 57's finding.
   *
   * The first version said "Copied" whether or not the write had happened — which is the
   * founder-visible silent failure this whole task exists to remove, reproduced in the
   * control meant to replace it. `copyDiagnostics` already returns whether it worked; the
   * label now says which.
   */
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  const queryClient = useQueryClient();
  const segments = useSegments();

  const route = (segments as readonly string[]).join('/') || '(root)';

  /**
   * Assembles the text, and never rejects.
   *
   * Separate from storing it so the effect below has a single `await` boundary to set state
   * after — `react-hooks/set-state-in-effect` rightly refuses a synchronous set from an
   * effect, and a helper that returns a string rather than writing one is the honest shape
   * regardless.
   */
  const assemble = useCallback(async () => {
    try {
      return await buildDiagnosticsReport(queryClient, route);
    } catch (error) {
      // The one screen that must not fail to draw. A report that could not be assembled is
      // still worth showing as the reason it could not be.
      return `Could not build the report: ${error instanceof Error ? error.name : 'unknown'}`;
    }
  }, [queryClient, route]);

  // Once, on open — this component only exists while the sheet is open, so mount is open.
  // The liveness flag is not tidiness: assembling waits on a session read that is bounded at
  // 2.5s, and the founder can close the sheet inside that window.
  useEffect(() => {
    let alive = true;
    void assemble().then((text) => {
      if (alive) setReport(text);
    });
    return () => {
      alive = false;
    };
  }, [assemble]);

  return (
    <Sheet visible onClose={onClose} label="Diagnostics">
      <ScrollView style={styles.body} contentContainerStyle={styles.content}>
        {/* Selectable as well as copyable: if the clipboard write ever fails, iOS's own
            text selection is still a way to get the report off the device. */}
        <Text variant="caption" tone="secondary" style={styles.report} selectable>
          {report || 'Building…'}
        </Text>
      </ScrollView>
      <View style={styles.actions}>
        <Button
          label="Refresh"
          kind="secondary"
          onPress={() => void assemble().then(setReport)}
        />
        <Button
          label={copy === 'done' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy'}
          // Nothing to copy until the report has been assembled, and a press that quietly
          // did nothing is exactly what must not happen here again.
          disabled={!report}
          disabledReason="Still building the report."
          onPress={() => setCopy(copyDiagnostics(report) ? 'done' : 'failed')}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { maxHeight: 440 },
  content: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[4] },
  // Small and tight, because the report is wide fixed-width columns and the whole point is
  // to read a table on a phone before deciding it is worth pasting.
  report: { fontSize: 11, lineHeight: 15 },
  actions: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
  },
});
