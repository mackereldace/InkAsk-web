import Dexie, { type Table } from "dexie";
import type { Asset, InkDocument, Project } from "../types";
import type { WorkspaceFolder } from "./storage";

/**
 * The browser copy of the workspace, kept **only** as a migration source and as a
 * read-only fallback when the local service is not running.
 *
 * Project data now lives on disk under `.inkask/` (see `server/store.ts`). This
 * module still understands the two IndexedDB generations that exist in the wild:
 *
 * - v1 rows hold the whole `Project` including Blob fields;
 * - v2 rows hold metadata plus `{ binaryId, type }` references into `binaries`.
 *
 * Nothing here writes: migration uploads to the service and leaves this copy
 * untouched, so a failed migration can always be retried from the same bytes.
 */

interface BinaryReference {
  binaryId: string;
  type: string;
}
interface BinaryRecord {
  id: string;
  projectId: string;
  bytes: ArrayBuffer;
}
type StoredDocument = Omit<InkDocument, "pdf"> & { pdf: BinaryReference };
type StoredProject = Omit<Project, "document" | "assets"> & {
  storageVersion: 2;
  document: StoredDocument;
  assets: (Omit<Asset, "data"> & { data: BinaryReference })[];
};
type DocumentMetadata = Omit<InkDocument, "pdf">;
export interface LegacyMembership {
  projectId: string;
  folderId: string;
}

class LegacyDatabase extends Dexie {
  projects!: Table<Project | StoredProject, string>;
  binaries!: Table<BinaryRecord, string>;
  documents!: Table<DocumentMetadata, string>;
  folders!: Table<WorkspaceFolder, string>;
  memberships!: Table<LegacyMembership, string>;

  constructor() {
    super("inkask");
    this.version(1).stores({ projects: "document.id, document.updatedAt" });
    this.version(2).stores({
      projects: "document.id, document.updatedAt",
      binaries: "id, projectId",
      documents: "id, updatedAt",
      folders: "id, parentId",
      memberships: "projectId, folderId",
    });
  }
}

let database: LegacyDatabase | undefined;
function db(): LegacyDatabase {
  return (database ??= new LegacyDatabase());
}

/** True when this browser has an IndexedDB workspace worth migrating. */
export async function hasLegacyData(): Promise<boolean> {
  try {
    return (await db().projects.count()) > 0;
  } catch {
    return false;
  }
}

export async function listLegacyDocuments(): Promise<InkDocument[]> {
  // Read the projects table rather than `documents`: the v1 generation had no
  // documents table, and its metadata is the only record of what was saved.
  try {
    const projects = await db().projects.toArray();
    return projects
      .map((project) => {
        const { pdf: _pdf, ...document } = project.document;
        return { ...document, pdf: new Blob([], { type: "application/pdf" }) };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function isStored(project: Project | StoredProject): project is StoredProject {
  return "storageVersion" in project && project.storageVersion === 2;
}

export async function loadLegacyProject(id: string): Promise<Project | undefined> {
  const database = db();
  const loaded = await database.transaction("r", database.projects, database.binaries, async () => {
    const project = await database.projects.get(id);
    if (!project) return undefined;
    if (!isStored(project)) return project;
    const restore = async (reference: BinaryReference): Promise<Blob> => {
      const binary = await database.binaries.get(reference.binaryId);
      if (!binary) throw new Error("浏览器里的旧资料缺少附件数据，请改用 .inkask 备份恢复。");
      return new Blob([binary.bytes], { type: reference.type });
    };
    const { storageVersion: _storageVersion, ...rest } = project;
    return {
      ...rest,
      document: { ...project.document, pdf: await restore(project.document.pdf) },
      assets: await Promise.all(
        project.assets.map(async (asset) => ({ ...asset, data: await restore(asset.data) })),
      ),
    } as Project;
  });
  if (!loaded) return undefined;
  // A stream that was interrupted by a reload or a crash is no longer streaming.
  for (const note of loaded.notes) {
    for (const message of note.messages) if (message.status === "streaming") message.status = "stopped";
  }
  return loaded;
}

export async function listLegacyFolders(): Promise<WorkspaceFolder[]> {
  try {
    return await db().folders.toArray();
  } catch {
    return [];
  }
}

export async function listLegacyMemberships(): Promise<LegacyMembership[]> {
  try {
    return await db().memberships.toArray();
  } catch {
    return [];
  }
}

export async function deleteLegacyProject(id: string): Promise<void> {
  const database = db();
  await database.transaction(
    "rw",
    database.projects,
    database.binaries,
    database.documents,
    database.memberships,
    async () => {
      await database.projects.delete(id);
      await database.documents.delete(id);
      await database.binaries.where("projectId").equals(id).delete();
      await database.memberships.delete(id);
    },
  );
}
