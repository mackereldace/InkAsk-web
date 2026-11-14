import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  Asset,
  HistoryMessage,
  InkDocument,
  Message,
  Note,
  PageText,
  Project,
  PromptTemplate,
  Rect,
  Source,
} from "../types";
import { anchorFragments, anchorPagesLabel, clonePdfAnchor } from "./pdf-anchor";

export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 128 * 1024 * 1024,
  extractedBytes: 512 * 1024 * 1024,
  pdfBytes: 100 * 1024 * 1024,
  assetBytes: 64 * 1024 * 1024,
  assets: 2_000,
});

interface ArchivedAsset extends Omit<Asset, "data"> {
  archivePath: string;
}

interface Manifest {
  format: "inkask";
  formatVersion: 1;
  project: Omit<Project, "document" | "assets"> & {
    document: Omit<InkDocument, "pdf"> & { pdfPath: string };
    assets: ArchivedAsset[];
  };
}

function randomId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "asset";
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function blobFrom(bytesValue: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(bytesValue.byteLength);
  copy.set(bytesValue);
  return new Blob([copy.buffer], { type: mime });
}

function equalRect(a: Rect, b: Rect): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function exportProject(project: Project): Promise<Blob> {
  const pdf = await bytes(project.document.pdf);
  if (!pdf.byteLength || pdf.byteLength > ARCHIVE_LIMITS.pdfBytes) {
    throw new Error("PDF is empty or exceeds the archive size limit.");
  }
  if (project.assets.length > ARCHIVE_LIMITS.assets) {
    throw new Error("Project contains too many assets.");
  }

  const files: Record<string, Uint8Array> = { "document.pdf": pdf };
  const archivedAssets: ArchivedAsset[] = [];
  for (const [index, asset] of project.assets.entries()) {
    const assetBytes = await bytes(asset.data);
    if (assetBytes.byteLength > ARCHIVE_LIMITS.assetBytes) {
      throw new Error(`Asset ${asset.name} exceeds the archive size limit.`);
    }
    const archivePath = `assets/${index}-${safeName(asset.name)}`;
    files[archivePath] = assetBytes;
    const { data: _data, ...metadata } = asset;
    archivedAssets.push({ ...metadata, archivePath });
  }

  const { pdf: _pdf, ...document } = project.document;
  const manifest: Manifest = {
    format: "inkask",
    formatVersion: 1,
    project: {
      ...project,
      document: { ...document, pdfPath: "document.pdf" },
      assets: archivedAssets,
    },
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  const zipped = zipSync(files, { level: 6 });
  const output = new Uint8Array(zipped.byteLength);
  output.set(zipped);
  return new Blob([output.buffer], { type: "application/zip" });
}

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}.`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
}

function assertNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number.`);
}

function assertArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
}

function assertRect(value: unknown, name: string): asserts value is Rect {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (coordinate) =>
        typeof coordinate !== "number" || !Number.isFinite(coordinate),
    )
  ) {
    throw new Error(`${name} must be a four-number rectangle.`);
  }
  if (value[2] <= value[0] || value[3] <= value[1])
    throw new Error(`${name} must have positive dimensions.`);
}

function assertPdfAnchor(value: unknown, pageCount: number): void {
  assertRecord(value, "note.anchor");
  const fragment = (item: unknown, name: string) => {
    assertRecord(item, name);
    if (!Number.isSafeInteger(item.page) || (item.page as number) < 1 || (item.page as number) > pageCount)
      throw new Error(`${name}.page is outside the document page range.`);
    assertArray(item.rects, `${name}.rects`);
    if (!item.rects.length) throw new Error(`${name} must have an anchor rectangle.`);
    item.rects.forEach((rect, index) => assertRect(rect, `${name}.rects[${index}]`));
    assertString(item.quote, `${name}.quote`);
  };
  fragment(value, "note.anchor");
  if (value.fragments === undefined) return;
  assertArray(value.fragments, "note.anchor.fragments");
  if (!value.fragments.length) throw new Error("A multi-page anchor must have fragments.");
  let previous = 0;
  for (const [index, item] of value.fragments.entries()) {
    fragment(item, `note.anchor.fragments[${index}]`);
    const page = (item as Record<string, unknown>).page as number;
    if (page <= previous) throw new Error("Anchor fragments must have unique pages in document order.");
    previous = page;
  }
  const parts = value.fragments as Array<{ page: number; rects: Rect[]; quote: string }>;
  const first = parts[0], rects = value.rects as Rect[];
  if (value.page !== first.page || rects.length !== first.rects.length || !rects.every((rect, index) => equalRect(rect, first.rects[index])))
    throw new Error("Anchor legacy coordinates must match its first fragment.");
  if ((value.quote as string).trim() !== parts.map(part => part.quote).join("\n").trim())
    throw new Error("Anchor quote must contain all fragments in document order.");
}

