import type { Anchor, Note, Project, Rect } from "../types";
import type { EvidenceBlock } from "./evidence-types";
import { anchorEvidenceBlocks, pageEvidenceBlocks } from "./evidence-blocks";
import { anchorFragments, anchorPage } from "./pdf-anchor";

const MAX_EVIDENCE = 3;
const common = new Set(["什么", "怎么", "如何", "这个", "那个", "一个", "这里", "后面", "使用", "条件", "问题", "请问", "解释", "中的", "的是", "什么是", "原文", "引用", "参考", "来源", "本次", "提供", "片段", "文档", "the", "and", "this", "that", "with", "from", "what", "how", "why", "is", "of", "to", "in", "on", "for", "as", "an"]);
const compact = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
// Evidence identity must retain operators and case: x+y and x-y are not duplicates.
const identity = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
function terms(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(normalized.match(/[a-z][a-z0-9_-]+/g) ?? []);
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? [])
    if (run.length > 1) for (let i = 0; i < run.length - 1; i++) result.add(run.slice(i, i + 2));
  return result;
}
const indices = new WeakMap<EvidenceBlock, { text: string; terms: Set<string>; label: string }>();
function index(block: EvidenceBlock) {
  let found = indices.get(block);
  if (!found) { found = { text: compact(block.text), terms: terms(block.text), label: compact(`${block.section ?? ""} ${block.label}`) }; indices.set(block, found); }
  return found;
}
function area(rect: Rect): number { return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]); }
function intersects(a: Rect, b: Rect): boolean {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) > Math.min(area(a), area(b)) * .1;
}
const imageQuery = (query: string) => /图片|原图|扫描|照片|图中|插图|figure|image|photo|scan/i.test(query);
const noteQuery = (query: string) => /笔误|注释|注解|存疑|错误|严谨|整理者|remark|errat/i.test(query);
function sectionIds(text: string): Set<string> {
  const value = text.normalize("NFKC"), found = new Set<string>();
  // Lower-case t1/t2 commonly denote arguments in formulas, not theorem IDs.
  for (const match of value.matchAll(/\bT\s*(\d+(?:\.\d+)*)\b/g)) found.add(`t${match[1]}`);
  for (const match of value.matchAll(/\btheorem\s*[.:：-]?\s*(\d+(?:\.\d+)*)\b/gi)) found.add(`t${match[1]}`);
  for (const match of value.matchAll(/定理\s*(\d+(?:\.\d+)*)/g)) found.add(`t${match[1]}`);
  return found;
}

