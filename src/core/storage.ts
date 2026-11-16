import type { Asset, InkDocument, Project } from "../types";
import {
  deleteLegacyProject,
  listLegacyDocuments,
  listLegacyFolders,
  listLegacyMemberships,
  loadLegacyProject,
} from "./legacy-storage";

/**
 * Project storage backed by the local service, which writes files under `.inkask/`.
 *
 * Everything the app calls here is unchanged from the IndexedDB version: the same
 * functions, the same validation, the same "metadata only, bytes by reference"
 * shape. What changed is where the bytes land — on disk, so clearing browser data
 * or switching between the dev and built origins no longer hides your notes.
 *
 * The browser copy (`./legacy-storage.ts`) stays in place for two jobs: it is the
 * source of a one-time migration, and it keeps reading possible when the local
 * service is not running.
 */

export interface WorkspaceFolder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
}

interface BinaryReference {
  binaryId: string;
  type: string;
}
type StoredDocument = Omit<InkDocument, "pdf"> & { pdf: BinaryReference };
type StoredProject = Omit<Project, "document" | "assets"> & {
  storageVersion: 2;
  document: StoredDocument;
  assets: (Omit<Asset, "data"> & { data: BinaryReference })[];
};
type DocumentMetadata = Omit<InkDocument, "pdf">;
interface Membership {
  projectId: string;
  folderId: string;
}
interface Workspace {
  version: 1;
  folders: WorkspaceFolder[];
  memberships: Membership[];
}

export const STORAGE_LIMITS = Object.freeze({
  projectBytes: 256 * 1024 * 1024,
  blobBytes: 128 * 1024 * 1024,
});

const MIGRATION_FLAG = "inkask:disk-migration:v1";

/** The local service is not reachable; callers may fall back to the browser copy. */
export class StorageUnavailableError extends Error {}
/** The project does not exist on disk (never saved, or deleted). */
export class StorageMissingError extends Error {}

const queues = new Map<string, Promise<unknown>>();
function serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  void result
    .finally(() => {
      if (queues.get(id) === result) queues.delete(id);
    })
    .catch(() => undefined);
  queues.set(id, result);
  return result;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new StorageUnavailableError(
      "本地服务没有响应：项目保存在磁盘上，需要先启动 InkAsk 服务（npm start 或启动面板）。",
    );
  }
  if (response.ok) return response;
  if (response.status === 404) throw new StorageMissingError("资料不存在。");
  const detail = (await response.json().catch(() => undefined)) as
    | { message?: string }
    | undefined;
  throw new Error(detail?.message ?? `本机存储请求失败（HTTP ${response.status}）。`);
}