function rejectPrototypeKeys(value: unknown, path = "manifest"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectPrototypeKeys(item, `${path}[${index}]`),
    );
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error(`Forbidden key in ${path}: ${key}.`);
    }
    rejectPrototypeKeys(child, `${path}.${key}`);
  }
}

function remapText(value: string, ids: Map<string, string>): string {
  return value.replace(
    /(inkask:\/\/asset\/|asset:)([A-Za-z0-9._~-]+)/g,
    (match, prefix: string, assetId: string) => {
      const replacement = ids.get(assetId);
      return replacement ? `${prefix}${replacement}` : match;
    },
  );
}

function remapAssetIds(
  values: string[] | undefined,
  ids: Map<string, string>,
): string[] | undefined {
  if (!values) return undefined;
  return values.map((value) => ids.get(value) ?? value);
}

function remapHistory(
  messages: HistoryMessage[],
  ids: Map<string, string>,
): HistoryMessage[] {
  return messages.map((message) => ({
    ...message,
    content: remapText(message.content, ids),
    ...(message.assetIds
      ? { assetIds: remapAssetIds(message.assetIds, ids) }
      : {}),
  }));
}

function remapSource(source: Source, ids: Map<string, string>): Source {
  return { ...source, text: remapText(source.text, ids) };
}

function remapMessage(
  message: Message,
  ids: Map<string, string>,
  messageIds: Map<string, string>,
  templateIds: Map<string, string>,
): Message {
  return {
    ...message,
    id: messageIds.get(message.id)!,
    content: remapText(message.content, ids),
    assetIds: remapAssetIds(message.assetIds, ids) ?? [],
    ...(message.error ? { error: remapText(message.error, ids) } : {}),
    ...(message.prompt ? { prompt: remapText(message.prompt, ids) } : {}),
    ...(message.template
      ? {
          template: {
            ...message.template,
            id: templateIds.get(message.template.id) ?? message.template.id,
          },
        }
      : {}),
    ...(message.sources
      ? { sources: message.sources.map((source) => remapSource(source, ids)) }
      : {}),
    ...(message.coverage ? { coverage: remapText(message.coverage, ids) } : {}),
    ...(message.history ? { history: remapHistory(message.history, ids) } : {}),
  };
}

