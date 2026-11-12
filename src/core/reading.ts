import type { Message, Note } from "../types";

export interface ReadingTarget {
  noteId: string;
  messageId?: string;
}

export function answerFor(note: Note, messageId?: string): Message | undefined {
  return (
    note.messages.find((m) => m.id === messageId && m.role === "assistant") ??
    [...note.messages].reverse().find((m) => m.role === "assistant")
  );
}

export function readingTrail(notes: Note[], noteId?: string): Note[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const trail: Note[] = [];
  const seen = new Set<string>();
  let note = noteId ? byId.get(noteId) : undefined;
  while (note && !seen.has(note.id)) {
    seen.add(note.id);
    trail.unshift(note);
    note = note.parentId ? byId.get(note.parentId) : undefined;
  }
  return trail;
}

export function parentReadingTarget(notes: Note[], noteId: string): ReadingTarget | undefined {
  const note = notes.find((item) => item.id === noteId);
  if (!note?.parentId || !notes.some((item) => item.id === note.parentId)) return;
  return { noteId: note.parentId, messageId: note.parentMessageId };
}
