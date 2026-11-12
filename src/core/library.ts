import type { InkDocument } from "../types";
import type { WorkspaceFolder } from "./storage";

export function folderTrail(folders: WorkspaceFolder[], id?: string): WorkspaceFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const result: WorkspaceFolder[] = [], seen = new Set<string>();
  let folder = id ? byId.get(id) : undefined;
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id); result.unshift(folder);
    folder = folder.parentId ? byId.get(folder.parentId) : undefined;
  }
  return result;
}
export function folderLabel(folders: WorkspaceFolder[], id?: string): string {
  return folderTrail(folders, id).map((folder) => folder.name).join(" / ") || "阅读空间";
}
export function libraryDocuments(documents: InkDocument[], membership: Record<string, string>, folderId?: string, search = ""): InkDocument[] {
  const query = search.trim().toLocaleLowerCase();
  return documents.filter((document) => query ? document.name.toLocaleLowerCase().includes(query) : (membership[document.id] || undefined) === folderId);
}