function remapProject(project: Project): Project {
  const documentId = randomId("document");
  const assetIds = new Map(
    project.assets.map((asset) => [asset.id, randomId("asset")]),
  );
  const noteIds = new Map(
    project.notes.map((note) => [note.id, randomId("note")]),
  );
  const messageIds = new Map(
    project.notes.flatMap((note) =>
      note.messages.map(
        (message) => [message.id, randomId("message")] as const,
      ),
    ),
  );
  const templateIds = new Map(
    [
      ...project.templates.map((template) => template.id),
      ...project.notes.flatMap((note) =>
        note.messages.flatMap((message) =>
          message.template ? [message.template.id] : [],
        ),
      ),
    ].map((templateId) => [templateId, randomId("template")] as const),
  );
  const allIds = new Map<string, string>([
    [project.document.id, documentId],
    ...assetIds,
    ...noteIds,
    ...messageIds,
    ...templateIds,
  ]);

  return {
    ...project,
    document: {
      ...project.document,
      id: documentId,
      name: remapText(project.document.name, allIds),
      fingerprint: remapText(project.document.fingerprint, allIds),
    },
    pages: project.pages.map((page) => ({
      ...page,
      text: remapText(page.text, allIds),
      words: page.words.map((word) => ({
        ...word,
        text: remapText(word.text, allIds),
        rect: [...word.rect],
      })),
    })),
    assets: project.assets.map((asset) => ({
      ...asset,
      id: assetIds.get(asset.id)!,
      name: remapText(asset.name, allIds),
      ...(asset.source
        ? {
            source: {
              ...asset.source,
              ...(asset.source.rect ? { rect: [...asset.source.rect] } : {}),
            },
          }
        : {}),
    })),
    notes: project.notes.map((note) => ({
      ...note,
      id: noteIds.get(note.id)!,
      title: remapText(note.title, allIds),
      anchor: clonePdfAnchor(note.anchor, quote => remapText(quote, allIds)),
      ...(note.parentId
        ? { parentId: noteIds.get(note.parentId) ?? note.parentId }
        : {}),
      ...(note.parentMessageId
        ? {
            parentMessageId:
              messageIds.get(note.parentMessageId) ?? note.parentMessageId,
          }
        : {}),
      ...(note.branchQuote
        ? { branchQuote: remapText(note.branchQuote, allIds) }
        : {}),
      ...(note.answerAnchor ? { answerAnchor: { ...note.answerAnchor,
        end: note.answerAnchor.start + remapText(note.answerAnchor.quote, allIds).length,
        quote: remapText(note.answerAnchor.quote, allIds) } } : {}),
      ...(note.sourceAssetId ? { sourceAssetId: assetIds.get(note.sourceAssetId) ?? note.sourceAssetId } : {}),
      ...(note.sourceAssetIds ? { sourceAssetIds: remapAssetIds(note.sourceAssetIds, allIds) } : {}),
      inheritedHistory: remapHistory(note.inheritedHistory, allIds),
      templateId: templateIds.get(note.templateId) ?? note.templateId,
      draft: remapText(note.draft, allIds),
      draftAssetIds: remapAssetIds(note.draftAssetIds, allIds) ?? [],
      messages: note.messages.map((message) =>
        remapMessage(message, allIds, messageIds, templateIds),
      ),
    })),
    templates: project.templates.map((template) => ({
      ...template,
      id: templateIds.get(template.id)!,
      name: remapText(template.name, allIds),
      body: remapText(template.body, allIds),
    })),
  };
}

function validateTextReferences(value: string, assetIds: Set<string>): void {
  for (const match of value.matchAll(
    /(?:inkask:\/\/asset\/|asset:)([A-Za-z0-9._~-]+)/g,
  )) {
    if (!assetIds.has(match[1]))
      throw new Error(`Content references missing asset ${match[1]}.`);
  }
}

