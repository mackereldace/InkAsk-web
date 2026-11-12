import type { Note, Project } from "../types";

function copyNote(note: Note): Note {
  return {
    ...note,
    messages: note.messages.map((message) => ({ ...message, assetIds: [...message.assetIds] })),
    draftAssetIds: [...note.draftAssetIds],
  };
}

/**
 * Prepare a mutable edit without cloning an unrelated answer tree on every token.
 * Omitted scope copies every note. An ID permits edits only to that note; null is
 * for adding/removing notes or editing project metadata. Existing history, text,
 * word arrays and immutable Blob data are shared. Page entries are always copied
 * because extraction/OCR handlers may update a page's status in place.
 */
export function copyProjectForEdit(project: Project, noteScope?: string | null, now = Date.now()): Project {
  let notes: Note[];
  if (noteScope === undefined) notes = project.notes.map(copyNote);
  else {
    notes = [...project.notes];
    if (noteScope !== null) {
      const index = notes.findIndex((note) => note.id === noteScope);
      if (index !== -1) notes[index] = copyNote(notes[index]);
    }
  }
  return {
    ...project,
    document: { ...project.document, updatedAt: now },
    notes,
    pages: project.pages.map((page) => ({ ...page })),
    assets: [...project.assets],
    templates: project.templates.map((template) => ({ ...template })),
    view: { ...project.view },
  };
}