/** Scores require content matches. Geometry and labels only strengthen real matches. */
export function rankEvidenceBlocks(blocks: readonly EvidenceBlock[], query: string, options: { anchor?: Anchor; includeCaptions?: boolean } = {}): { block: EvidenceBlock; score: number }[] {
  const wanted = terms(query), explicitSections = sectionIds(query);
  // A matching identifier alone is not evidence that the body supports a claim.
  for (const section of explicitSections) { wanted.delete(section); wanted.delete(section.replace(/^t/, "theorem")); }
  if (explicitSections.size) { wanted.delete("theorem"); wanted.delete("定理"); }
  if (!wanted.size) return [];
  const phrases = [...new Set((query.normalize("NFKC").toLocaleLowerCase().match(/[\u3400-\u9fff]{3,16}|[a-z][a-z0-9_-]{2,}/g) ?? []).filter((phrase) => !common.has(phrase)))];
  const frequencies = new Map<string, number>();
  for (const block of blocks) for (const term of wanted) if (index(block).terms.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const count = Math.max(1, blocks.length), includeCaptions = options.includeCaptions ?? imageQuery(query);
  const output: { block: EvidenceBlock; score: number }[] = [];
  for (const block of blocks) {
    if (block.role === "marginal" || block.role === "heading" || (block.role === "caption" && !includeCaptions)) continue;
    const value = index(block);
    let content = 0, informative = 0;
    for (const term of wanted) if (value.terms.has(term)) {
      const weight = common.has(term) ? .12 : 1;
      content += weight * (1 + Math.log(1 + count / (1 + (frequencies.get(term) ?? 0))));
      if (!common.has(term)) informative++;
    }
    if (!informative) continue;
    // Exact phrases matter more than isolated overlapping Chinese bigrams.
    for (const phrase of phrases) if (value.text.includes(compact(phrase))) {
      content += Math.min(5, phrase.length * .65);
      if (value.label.includes(compact(phrase))) content += .8;
    }
    // Mild length normalization prevents a long notes section winning by volume.
    content /= Math.sqrt(Math.max(1, block.text.length / 180));
    let score = content * (block.role === "note" ? (noteQuery(query) ? 1.1 : .38) : block.role === "caption" ? .55 : block.role === "theorem" || block.role === "definition" ? 1.1 : 1);
    if (explicitSections.size) {
      const sections = sectionIds(block.section || block.label);
      if ([...sections].some((section) => explicitSections.has(section))) score *= 1.55;
      else if (sections.size) score *= .28;
      else score *= .75;
    }
    const anchor = options.anchor && anchorPage(options.anchor, block.page);
    if (anchor && block.page === anchor.page) {
      score += .15;
      if (block.rects.some((a) => anchor.rects.some((b) => intersects(a, b)))) score += Math.min(3, content * .5);
    }
    if (score >= .7) output.push({ block, score });
  }
  return output.sort((a, b) => b.score - a.score || a.block.page - b.block.page || a.block.start - b.block.start || a.block.id.localeCompare(b.block.id));
}

/** Keep distinct same-page evidence, but never send nested windows as new sources. */
export function deduplicateEvidence(blocks: readonly EvidenceBlock[]): EvidenceBlock[] {
  const found: EvidenceBlock[] = [];
  for (const block of blocks) {
    const duplicate = found.findIndex((other) => {
      if (other.page !== block.page) return false;
      if (other.id === block.id || identity(other.text) === identity(block.text)) return true;
      const overlap = Math.max(0, Math.min(other.end, block.end) - Math.max(other.start, block.start));
      return overlap / Math.max(1, Math.min(other.end - other.start, block.end - block.start)) >= .85;
    });
    if (duplicate < 0) found.push(block);
    else if (block.end - block.start < (found[duplicate].end - found[duplicate].start) * .8) found[duplicate] = block;
  }
  return found;
}

const pools = new WeakMap<Project["pages"], readonly EvidenceBlock[]>();
function pool(project: Project): readonly EvidenceBlock[] {
  let blocks = pools.get(project.pages);
  if (!blocks) { blocks = project.pages.filter((page) => page.status === "ready" && page.text.trim()).flatMap((page) => [...pageEvidenceBlocks(page)]); pools.set(project.pages, blocks); }
  return blocks;
}

export function selectEvidence(project: Project, note: Note, question: string): EvidenceBlock[] {
  const blocks = pool(project), query = `${note.anchor.quote}\n${note.branchQuote ?? ""}\n${question}`;
  const selected: EvidenceBlock[] = [];
  const add = (block: EvidenceBlock) => {
    if (block.role === "marginal" || block.role === "heading" || (block.role === "caption" && !imageQuery(query))) return;
    if (anchorFragments(note.anchor).some(fragment => fragment.page === block.page && identity(block.text) === identity(fragment.quote))) return;
    const next = deduplicateEvidence([...selected, block]);
    if (next.length <= MAX_EVIDENCE) { selected.length = 0; selected.push(...next); }
  };
  const local = anchorFragments(note.anchor).flatMap(fragment => {
    const page = project.pages.find(page => page.page === fragment.page && page.status === "ready");
    return page ? anchorEvidenceBlocks(page, fragment) : [];
  }).filter((block) => !["heading", "caption", "marginal"].includes(block.role)).sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.page - b.page || a.start - b.start);
  for (const block of local.slice(0, 2)) add(block);
  const primary = local[0];
  if (primary?.section && /后面|使用|作用|怎么|如何|为什么|证明|推导|条件|解释|成立|use|prove|why|how|explain/i.test(question || "解释")) {
    const complementary = primary.role === "proof" ? ["theorem", "definition"] : ["proof"];
    const companion = blocks.find((block) => block.page === primary.page && block.section === primary.section && complementary.includes(block.role));
    if (companion) add(companion);
  }
  const ranked = rankEvidenceBlocks(blocks, query);
  const threshold = Math.max(1.1, (ranked[0]?.score ?? 0) * .28);
  for (const { block, score } of ranked) {
    if (score < threshold) break;
    add(block);
    if (selected.length >= MAX_EVIDENCE) break;
  }
  return selected;
}