function validateReferences(project: Project): void {
  const pages = new Set<number>();
  for (const page of project.pages) {
    if (
      !Number.isInteger(page.page) ||
      page.page < 1 ||
      page.page > project.document.pageCount
    ) {
      throw new Error("A page is outside the document page range.");
    }
    if (pages.has(page.page))
      throw new Error("Document contains duplicate pages.");
    pages.add(page.page);
  }

  const notes = new Map<string, Note>();
  const messages = new Set<string>();
  for (const note of project.notes) {
    if (notes.has(note.id))
      throw new Error("Document contains duplicate note IDs.");
    notes.set(note.id, note);
    if (note.anchor.page < 1 || note.anchor.page > project.document.pageCount) {
      throw new Error("A note anchor is outside the document page range.");
    }
    for (const message of note.messages) {
      if (messages.has(message.id))
        throw new Error("Document contains duplicate message IDs.");
      messages.add(message.id);
    }
  }

  for (const note of project.notes) {
    if (note.answerAnchor && (!note.parentId || !notes.get(note.parentId)?.messages.some((message) => message.id === note.parentMessageId && message.role === "assistant"))) {
      throw new Error("An answer anchor requires an assistant parent message.");
    }
    if (note.parentId) {
      if (!note.parentMessageId)
        throw new Error("A branch note requires a parent message.");
      const parent = notes.get(note.parentId);
      if (!parent)
        throw new Error("A branch note references a missing parent.");
      if (
        note.parentMessageId &&
        !parent.messages.some((message) => message.id === note.parentMessageId)
      ) {
        throw new Error("A branch note references a missing parent message.");
      }
    }

    const chain = new Set<string>();
    let cursor: Note | undefined = note;
    while (cursor.parentId) {
      if (chain.has(cursor.id))
        throw new Error("The note tree contains a cycle.");
      chain.add(cursor.id);
      cursor = notes.get(cursor.parentId);
      if (!cursor)
        throw new Error("A branch note references a missing parent.");
    }
    if (chain.has(cursor.id))
      throw new Error("The note tree contains a cycle.");
  }

  const assetIds = new Set(project.assets.map((asset) => asset.id));
  if (assetIds.size !== project.assets.length)
    throw new Error("Project contains duplicate asset IDs.");
  const templateIds = new Set(project.templates.map((template) => template.id));
  if (templateIds.size !== project.templates.length)
    throw new Error("Project contains duplicate template IDs.");

  for (const note of project.notes) {
    if (!templateIds.has(note.templateId))
      throw new Error("A note references a missing template.");
    if (note.sourceAssetId && !assetIds.has(note.sourceAssetId)) throw new Error("A note source image is missing.");
    for (const id of note.sourceAssetIds ?? []) {
      if (!assetIds.has(id)) throw new Error("A note source image is missing.");
    }
    validateTextReferences(note.draft, assetIds);
    if (note.branchQuote) validateTextReferences(note.branchQuote, assetIds);
    if (note.answerAnchor) validateTextReferences(note.answerAnchor.quote, assetIds);
    for (const assetId of note.draftAssetIds) {
      if (!assetIds.has(assetId))
        throw new Error("A note draft references a missing asset.");
    }
    for (const message of note.messages) {
      validateTextReferences(message.content, assetIds);
      if (message.error) validateTextReferences(message.error, assetIds);
      if (message.prompt) validateTextReferences(message.prompt, assetIds);
      message.sources?.forEach((source) =>
        validateTextReferences(source.text, assetIds),
      );
      message.history?.forEach((history) =>
        validateTextReferences(history.content, assetIds),
      );
      for (const assetId of message.assetIds) {
        if (!assetIds.has(assetId))
          throw new Error("A message references a missing asset.");
      }
    }
    for (const message of note.inheritedHistory) {
      validateTextReferences(message.content, assetIds);
      for (const assetId of message.assetIds ?? []) {
        if (!assetIds.has(assetId))
          throw new Error("Branch history references a missing asset.");
      }
    }
  }
}

