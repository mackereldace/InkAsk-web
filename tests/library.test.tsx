import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Library from "../src/Library";
import { canMoveFolder, folderLabel, folderTrail, libraryDocuments, selectLibraryItems, topLevelMoveItems } from "../src/core/library";
import type { WorkspaceFolder } from "../src/core/storage";
import type { InkDocument } from "../src/types";
const folders: WorkspaceFolder[] = [{ id: "math", name: "数学", createdAt: 1 }, { id: "calculus", name: "微积分", parentId: "math", createdAt: 2 }];
const docs: InkDocument[] = ["Text.pdf", "扫描.pdf", "导数.pdf"].map((name, index) => ({ id: String(index), name, fingerprint: name, pdf: new Blob(), pageCount: 1, createdAt: 1, updatedAt: 1 }));
const membership = { "1": "math", "2": "calculus" };
describe("whole-file workspace organization", () => {
  it("filters the current directory and searches names across directories", () => {
    expect(libraryDocuments(docs, membership).map((doc) => doc.id)).toEqual(["0"]);
    expect(libraryDocuments(docs, membership, "math").map((doc) => doc.id)).toEqual(["1"]);
    expect(libraryDocuments(docs, membership, undefined, "导数").map((doc) => doc.id)).toEqual(["2"]);
    expect(libraryDocuments(docs, membership, "math", " TEXT ").map((doc) => doc.id)).toEqual(["0"]);
  });
  it("resolves nested paths and bounds damaged cyclic directory metadata", () => {
    expect(folderLabel(folders, "calculus")).toBe("数学 / 微积分");
    expect(folderLabel(folders)).toBe("阅读空间");
    expect(folderTrail([{ ...folders[0], parentId: "calculus" }, folders[1]], "calculus")).toHaveLength(2);
  });
  it("shows selectable folders and whole PDFs with a shared move toolbar", () => {
    const noop = () => {}, asyncNoop = async () => {};
    const html = renderToStaticMarkup(<Library documents={docs} folders={folders} membership={membership} folderId="math" search=""
      onSearch={noop} onFolder={noop} onOpen={noop} onAddPdf={noop} onImport={noop} onSample={noop}
      onCreate={asyncNoop} onRename={asyncNoop} onDeleteFolder={asyncNoop} onMove={asyncNoop} />);
    expect(html).toContain("微积分");
    expect(html).toContain('role="option" aria-selected="false" aria-label="扫描.pdf"');
    expect(html).not.toContain('aria-label="导数.pdf"');
    expect(html).toContain("移动到…");
    expect(html).not.toContain("<select");
    expect(html).toContain('aria-multiselectable="true"');
  });
  it("uses Finder additive and anchored range selection without losing earlier items", () => {
    const order = ["a", "b", "c", "d"];
    expect(selectLibraryItems(["a"], order, "b", { additive: true })).toEqual(["a", "b"]);
    expect(selectLibraryItems(["a", "b"], order, "a", { additive: true })).toEqual(["b"]);
    expect(selectLibraryItems(["d"], order, "c", { range: true, anchor: "a" })).toEqual(["a", "b", "c"]);
    expect(selectLibraryItems(["d"], order, "b", { additive: true, range: true, anchor: "a" })).toEqual(["d", "a", "b"]);
    expect(selectLibraryItems(["d"], order, "c", { range: true, anchor: "missing" })).toEqual(["c"]);
  });
  it("does not move selected descendants out of a folder that is moving with them", () => {
    const items = [{ kind: "folder" as const, id: "math" }, { kind: "folder" as const, id: "calculus" }, { kind: "document" as const, id: "1" }, { kind: "document" as const, id: "2" }, { kind: "document" as const, id: "0" }];
    expect(topLevelMoveItems(items, folders, membership)).toEqual([items[0], items[4]]);
    expect(canMoveFolder(folders, "math", "calculus")).toBe(false);
    expect(canMoveFolder(folders, "math", "math")).toBe(false);
    expect(canMoveFolder(folders, "calculus")).toBe(true);
    expect(canMoveFolder(folders, "math", "missing")).toBe(false);
  });
});
