import "fake-indexeddb/auto";
import Dexie from "dexie";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../src/types";
import { installLocalStorage, startDiskServer, type DiskServer } from "./helpers/disk-server";

function fixture(id = "doc"): Project {
  return {
    version: 1,
    document: {
      id,
      name: `${id}.pdf`,
      fingerprint: id,
      pdf: new File([new Uint8Array([0, 255, 42])], "paper.pdf", { type: "application/pdf" }),
      pageCount: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    assets: [
      {
        id: "image",
        name: "image.png",
        mime: "image/png",
        data: new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }),
      },
    ],
    pages: [],
    notes: [],
    templates: [],
    view: { page: 1, scale: 1, rotation: 0 },
  };
}

function withNote(project: Project, status: "streaming" | "complete"): Project {
  project.notes = [
    {
      id: "note-1",
      title: "便签",
      anchor: { page: 1, rects: [[0, 0, 10, 10]], quote: "原文" },
      inheritedHistory: [],
      collapsed: false,
      task: "explain",
      templateId: "t1",
      draft: "",
      draftAssetIds: [],
      createdAt: 1,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "半截回答",
          assetIds: [],
          status,
          createdAt: 2,
        },
      ],
    },
  ];
  project.templates = [{ id: "t1", name: "解释", task: "explain", body: "解释", version: 1 }];
  return project;
}

