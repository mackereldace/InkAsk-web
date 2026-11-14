import type { AnswerAnchor, HistoryMessage, Note, Project, Task } from "../types";
import { mathExcerpt } from "./math-markdown";
import { clonePdfAnchor } from "./pdf-anchor";

function id(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function historyThrough(note: Note, parentMessageId: string): HistoryMessage[] {
  const target = note.messages.find(
    (message) => message.id === parentMessageId,
  );
  if (!target)
    throw new Error("Parent message was not found in the source note.");
  const snapshot: HistoryMessage[] = note.inheritedHistory.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.assetIds?.length ? { assetIds: [...message.assetIds] } : {}),
  }));

  for (const message of note.messages) {
    snapshot.push({
      role: message.role,
      content: message.content,
      ...(message.assetIds.length ? { assetIds: [...message.assetIds] } : {}),
    });
    if (message.id === parentMessageId) break;
  }
  return snapshot;
}

function branchTemplateId(project: Project, task: Task): string {
  const custom = project.templates.find(
    (template) => template.task === task,
  );
  if (!custom)
    throw new Error("No custom prompt template is available for this branch.");
  return custom.id;
}

function branchQuoteFor(
  note: Note,
  parentMessageId: string,
  quote: string,
): string {
  const explicit = quote.trim();
  if (explicit) return explicit;
  const messages: Note["messages"] = [];
  for (const candidate of note.messages) {
    messages.push(candidate);
    if (candidate.id === parentMessageId) break;
  }
  const target = messages.at(-1);
  if (target?.role === "assistant") return target.content.trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant")
      return messages[index].content.trim();
  }
  return "";
}

export function createBranch(
  project: Project,
  parentNote: Note,
  parentMessageId: string,
  quote = "",
  task: Task = "custom",
  answerAnchor?: AnswerAnchor,
): Note {
  const note = project.notes.find(
    (candidate) => candidate.id === parentNote.id,
  );
  if (!note) throw new Error("Parent note does not belong to this project.");
  const cleanQuote = branchQuoteFor(note, parentMessageId, quote);
  return {
    id: id(),
    title: cleanQuote ? `追问 · ${mathExcerpt(cleanQuote)}` : "分支追问",
    anchor: clonePdfAnchor(note.anchor),
    parentId: note.id,
    parentMessageId,
    ...(cleanQuote ? { branchQuote: cleanQuote } : {}),
    ...(answerAnchor ? { answerAnchor: { ...answerAnchor } } : {}),
    inheritedHistory: historyThrough(note, parentMessageId),
    collapsed: false,
    task,
    templateId: branchTemplateId(project, task),
    draft: "",
    draftAssetIds: [],
    messages: [],
    createdAt: Date.now(),
  };
}

export function descendantIds(notes: Note[], noteId: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const note of notes) {
    if (!note.parentId) continue;
    const children = byParent.get(note.parentId) ?? [];
    children.push(note.id);
    byParent.set(note.parentId, children);
  }

  const found: string[] = [];
  const seen = new Set<string>([noteId]);
  const queue = [...(byParent.get(noteId) ?? [])];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    queue.push(...(byParent.get(current) ?? []));
  }
  return found;
}
