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
});
