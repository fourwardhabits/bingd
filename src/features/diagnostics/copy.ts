import { Clipboard } from 'react-native';

/**
 * The report onto the clipboard, with no user interface involved.
 *
 * ---------------------------------------------------------------------------
 * **WHY THE CLIPBOARD COMES FROM `react-native` AND NOT `expo-clipboard`**
 *
 * `expo-clipboard` is not a dependency of this project, and it carries a native module — so
 * adding it would move the fingerprint and need a **new binary**. This update has to land on
 * the TestFlight build already in the founder's hands, which rules that out completely.
 *
 * React Native still ships `Clipboard` in core. It is deprecated and logs a warning the first
 * time it is touched, and `NativeClipboard` is compiled into every React Native binary —
 * including build 4. So it is available over the air, today, at the cost of one console line
 * nobody on a phone will ever see.
 *
 * If a future SDK finally removes it, this returns `false` rather than throwing, and the
 * sheet's selectable text is still a way to get the report off the device. A failsafe that
 * can crash the screen it is a failsafe for is not one.
 */
export function copyDiagnostics(report: string): boolean {
  try {
    if (!report) return false;
    Clipboard.setString(report);
    return true;
  } catch {
    return false;
  }
}
