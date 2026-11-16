import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Project storage on disk, served by the local InkAsk service.
 *
 * Layout (all under `INKASK_DATA_DIR`, default `.inkask/` next to the source):
 *
 *   projects/<projectId>/project.json   metadata only: pages, notes, templates, blob refs
 *   blobs/<aa>/<sha256>                 raw bytes, content addressed (PDF, crops, images)
 *   workspace.json                      folders and folder↔project memberships
 *
 * Why not IndexedDB: the browser profile is the wrong owner for this data. Clearing
 * site data, switching port/origin, or opening a different browser all look like
 * "my notes are gone". Files under the project directory survive all three and can
 * be backed up with a plain copy.
 *
 * Metadata and bytes commit separately: a project.json is written with write+rename,
 * so a crash mid-write leaves the previous version intact. Blobs are immutable and
 * content addressed, so a failed upload can simply be retried.
 */

export const STORE_LIMITS = Object.freeze({
  projects: 500,
  projectBytes: 256 * 1024 * 1024,
  blobBytes: 128 * 1024 * 1024,
  workspaceBytes: 4 * 1024 * 1024,
});

const PROJECT_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const BLOB_ID = /^[a-f0-9]{64}$/;

export class StoreValidationError extends Error {}
export class StoreLimitError extends Error {}

export interface StoredFolder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
}

export interface StoredMembership {
  projectId: string;
  folderId: string;
}

export interface StoredWorkspace {
  version: 1;
  folders: StoredFolder[];
  memberships: StoredMembership[];
}

export interface DocumentMetadata {
  id: string;
  name: string;
  fingerprint: string;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
}

interface StoredProjectShape {
  storageVersion?: unknown;
  document?: { id?: unknown };
  updatedAt?: unknown;
}

function assertProjectId(id: string): void {
  if (!PROJECT_ID.test(id)) throw new StoreValidationError("资料 ID 不合法。");
}

function assertBlobId(id: string): void {
  if (!BLOB_ID.test(id)) throw new StoreValidationError("数据块 ID 不合法。");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreValidationError("请求内容格式不正确。");
  }
  return value as Record<string, unknown>;
}

function isSafeText(value: unknown, limit = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\u0000-\u001f]/.test(value)
  );
}

