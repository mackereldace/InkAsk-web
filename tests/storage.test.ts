import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../src/types";

function fixture(id = "doc"): Project {
  return {
    version: 1,
    document: { id, name: `${id}.pdf`, fingerprint: id, pdf: new File([new Uint8Array([0, 255, 42])], "paper.pdf", { type: "application/pdf" }), pageCount: 1, createdAt: 1, updatedAt: 2 },
    assets: [{ id: "image", name: "image.png", mime: "image/png", data: new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }) }],
    pages: [], notes: [], templates: [], view: { page: 1, scale: 1, rotation: 0 },
  };
}
function hasBlob(value: unknown): boolean {
  return value instanceof Blob || (!!value && typeof value === "object" && Object.values(value).some(hasBlob));
}
async function rawDatabase() {
  const database = new Dexie("inkask");
  await database.open();
  return database;
}
async function bytes(blob: Blob) { return [...new Uint8Array(await blob.arrayBuffer())]; }

function closeDatabases() {
  (Dexie as unknown as { connections: Dexie[] }).connections.forEach((database) => database.close());
}

beforeEach(async () => {
  closeDatabases();
  await Dexie.delete("inkask");
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); closeDatabases(); });

describe("binary-safe project storage", () => {
  it("never sends Blob/File to IDB and reuses PDF bytes for metadata-only saves", async () => {
    const put = IDBObjectStore.prototype.put;
    const binaryWrites: unknown[] = [];
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (hasBlob(value)) throw new DOMException("Error preparing Blob/File data to be stored in object store", "UnknownError");
      if (this.name === "binaries") binaryWrites.push(value);
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    });
    const storage = await import("../src/core/storage");
    const project = fixture();
    await storage.saveProject(project);
    project.document.name = "renamed.pdf";
    await storage.saveProject(project);
    const loaded = (await storage.loadProject("doc"))!;
    expect(await bytes(loaded.document.pdf)).toEqual([0, 255, 42]);
    expect(await bytes(loaded.assets[0].data)).toEqual([9, 8, 7]);
    expect(loaded.document.pdf.type).toBe("application/pdf");
    await storage.saveProject(loaded);
    loaded.document.pdf = new Blob([new Uint8Array([0, 255, 42])], { type: "application/pdf" });
    await storage.saveProject(loaded);
    expect(binaryWrites).toHaveLength(2);
    const get = vi.spyOn(IDBObjectStore.prototype, "get");
    const cards = await storage.listDocuments();
    expect(cards[0].name).toBe("renamed.pdf");
    expect(cards[0].pdf.size).toBe(0);
    expect(get.mock.contexts.some((store) => (store as unknown as IDBObjectStore).name === "binaries")).toBe(false);
  });

  it("captures one private metadata graph before delayed Blob reads and isolates later external edits", async () => {
    const storage = await import("../src/core/storage");
    const project = fixture();
    project.pages = [{ page: 1, text: "original page", words: [{ text: "original word", rect: [1, 2, 3, 4] }], source: "native", status: "ready", width: 600, height: 800 }];
    project.notes = [{
      id: "note", title: "original note", anchor: { page: 1, rects: [[10, 20, 30, 40]], quote: "original quote" },
      inheritedHistory: [{ role: "assistant", content: "original inherited answer", assetIds: ["image"] }],
      collapsed: false, task: "explain", templateId: "template", draft: "original draft", draftAssetIds: ["image"], createdAt: 1,
      messages: [{ id: "answer", role: "assistant", content: "original answer", assetIds: ["image"], status: "complete", createdAt: 1,
        sources: [{ id: "S1", page: 1, text: "original source" }], history: [{ role: "user", content: "original question", assetIds: ["image"] }] }],
    }];
    project.assets[0].source = { page: 1, rect: [1, 2, 30, 40] };
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readPdf = project.document.pdf.arrayBuffer.bind(project.document.pdf);
    vi.spyOn(project.document.pdf, "arrayBuffer").mockImplementation(async () => { started(); await gate; return readPdf(); });
    const clone = vi.spyOn(globalThis, "structuredClone");
    const saving = storage.saveProject(project);
    await reading;
    // This budget catches a second whole-graph clone before any IDB serialization.
    expect(clone.mock.calls.filter(([value]) => value && typeof value === "object" && "notes" in value && !("storageVersion" in value))).toHaveLength(1);
    project.document.name = "changed.pdf";
    project.view.scale = 2;
    project.pages[0].text = "changed page";
    project.pages[0].words[0].rect[0] = 999;
    project.notes[0].title = "changed note";
    project.notes[0].anchor.rects[0][0] = 999;
    project.notes[0].inheritedHistory[0].content = "changed inherited answer";
    project.notes[0].inheritedHistory[0].assetIds!.push("later-image");
    project.notes[0].messages[0].content = "changed answer";
    project.notes[0].messages[0].sources![0].text = "changed source";
    project.notes[0].messages[0].history![0].content = "changed question";
    project.notes[0].draftAssetIds.push("later-image");
    project.assets[0].name = "changed-image.png";
    project.assets[0].source!.rect![0] = 999;
    project.assets[0].data = new Blob(["changed image bytes"]);
    release();
    await saving;
    const saved = (await storage.loadProject("doc"))!;
    expect(saved.document.name).toBe("doc.pdf");
    expect(saved.view.scale).toBe(1);
    expect(saved.pages[0]).toMatchObject({ text: "original page", words: [{ text: "original word", rect: [1, 2, 3, 4] }] });
    expect(saved.notes[0]).toMatchObject({ title: "original note", anchor: { rects: [[10, 20, 30, 40]] }, draftAssetIds: ["image"],
      inheritedHistory: [{ role: "assistant", content: "original inherited answer", assetIds: ["image"] }],
      messages: [{ content: "original answer", sources: [{ text: "original source" }], history: [{ content: "original question" }] }],
    });
    expect(saved.assets[0]).toMatchObject({ name: "image.png", source: { page: 1, rect: [1, 2, 30, 40] } });
    expect(await bytes(saved.assets[0].data)).toEqual([9, 8, 7]);
  });

  it("upgrades v1 without Blob writes and lazily converts legacy data", async () => {
    const legacy = new Dexie("inkask");
    legacy.version(1).stores({ projects: "document.id, document.updatedAt" });
    await legacy.table("projects").put(fixture());
    legacy.close();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      expect(hasBlob(value)).toBe(false);
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    });
    const storage = await import("../src/core/storage");
    expect((await storage.listDocuments())[0].id).toBe("doc");
    const loaded = (await storage.loadProject("doc"))!;
    expect(await bytes(loaded.document.pdf)).toEqual([0, 255, 42]);
    const database = await rawDatabase();
    expect((await database.table("projects").get("doc")).storageVersion).toBe(2);
    expect(await database.table("binaries").count()).toBe(2);
    database.close();
  });

  it("retains the old project if replacement bytes fail and isolates cleanup", async () => {
    const storage = await import("../src/core/storage");
    const project = fixture();
    const other = fixture("other");
    await storage.saveProject(project);
    await storage.saveProject(other);
    project.assets[0].data = new Blob(["replacement"]);
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "projects") throw new DOMException("full", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    });
    await expect(storage.saveProject(project)).rejects.toThrow("full");
    failure.mockRestore();
    expect(await bytes((await storage.loadProject("doc"))!.assets[0].data)).toEqual([9, 8, 7]);
    await storage.saveProject(project);
    expect(await (await storage.loadProject("doc"))!.assets[0].data.text()).toBe("replacement");
    const database = await rawDatabase();
    expect(await database.table("binaries").where("projectId").equals("doc").count()).toBe(2);
    await storage.deleteProject("doc");
    expect(await database.table("binaries").where("projectId").equals("doc").count()).toBe(0);
    expect(await bytes((await storage.loadProject("other"))!.document.pdf)).toEqual([0, 255, 42]);
    database.close();
  });

  it("keeps a legacy project readable and unchanged when migration fails", async () => {
    const legacy = new Dexie("inkask");
    legacy.version(1).stores({ projects: "document.id, document.updatedAt" });
    await legacy.table("projects").put(fixture());
    legacy.close();
    const storage = await import("../src/core/storage");
    await storage.listDocuments();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "binaries") throw new DOMException("full", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    });
    expect(await bytes((await storage.loadProject("doc"))!.document.pdf)).toEqual([0, 255, 42]);
    const database = await rawDatabase();
    expect((await database.table("projects").get("doc")).document.pdf).toBeInstanceOf(Blob);
    expect(await database.table("binaries").count()).toBe(0);
    database.close();
  });
});

