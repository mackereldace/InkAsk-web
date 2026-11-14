import type {
  ContextResult,
  HistoryMessage,
  Note,
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
import { selectEvidence } from "./evidence-retrieval";
import { anchorFragments } from "./pdf-anchor";

const DEFAULT_BUDGET = 12_000;
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

function rootSources(note: Note): Source[] {
  return anchorFragments(note.anchor).map((fragment, index) => ({
    id: `S${index + 1}`, page: fragment.page,
    rects: fragment.rects.map((rect) => [...rect]),
    text: fragment.quote.trim() || "（选中的 PDF 区域，参见提问附图）",
  }));
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
    .map((source) => `[${source.id}] 第 ${source.page} 页${source.label ? ` · ${source.label}` : ""}\n${source.text}`)
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
    page_number: anchorFragments(note.anchor).map(fragment => fragment.page).join("、"),
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
  const fixedSources = rootSources(input.note);
  const candidates = selectEvidence(input.project, input.note, input.question);
  const allHistory = currentHistory(input.note);
  const history = allHistory.slice(-MAX_HISTORY_MESSAGES);
  const initialImages = imageOccurrences(input.note, history);
  let truncated =
    allHistory.length > MAX_HISTORY_MESSAGES ||
    initialImages > MAX_IMAGE_ATTACHMENTS;
  let sourceCount = candidates.length;
  let historyStart = 0;

  const makeSources = (count: number): Source[] => [
    ...fixedSources,
    ...candidates.slice(0, count).map((candidate, index) => ({
      id: `S${index + fixedSources.length + 1}`,
      page: candidate.page,
      text: candidate.text,
      ...(candidate.rects.length ? { rects: candidate.rects.map((rect) => [...rect] as typeof rect) } : {}),
      blockId: candidate.id,
      label: candidate.label,
      textRange: [candidate.start, candidate.end] as [number, number],
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
