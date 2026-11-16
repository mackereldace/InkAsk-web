import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore, StoreLimitError, StoreValidationError } from "../server/store";

let dir: string;
let store: ProjectStore;

const PDF = "a".repeat(64);
const CROP = "b".repeat(64);

function record(id: string, overrides: Record<string, unknown> = {}) {
  return {
    storageVersion: 2,
    document: {
      id,
      name: `${id}.pdf`,
      fingerprint: id,
      pageCount: 3,
      createdAt: 10,
      updatedAt: 20,
      pdf: { binaryId: PDF, type: "application/pdf" },
    },
    pages: [],
    notes: [],
    templates: [],
    assets: [],
    view: { page: 1, scale: 1, rotation: 0 },
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkask-project-store-"));
  store = new ProjectStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("project store on disk", () => {
  it("writes a project, lists it by metadata and reads it back", async () => {
    await store.writeBlob(PDF, new Uint8Array([1, 2, 3]));
    await store.write("alpha", record("alpha"));
    await store.write(
      "beta",
      record("beta", { document: { ...record("beta").document, updatedAt: 99 } }),
    );

    expect(await store.list()).toEqual([
      { id: "beta", name: "beta.pdf", fingerprint: "beta", pageCount: 3, createdAt: 10, updatedAt: 99 },
      { id: "alpha", name: "alpha.pdf", fingerprint: "alpha", pageCount: 3, createdAt: 10, updatedAt: 20 },
    ]);
    const read = (await store.read("alpha")) as { document: { pdf: { binaryId: string } } };
    expect(read.document.pdf.binaryId).toBe(PDF);
    expect([...(await store.readBlob(PDF))]).toEqual([1, 2, 3]);
    expect(await store.read("missing")).toBeUndefined();
  });

  it("leaves the previous version intact when a write is rejected", async () => {
    await store.write("alpha", record("alpha"));
    const before = await readFile(join(dir, "projects", "alpha", "project.json"), "utf8");

    await expect(store.write("alpha", record("other"))).rejects.toBeInstanceOf(StoreValidationError);
    await expect(store.write("alpha", { ...record("alpha"), storageVersion: 1 })).rejects.toBeInstanceOf(
      StoreValidationError,
    );
    await expect(store.write("../escape", record("../escape"))).rejects.toBeInstanceOf(
      StoreValidationError,
    );

    expect(await readFile(join(dir, "projects", "alpha", "project.json"), "utf8")).toBe(before);
  });

  it("rejects incomplete projects and empty or oversized attachments", async () => {
    await expect(store.write("alpha", { storageVersion: 2, document: { id: "alpha" } })).rejects.toBeInstanceOf(
      StoreValidationError,
    );
    await expect(store.writeBlob(PDF, new Uint8Array())).rejects.toBeInstanceOf(StoreValidationError);
    await expect(store.writeBlob("not-a-digest", new Uint8Array([1]))).rejects.toBeInstanceOf(
      StoreValidationError,
    );
    await expect(store.writeBlob("c".repeat(64), new Uint8Array(129 * 1024 * 1024))).rejects.toBeInstanceOf(
      StoreLimitError,
    );
    expect(await readdir(join(dir, "blobs")).catch(() => [])).toEqual([]);
  });

  it("stores each blob once even when it is uploaded repeatedly", async () => {
    await store.writeBlob(PDF, new Uint8Array([1, 2, 3]));
    await store.writeBlob(PDF, new Uint8Array([9, 9, 9]));
    const bucket = join(dir, "blobs", "aa");
    expect(await readdir(bucket)).toEqual([PDF]);
    expect([...(await store.readBlob(PDF))]).toEqual([1, 2, 3]);
  });

  it("prunes only the blobs that no remaining project references", async () => {
    const shared = "d".repeat(64);
    const extra = "e".repeat(64);
    await store.writeBlob(shared, new Uint8Array([1]));
    await store.writeBlob(extra, new Uint8Array([2]));
    await store.write("one", record("one"));
    await store.write("two", record("two", { document: { ...record("two").document, pdf: { binaryId: shared, type: "application/pdf" } } }));

    expect(await store.remove("one")).toBe(true);
    expect(await store.blobExists(PDF)).toBe(false);
    expect(await store.blobExists(shared)).toBe(true);
    expect(await store.remove("one")).toBe(false);
  });

  it("defaults the workspace to empty and quarantines a corrupt file", async () => {
    expect(await store.readWorkspace()).toEqual({ version: 1, folders: [], memberships: [] });

    const workspace = {
      version: 1 as const,
      folders: [{ id: "f1", name: "作业", createdAt: 5 }],
      memberships: [{ projectId: "alpha", folderId: "f1" }],
    };
    expect(await store.writeWorkspace(workspace)).toEqual(workspace);
    expect(await store.readWorkspace()).toEqual(workspace);

    await writeFile(join(dir, "workspace.json"), "{ broken", "utf8");
    expect(await store.readWorkspace()).toEqual({ version: 1, folders: [], memberships: [] });
    const files = await readdir(dir);
    expect(files.some((file) => file.startsWith("workspace.json.corrupt-"))).toBe(true);
    expect(await stat(join(dir, "workspace.json")).catch(() => null)).toBeNull();
  });

  it("validates the workspace shape before writing", async () => {
    await expect(store.writeWorkspace({ folders: "no" })).rejects.toBeInstanceOf(StoreValidationError);
    await expect(
      store.writeWorkspace({ version: 1, folders: [{ id: "", name: "x", createdAt: 1 }], memberships: [] }),
    ).rejects.toBeInstanceOf(StoreValidationError);
    await expect(
      store.writeWorkspace({ version: 1, folders: [], memberships: [{ projectId: "a" }] }),
    ).rejects.toBeInstanceOf(StoreValidationError);
  });

  it("reports where the files live and how much is stored", async () => {
    await store.writeBlob(PDF, new Uint8Array([1, 2, 3, 4]));
    await store.write("alpha", record("alpha"));
    expect(await store.stats()).toEqual({ dir, projects: 1, blobs: 1, bytes: 4 });
  });
});