describe("workspace folders", () => {
  it("moves entire documents and promotes child folders and documents without deleting contents", async () => {
    const storage = await import("../src/core/storage");
    await storage.saveProject(fixture());
    const root = await storage.createFolder("  Research  ");
    const child = await storage.createFolder("Child", root.id);
    const grandchild = await storage.createFolder("Nested", child.id);
    await storage.moveDocument("doc", child.id);
    await storage.deleteFolder(child.id);
    expect(await storage.listDocumentFolders()).toEqual({ doc: root.id });
    expect((await storage.listFolders()).find((folder) => folder.id === grandchild.id)?.parentId).toBe(root.id);
    await storage.deleteFolder(root.id);
    expect(await storage.listDocumentFolders()).toEqual({});
    expect((await storage.listFolders()).find((folder) => folder.id === grandchild.id)?.parentId).toBeUndefined();
    expect(await bytes((await storage.loadProject("doc"))!.document.pdf)).toEqual([0, 255, 42]);
    await storage.moveDocument("doc", grandchild.id);
    await storage.deleteProject("doc");
    expect(await storage.listDocumentFolders()).toEqual({});
    expect(await storage.listFolders()).toHaveLength(1);
  });

  it("validates names, missing parents, duplicate siblings and document targets", async () => {
    const storage = await import("../src/core/storage");
    const folder = await storage.createFolder("Folder");
    expect(folder.name).toBe("Folder");
    await expect(storage.createFolder(" ")).rejects.toThrow();
    await expect(storage.createFolder(" Folder ")).rejects.toThrow();
    await expect(storage.createFolder("child", "missing")).rejects.toThrow();
    const sibling = await storage.createFolder("Sibling");
    await expect(storage.renameFolder(sibling.id, "Folder")).rejects.toThrow();
    await expect(storage.renameFolder("missing", "New")).rejects.toThrow();
    await storage.renameFolder(folder.id, " Renamed ");
    expect((await storage.listFolders()).find((item) => item.id === folder.id)?.name).toBe("Renamed");
    await expect(storage.moveDocument("missing", folder.id)).rejects.toThrow();
    await storage.saveProject(fixture());
    await expect(storage.moveDocument("doc", "missing")).rejects.toThrow();
    await storage.moveDocument("doc", folder.id);
    await storage.moveDocument("doc");
    expect(await storage.listDocumentFolders()).toEqual({});
  });
  it("moves folder subtrees with their document memberships and rejects cycles and collisions", async () => {
    const storage = await import("../src/core/storage");
    await storage.saveProject(fixture());
    const source = await storage.createFolder("Research"), destination = await storage.createFolder("Archive");
    const child = await storage.createFolder("Notes", source.id), nested = await storage.createFolder("Nested", child.id);
    await storage.moveDocument("doc", nested.id);
    await expect(storage.moveFolder(source.id, nested.id)).rejects.toThrow(/自身|子文件夹/);
    await expect(storage.moveFolder(child.id, child.id)).rejects.toThrow(/自身|子文件夹/);
    await expect(storage.moveFolder(child.id, "missing")).rejects.toThrow(/不存在/);
    await storage.createFolder("Notes", destination.id);
    await expect(storage.moveFolder(child.id, destination.id)).rejects.toThrow(/同名/);
    expect((await storage.listFolders()).find((folder) => folder.id === child.id)?.parentId).toBe(source.id);
    await storage.moveFolder(source.id, destination.id);
    expect((await storage.listFolders()).find((folder) => folder.id === source.id)?.parentId).toBe(destination.id);
    expect((await storage.listFolders()).find((folder) => folder.id === nested.id)?.parentId).toBe(child.id);
    expect(await storage.listDocumentFolders()).toEqual({ doc: nested.id });
    expect(await bytes((await storage.loadProject("doc"))!.document.pdf)).toEqual([0, 255, 42]);
    await storage.moveFolder(source.id);
    expect((await storage.listFolders()).find((folder) => folder.id === source.id)?.parentId).toBeUndefined();
  });

});
