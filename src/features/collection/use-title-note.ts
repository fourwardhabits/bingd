import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { useCurrentProfile } from '@/features/auth';

import { invalidateAfterCollectionChange } from './invalidate';
import { useLogState } from './use-log-state';
import { newOperationId, saveNote, type NoteVisibility } from './writes';

/**
 * The title's one note, for a surface that is not the log sheet.
 *
 * Founder decision, 2026-09-25: the note experience is the same wherever a note about a
 * watch is written. `LogSheet` keeps its own state machine (it has a whole sheet's worth of
 * other things to coordinate); this is the same *model* for the two rewatch surfaces —
 * Another watch, and Watch History → edit — which previously wrote `watch_events.note` and
 * therefore had nowhere to put "Contains spoilers" or "Share as a review".
 *
 * It reads and writes `user_media.note` through `save_note`, exactly as the log sheet does.
 * No new schema, and `watch_events.note` stays owner-only and untouched.
 *
 * **Saving is explicit rather than timed.** The log sheet autosaves because it can be
 * swiped away mid-sentence; both callers here have a commit the reader presses (Save, or
 * choosing a bucket), so the write happens on blur and on `flush()`. That is deterministic,
 * which is what makes the three entry points testable against the same assertions.
 */
export function useTitleNote(mediaItemId: string | null) {
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const state = useLogState(profile.id, mediaItemId);

  /**
   * Null means untouched, which is the only way a real edit can be told from "no edit".
   * Clearing a note is an edit to the empty string, and `??` passes that through.
   */
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const [visibilityEdit, setVisibilityEdit] = useState<NoteVisibility | null>(null);
  const [spoilersEdit, setSpoilersEdit] = useState<boolean | null>(null);

  const stored = state.data;
  const note = noteEdit ?? stored?.note ?? '';

  /**
   * What the reader just chose, then what the note was *saved* with, then **private**.
   *
   * The middle term is the promise the founder named explicitly: a note that already exists
   * opens on its stored value and nothing else, so nothing can republish writing its author
   * kept private.
   *
   * The last term is the one place these surfaces differ from `LogSheet`, deliberately and
   * pending the founder's confirmation. The sheet's rule (2026-09-06) opens a reader's
   * *first-ever* note with Share as a review already on, and then remembers what they chose
   * last. Today's instruction is flatter — "private note remains the default", "Share as a
   * review must remain an EXPLICIT user action" — and these are the two surfaces where the
   * reader arrived to record a **watch**, not to write a review. Defaulting private here
   * cannot publish anything by accident; defaulting public can, and that asymmetry is what
   * decides it until the founder says otherwise. The remembered preference is deliberately
   * not read, and deliberately not written: a rewatch must not move the log sheet's default.
   */
  const visibility: NoteVisibility =
    visibilityEdit ?? (stored?.note ? stored.noteVisibility : 'private');
  const spoilers = spoilersEdit ?? stored?.noteSpoilers ?? false;

  /** The newest version this surface has seen, so a second save does not fight the first. */
  const version = useRef<string | null>(null);
  const dirty = useRef(false);

  const write = async (next: {
    note?: string;
    visibility?: NoteVisibility;
    spoilers?: boolean;
  }) => {
    if (!mediaItemId) return;
    // Trimmed at the edge, as the log sheet does: leading newlines are not writing.
    const text = (next.note ?? note).trim();
    const nextVisibility = next.visibility ?? visibility;
    const nextSpoilers = next.spoilers ?? spoilers;

    const result = await saveNote({
      operationId: newOperationId(),
      mediaItemId,
      note: text,
      baseVersion: version.current ?? stored?.noteVersion ?? null,
      noteVisibility: nextVisibility,
      noteSpoilers: nextSpoilers,
    });

    if (result.outcome === 'failed') return;
    if (result.noteVersion) version.current = result.noteVersion;
    dirty.current = false;
    invalidateAfterCollectionChange(queryClient, profile.id, mediaItemId);
  };

  return {
    loaded: Boolean(stored),
    note,
    visibility,
    spoilers,
    onChangeText: (next: string) => {
      setNoteEdit(next);
      dirty.current = true;
    },
    /** A claim is an act, so it saves the moment it is made — as in the log sheet. */
    onVisibility: (next: NoteVisibility) => {
      setVisibilityEdit(next);
      void write({ visibility: next });
    },
    onSpoilers: (next: boolean) => {
      setSpoilersEdit(next);
      void write({ spoilers: next });
    },
    /** Blur, and whatever the caller calls its commit. Idempotent when nothing changed. */
    flush: async () => {
      if (!dirty.current) return;
      await write({});
    },
  };
}

export type TitleNote = ReturnType<typeof useTitleNote>;
