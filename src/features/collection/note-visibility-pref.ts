import type { NoteVisibility } from './writes';

/**
 * Which visibility a **new** note opens on: private, every time (founder, 2026-11-04).
 *
 * ---------------------------------------------------------------------------
 * WHY PRIVATE, AND WHY THERE IS NO LONGER A REMEMBERED HABIT
 *
 * From 2026-09-06 a reader's first-ever note opened with *Share as a review* on, and every
 * later new note opened on whatever they chose last time. With the log sheet's details
 * above its buckets (ranking-start Option A), that meant a first note typed before a
 * bucket was autosaved as a public review a second after typing paused — in the title's
 * Reviews, counted on the profile and the Leaderboard, able to unlock an award post —
 * before the reader had ranked anything, and still public if they closed the sheet.
 *
 * The founder's rule now: **a note becomes a public review only when the reader turns on
 * "Share as a review" for it.** So a new note opens private, and a past choice no longer
 * carries to the next note — a remembered "shared" would publish the next note without
 * that note's own explicit act. Completing a ranking publishes nothing either.
 *
 * Two things are unchanged and must stay so:
 * - **Writing that already exists opens on the visibility it was saved with.** Published
 *   reviews stay published; private notes stay private.
 * - **"Write a review"** on a title's Reviews is an explicit request to publish that note,
 *   so the log sheet still opens it shared (`noteIntent: 'review'`). It is the one entry
 *   point that names a review before anything is written.
 *
 * The `notes.share-default` value earlier builds stored on a device is no longer read. It
 * is inert, so nothing needs cleaning up.
 */
export const NEW_NOTE_VISIBILITY: NoteVisibility = 'private';
