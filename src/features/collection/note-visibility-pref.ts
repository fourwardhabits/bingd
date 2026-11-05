import { readPref, writePref } from '@/lib/prefs';

import type { NoteVisibility } from './writes';

/**
 * Which visibility a **new** note opens on (founder, 2026-11-04, amending `94c789a`).
 *
 * ---------------------------------------------------------------------------
 * THE RULES
 *
 * - **A first-ever note opens private.** Nothing becomes a public review unless its reader
 *   turns *Share as a review* on.
 * - **That explicit tap is remembered** for later new notes — turning sharing on, and
 *   turning it off, on any note. It is the only thing that writes the preference: opening
 *   a note, saving one and finishing a ranking never change it (`rememberShareChoice` has
 *   one caller per surface, the toggle's own handler).
 * - **A note that already exists opens on its own stored visibility**, whatever the
 *   preference says. Published reviews stay published; private notes stay private.
 * - **"Write a review"** on a title's Reviews still opens ready to share
 *   (`noteIntent: 'review'`): it is the one entry point that asks for a review before
 *   anything is written, and it does not by itself change the preference.
 * - **The state is on screen before anything can be saved.** Both note surfaces keep the
 *   composer shut until this preference has been read, so a composer can never open
 *   private and turn shared under somebody who is already typing — and the chip, with its
 *   "Only you can read this." or "Shown with your rating…" line, sits beside the field
 *   the autosave reads from.
 *
 * ---------------------------------------------------------------------------
 * WHY A NEW KEY
 *
 * Builds from 2026-09-06 stored `notes.share-default` on every successful save of a new
 * note, with sharing on by default — so a stored "public" there usually means "saved under
 * the old default", not "chose to share". Reading it would quietly reintroduce the public
 * default this exists to remove. `notes.share-choice` holds only explicit taps; the old key
 * is left alone and never read.
 *
 * Local and per account, through `readPref`/`writePref`: a device habit rather than a
 * fact about the account, so no column, no migration and no sync.
 */
const KEY = 'notes.share-choice';

/** What a reader who has never chosen gets: private. */
export const DEFAULT_NEW_NOTE_VISIBILITY: NoteVisibility = 'private';

const isVisibility = (value: unknown): value is NoteVisibility =>
  value === 'public' || value === 'private';

/**
 * What a new note should open on for this reader. A store that cannot be read, or a value
 * that will not parse, is the default — private — never a guess at sharing.
 */
export async function readNewNoteVisibility(userId: string): Promise<NoteVisibility> {
  try {
    const stored = await readPref<unknown>(`${userId}.${KEY}`);
    return isVisibility(stored) ? stored : DEFAULT_NEW_NOTE_VISIBILITY;
  } catch {
    return DEFAULT_NEW_NOTE_VISIBILITY;
  }
}

/**
 * Remember an explicit *Share as a review* tap, for the next **new** note.
 *
 * Called from the toggle and from nowhere else. It never changes a note that already
 * exists: those open on their own stored visibility.
 */
export async function rememberShareChoice(userId: string, visibility: NoteVisibility) {
  try {
    await writePref(`${userId}.${KEY}`, visibility);
  } catch {
    // Losing the memory costs the next note its default and nothing else.
  }
}
