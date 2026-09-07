import { readPref, writePref } from '@/lib/prefs';

import type { NoteVisibility } from './writes';

/**
 * Which visibility a **new** note opens on, remembered per account.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND THE ONE THING IT MUST NEVER DO
 *
 * The founder's decision: the first note anybody ever writes opens with *Share as a
 * review* **on**, because a review nobody can read is not what most people mean when
 * they write about a film. After that the app follows them — turn it off and save, and
 * the next new note opens off; turn it back on, and the next opens on.
 *
 * **It never touches writing that already exists.** A note that has been saved opens on
 * the visibility it was saved with, full stop. This preference is consulted only for a
 * note with no stored value to contradict, which is what makes it impossible for a
 * general habit to retroactively publish something somebody kept private. `LogSheet`
 * enforces that ordering; this module holds no opinion about it and could not, because
 * it is never told whether a note exists.
 * ---------------------------------------------------------------------------
 *
 * Local and per account, through the same `readPref`/`writePref` pair the Collection's
 * remembered medium uses: it is a device habit rather than a fact about the account, so
 * it needs no column, no migration and no sync. A device that has never been used to
 * write anything gets the default, which is the right answer for a new device too.
 */
const KEY = 'notes.share-default';

/** ON, and deliberately. See the header. */
export const DEFAULT_NOTE_VISIBILITY: NoteVisibility = 'public';

const isVisibility = (value: unknown): value is NoteVisibility =>
  value === 'public' || value === 'private';

/**
 * What a new note should open on for this reader.
 *
 * A stored value that will not parse — a key left by an older build — is ignored rather
 * than trusted, the same way the remembered medium validates its own.
 */
export async function readNoteVisibilityDefault(userId: string): Promise<NoteVisibility> {
  try {
    const stored = await readPref<unknown>(`${userId}.${KEY}`);
    return isVisibility(stored) ? stored : DEFAULT_NOTE_VISIBILITY;
  } catch {
    // A store that cannot be read is not a reader who chose privately. The product
    // default stands, which is the same answer a fresh install gets.
    return DEFAULT_NOTE_VISIBILITY;
  }
}

/**
 * Remember what they chose, on a successful save of a **new** note.
 *
 * Only on success, and only for a new one: a save that failed says nothing about intent,
 * and an edit to existing writing is a decision about *that note* rather than a change
 * of habit. Both conditions are the caller's to establish — see `LogSheet`.
 */
export async function rememberNoteVisibility(userId: string, visibility: NoteVisibility) {
  try {
    await writePref(`${userId}.${KEY}`, visibility);
  } catch {
    // A preference that could not be stored costs the next note its memory and nothing
    // else. Never worth failing a save that already landed.
  }
}
