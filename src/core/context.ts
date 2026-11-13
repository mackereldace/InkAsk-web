import type {
  ContextResult,
  HistoryMessage,
  Note,
  PageText,
  Project,
  PromptTemplate,
  Source,
} from "../types";
import {
  interpolateTemplate,
  SYSTEM_PROMPT,
  TASK_LABELS,
  type TemplateVariable,
  type TemplateVariables,
} from "./templates";
import { sourceAnchor } from "./source-location";

const DEFAULT_BUDGET = 12_000;
const CHUNK_SIZE = 700;
const MAX_RETRIEVED_SOURCES = 7;
const MAX_HISTORY_MESSAGES = 40;
const MAX_IMAGE_ATTACHMENTS = 20;
const APPROX_CHARS_PER_IMAGE = 2_000;

interface BuildContextInput {
  project: Project;
  note: Note;
  question: string;
  template: PromptTemplate;
  budget?: number;
}

interface ScoredChunk {
  page: number;
  text: string;
  score: number;
  order: number;
}

function words(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  const han = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  const bigrams = han.flatMap((run) =>
    run.length < 2
      ? [run]
      : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)),
  );
  return [...latin, ...bigrams];
}

function chunks(page: PageText): string[] {
  const text = page.text.trim();
  if (!text) return [];

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const output: string[] = [];
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    for (let offset = 0; offset < paragraph.length; offset += CHUNK_SIZE) {
      output.push(paragraph.slice(offset, offset + CHUNK_SIZE));
    }
  }
  return output;
}

function pageCoverage(project: Project): string {
  const total = project.document.pageCount;
  const pages = new Map(project.pages.map((page) => [page.page, page]));
  let ready = 0;
  let pending = 0;
  let nativeEmpty = 0;
  let ocrEmpty = 0;
  let errors = 0;

  for (let pageNo = 1; pageNo <= total; pageNo += 1) {
    const page = pages.get(pageNo);
    if (!page || page.status === "pending") {
      pending += 1;
    } else if (page.status === "error") {
      errors += 1;
    } else if (page.status === "empty" || !page.text.trim()) {
      if (page.source === "native") nativeEmpty += 1;
      else ocrEmpty += 1;
    } else {
      ready += 1;
    }
  }

  const detail = [
    pending ? `尚未识别 ${pending} 页` : "",
    nativeEmpty ? `未提取到文字、可按需 OCR ${nativeEmpty} 页` : "",
    ocrEmpty ? `已识别但无可检索文字 ${ocrEmpty} 页` : "",
    errors ? `识别失败 ${errors} 页` : "",
  ].filter(Boolean);
  return `已可检索 ${ready}/${total} 页${detail.length ? `；${detail.join("；")}` : ""}。`;
}

function nearby(project: Project, note: Note): string {
  const page = project.pages.find(
    (candidate) => candidate.page === note.anchor.page,
  );
  if (!page?.text.trim()) return "";
  const selected = note.anchor.quote.trim();
  const at = selected ? page.text.indexOf(selected) : -1;
  if (at >= 0) {
    const start = Math.max(0, at - CHUNK_SIZE / 2);
    return page.text.slice(start, start + CHUNK_SIZE * 2).trim();
  }
  return page.text.slice(0, CHUNK_SIZE).trim();
}

function rootSource(note: Note): Source {
  return {
    id: "S1", page: note.anchor.page,
    rects: note.anchor.rects.map((rect) => [...rect]),
    text: note.anchor.quote.trim() || "（选中的 PDF 区域，参见提问附图）",
  };
}

function retrieve(
  project: Project,
  note: Note,
  question: string,
): ScoredChunk[] {
  const query = words(`${note.anchor.quote}\n${note.branchQuote ?? ""}\n${question}`);
  const terms = new Set(query);
  if (!terms.size) return [];

  const scored: ScoredChunk[] = [];
  let order = 0;
  for (const page of project.pages) {
    if (page.status !== "ready" || !page.text.trim()) continue;
    for (const text of chunks(page)) {
      const candidate = new Set(words(text));
      let score = 0;
      for (const term of terms) if (candidate.has(term)) score += 1;
      if (page.page === note.anchor.page) score += 1;
      if (score > 1) scored.push({ page: page.page, text, score, order });
      order += 1;
    }
  }

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const seen = new Set<string>();
  return scored.filter((chunk) => {
    const key = `${chunk.page}:${chunk.text}`;
    const selectedChunk = note.anchor.quote.trim();
    if (seen.has(key) || chunk.text === selectedChunk) return false;
    seen.add(key);
    return true;
  });
}

function currentHistory(note: Note): HistoryMessage[] {
  const inherited = note.inheritedHistory.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.assetIds?.length ? { assetIds: [...message.assetIds] } : {}),
  }));
  const current = note.messages
    .filter((message) => message.content.trim())
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.assetIds.length ? { assetIds: [...message.assetIds] } : {}),
    }));
  return [...inherited, ...current];
}

function sourceSection(sources: Source[]): string {
  return sources
    .map((source) => `[${source.id}] 第 ${source.page} 页\n${source.text}`)
    .join("\n\n");
}

function attachmentDescriptions(project: Project, note: Note): string {
  const descriptions = note.draftAssetIds.flatMap((assetId) => {
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) return [];
    const page = asset.source?.page ? `，来源第 ${asset.source.page} 页` : "";
    return [
      `- ${asset.name}（${asset.mime}${page}），引用图片使用 ![${asset.name}](asset:${asset.id})`,
    ];
  });
  return descriptions.length ? descriptions.join("\n") : "（无）";
}

