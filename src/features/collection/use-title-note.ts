import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useCurrentProfile } from '@/features/auth';

import { invalidateAfterCollectionChange } from './invalidate';
import { readNoteVisibilityDefault, rememberNoteVisibility } from './note-visibility-pref';
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

  /**
   * What a note nobody has written yet opens on for this reader.
   *
   * The same `note-visibility-pref` the log sheet consults, deliberately: the founder's
   * rule (2026-09-25) is one rule for all three surfaces, so a reader who turned sharing
   * off in the log sheet finds a new note here off too. Null until the local store
   * answers; the fallback while it is null is the product default, because a composer
   * that opened private and flipped a beat later would be worse than either.
   */
  const [remembered, setRemembered] = useState<NoteVisibility | null>(null);
  useEffect(() => {
    let live = true;
    void readNoteVisibilityDefault(profile.id).then((value) => {
      if (live) setRemembered(value);
    });
    return () => {
      live = false;
    };
  }, [profile.id]);

  const stored = state.data;
  const note = noteEdit ?? stored?.note ?? '';

  /**
   * Three sources, in priority order: what the reader just chose, then what the note was
   * *saved* with, then the remembered default for writing that does not exist yet.
   *
   * The middle term is the promise, and it is the one that has survived every reversal of
   * the other two: a note that already exists opens on its stored value and nothing else,
   * so no habit and no default can republish writing its author kept private.
   *
   * There is no `noteIntent` here and there should not be. "Write a review" is a door on
   * the title page into the log sheet; a reader who opened *Another watch* or went to edit
   * a watch did not press it, so this surface has nothing explicit to honour and falls to
   * the habit.
   */
  const visibility: NoteVisibility =
    visibilityEdit ?? (stored?.note ? stored.noteVisibility : (remembered ?? 'public'));
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
    /**
     * **The habit, and only for a new composition.**
     *
     * A decision about a note that already exists is a decision about *that* note — the
     * log sheet draws the same line for the same reason: remembering it here is how a
     * reader who unshared one old private note would find every future note opening
     * private. Only on an acknowledged success, because a write that did not land says
     * nothing about what anybody intended.
     */
    if (!stored?.note) void rememberNoteVisibility(profile.id, nextVisibility);
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
