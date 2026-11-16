import { strToU8, zipSync } from "fflate";
import type { Asset, Message, Note, Project } from "../types";
import { anchorFragments, anchorPagesLabel } from "./pdf-anchor";

/**
 * Turn a project into a directory of Markdown files: one file per note, plus a
 * README tree, the untouched PDF and the referenced images. The result is meant
 * to be committed to Git and grepped, so every value that matters for identity
 * (note id, page, task, parent note, message role) is written verbatim instead
 * of being folded into prose.
 *
 * This is a read-only rendering of saved answers. It does not re-run retrieval,
 * rewrite stored Markdown, or invent citations the answer did not carry.
 */
export const NOTE_EXPORT_LIMITS = Object.freeze({
  notes: 20_000,
  assets: 2_000,
  sourceChars: 2_000,
  nameChars: 48,
});

export interface NoteExportOptions {
  /** Copy the original PDF next to the notes (default: true). */
  includePdf?: boolean;
  /** Copy region crops and question images under `assets/` (default: true). */
  includeAssets?: boolean;
  /** Characters kept from each citation source before it is clipped. */
  sourceChars?: number;
  /** Export timestamp for the README line; injectable so tests stay deterministic. */
  now?: number;
}

export interface NoteExportFile {
  path: string;
  text: string;
}

export interface NoteExportAsset {
  path: string;
  asset: Asset;
}

export interface NoteExportPlan {
  /** Directory name that wraps the exported tree. */
  root: string;
  files: NoteExportFile[];
  assets: NoteExportAsset[];
  includePdf: boolean;
  stats: { notes: number; messages: number; images: number };
}

interface Entry {
  note: Note;
  depth: number;
  path: string;
}

const ILLEGAL_NAME = /[\u0000-\u001f<>:"/\\|?*\u007f]/g;
const NAME_EDGES = /^[-.\s]+|[-.\s]+$/g;

/**
 * File names stay readable for CJK titles while remaining safe on macOS,
 * Windows (no trailing dots), and in Git. Characters that split paths or upset
 * shells are folded to `-`; nothing is transliterated, because the title is
 * already stored inside the file.
 */
function slug(value: string, fallback: string, limit = NOTE_EXPORT_LIMITS.nameChars): string {
  const folded = value
    .normalize("NFC")
    .replace(ILLEGAL_NAME, "-")
    .replace(/[\s\u3000]+/g, "-")
    .replace(/-+/g, "-");
  const trimmed = folded.replace(NAME_EDGES, "");
  const cut = Array.from(trimmed).slice(0, limit).join("").replace(NAME_EDGES, "");
  return cut || fallback;
}

/** JSON string escapes are a valid subset of YAML double-quoted scalars. */
function yaml(value: string): string {
  return JSON.stringify(value);
}

function iso(ms: number): string {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "1970-01-01T00:00:00.000Z";
}

function pagesOf(note: Note): number[] {
  return [...new Set(anchorFragments(note.anchor).map((fragment) => fragment.page))].sort(
    (a, b) => a - b,
  );
}

/** Depth-first order so file numbers follow the reading order of the note tree. */
function orderNotes(notes: Note[]): { note: Note; depth: number }[] {
  const known = new Set(notes.map((note) => note.id));
  const byParent = new Map<string | undefined, Note[]>();
  for (const note of notes) {
    // A note whose parent is gone stays visible as a root instead of vanishing.
    const parent = note.parentId && known.has(note.parentId) ? note.parentId : undefined;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(note);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  const ordered: { note: Note; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number): void => {
    for (const note of byParent.get(parent) ?? []) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      ordered.push({ note, depth });
      walk(note.id, depth + 1);
    }
  };
  walk(undefined, 0);
  // Notes caught in a parent cycle are appended rather than dropped.
  for (const note of notes) {
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    ordered.push({ note, depth: 0 });
  }
  return ordered;
}

function assetExtension(asset: Asset): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(asset.name)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const fromMime = /^image\/([a-z0-9.+-]+)$/i.exec(asset.mime)?.[1];
  return fromMime === "jpeg" ? "jpg" : (fromMime ?? "bin");
}

interface AssetIndex {
  /** asset id → path relative to the export root. */
  pathById: Map<string, string>;
  assets: NoteExportAsset[];
  /** True when the caller asked to skip images: missing references say so plainly. */
  disabled: boolean;
}

