import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { ReportSheet } from '@/features/moderation/ReportSheet';
import type { Surface } from '@/lib/analytics';
import { Sheet, SheetRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { useSocialWrites, type Relationship } from './use-social';

export type ProfileMenuProps = {
  userId: string;
  name: string;
  viewerId: string;
  relationship: Relationship | undefined;
  /** Where this is being shown, for the social writes' own analytics. */
  surface: Surface;
};

/**
 * The other person's profile, in the corner where the owner's has its gear and bell.
 *
 * **Why the controls moved here.** Block and Report used to be two tertiary buttons in
 * a row beside Follow. The founder's device pass is that this made the primary action
 * area of somebody else's profile read as a moderation console: the three things
 * offered about a person you had just looked up were follow them, block them, report
 * them, at the same altitude and the same distance from the thumb. Neither is a
 * frequent act, and permanent buttons for rare and severe acts is the wrong shape.
 *
 * **What did not change.** Both are still one tap from every profile, both still
 * confirm before doing anything, and both still call the same server actions. In
 * particular Report is offered on a *blocked* profile too, which is the client half of
 * a rule the database states: `report()` checks that a subject exists and deliberately
 * not that the caller can still see it, so that blocking somebody cannot become a way
 * to suppress the complaint about them (20260813002000 §4). Hiding the control the
 * moment you block would reintroduce in the UI exactly the inversion the server
 * refuses to have.
 *
 * **A hamburger rather than an ellipsis**, matching the founder's note that this is
 * where the owner's Settings gear sits. Same corner, same size, same hit target, so a
 * reader who has learned "the controls for this screen are top right" is right on both
 * profiles.
 *
 * Never rendered on the viewer's own profile — this screen can be one, because
 * Settings › Privacy links here as "see your public profile", and the server refuses a
 * self-report with a 22023 anyway.
 */
export function ProfileMenu({ userId, name, viewerId, relationship, surface }: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const { block, unblock, busy } = useSocialWrites(viewerId, surface);

  const blocked = Boolean(relationship?.blocked);

  const say = (result: { ok: boolean; message?: string }, failed: string) => {
    if (!result.ok && result.message) Alert.alert(failed, result.message);
  };

  const confirmBlock = () =>
    Alert.alert(
      `Block ${name}?`,
      'You will not see each other on bingd. Any follow between you is removed, and unblocking does not bring it back.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () =>
            void (async () => {
              say(await block({ userId }), 'Could not block');
            })(),
        },
      ],
    );

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More options for ${name}`}
        accessibilityHint="Report or block this person"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        hitSlop={theme.space[3]}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Ionicons name="menu" size={theme.layout.icon.md} color={theme.text.secondary} />
      </Pressable>

      {/* Mounted only while open, like every other sheet in the app. */}
      {open ? (
        <Sheet visible onClose={() => setOpen(false)} label={`Options for ${name}`}>
          <View style={styles.menu}>
            {/* Report first, and above the block, because it is the lighter of the two
                and the one somebody is more often looking for. A block is between two
                people and takes effect immediately; a report is a message to whoever
                runs Bingd. Neither implies the other, which is why they are two rows
                rather than one. */}
            <SheetRow
              icon="flag-outline"
              label="Report"
              value={`Tells whoever runs bingd. about ${name}`}
              onPress={() => {
                setOpen(false);
                setReporting(true);
              }}
            />
            {blocked ? (
              <SheetRow
                icon="lock-open-outline"
                label="Unblock"
                value="Does not restore any follow between you"
                onPress={
                  busy
                    ? undefined
                    : () => {
                        setOpen(false);
                        void (async () => {
                          say(await unblock({ userId }), 'Could not unblock');
                        })();
                      }
                }
                disabledReason={busy ? 'Saving your last change.' : undefined}
              />
            ) : (
              <SheetRow
                icon="ban-outline"
                label="Block"
                value="You will not see each other on bingd."
                onPress={
                  busy
                    ? undefined
                    : () => {
                        setOpen(false);
                        confirmBlock();
                      }
                }
                disabledReason={busy ? 'Saving your last change.' : undefined}
              />
            )}
          </View>
        </Sheet>
      ) : null}

      <ReportSheet
        visible={reporting}
        onClose={() => setReporting(false)}
        subject="profile"
        subjectId={userId}
        noun="profile"
      />
    </>
  );
}

const styles = StyleSheet.create({
  // The same box the header's other glyphs get, so the icon lands on the same
  // baseline as a Back control opposite it.
  button: { padding: theme.space[1] },
  pressed: { opacity: 0.7 },
  menu: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[6],
  },
});