function validateManifest(value: unknown): asserts value is Manifest {
  assertRecord(value, "manifest");
  if (value.format !== "inkask" || value.formatVersion !== 1)
    throw new Error("Unsupported InkAsk archive.");
  assertRecord(value.project, "project");
  const project = value.project;
  if (project.version !== 1) throw new Error("Unsupported project version.");
  assertRecord(project.document, "document");
  assertString(project.document.id, "document.id");
  assertString(project.document.name, "document.name");
  assertString(project.document.fingerprint, "document.fingerprint");
  assertNumber(project.document.pageCount, "document.pageCount");
  assertString(project.document.pdfPath, "document.pdfPath");
  if (
    !Number.isInteger(project.document.pageCount) ||
    project.document.pageCount < 1
  ) {
    throw new Error("document.pageCount must be a positive integer.");
  }
  for (const key of ["pages", "notes", "assets", "templates"] as const) {
    if (!Array.isArray(project[key]))
      throw new Error(`project.${key} must be an array.`);
  }
  assertRecord(project.view, "project.view");

  for (const [index, item] of (project.pages as unknown[]).entries()) {
    assertRecord(item, `project.pages[${index}]`);
    assertNumber(item.page, `project.pages[${index}].page`);
    assertString(item.text, `project.pages[${index}].text`);
    assertArray(item.words, `project.pages[${index}].words`);
    if (!["native", "ocr"].includes(String(item.source)))
      throw new Error("Invalid page source.");
    if (!["pending", "ready", "empty", "error"].includes(String(item.status)))
      throw new Error("Invalid page status.");
    assertNumber(item.width, `project.pages[${index}].width`);
    assertNumber(item.height, `project.pages[${index}].height`);
    for (const [wordIndex, word] of item.words.entries()) {
      assertRecord(word, `project.pages[${index}].words[${wordIndex}]`);
      assertString(word.text, "word.text");
      assertRect(word.rect, "word.rect");
    }
  }

  for (const [index, item] of (project.notes as unknown[]).entries()) {
    assertRecord(item, `project.notes[${index}]`);
    assertString(item.id, `project.notes[${index}].id`);
    assertString(item.title, `project.notes[${index}].title`);
    assertPdfAnchor(item.anchor, project.document.pageCount as number);
    if (item.sourceAssetId !== undefined) assertString(item.sourceAssetId, "note.sourceAssetId");
    if (item.sourceAssetIds !== undefined) {
      assertArray(item.sourceAssetIds, "note.sourceAssetIds");
      if (!item.sourceAssetIds.length) throw new Error("note.sourceAssetIds must not be empty.");
      item.sourceAssetIds.forEach(id => assertString(id, "note.sourceAssetIds entry"));
      if (new Set(item.sourceAssetIds).size !== item.sourceAssetIds.length) throw new Error("note.sourceAssetIds contains duplicate images.");
      if (item.sourceAssetId !== undefined && item.sourceAssetId !== item.sourceAssetIds[0]) throw new Error("note.sourceAssetId must be the first source image.");
    }
    if (item.answerAnchor !== undefined) {
      assertRecord(item.answerAnchor, "note.answerAnchor");
      const { start, end, quote } = item.answerAnchor;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
        throw new Error("Invalid answer anchor offsets.");
      }
      assertString(quote, "note.answerAnchor.quote");
      if (!quote.trim() || (end as number) - (start as number) !== quote.length) throw new Error("Invalid answer anchor quote.");
    }
    assertArray(item.inheritedHistory, "note.inheritedHistory");
    requiredBoolean(item.collapsed, "note.collapsed");
    assertString(item.task, "note.task");
    if (
      !["explain", "formula", "summarize", "translate", "custom"].includes(
        item.task,
      )
    )
      throw new Error("Invalid note task.");
    assertString(item.templateId, "note.templateId");
    assertString(item.draft, "note.draft");
    assertArray(item.draftAssetIds, "note.draftAssetIds");
    assertArray(item.messages, "note.messages");
    assertNumber(item.createdAt, "note.createdAt");
    for (const history of item.inheritedHistory as unknown[]) {
      assertRecord(history, "history message");
      if (!["user", "assistant"].includes(String(history.role)))
        throw new Error("Invalid history role.");
      assertString(history.content, "history.content");
      if (history.assetIds !== undefined)
        assertArray(history.assetIds, "history.assetIds");
    }
    for (const [messageIndex, itemMessage] of item.messages.entries()) {
      assertRecord(
        itemMessage,
        `project.notes[${index}].messages[${messageIndex}]`,
      );
      assertString(itemMessage.id, "message.id");
      if (!["user", "assistant"].includes(String(itemMessage.role)))
        throw new Error("Invalid message role.");
      assertString(itemMessage.content, "message.content");
      assertArray(itemMessage.assetIds, "message.assetIds");
      if (
        !["complete", "streaming", "stopped", "error"].includes(
          String(itemMessage.status),
        )
      ) {
        throw new Error("Invalid message status.");
      }
      assertNumber(itemMessage.createdAt, "message.createdAt");
      itemMessage.assetIds.forEach((id) =>
        assertString(id, "message asset ID"),
      );
      if (itemMessage.prompt !== undefined)
        assertString(itemMessage.prompt, "message.prompt");
      if (itemMessage.error !== undefined)
        assertString(itemMessage.error, "message.error");
      if (itemMessage.sources !== undefined) {
        assertArray(itemMessage.sources, "message.sources");
        for (const source of itemMessage.sources) {
          assertRecord(source, "source");
          assertString(source.id, "source.id");
          assertString(source.text, "source.text");
          assertNumber(source.page, "source.page");
          if (source.blockId !== undefined) assertString(source.blockId, "source.blockId");
          if (source.label !== undefined) assertString(source.label, "source.label");
          if (source.textRange !== undefined) {
            assertArray(source.textRange, "source.textRange");
            if (source.textRange.length !== 2 || !source.textRange.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0) || (source.textRange[1] as number) <= (source.textRange[0] as number))
              throw new Error("Invalid evidence text range.");
          }
          if (source.rects !== undefined) {
            assertArray(source.rects, "source.rects");
            source.rects.forEach((rect) => assertRect(rect, "source.rect"));
          }
          if (
            !Number.isInteger(source.page) ||
            source.page < 1 ||
            source.page > project.document.pageCount
          )
            throw new Error("Invalid source page.");
        }
      }
      if (itemMessage.history !== undefined) {
        assertArray(itemMessage.history, "message.history");
        for (const history of itemMessage.history)
          validateHistoryMessage(history);
      }
      if (itemMessage.template !== undefined) {
        assertRecord(itemMessage.template, "message.template");
        assertString(itemMessage.template.id, "template.id");
        assertString(itemMessage.template.name, "template.name");
        assertString(itemMessage.template.body, "template.body");
        assertNumber(itemMessage.template.version, "template.version");
      }
    }
  }

  const assetIds = new Set<string>();
  for (const [index, item] of (project.assets as unknown[]).entries()) {
    assertRecord(item, `project.assets[${index}]`);
    assertString(item.id, "asset.id");
    if (assetIds.has(item.id))
      throw new Error("Project contains duplicate asset IDs.");
    assetIds.add(item.id);
    assertString(item.name, "asset.name");
    assertString(item.mime, "asset.mime");
    if (!item.mime.startsWith("image/"))
      throw new Error("Archive assets must be images.");
    assertString(item.archivePath, "asset.archivePath");
    if (item.source !== undefined) {
      assertRecord(item.source, "asset.source");
      assertNumber(item.source.page, "asset.source.page");
      if (item.source.rect !== undefined)
        assertRect(item.source.rect, "asset.source.rect");
    }
  }

  for (const [index, item] of (project.templates as unknown[]).entries()) {
    assertRecord(item, `project.templates[${index}]`);
    assertString(item.id, "template.id");
    assertString(item.name, "template.name");
    if (
      !["explain", "formula", "summarize", "translate", "custom"].includes(
        String(item.task),
      )
    ) {
      throw new Error("Invalid template task.");
    }
    assertString(item.body, "template.body");
    assertNumber(item.version, "template.version");
  }

  assertNumber(project.view.page, "view.page");
  assertNumber(project.view.scale, "view.scale");
  if (project.view.direction !== undefined && project.view.direction !== "vertical" && project.view.direction !== "horizontal") throw new Error("Invalid reading direction.");
  assertNumber(project.view.rotation, "view.rotation");
  if (!(project.templates as unknown[]).length)
    throw new Error("At least one prompt template is required.");
  if (
    !Number.isInteger(project.view.page) ||
    project.view.page < 1 ||
    project.view.page > project.document.pageCount ||
    project.view.scale < 0.25 ||
    project.view.scale > 3 ||
    ![0, 90, 180, 270].includes(project.view.rotation)
  )
    throw new Error("Invalid document view.");
}