function indexAssets(project: Project, notes: Note[], enabled: boolean): AssetIndex {
  const pathById = new Map<string, string>();
  if (!enabled) return { pathById, assets: [], disabled: true };

  const referenced: string[] = [];
  const push = (id: string | undefined): void => {
    if (id && !referenced.includes(id)) referenced.push(id);
  };
  for (const note of notes) {
    push(note.sourceAssetId);
    for (const id of note.sourceAssetIds ?? []) push(id);
    for (const id of note.draftAssetIds ?? []) push(id);
    for (const message of note.messages) for (const id of message.assetIds ?? []) push(id);
  }

  const assets: NoteExportAsset[] = [];
  for (const id of referenced) {
    const asset = project.assets.find((candidate) => candidate.id === id);
    if (!asset) continue; // Missing bytes are reported inline, not fatal.
    // The sequence prefix keeps names unique even when two images share a title.
    const seq = String(assets.length + 1).padStart(3, "0");
    const base = slug(asset.name.replace(/\.[^.]+$/, ""), "image");
    const name = `${seq}-${base}.${assetExtension(asset)}`;
    if (assets.length >= NOTE_EXPORT_LIMITS.assets) {
      throw new Error(`引用的图片过多（超过 ${NOTE_EXPORT_LIMITS.assets} 张），请先精简后再导出。`);
    }
    pathById.set(id, `assets/${name}`);
    assets.push({ path: `assets/${name}`, asset });
  }
  return { pathById, assets, disabled: false };
}

function clip(text: string, limit: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized.split("\n");
  return [
    ...chars.slice(0, limit).join("").split("\n"),
    `…（已截断，共 ${chars.length} 字；完整原文见 PDF 对应页）`,
  ];
}

function imageLines(index: AssetIndex, ids: string[]): string[] {
  const lines: string[] = [];
  for (const id of ids) {
    const path = index.pathById.get(id);
    lines.push(
      path ? `![图片](../${path})` : index.disabled ? `（图片未导出：${id}）` : `（图片缺失：${id}）`,
    );
    lines.push("");
  }
  return lines;
}

function renderSources(message: Message, limit: number): string[] {
  const sources = message.sources ?? [];
  if (!sources.length) return [];
  const lines = ["### 本次参考来源", ""];
  for (const source of sources) {
    const parts = [source.id, `第 ${source.page} 页`, source.label].filter(Boolean);
    const range = source.textRange ? `（选区 ${source.textRange[0]}–${source.textRange[1]}）` : "";
    lines.push(`- **${parts.join(" · ")}**${range}`);
    for (const line of clip(source.text ?? "", limit)) lines.push(`  > ${line}`);
    lines.push("");
  }
  return lines;
}

function renderMessages(
  note: Note,
  index: AssetIndex,
  limit: number,
  noteTemplate: string | undefined,
): string[] {
  const lines: string[] = [];
  let round = 0;
  for (const message of note.messages) {
    const isUser = message.role === "user";
    if (isUser) round += 1;
    const suffix = round > 1 ? ` ${round}` : "";
    lines.push(`## ${isUser ? "提问" : "回答"}${suffix}`, "");
    // The note-level template already appears in the front matter and the task
    // line; repeat it per message only when a message used something else.
    if (message.template?.name && message.template.name !== noteTemplate) {
      lines.push(`> 模板：${message.template.name}`, "");
    }
    const content = message.content.trim();
    lines.push(content || (isUser ? "（空提示词）" : "（空回答）"), "");
    if (!isUser) {
      if (message.status === "stopped") lines.push("> ⏹ 生成被中止，以上为已收到的部分。", "");
      if (message.status === "error") {
        lines.push(`> ⚠️ 生成失败：${message.error ?? "未知错误"}`, "");
      }
      for (const line of imageLines(index, message.assetIds ?? [])) lines.push(line);
      lines.push(...renderSources(message, limit));
    } else {
      for (const line of imageLines(index, message.assetIds ?? [])) lines.push(line);
    }
  }
  if (!note.messages.length) lines.push("（这条便签还没有提问）", "");
  return lines;
}

