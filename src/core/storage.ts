import Dexie, { type Table } from "dexie";
import type { Asset, InkDocument, Project } from "../types";

export interface WorkspaceFolder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
}
interface BinaryReference { binaryId: string; type: string }
interface BinaryRecord { id: string; projectId: string; bytes: ArrayBuffer }
type StoredDocument = Omit<InkDocument, "pdf"> & { pdf: BinaryReference };
type StoredProject = Omit<Project, "document" | "assets"> & {
  storageVersion: 2;
  document: StoredDocument;
  assets: (Omit<Asset, "data"> & { data: BinaryReference })[];
};
type DocumentMetadata = Omit<InkDocument, "pdf">;
interface Membership { projectId: string; folderId: string }

class InkAskDatabase extends Dexie {
  projects!: Table<Project | StoredProject, string>;
  binaries!: Table<BinaryRecord, string>;
  documents!: Table<DocumentMetadata, string>;
  folders!: Table<WorkspaceFolder, string>;
  memberships!: Table<Membership, string>;

  constructor() {
    super("inkask");
    this.version(1).stores({ projects: "document.id, document.updatedAt" });
    // Never rewrite legacy Blob records during schema upgrade: some browsers can
    // read them but cannot write them. Only copy their small document metadata.
    this.version(2).stores({
      projects: "document.id, document.updatedAt",
      binaries: "id, projectId",
      documents: "id, updatedAt",
      folders: "id, parentId",
      memberships: "projectId, folderId",
    }).upgrade(async (transaction) => {
      const documents: DocumentMetadata[] = [];
      await transaction.table("projects").each((project: Project) => {
        const { pdf: _pdf, ...metadata } = project.document;
        documents.push(metadata);
      });
      await transaction.table("documents").bulkPut(documents);
    });
  }
}
let database: InkAskDatabase | undefined;
function db(): InkAskDatabase { return database ??= new InkAskDatabase(); }
const binaryIds = new WeakMap<Blob, string>();
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  queues.set(id, result);
  void result.finally(() => { if (queues.get(id) === result) queues.delete(id); }).catch(() => undefined);
  return result;
}
function isStored(project: Project | StoredProject): project is StoredProject {
  return "storageVersion" in project && project.storageVersion === 2;
}
function references(project: StoredProject): BinaryReference[] {
  return [project.document.pdf, ...project.assets.map((asset) => asset.data)];
}

async function prepare(project: Project): Promise<{ value: StoredProject; binaries: BinaryRecord[] }> {
  const binaries: BinaryRecord[] = [];
  const capture = async (blob: Blob): Promise<BinaryReference> => {
    let id = binaryIds.get(blob);
    let bytes: ArrayBuffer | undefined;
    if (!id) {
      bytes = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      binaryIds.set(blob, id);
    }
    // Scope IDs to the project so deletion can never remove another PDF's bytes.
    const binaryId = `${project.document.id}:${id}`;
    if (!(await db().binaries.where(":id").equals(binaryId).count())) {
      binaries.push({ id: binaryId, projectId: project.document.id, bytes: bytes ?? await blob.arrayBuffer() });
    }
    return { binaryId, type: blob.type };
  };
  // Both callers own a private snapshot: saveProject captures it synchronously,
  // and legacy migration has not returned its IDB copy to the caller yet. Reuse
  // those nested metadata objects instead of cloning the full project twice.
  const { pdf, ...document } = project.document;
  const assets = project.assets.map(({ data, ...asset }) => ({ data, metadata: asset }));
  const { document: _document, assets: _assets, ...rest } = project;
  const metadata = { ...rest, document };
  const pdfReference = await capture(pdf);
  const storedAssets = await Promise.all(assets.map(async ({ data, metadata: asset }) => ({ ...asset, data: await capture(data) })));
  return { value: { ...metadata, storageVersion: 2, document: { ...metadata.document, pdf: pdfReference }, assets: storedAssets }, binaries };
}

async function writeProject(project: Project, legacyOnly = false): Promise<void> {
  const { value, binaries } = await prepare(project);
  const database = db();
  await database.transaction("rw", database.projects, database.binaries, database.documents, async () => {
    if (legacyOnly) {
      const current = await database.projects.get(project.document.id);
      if (!current || isStored(current)) return;
    }
    for (const binary of binaries) await database.binaries.put(binary);
    const retained = new Set(references(value).map((reference) => reference.binaryId));
    for (const key of retained) {
      if (!(await database.binaries.where(":id").equals(key).count())) {
        throw new Error("资料在保存期间发生变化，请重试保存。");
      }
    }
    // Metadata and bytes commit together. Any quota/serialization error preserves
    // the entire previous project, including its PDF and attachments.
    const { pdf: _pdf, ...metadata } = value.document;
    await database.projects.put(value);
    await database.documents.put(metadata);
    const oldKeys = await database.binaries.where("projectId").equals(value.document.id).primaryKeys();
    await database.binaries.bulkDelete(oldKeys.filter((key) => !retained.has(key)));
  });
}

export function saveProject(project: Project): Promise<void> {
  // Snapshot metadata immediately; Blob is immutable and is deliberately not
  // passed to structuredClone or IndexedDB's structured serialization.
  const { pdf, ...document } = project.document;
  const { document: _document, assets: _assets, ...rest } = project;
  const snapshot = {
    ...structuredClone(rest), document: { ...structuredClone(document), pdf },
    assets: project.assets.map(({ data, ...asset }) => ({ ...structuredClone(asset), data })),
  };
  return serialize(project.document.id, () => writeProject(snapshot));
}