function validateHistoryMessage(history: unknown) {
  assertRecord(history, "history message");
  if (!["user", "assistant"].includes(String(history.role)))
    throw new Error("Invalid history role.");
  assertString(history.content, "history.content");
  if (history.assetIds !== undefined) {
    assertArray(history.assetIds, "history.assetIds");
    history.assetIds.forEach((id) => assertString(id, "history asset ID"));
  }
}

function requiredBoolean(
  value: unknown,
  name: string,
): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
}

export async function importProject(file: Blob): Promise<Project> {
  if (file.size <= 0 || file.size > ARCHIVE_LIMITS.archiveBytes) {
    throw new Error("Archive is empty or exceeds the size limit.");
  }
  const archive = new Uint8Array(await file.arrayBuffer());
  let extractedBytes = 0;
  const entryNames = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, {
      filter: (entry) => {
        if (entry.name.startsWith("/") || entry.name.includes(".."))
          throw new Error("Unsafe archive path.");
        if (entryNames.has(entry.name))
          throw new Error("Archive contains duplicate entries.");
        entryNames.add(entry.name);
        extractedBytes += entry.originalSize;
        if (extractedBytes > ARCHIVE_LIMITS.extractedBytes)
          throw new Error("Archive expands beyond the size limit.");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Archive"))
      throw error;
    if (error instanceof Error && error.message === "Unsafe archive path.")
      throw error;
    throw new Error("Archive is not a valid InkAsk ZIP file.");
  }

  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("Archive manifest is missing.");
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error("Archive manifest is not valid JSON.");
  }
  rejectPrototypeKeys(raw);
  validateManifest(raw);
  const manifest = raw;
  const pdfBytes = files[manifest.project.document.pdfPath];
  if (!pdfBytes?.byteLength || pdfBytes.byteLength > ARCHIVE_LIMITS.pdfBytes) {
    throw new Error("Archive PDF is missing or exceeds the size limit.");
  }
  if (strFromU8(pdfBytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("Archive document is not a PDF.");
  }
  if (manifest.project.assets.length > ARCHIVE_LIMITS.assets) {
    throw new Error("Archive contains too many assets.");
  }

  const assets: Asset[] = manifest.project.assets.map((asset) => {
    const data = files[asset.archivePath];
    if (!data) throw new Error(`Asset ${asset.name} is missing.`);
    if (data.byteLength > ARCHIVE_LIMITS.assetBytes)
      throw new Error(`Asset ${asset.name} exceeds the size limit.`);
    const { archivePath: _archivePath, ...metadata } = asset;
    return { ...metadata, data: blobFrom(data, asset.mime) };
  });
  const { pdfPath, ...document } = manifest.project.document;
  const project: Project = {
    ...manifest.project,
    document: { ...document, pdf: blobFrom(pdfBytes, "application/pdf") },
    assets,
  } as Project;
  validateReferences(project);
  const imported = remapProject(project);
  for (const note of imported.notes) {
    for (const message of note.messages) {
      if (message.status === "streaming") message.status = "stopped";
    }
  }
  return imported;
}

function exportMessage(message: Message, depth: number): string {
  const indent = "  ".repeat(depth);
  const sourceLinks = message.sources?.length
    ? `\n${indent}- 来源：${message.sources.map((source) => `[${source.id}]（第 ${source.page} 页）`).join("、")}`
    : "";
  return `${indent}- ${message.role === "user" ? "用户" : "AI"}：${message.content.replace(/\n/g, `\n${indent}  `)}${sourceLinks}`;
}

export function exportMarkdown(project: Project): string {
  const notesByParent = new Map<string | undefined, Note[]>();
  for (const note of project.notes) {
    const siblings = notesByParent.get(note.parentId) ?? [];
    siblings.push(note);
    notesByParent.set(note.parentId, siblings);
  }
  for (const siblings of notesByParent.values())
    siblings.sort((a, b) => a.createdAt - b.createdAt);

  const lines = [
    `# ${project.document.name}`,
    "",
    `> InkAsk 项目导出 · ${project.document.pageCount} 页`,
    "",
  ];
  const walk = (parentId: string | undefined, depth: number): void => {
    for (const note of notesByParent.get(parentId) ?? []) {
      const heading = "#".repeat(Math.min(depth + 2, 6));
      lines.push(`${heading} ${note.title}`, "");
      lines.push(`- 定位：${anchorPagesLabel(note.anchor)}`);
      if (note.anchor.fragments) {
        for (const fragment of anchorFragments(note.anchor))
          if (fragment.quote) lines.push(`- 原文（第 ${fragment.page} 页）：${fragment.quote}`);
      } else if (note.anchor.quote) lines.push(`- 原文：${note.anchor.quote}`);
      if (note.branchQuote) lines.push(`- 分支引用：${note.branchQuote}`);
      lines.push("");
      for (const message of note.messages)
        lines.push(exportMessage(message, 0));
      lines.push("");
      walk(note.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return `${lines.join("\n").trim()}\n`;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const view = new Uint8Array(buffer);
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