function jsonRequest(path: string, method: string, body: unknown): Promise<Response> {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── 附件字节：按内容寻址，同一份 PDF / 截图只上传一次 ─────────────────────────

const digests = new WeakMap<Blob, Promise<string>>();
const uploaded = new Set<string>();

async function sha256(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function upload(blob: Blob): Promise<BinaryReference> {
  let pending = digests.get(blob);
  if (!pending) {
    pending = sha256(blob);
    digests.set(blob, pending);
  }
  const id = await pending;
  if (!uploaded.has(id)) {
    if (blob.size > STORAGE_LIMITS.blobBytes) throw new Error("单个附件超过 128 MB，无法保存。");
    await request(`/api/blobs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
    uploaded.add(id);
  }
  return { binaryId: id, type: blob.type || "application/octet-stream" };
}

async function download(reference: BinaryReference): Promise<Blob> {
  const response = await request(`/api/blobs/${reference.binaryId}`);
  const bytes = await response.arrayBuffer();
  return new Blob([bytes], { type: reference.type });
}

// ── 项目 ─────────────────────────────────────────────────────────────────────

/** Snapshot first, then upload bytes, then replace metadata in one request. */
export function saveProject(project: Project): Promise<void> {
  const { pdf, ...document } = project.document;
  const { document: _document, assets: _assets, ...rest } = project;
  const snapshot = {
    ...structuredClone(rest),
    document: { ...structuredClone(document), pdf },
    assets: project.assets.map(({ data, ...asset }) => ({ ...structuredClone(asset), data })),
  };
  const id = snapshot.document.id;
  return serialize(id, async () => {
    const pdfReference = await upload(snapshot.document.pdf);
    const assets: StoredProject["assets"] = [];
    for (const asset of snapshot.assets) {
      const reference = await upload(asset.data);
      const { data: _data, ...metadata } = asset;
      assets.push({ ...metadata, data: reference });
    }
    const value: StoredProject = {
      ...snapshot,
      storageVersion: 2,
      document: { ...snapshot.document, pdf: pdfReference },
      assets,
    };
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      throw new Error("项目内容无法序列化，请尝试导出一份备份。");
    }
    if (new TextEncoder().encode(text).byteLength > STORAGE_LIMITS.projectBytes) {
      throw new Error("项目超过 256 MB，无法保存到磁盘。");
    }
    await request(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
  });
}

export async function loadProject(id: string): Promise<Project | undefined> {
  await queues.get(id)?.catch(() => undefined);
  let stored: StoredProject;
  try {
    const response = await request(`/api/projects/${encodeURIComponent(id)}`);
    const payload = (await response.json()) as { project?: StoredProject };
    if (!payload.project) return undefined;
    stored = payload.project;
  } catch (error) {
    // Not on disk yet (or the service is down): the browser copy may still have it.
    if (error instanceof StorageMissingError || error instanceof StorageUnavailableError) {
      return loadLegacyProject(id).catch(() => undefined);
    }
    throw error;
  }
  const { storageVersion: _storageVersion, ...rest } = stored;
  const project: Project = {
    ...rest,
    document: { ...stored.document, pdf: await download(stored.document.pdf) },
    assets: await Promise.all(
      stored.assets.map(async (asset) => {
        const { data, ...metadata } = asset;
        return { ...metadata, data: await download(data) };
      }),
    ),
  };
  // A stream interrupted by a reload or a crash must not come back as "streaming".
  for (const note of project.notes) {
    for (const message of note.messages) if (message.status === "streaming") message.status = "stopped";
  }
  return project;
}

async function fetchDocuments(): Promise<DocumentMetadata[]> {
  const response = await request("/api/projects");
  const payload = (await response.json()) as { documents?: DocumentMetadata[] };
  return payload.documents ?? [];
}

export async function listDocuments(): Promise<InkDocument[]> {
  try {
    const documents = await fetchDocuments();
    // Library cards only need metadata; the PDF is fetched by loadProject.
    return documents.map((document) => ({
      ...document,
      pdf: new Blob([], { type: "application/pdf" }),
    }));
  } catch (error) {
    if (error instanceof StorageUnavailableError) return listLegacyDocuments();
    throw error;
  }
}

export function deleteProject(id: string): Promise<void> {
  return serialize(id, async () => {
    try {
      await request(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof StorageMissingError) && !(error instanceof StorageUnavailableError)) {
        throw error;
      }
    }
    // Deleting a project may prune unattached blobs on disk, so forget the
    // session upload cache: a later save of the same bytes must upload again.
    uploaded.clear();
    // Keep the browser copy consistent so it cannot resurrect a deleted project.
    await deleteLegacyProject(id).catch(() => undefined);
  });
}

// ── 资料空间（文件夹与归属）───────────────────────────────────────────────────

async function readWorkspace(): Promise<Workspace> {
  const response = await request("/api/workspace");
  const payload = (await response.json()) as Partial<Workspace>;
  return {
    version: 1,
    folders: payload.folders ?? [],
    memberships: payload.memberships ?? [],
  };
}

async function writeWorkspace(workspace: Workspace): Promise<void> {
  await jsonRequest("/api/workspace", "PUT", workspace);
}

/** Read-modify-write the small workspace file, one operation at a time. */
function withWorkspace<T>(operation: (workspace: Workspace) => Promise<T> | T): Promise<T> {
  return serialize("workspace", async () => {
    const workspace = await readWorkspace();
    const result = await operation(workspace);
    await writeWorkspace(workspace);
    return result;
  });
}

export async function listFolders(): Promise<WorkspaceFolder[]> {
  try {
    return (await readWorkspace()).folders;
  } catch (error) {
    if (error instanceof StorageUnavailableError) return listLegacyFolders();
    throw error;
  }
}

function folderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("文件夹名称不能为空。");
  return trimmed;
}

function validateFolder(
  workspace: Workspace,
  name: string,
  parentId?: string,
  exceptId?: string,
): void {
  if (parentId && !workspace.folders.some((folder) => folder.id === parentId)) {
    throw new Error("父文件夹不存在。");
  }
  const duplicate = workspace.folders.find(
    (folder) => folder.id !== exceptId && folder.parentId === parentId && folder.name === name,
  );
  if (duplicate) throw new Error("同一目录下已有同名文件夹。");
}

export async function createFolder(name: string, parentId?: string): Promise<WorkspaceFolder> {
  const trimmed = folderName(name);
  const folder: WorkspaceFolder = {
    id: crypto.randomUUID(),
    name: trimmed,
    parentId: parentId || undefined,
    createdAt: Date.now(),
  };
  return withWorkspace((workspace) => {
    validateFolder(workspace, folder.name, folder.parentId);
    workspace.folders.push(folder);
    return folder;
  });
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const trimmed = folderName(name);
  await withWorkspace((workspace) => {
    const folder = workspace.folders.find((candidate) => candidate.id === id);
    if (!folder) throw new Error("文件夹不存在。");
    validateFolder(workspace, trimmed, folder.parentId, id);
    folder.name = trimmed;
  });
}

export async function moveFolder(id: string, parentId?: string): Promise<void> {
  await withWorkspace((workspace) => {
    const folder = workspace.folders.find((candidate) => candidate.id === id);
    if (!folder) throw new Error("文件夹不存在。");
    const seen = new Set<string>();
    let ancestor = parentId;
    while (ancestor) {
      if (ancestor === id) throw new Error("不能把文件夹移入自身或它的子文件夹。");
      if (seen.has(ancestor)) throw new Error("目标目录的层级无效。");
      seen.add(ancestor);
      const target = workspace.folders.find((candidate) => candidate.id === ancestor);
      if (!target) throw new Error("目标文件夹不存在。");
      ancestor = target.parentId;
    }
    validateFolder(workspace, folder.name, parentId, id);
    folder.parentId = parentId || undefined;
  });
}

export async function deleteFolder(id: string): Promise<void> {
  await withWorkspace((workspace) => {
    const folder = workspace.folders.find((candidate) => candidate.id === id);
    if (!folder) return;
    for (const child of workspace.folders.filter((candidate) => candidate.parentId === id)) {
      // A promoted folder must not create ambiguous sibling names.
      let name = child.name;
      let suffix = 2;
      while (
        workspace.folders.some(
          (candidate) =>
            candidate.id !== child.id &&
            candidate.id !== id &&
            candidate.parentId === folder.parentId &&
            candidate.name === name,
        )
      ) {
        name = `${child.name} (${suffix++})`;
      }
      child.name = name;
      child.parentId = folder.parentId;
    }
    for (const membership of workspace.memberships) {
      if (membership.folderId !== id) continue;
      if (folder.parentId) membership.folderId = folder.parentId;
      else membership.folderId = "";
    }
    workspace.memberships = workspace.memberships.filter((membership) => membership.folderId);
    workspace.folders = workspace.folders.filter((candidate) => candidate.id !== id);
  });
}

export async function moveDocument(id: string, folderId?: string): Promise<void> {
  await withWorkspace(async (workspace) => {
    const documents = await fetchDocuments();
    if (!documents.some((document) => document.id === id)) throw new Error("资料不存在。");
    if (folderId && !workspace.folders.some((folder) => folder.id === folderId)) {
      throw new Error("文件夹不存在。");
    }
    workspace.memberships = workspace.memberships.filter((membership) => membership.projectId !== id);
    if (folderId) workspace.memberships.push({ projectId: id, folderId });
  });
}

export async function listDocumentFolders(): Promise<Record<string, string>> {
  try {
    const workspace = await readWorkspace();
    return Object.fromEntries(
      workspace.memberships.map(({ projectId, folderId }) => [projectId, folderId]),
    );
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      const memberships = await listLegacyMemberships();
      return Object.fromEntries(
        memberships.map(({ projectId, folderId }) => [projectId, folderId]),
      );
    }
    throw error;
  }
}

// ── 启动时的一次性迁移 ────────────────────────────────────────────────────────

export interface StorageReport {
  /** Non-null when this run copied projects from the browser copy to disk. */
  migrated: { projects: number; folders: number } | null;
  /** True when the local service is unreachable and only the browser copy is readable. */
  readOnly: boolean;
}

function migrationDone(): boolean {
  try {
    return localStorage.getItem(MIGRATION_FLAG) !== null;
  } catch {
    return true;
  }
}

function markMigrated(): void {
  try {
    localStorage.setItem(MIGRATION_FLAG, String(Date.now()));
  } catch {
    /* Private mode: migration simply runs again next time and skips existing ids. */
  }
}

/**
 * Called once at startup. Copies any IndexedDB workspace onto disk **without**
 * deleting it: if the upload fails halfway, the next start retries the rest and
 * the browser copy is still there to fall back to.
 */
export async function prepareStorage(): Promise<StorageReport> {
  return serialize("prepare", async () => {
    let documents: DocumentMetadata[];
    let workspace: Workspace;
    try {
      documents = await fetchDocuments();
      workspace = await readWorkspace();
    } catch (error) {
      if (error instanceof StorageUnavailableError) return { migrated: null, readOnly: true };
      throw error;
    }
    if (migrationDone()) return { migrated: null, readOnly: false };

    const legacyDocuments = await listLegacyDocuments();
    const legacyFolders = await listLegacyFolders();
    const legacyMemberships = await listLegacyMemberships();
    const known = new Set(documents.map((document) => document.id));
    let projects = 0;
    let failures = 0;
    for (const document of legacyDocuments) {
      if (known.has(document.id)) continue;
      const project = await loadLegacyProject(document.id).catch(() => undefined);
      if (!project) continue;
      try {
        await saveProject(project);
        projects += 1;
      } catch {
        // A failed project must not be forgotten: the flag stays unset and the
        // whole migration retries on the next start (already-copied ids skip).
        failures += 1;
      }
    }

    let folders = 0;
    for (const folder of legacyFolders) {
      if (workspace.folders.some((candidate) => candidate.id === folder.id)) continue;
      workspace.folders.push(folder);
      folders += 1;
    }
    for (const membership of legacyMemberships) {
      if (workspace.memberships.some((item) => item.projectId === membership.projectId)) continue;
      if (!workspace.folders.some((folder) => folder.id === membership.folderId)) continue;
      workspace.memberships.push({ projectId: membership.projectId, folderId: membership.folderId });
    }
    if (folders) {
      await writeWorkspace(workspace).catch(() => {
        failures += 1;
      });
    }
    // Only a complete run earns the flag; otherwise the next start tries again.
    if (failures === 0) markMigrated();
    return { migrated: projects || folders ? { projects, folders } : null, readOnly: false };
  });
}

/** Where the files live, for the settings panel and for support questions. */
export async function storageInfo(): Promise<{ dir: string; projects: number; blobs: number; bytes: number }> {
  const response = await request("/api/storage");
  return (await response.json()) as { dir: string; projects: number; blobs: number; bytes: number };
}