export async function loadProject(id: string): Promise<Project | undefined> {
  await queues.get(id)?.catch(() => undefined);
  const database = db();
  // Read metadata and its bytes from one snapshot while another tab may save.
  const loaded = await database.transaction("r", database.projects, database.binaries, async () => {
    const project = await database.projects.get(id);
    if (!project) return undefined;
    if (!isStored(project)) return { project, legacy: true };
    const restore = async (reference: BinaryReference): Promise<Blob> => {
      const binary = await database.binaries.get(reference.binaryId);
      if (!binary) throw new Error("本地资料的二进制数据缺失，请从备份恢复。");
      const blob = new Blob([binary.bytes], { type: reference.type });
      binaryIds.set(blob, reference.binaryId.slice(id.length + 1));
      return blob;
    };
    const { storageVersion: _storageVersion, ...rest } = project;
    const restored: Project = {
      ...rest, document: { ...project.document, pdf: await restore(project.document.pdf) },
      assets: await Promise.all(project.assets.map(async (asset) => ({ ...asset, data: await restore(asset.data) }))),
    };
    return { project: restored, legacy: false };
  });
  if (!loaded) return undefined;
  const copy = loaded.project;
  if (loaded.legacy) {
    // Reading remains usable if conversion fails (for example quota exhausted).
    // The transaction either migrates all bytes or leaves the legacy row intact.
    await serialize(id, () => writeProject(copy, true)).catch(() => undefined);
  }
  for (const note of copy.notes) {
    for (const message of note.messages) if (message.status === "streaming") message.status = "stopped";
  }
  return copy;
}

export async function listDocuments(): Promise<InkDocument[]> {
  const documents = await db().documents.orderBy("updatedAt").reverse().toArray();
  // Library cards only need metadata. The actual PDF is loaded by loadProject.
  return documents.map((document) => ({ ...document, pdf: new Blob([], { type: "application/pdf" }) }));
}
export function deleteProject(id: string): Promise<void> {
  return serialize(id, async () => {
    const database = db();
    await database.transaction("rw", database.projects, database.binaries, database.documents, database.memberships, async () => {
      await database.projects.delete(id);
      await database.documents.delete(id);
      await database.binaries.where("projectId").equals(id).delete();
      await database.memberships.delete(id);
    });
  });
}

export async function listFolders(): Promise<WorkspaceFolder[]> { return db().folders.toArray(); }
function folderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("文件夹名称不能为空。");
  return trimmed;
}
async function validateFolder(name: string, parentId?: string, exceptId?: string): Promise<void> {
  if (parentId && !(await db().folders.get(parentId))) throw new Error("父文件夹不存在。");
  const duplicate = await db().folders.filter((folder) => folder.id !== exceptId && folder.parentId === parentId && folder.name === name).first();
  if (duplicate) throw new Error("同一目录下已有同名文件夹。");
}
export async function createFolder(name: string, parentId?: string): Promise<WorkspaceFolder> {
  name = folderName(name);
  parentId ||= undefined;
  return db().transaction("rw", db().folders, async () => {
    await validateFolder(name, parentId);
    const folder = { id: crypto.randomUUID(), name, parentId, createdAt: Date.now() };
    await db().folders.add(folder);
    return folder;
  });
}
export async function renameFolder(id: string, name: string): Promise<void> {
  name = folderName(name);
  await db().transaction("rw", db().folders, async () => {
    const folder = await db().folders.get(id);
    if (!folder) throw new Error("文件夹不存在。");
    await validateFolder(name, folder.parentId, id);
    await db().folders.update(id, { name });
  });
}
export async function moveFolder(id: string, parentId?: string): Promise<void> {
  parentId ||= undefined;
  await db().transaction("rw", db().folders, async () => {
    const folder = await db().folders.get(id);
    if (!folder) throw new Error("文件夹不存在。");
    const seen = new Set<string>();
    let ancestor = parentId;
    while (ancestor) {
      if (ancestor === id) throw new Error("不能把文件夹移入自身或它的子文件夹。");
      if (seen.has(ancestor)) throw new Error("目标目录的层级无效。");
      seen.add(ancestor);
      const target = await db().folders.get(ancestor);
      if (!target) throw new Error("目标文件夹不存在。");
      ancestor = target.parentId;
    }
    await validateFolder(folder.name, parentId, id);
    await db().folders.update(id, { parentId });
  });
}
export async function deleteFolder(id: string): Promise<void> {
  await db().transaction("rw", db().folders, db().memberships, async () => {
    const folder = await db().folders.get(id);
    if (!folder) return;
    const children = await db().folders.where("parentId").equals(id).toArray();
    for (const child of children) {
      // A promoted folder must not create ambiguous sibling names.
      let name = child.name;
      let suffix = 2;
      while (await db().folders.filter((candidate) => candidate.id !== child.id && candidate.id !== id && candidate.parentId === folder.parentId && candidate.name === name).first()) name = `${child.name} (${suffix++})`;
      await db().folders.put({ ...child, name, parentId: folder.parentId });
    }
    const memberships = await db().memberships.where("folderId").equals(id).toArray();
    for (const membership of memberships) {
      if (folder.parentId) await db().memberships.put({ ...membership, folderId: folder.parentId });
      else await db().memberships.delete(membership.projectId);
    }
    await db().folders.delete(id);
  });
}
export async function moveDocument(id: string, folderId?: string): Promise<void> {
  await db().transaction("rw", db().projects, db().folders, db().memberships, async () => {
    if (!(await db().projects.get(id))) throw new Error("资料不存在。");
    if (folderId) {
      if (!(await db().folders.get(folderId))) throw new Error("文件夹不存在。");
      await db().memberships.put({ projectId: id, folderId });
    } else await db().memberships.delete(id);
  });
}
export async function listDocumentFolders(): Promise<Record<string, string>> {
  return Object.fromEntries((await db().memberships.toArray()).map(({ projectId, folderId }) => [projectId, folderId]));
}