/** One write at a time per key, so two tabs cannot interleave renames. */
class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    // The stored tail must never be a rejected promise nobody awaits, otherwise a
    // validation failure would surface as an unhandled rejection in the host.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.tails.set(key, tail);
    return result;
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class ProjectStore {
  private readonly queue = new KeyedQueue();
  constructor(readonly root: string) {}

  private get projectsDir(): string {
    return join(this.root, "projects");
  }
  private get blobsDir(): string {
    return join(this.root, "blobs");
  }
  private get workspacePath(): string {
    return join(this.root, "workspace.json");
  }
  private projectPath(id: string): string {
    return join(this.projectsDir, id, "project.json");
  }
  private blobPath(id: string): string {
    return join(this.blobsDir, id.slice(0, 2), id);
  }

  /** Library cards need metadata only; the PDF and assets stay on disk. */
  async list(): Promise<DocumentMetadata[]> {
    let entries: string[];
    try {
      entries = await readdir(this.projectsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const documents: DocumentMetadata[] = [];
    for (const entry of entries) {
      if (!PROJECT_ID.test(entry)) continue;
      const record = await this.readRecord(entry);
      if (!record) continue;
      const document = asRecord(record.document);
      documents.push({
        id: entry,
        name: typeof document.name === "string" ? document.name : entry,
        fingerprint: typeof document.fingerprint === "string" ? document.fingerprint : "",
        pageCount: typeof document.pageCount === "number" ? document.pageCount : 0,
        createdAt: typeof document.createdAt === "number" ? document.createdAt : 0,
        updatedAt: typeof document.updatedAt === "number" ? document.updatedAt : 0,
      });
    }
    return documents.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async readRecord(id: string): Promise<StoredProjectShape | undefined> {
    let text: string;
    try {
      text = await readFile(this.projectPath(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as StoredProjectShape) : undefined;
    } catch {
      // A half-written or hand-edited file must not break the whole library.
      return undefined;
    }
  }

  async read(id: string): Promise<Record<string, unknown> | undefined> {
    assertProjectId(id);
    let text: string;
    try {
      text = await readFile(this.projectPath(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new StoreValidationError("磁盘上的项目文件已损坏，无法读取。");
    }
  }

  /** Write metadata atomically; the previous version survives any failure. */
  async write(id: string, value: unknown): Promise<void> {
    assertProjectId(id);
    return this.queue.run(`project:${id}`, async () => {
      const record = asRecord(value);
      const document = asRecord(record.document);
      if (record.storageVersion !== 2) {
        throw new StoreValidationError("项目格式版本不受支持。");
      }
      if (document.id !== id) {
        throw new StoreValidationError("项目 ID 与请求路径不一致。");
      }
      if (!Array.isArray(record.notes) || !Array.isArray(record.pages) || !Array.isArray(record.assets)) {
        throw new StoreValidationError("项目内容不完整。");
      }
      const limit = STORE_LIMITS.projectBytes;
      let text: string;
      try {
        text = JSON.stringify(record);
      } catch {
        throw new StoreValidationError("项目内容无法序列化。");
      }
      if (Buffer.byteLength(text) > limit) {
        throw new StoreLimitError(`项目超过 ${Math.round(limit / 1024 / 1024)} MB，无法保存。`);
      }
      await writeAtomic(this.projectPath(id), text);
    });
  }

  readBlob(id: string): Promise<Buffer> {
    assertBlobId(id);
    return readFile(this.blobPath(id));
  }

  async blobExists(id: string): Promise<boolean> {
    if (!BLOB_ID.test(id)) return false;
    try {
      await stat(this.blobPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async writeBlob(id: string, bytes: Uint8Array): Promise<void> {
    assertBlobId(id);
    if (bytes.byteLength > STORE_LIMITS.blobBytes) {
      throw new StoreLimitError(
        `单个附件超过 ${Math.round(STORE_LIMITS.blobBytes / 1024 / 1024)} MB，无法保存。`,
      );
    }
    if (bytes.byteLength === 0) throw new StoreValidationError("附件内容为空。");
    return this.queue.run(`blob:${id}`, async () => {
      // Blobs are content addressed, so an existing file is already the right bytes.
      if (await this.blobExists(id)) return;
      await writeAtomic(this.blobPath(id), bytes);
    });
  }

  async remove(id: string): Promise<boolean> {
    assertProjectId(id);
    return this.queue.run(`project:${id}`, async () => {
      const existed = await stat(join(this.projectsDir, id))
        .then(() => true)
        .catch(() => false);
      await rm(join(this.projectsDir, id), { recursive: true, force: true });
      await this.pruneBlobs();
      return existed;
    });
  }

  /** Drop blobs no living project references; keeps the directory from growing forever. */
  async pruneBlobs(): Promise<number> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      projectDirs = [];
    }
    const keep = new Set<string>();
    for (const dir of projectDirs) {
      if (!PROJECT_ID.test(dir)) continue;
      const record = (await this.readRecord(dir)) as
        | (StoredProjectShape & { assets?: unknown; document?: { pdf?: { binaryId?: unknown } } })
        | undefined;
      const pdf = record?.document?.pdf?.binaryId;
      if (typeof pdf === "string") keep.add(pdf);
      if (Array.isArray(record?.assets)) {
        for (const asset of record.assets) {
          const id = (asset as { data?: { binaryId?: unknown } })?.data?.binaryId;
          if (typeof id === "string") keep.add(id);
        }
      }
    }
    let removed = 0;
    let buckets: string[];
    try {
      buckets = await readdir(this.blobsDir);
    } catch {
      return 0;
    }
    for (const bucket of buckets) {
      let files: string[];
      try {
        files = await readdir(join(this.blobsDir, bucket));
      } catch {
        continue;
      }
      for (const file of files) {
        if (keep.has(file)) continue;
        await unlink(join(this.blobsDir, bucket, file)).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }

  async readWorkspace(): Promise<StoredWorkspace> {
    let text: string;
    try {
      text = await readFile(this.workspacePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, folders: [], memberships: [] };
      }
      throw error;
    }
    try {
      return this.validateWorkspace(JSON.parse(text));
    } catch {
      // Keep the unreadable file for inspection instead of deleting user data.
      await rename(this.workspacePath, `${this.workspacePath}.corrupt-${Date.now()}`).catch(
        () => undefined,
      );
      return { version: 1, folders: [], memberships: [] };
    }
  }

  writeWorkspace(value: unknown): Promise<StoredWorkspace> {
    return this.queue.run("workspace", async () => {
      const workspace = this.validateWorkspace(value);
      const text = JSON.stringify(workspace);
      if (Buffer.byteLength(text) > STORE_LIMITS.workspaceBytes) {
        throw new StoreLimitError("资料空间结构过大，无法保存。");
      }
      await writeAtomic(this.workspacePath, text);
      return workspace;
    });
  }

  private validateWorkspace(value: unknown): StoredWorkspace {
    const record = asRecord(value);
    if (!Array.isArray(record.folders) || !Array.isArray(record.memberships)) {
      throw new StoreValidationError("资料空间结构不正确。");
    }
    if (record.folders.length > 5_000) throw new StoreLimitError("文件夹数量超出上限。");
    const folders: StoredFolder[] = record.folders.map((raw) => {
      const folder = asRecord(raw);
      if (!isSafeText(folder.id, 64) || !isSafeText(folder.name, 200)) {
        throw new StoreValidationError("文件夹信息不完整。");
      }
      const parentId = folder.parentId;
      if (parentId !== undefined && !isSafeText(parentId, 64)) {
        throw new StoreValidationError("文件夹层级不正确。");
      }
      const createdAt = folder.createdAt;
      if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
        throw new StoreValidationError("文件夹时间戳不正确。");
      }
      return { id: folder.id, name: folder.name, parentId, createdAt };
    });
    const memberships: StoredMembership[] = record.memberships.map((raw) => {
      const membership = asRecord(raw);
      if (!isSafeText(membership.projectId, 64) || !isSafeText(membership.folderId, 64)) {
        throw new StoreValidationError("资料与文件夹的关联不正确。");
      }
      return { projectId: membership.projectId, folderId: membership.folderId };
    });
    return { version: 1, folders, memberships };
  }

  async stats(): Promise<{ dir: string; projects: number; blobs: number; bytes: number }> {
    const documents = await this.list();
    let blobs = 0;
    let bytes = 0;
    let buckets: string[] = [];
    try {
      buckets = await readdir(this.blobsDir);
    } catch {
      buckets = [];
    }
    for (const bucket of buckets) {
      const files = await readdir(join(this.blobsDir, bucket)).catch(() => [] as string[]);
      for (const file of files) {
        blobs += 1;
        bytes += await stat(join(this.blobsDir, bucket, file))
          .then((info) => info.size)
          .catch(() => 0);
      }
    }
    return { dir: this.root, projects: documents.length, blobs, bytes };
  }
}
