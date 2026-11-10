import type {
  ContextResult,
  HistoryMessage,
  Note,
  PageText,
  Project,
  PromptTemplate,
  Source,
} from '../types';
import { SYSTEM_PROMPT, TASK_LABELS } from './templates';

const DEFAULT_BUDGET = 12_000;
const CHUNK_SIZE = 700;
const MAX_SOURCES = 8;

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
    run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)),
  );
  return [...latin, ...bigrams];
}

function chunks(page: PageText): string[] {
  const text = page.text.trim();
  if (!text) return [];

  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
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
  let empty = 0;
  let errors = 0;

  for (let pageNo = 1; pageNo <= total; pageNo += 1) {
    const page = pages.get(pageNo);
    if (!page || page.status === 'pending') pending += 1;
    else if (page.status === 'error') errors += 1;
    else if (page.status === 'empty' || !page.text.trim()) empty += 1;
    else ready += 1;
  }

  const detail = [
    pending ? `尚未识别 ${pending} 页` : '',
    empty ? `已识别但无可检索文字 ${empty} 页` : '',
    errors ? `识别失败 ${errors} 页` : '',
  ].filter(Boolean);
  return `已可检索 ${ready}/${total} 页${detail.length ? `；${detail.join('；')}` : ''}。`;
}

function nearby(project: Project, note: Note): string {
  const page = project.pages.find((candidate) => candidate.page === note.anchor.page);
  if (!page?.text.trim()) return '';
  const selected = note.anchor.quote.trim();
  const at = selected ? page.text.indexOf(selected) : -1;
  if (at >= 0) {
    const start = Math.max(0, at - CHUNK_SIZE / 2);
    return page.text.slice(start, start + CHUNK_SIZE * 2).trim();
  }
  return page.text.slice(0, CHUNK_SIZE).trim();
}

function retrieve(project: Project, note: Note, question: string): ScoredChunk[] {
  const query = words(`${note.anchor.quote}\n${question}`);
  const terms = new Set(query);
  if (!terms.size) return [];

  const scored: ScoredChunk[] = [];
  let order = 0;
  for (const page of project.pages) {
    if (page.status !== 'ready' || !page.text.trim()) continue;
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

function render(
  input: BuildContextInput,
  coverage: string,
  near: string,
  sources: Source[],
  history: HistoryMessage[],
): string {
  const { project, note, question, template } = input;
  const sourceText = sources.length
    ? sources.map((source) => `[${source.id}] 第 ${source.page} 页\n${source.text}`).join('\n\n')
    : '（没有可用的检索片段）';
  const historyText = history.length
    ? history
        .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
        .join('\n\n')
    : '（无）';

  return `${SYSTEM_PROMPT}

【任务】
${TASK_LABELS[template.task]}
${template.body}

【文档】
名称：${project.document.name}
当前页：${note.anchor.page}
本次可参考范围：${coverage}

【选中的原文】
${note.anchor.quote || '（未选择文字）'}

【当前页附近内容】
${near || '（无）'}

【相关文档片段】
${sourceText}

【分支所针对的回答】
${note.branchQuote || '（无）'}

【祖先与当前便签对话】
${historyText}

【用户问题】
${question.trim() || template.body}

请先直接回应问题，再按需要解释概念、公式或推导步骤。
涉及文档依据时只引用上方实际提供的来源 ID。`;
}

export function buildContext(input: BuildContextInput): ContextResult {
  const budget = Math.max(1, input.budget ?? DEFAULT_BUDGET);
  const coverage = pageCoverage(input.project);
  const near = nearby(input.project, input.note);
  const candidates = retrieve(input.project, input.note, input.question).slice(0, MAX_SOURCES);
  const history = currentHistory(input.note);
  let sourceCount = candidates.length;
  let truncated = false;

  const makeSources = (count: number): Source[] =>
    candidates.slice(0, count).map((candidate, index) => ({
      id: `S${index + 1}`,
      page: candidate.page,
      text: candidate.text,
    }));

  let historyStart = 0;
  let prompt = render(input, coverage, near, makeSources(sourceCount), history.slice(historyStart));

  while (prompt.length > budget && sourceCount > 0) {
    sourceCount -= 1;
    truncated = true;
    prompt = render(input, coverage, near, makeSources(sourceCount), history.slice(historyStart));
  }
  while (prompt.length > budget && historyStart < history.length) {
    historyStart += 1;
    truncated = true;
    prompt = render(input, coverage, near, makeSources(sourceCount), history.slice(historyStart));
  }

  return {
    prompt,
    sources: makeSources(sourceCount),
    coverage,
    truncated,
    history: history.slice(historyStart),
  };
}
