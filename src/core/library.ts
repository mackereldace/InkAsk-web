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

export interface LibraryItemRef { kind: "document" | "folder"; id: string }
export const libraryItemKey = (item: LibraryItemRef): string => `${item.kind}:${item.id}`;

export function selectLibraryItems(current: string[], ordered: string[], clicked: string, options: { additive?: boolean; range?: boolean; anchor?: string } = {}): string[] {
  if (options.range && options.anchor && ordered.includes(options.anchor)) {
    const from = ordered.indexOf(options.anchor), to = ordered.indexOf(clicked);
    if (to < 0) return current;
    const range = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
    return options.additive ? [...new Set([...current, ...range])] : range;
  }
  if (options.additive) return current.includes(clicked) ? current.filter((key) => key !== clicked) : [...current, clicked];
  return [clicked];
}
export function canMoveFolder(folders: WorkspaceFolder[], id: string, destination?: string): boolean {
  return folders.some((folder) => folder.id === id) && (!destination || folders.some((folder) => folder.id === destination)) &&
    !folderTrail(folders, destination).some((folder) => folder.id === id);
}
/** Moving a folder carries its contents, so don't separately move selected descendants. */
export function topLevelMoveItems(items: LibraryItemRef[], folders: WorkspaceFolder[], membership: Record<string, string>): LibraryItemRef[] {
  const unique = [...new Map(items.map((item) => [libraryItemKey(item), item])).values()];
  const selectedFolders = new Set(unique.filter((item) => item.kind === "folder").map((item) => item.id));
  return unique.filter((item) => {
    const parent = item.kind === "folder" ? folders.find((folder) => folder.id === item.id)?.parentId : membership[item.id];
    return !folderTrail(folders, parent).some((folder) => selectedFolders.has(folder.id));
  });
}