function renderNote(
  entry: Entry,
  project: Project,
  index: AssetIndex,
  pathById: Map<string, string>,
  children: Entry[],
  limit: number,
): string {
  const { note } = entry;
  const pages = pagesOf(note);
  const template = project.templates.find((candidate) => candidate.id === note.templateId);
  const lines: string[] = ["---"];

  lines.push(`id: ${yaml(note.id)}`);
  lines.push(`title: ${yaml(note.title || "未命名便签")}`);
  lines.push(`page: ${pages[0] ?? note.anchor.page}`);
  if (pages.length > 1) lines.push(`pages: [${pages.join(", ")}]`);
  lines.push(`task: ${note.task}`);
  if (template?.name) lines.push(`template: ${yaml(template.name)}`);
  lines.push(`created: ${iso(note.createdAt)}`);
  lines.push(`depth: ${entry.depth}`);
  if (note.parentId) lines.push(`parent_id: ${yaml(note.parentId)}`);
  if (note.parentId) {
    const parentPath = pathById.get(note.parentId);
    if (parentPath) lines.push(`parent: ${yaml(parentPath.replace(/^notes\//, ""))}`);
  }
  if (note.parentMessageId) lines.push(`parent_message: ${yaml(note.parentMessageId)}`);
  lines.push(`messages: ${note.messages.length}`);
  lines.push(`children: ${children.length}`);
  lines.push("---", "");

  lines.push(`# ${note.title || "未命名便签"}`, "");
  for (const fragment of anchorFragments(note.anchor)) {
    if (!fragment.quote) continue;
    for (const line of fragment.quote.replace(/\r\n/g, "\n").trim().split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push(`> — 第 ${fragment.page} 页`, "");
  }
  lines.push(`- 定位：${anchorPagesLabel(note.anchor)}`);
  const taskText = template?.name
    ? `${taskLabel(note.task)} · 模板：${template.name}`
    : taskLabel(note.task);
  lines.push(`- 任务：${taskText}`);
  if (note.branchQuote) lines.push(`- 分支引用：${note.branchQuote.replace(/\r?\n/g, " ")}`);
  lines.push(`- 便签 ID：\`${note.id}\``);
  lines.push("");

  const crops = [note.sourceAssetId, ...(note.sourceAssetIds ?? [])].filter(
    (id): id is string => Boolean(id),
  );
  if (crops.length) {
    lines.push("## 选区截图", "");
    lines.push(...imageLines(index, [...new Set(crops)]));
  }

  lines.push(...renderMessages(note, index, limit, template?.name));

  if (note.draft.trim()) {
    lines.push("## 草稿（未提交）", "", note.draft.trim(), "");
    const draftImages = imageLines(index, note.draftAssetIds ?? []);
    if (draftImages.length) lines.push(...draftImages);
  }

  if (children.length) {
    lines.push("## 子便签", "");
    for (const child of children) {
      const pagesLabel = pagesOf(child.note)[0];
      lines.push(
        `- [${child.note.title || "未命名便签"}](${child.path.replace(/^notes\//, "")})· 第 ${pagesLabel} 页`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function taskLabel(task: Note["task"]): string {
  switch (task) {
    case "explain":
      return "解释";
    case "formula":
      return "公式";
    case "summarize":
      return "总结";
    case "translate":
      return "翻译";
    default:
      return "自定义";
  }
}

function renderReadme(
  project: Project,
  entries: Entry[],
  childrenOf: Map<string, Entry[]>,
  stats: NoteExportPlan["stats"],
  plan: NoteExportOptions,
  limit: number,
  now: number,
): string {
  const lines: string[] = [
    `# ${project.document.name}`,
    "",
    `> InkAsk 笔记目录 · 共 ${project.document.pageCount} 页 · ${stats.notes} 条便签 · ${stats.messages} 条消息 · ${stats.images} 张图片`,
    `> 导出于 ${iso(now)}；原 PDF 未修改。`,
    "",
    "## 目录结构",
    "",
    "- `notes/` —— 一条便签一个 Markdown 文件，文件名前面的编号就是阅读顺序",
    "- `assets/` —— 选区截图与提问附图",
    plan.includePdf === false ? null : "- `document.pdf` —— 原始 PDF（可直接加入 `.gitignore`）",
    "",
    "## 便签树",
    "",
  ].filter((line): line is string => line !== null);

  const roots = entries.filter((entry) => entry.depth === 0);
  const printed = new Set<string>();
  const walk = (entry: Entry): void => {
    if (printed.has(entry.note.id)) return; // parent cycles must not recurse forever
    printed.add(entry.note.id);
    const pages = pagesOf(entry.note);
    const indent = "  ".repeat(entry.depth);
    lines.push(
      `${indent}- [第 ${pages[0]} 页 · ${entry.note.title || "未命名便签"}](${entry.path})`,
    );
    for (const child of childrenOf.get(entry.note.id) ?? []) walk(child);
  };
  if (roots.length) for (const root of roots) walk(root);
  else lines.push("（这个项目还没有便签）");
  lines.push("");

  lines.push(
    "## 约定",
    "",
    "- front matter 里的 `id` / `page` / `task` / `parent_id` 是稳定标识，可直接被脚本读取",
    "- `## 提问` 是实际发给模型的提示词，`## 回答` 是模型返回的原始 Markdown（含公式源码）",
    `- 引用来源里的原文按 ${limit} 字截断，完整原文见 PDF 对应页`,
    "- 祖先问答不重复写入（保存在便签的 `inheritedHistory` 里），便于逐分支对比",
    "- 这个目录不包含便签坐标与词框；要完整还原请用「导出 → 完整项目 (.inkask)」",
    "",
  );
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/**
 * Pure planning step: no Blob bytes are read here, so tests and callers can
 * inspect the whole tree cheaply. Binary content is added by
 * `buildNoteExportZip`.
 */
export function planNoteExport(project: Project, options: NoteExportOptions = {}): NoteExportPlan {
  if (project.notes.length > NOTE_EXPORT_LIMITS.notes) {
    throw new Error(`项目便签过多（${project.notes.length} 条），请先拆分项目再导出。`);
  }
  const limit = Math.max(200, Math.min(options.sourceChars ?? NOTE_EXPORT_LIMITS.sourceChars, 20_000));
  const includePdf = options.includePdf ?? true;
  const includeAssets = options.includeAssets ?? true;

  const ordered = orderNotes(project.notes);
  const index = indexAssets(project, project.notes, includeAssets);

  // The zero-padded sequence guarantees unique file names, including for
  // notes that share a title, so no collision suffix is needed.
  const entries: Entry[] = ordered.map(({ note, depth }, position) => {
    const seq = String(position + 1).padStart(4, "0");
    const base = slug(note.title || `note-${seq}`, "note");
    return { note, depth, path: `notes/${seq}-${base}.md` };
  });

  const childrenOf = new Map<string, Entry[]>();
  for (const entry of entries) {
    const parentId = entry.note.parentId;
    if (!parentId) continue;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(entry);
    childrenOf.set(parentId, siblings);
  }

  const pathById = new Map(entries.map((entry) => [entry.note.id, entry.path] as const));
  const now = options.now ?? Date.now();
  const files: NoteExportFile[] = entries.map((entry) => ({
    path: entry.path,
    text: renderNote(entry, project, index, pathById, childrenOf.get(entry.note.id) ?? [], limit),
  }));

  const stats = {
    notes: entries.length,
    messages: entries.reduce((sum, entry) => sum + entry.note.messages.length, 0),
    images: index.assets.length,
  };
  files.unshift({
    path: "README.md",
    text: renderReadme(project, entries, childrenOf, stats, { includePdf }, limit, now),
  });

  return {
    root: slug(project.document.name.replace(/\.pdf$/i, ""), "inkask-notes"),
    files,
    assets: index.assets,
    includePdf,
    stats,
  };
}

/** Zip the planned tree; `root/` keeps the extracted directory named after the PDF. */
export async function buildNoteExportZip(
  project: Project,
  options: NoteExportOptions = {},
): Promise<Blob> {
  const plan = planNoteExport(project, options);
  const files: Record<string, Uint8Array> = {};
  for (const file of plan.files) files[`${plan.root}/${file.path}`] = strToU8(file.text);
  if (plan.includePdf) {
    const pdf = new Uint8Array(await project.document.pdf.arrayBuffer());
    files[`${plan.root}/document.pdf`] = pdf;
  }
  for (const entry of plan.assets) {
    files[`${plan.root}/${entry.path}`] = new Uint8Array(await entry.asset.data.arrayBuffer());
  }
  const zipped = zipSync(files, { level: 6 });
  const output = new Uint8Array(zipped.byteLength);
  output.set(zipped);
  return new Blob([output.buffer], { type: "application/zip" });
}