async function bytes(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

function closeDatabases() {
  (Dexie as unknown as { connections: Dexie[] }).connections.forEach((database) => database.close());
}

let server: DiskServer;

beforeEach(async () => {
  closeDatabases();
  await Dexie.delete("inkask");
  installLocalStorage();
  vi.resetModules();
  server = await startDiskServer();
  server.installFetch();
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
  closeDatabases();
});

describe("disk-backed project storage", () => {
  it("writes metadata plus content-addressed bytes, and reads the same bytes back", async () => {
    const storage = await import("../src/core/storage");
    const project = fixture("disk-doc");
    await storage.saveProject(project);

    const record = JSON.parse(
      await readFile(join(server.dir, "projects", "disk-doc", "project.json"), "utf8"),
    ) as {
      storageVersion: number;
      document: { pdf: { binaryId: string; type: string } };
      assets: { data: { binaryId: string } }[];
    };
    expect(record.storageVersion).toBe(2);
    expect(record.document.pdf.binaryId).toMatch(/^[a-f0-9]{64}$/);
    expect(record.document.pdf.type).toBe("application/pdf");
    expect(JSON.stringify(record)).not.toContain("data:application");
    expect(record.assets).toHaveLength(1);

    const blobs = await readdir(join(server.dir, "blobs", record.document.pdf.binaryId.slice(0, 2)));
    expect(blobs).toHaveLength(1); // PDF and PNG hash to different buckets; both exist
    expect(await readdir(join(server.dir, "blobs"))).toHaveLength(2);

    const loaded = await storage.loadProject("disk-doc");
    expect(loaded?.document.name).toBe("disk-doc.pdf");
    expect(await bytes(loaded!.document.pdf)).toEqual([0, 255, 42]);
    expect(loaded!.document.pdf.type).toBe("application/pdf");
    expect(await bytes(loaded!.assets[0].data)).toEqual([9, 8, 7]);
    expect(loaded!.assets[0].mime).toBe("image/png");
  });

  it("uploads a given blob once and reuses it for metadata-only saves", async () => {
    const storage = await import("../src/core/storage");
    const project = fixture("reuse-doc");
    await storage.saveProject(project);
    const projectPuts = () =>
      server.calls.filter((call) => call.method === "PUT" && call.url.startsWith("/api/blobs/")).length;
    expect(projectPuts()).toBe(2);

    project.document.name = "改名后.pdf";
    await storage.saveProject(project);
    expect(projectPuts()).toBe(2); // no re-upload
    expect((await storage.listDocuments())[0].name).toBe("改名后.pdf");
  });

  it("repairs an interrupted stream when the project is read back", async () => {
    const storage = await import("../src/core/storage");
    await storage.saveProject(withNote(fixture("stream-doc"), "streaming"));
    const loaded = await storage.loadProject("stream-doc");
    expect(loaded?.notes[0].messages[0].status).toBe("stopped");
  });

  it("lists documents from metadata only, without touching PDF bytes", async () => {
    const storage = await import("../src/core/storage");
    const project = withNote(fixture("list-doc"), "complete");
    project.document.name = "持久化测试.pdf";
    await storage.saveProject(project);

    const documents = await storage.listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ id: "list-doc", name: "持久化测试.pdf", pageCount: 1 });
    expect(documents[0].pdf.size).toBe(0);
    expect(server.calls.some((call) => call.method === "GET" && call.url.startsWith("/api/blobs/"))).toBe(false);
  });

  it("deletes the project and prunes blobs nothing else references", async () => {
    const storage = await import("../src/core/storage");
    await storage.saveProject(fixture("gone-doc"));
    const buckets = await readdir(join(server.dir, "blobs"));
    expect(buckets).toHaveLength(2);

    await storage.deleteProject("gone-doc");
    expect(await storage.listDocuments()).toHaveLength(0);
    expect(await storage.loadProject("gone-doc")).toBeUndefined();
    const remaining = await Promise.all(
      (await readdir(join(server.dir, "blobs"))).map((bucket) =>
        readdir(join(server.dir, "blobs", bucket)),
      ),
    );
    expect(remaining.flat()).toHaveLength(0);
  });

  it("refuses to save when the local service is down, and still reads the browser copy", async () => {
    const database = new Dexie("inkask");
    database.version(1).stores({ projects: "document.id, document.updatedAt" });
    await database.open();
    await database.table("projects").put(withNote(fixture("legacy-doc"), "complete"));
    database.close();

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const storage = await import("../src/core/storage");
    await expect(storage.saveProject(fixture("new-doc"))).rejects.toThrow(/本地服务/);
    const documents = await storage.listDocuments();
    expect(documents.map((document) => document.id)).toContain("legacy-doc");
    const loaded = await storage.loadProject("legacy-doc");
    expect(loaded?.document.name).toBe("legacy-doc.pdf");
    expect(await bytes(loaded!.document.pdf)).toEqual([0, 255, 42]);
  });

  it("migrates the browser copy to disk once and leaves it untouched", async () => {
    const database = new Dexie("inkask");
    database.version(1).stores({ projects: "document.id, document.updatedAt" });
    database.version(2).stores({
      projects: "document.id, document.updatedAt",
      binaries: "id, projectId",
      documents: "id, updatedAt",
      folders: "id, parentId",
      memberships: "projectId, folderId",
    });
    await database.open();
    const legacy = withNote(fixture("old-doc"), "complete");
    const pdfBytes = await legacy.document.pdf.arrayBuffer();
    const imageBytes = await legacy.assets[0].data.arrayBuffer();
    const { pdf: _pdf, ...document } = legacy.document;
    const { data: _data, ...assetMetadata } = legacy.assets[0];
    await database.table("projects").put({
      ...legacy,
      storageVersion: 2,
      document: { ...document, pdf: { binaryId: "old-doc:pdf", type: "application/pdf" } },
      assets: [{ ...assetMetadata, data: { binaryId: "old-doc:image", type: "image/png" } }],
    });
    await database.table("binaries").bulkPut([
      { id: "old-doc:pdf", projectId: "old-doc", bytes: pdfBytes },
      { id: "old-doc:image", projectId: "old-doc", bytes: imageBytes },
    ]);
    await database.table("documents").put(document);
    await database.table("folders").put({ id: "folder-1", name: "作业", createdAt: 5 });
    await database.table("memberships").put({ projectId: "old-doc", folderId: "folder-1" });
    database.close();

    const storage = await import("../src/core/storage");
    const report = await storage.prepareStorage();
    expect(report.readOnly).toBe(false);
    expect(report.migrated).toEqual({ projects: 1, folders: 1 });

    const documents = await storage.listDocuments();
    expect(documents.map((item) => item.id)).toEqual(["old-doc"]);
    const loaded = await storage.loadProject("old-doc");
    expect(await bytes(loaded!.document.pdf)).toEqual([...new Uint8Array(pdfBytes)]);
    expect(await bytes(loaded!.assets[0].data)).toEqual([...new Uint8Array(imageBytes)]);
    expect(await storage.listFolders()).toHaveLength(1);
    expect(await storage.listDocumentFolders()).toEqual({ "old-doc": "folder-1" });

    // The browser copy is still there, and the migration does not run twice.
    const check = new Dexie("inkask");
    check.version(1).stores({ projects: "document.id, document.updatedAt" });
    check.version(2).stores({
      projects: "document.id, document.updatedAt",
      binaries: "id, projectId",
      documents: "id, updatedAt",
      folders: "id, parentId",
      memberships: "projectId, folderId",
    });
    await check.open();
    expect(await check.table("projects").count()).toBe(1);
    check.close();
    expect((await storage.prepareStorage())).toEqual({ migrated: null, readOnly: false });
  });
});