function historyCost(history: HistoryMessage[]): number {
  return history.reduce(
    (total, message) =>
      total + message.content.length + (message.role === "user" ? 8 : 10),
    0,
  );
}

function imageOccurrences(note: Note, history: HistoryMessage[]): number {
  return (
    note.draftAssetIds.length +
    history.reduce(
      (total, message) => total + (message.assetIds?.length ?? 0),
      0,
    )
  );
}

function appendRequiredFields(
  body: string,
  used: ReadonlySet<TemplateVariable>,
  variables: TemplateVariables,
  hasBranchQuote: boolean,
): string {
  const missing: Array<
    "selected_text" | "context_with_source_ids" | "question" | "branch_quote"
  > = ["selected_text", "context_with_source_ids", "question"];
  if (hasBranchQuote) missing.push("branch_quote");
  const labels: Record<(typeof missing)[number], string> = {
    selected_text: "选中的原文",
    context_with_source_ids: "附近内容与相关文档片段",
    branch_quote: "分支所针对的回答",
    question: "用户问题",
  };
  const fallbacks = missing
    .filter((name) => !used.has(name))
    .map((name) => `【${labels[name]}】\n${variables[name]}`);
  return [body.trim(), ...fallbacks].filter(Boolean).join("\n\n");
}

function renderPrompt(
  input: BuildContextInput,
  coverage: string,
  sources: Source[],
): string {
  const { project, note, question, template } = input;
  const variables: TemplateVariables = {
    task: TASK_LABELS[template.task],
    document_title: project.document.name,
    page_number: String(note.anchor.page),
    coverage,
    selected_text: (note.parentId ? note.branchQuote : note.anchor.quote)?.trim() || "（未选择文字）",
    context_with_source_ids: sourceSection(sources),
    branch_quote: note.branchQuote?.trim() || "（无）",
    question: question.trim() || "请按当前任务处理选中内容。",
    attachment_descriptions: attachmentDescriptions(project, note),
  };
  const rendered = interpolateTemplate(template.body, variables);
  const userPrompt = appendRequiredFields(
    rendered.text,
    rendered.used,
    variables,
    Boolean(note.branchQuote?.trim()),
  );
  const readingOrigin = note.parentId
    ? "【当前阅读位置】\n用户正在阅读上一层 AI 回答，当前选文来自该回答，不是 PDF 原文。请结合继承的对话理解这段回答；下方带来源 ID 的文档片段仍来自原始 PDF。\n\n"
    : "";
  return `${SYSTEM_PROMPT}\n\n${readingOrigin}${userPrompt}`;
}

export function buildContext(input: BuildContextInput): ContextResult {
  const budget = Math.max(1, input.budget ?? DEFAULT_BUDGET);
  const coverage = pageCoverage(input.project);
  const near = nearby(input.project, input.note);
  const fixedSource = rootSource(input.note);
  const candidates = [
    ...(near && near !== input.note.anchor.quote.trim() ? [{ page: input.note.anchor.page, text: near, score: Infinity, order: -1 }] : []),
    ...retrieve(input.project, input.note, input.question).filter((chunk) => chunk.page !== input.note.anchor.page || chunk.text !== near),
  ].slice(0, MAX_RETRIEVED_SOURCES);
  const allHistory = currentHistory(input.note);
  const history = allHistory.slice(-MAX_HISTORY_MESSAGES);
  const initialImages = imageOccurrences(input.note, history);
  let truncated =
    allHistory.length > MAX_HISTORY_MESSAGES ||
    initialImages > MAX_IMAGE_ATTACHMENTS;
  let sourceCount = candidates.length;
  let historyStart = 0;

  const makeSources = (count: number): Source[] => [
    fixedSource,
    ...candidates.slice(0, count).map((candidate, index) => ({
      id: `S${index + 2}`,
      page: candidate.page,
      text: candidate.text,
      rects: sourceAnchor({ id: "", page: candidate.page, text: candidate.text }, input.project.pages.find((page) => page.page === candidate.page))?.rects,
    })),
  ];

  const cost = (prompt: string, selectedHistory: HistoryMessage[]): number =>
    prompt.length +
    historyCost(selectedHistory) +
    imageOccurrences(input.note, selectedHistory) * APPROX_CHARS_PER_IMAGE;

  let prompt = renderPrompt(input, coverage, makeSources(sourceCount));
  let selectedHistory = history.slice(historyStart);

  while (cost(prompt, selectedHistory) > budget && sourceCount > 0) {
    sourceCount -= 1;
    truncated = true;
    prompt = renderPrompt(input, coverage, makeSources(sourceCount));
  }
  while (
    cost(prompt, selectedHistory) > budget &&
    historyStart < history.length
  ) {
    historyStart += 1;
    truncated = true;
    selectedHistory = history.slice(historyStart);
  }
  while (
    input.note.draftAssetIds.length < MAX_IMAGE_ATTACHMENTS &&
    imageOccurrences(input.note, selectedHistory) > MAX_IMAGE_ATTACHMENTS &&
    historyStart < history.length
  ) {
    historyStart += 1;
    truncated = true;
    selectedHistory = history.slice(historyStart);
  }
  if (cost(prompt, selectedHistory) > budget) truncated = true;

  return {
    prompt,
    sources: makeSources(sourceCount),
    coverage,
    truncated,
    history: selectedHistory,
  };
}