describe("workspace folders on disk", () => {
  it("creates, lists and renames folders while rejecting duplicates", async () => {
    const storage = await import("../src/core/storage");
    const root = await storage.createFolder("作业");
    const child = await storage.createFolder("第三周", root.id);
    expect((await storage.listFolders()).map((folder) => folder.name)).toEqual(["作业", "第三周"]);
    await expect(storage.createFolder("第三周", root.id)).rejects.toThrow(/同名/);
    await expect(storage.createFolder("   ")).rejects.toThrow(/不能为空/);
    await storage.renameFolder(child.id, "第三周作业");
    expect((await storage.listFolders()).find((folder) => folder.id === child.id)?.name).toBe(
      "第三周作业",
    );
  });

  it("moves documents into folders and clears the membership for the root", async () => {
    const storage = await import("../src/core/storage");
    await storage.saveProject(fixture("folder-doc"));
    const folder = await storage.createFolder("资料");
    await storage.moveDocument("folder-doc", folder.id);
    expect(await storage.listDocumentFolders()).toEqual({ "folder-doc": folder.id });
    await storage.moveDocument("folder-doc");
    expect(await storage.listDocumentFolders()).toEqual({});
    await expect(storage.moveDocument("missing-doc", folder.id)).rejects.toThrow(/资料不存在/);
  });

  it("promotes children on delete and renames collisions instead of losing folders", async () => {
    const storage = await import("../src/core/storage");
    const parent = await storage.createFolder("A");
    const child = await storage.createFolder("B", parent.id);
    const sibling = await storage.createFolder("B (2)");
    await storage.saveProject(fixture("promote-doc"));
    await storage.moveDocument("promote-doc", child.id);

    await storage.deleteFolder(parent.id);
    const folders = await storage.listFolders();
    const promoted = folders.find((folder) => folder.id === child.id);
    expect(promoted?.name).toBe("B");
    expect(promoted?.parentId).toBeUndefined();
    expect(folders.find((folder) => folder.id === sibling.id)?.name).toBe("B (2)");
    // The promoted child keeps its document; the deleted parent takes nothing with it.
    expect(await storage.listDocumentFolders()).toEqual({ "promote-doc": child.id });
  });

  it("rejects moving a folder into itself or its descendants", async () => {
    const storage = await import("../src/core/storage");
    const outer = await storage.createFolder("outer");
    const inner = await storage.createFolder("inner", outer.id);
    await expect(storage.moveFolder(outer.id, inner.id)).rejects.toThrow(/自身/);
    await expect(storage.moveFolder(outer.id, outer.id)).rejects.toThrow(/自身/);
    await expect(storage.moveFolder(outer.id, "missing")).rejects.toThrow(/不存在/);
  });
});
