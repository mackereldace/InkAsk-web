import type { Anchor, PageText, Rect, Source } from "../types";
import { anchorPage } from "./pdf-anchor";

interface IndexedText { text: string; owners: number[] }
const mathCommands: Record<string, string> = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", phi: "φ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω", times: "×", cdot: "·", le: "≤", leq: "≤", ge: "≥", geq: "≥", infty: "∞", partial: "∂", nabla: "∇", sum: "∑", int: "∫" };
/** Keep character-to-word correspondence while normalizing extraction/OCR typography. */
function canonical(input: IndexedText): IndexedText {
  let { text, owners } = input;
  const replace = (pattern: RegExp, value: (match: RegExpExecArray) => string) => {
    let output = "", indices: number[] = [], cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      output += text.slice(cursor, start); for (let i = cursor; i < start; i++) indices.push(owners[i]);
      const replacement = value(match); output += replacement;
      indices.push(...Array.from({ length: replacement.length }, () => owners[start]));
      cursor = start + match[0].length;
    }
    output += text.slice(cursor); for (let i = cursor; i < owners.length; i++) indices.push(owners[i]); text = output; owners = indices;
  };
  replace(/\\([A-Za-z]+)\b/g, (match) => mathCommands[match[1]] ?? (/^(?:left|right|mathrm|mathbf|mathit|text|operatorname)$/.test(match[1]) ? "" : match[0]));
  replace(/(?<=\p{L})[-‐]\s*\n\s*(?=\p{L})/gu, () => "");
  replace(/[\s\S]/gu, (match) => match[0].normalize("NFKC").replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(/[−–]/g, "-").replace(/[，]/g, ",").replace(/[。]/g, ".").replace(/[；]/g, ";").replace(/[：]/g, ":"));
  replace(/\\[()[\]]|[\s\u00ad\u200b\u2060${}]/g, () => "");
  return { text, owners };
}
function normalized(text: string): string { return canonical({ text, owners: [] }).text; }
/** Old S1 records joined the selected quote and nearby page text. The note's
 * original coordinates still identify the quote, including in child answers. */
export function sourceForAnchor(source: Source, anchor: Anchor): Source {
  const fragment = anchorPage(anchor, source.page);
  if (source.rects?.length || source.id !== "S1" || !fragment?.rects.length || !fragment.quote.trim()) return source;
  const legacy = /^选中原文：([\s\S]*?)(?:\n\s*\n当前页附近：|$)/.exec(source.text.trim());
  const selected = legacy ? legacy[1] : source.text;
  const compact = (text: string) => text.replace(/\s+/g, "");
  if (compact(selected) !== compact(fragment.quote)) return source;
  return { ...source, text: fragment.quote.trim(), rects: fragment.rects.map((rect) => [...rect]) };
}
const pageIndices = new WeakMap<PageText, { words: PageText["words"]; value: IndexedText }>();
function pageIndex(page: PageText): IndexedText {
  const cached = pageIndices.get(page);
  if (cached?.words === page.words) return cached.value;
  let text = ""; const owners: number[] = [];
  page.words.forEach((word, index) => {
    if (index) {
      const previous = page.words[index - 1];
      const differentLine = Math.abs((previous.rect[1] + previous.rect[3] - word.rect[1] - word.rect[3]) / 2) > Math.max(1, Math.min(Math.abs(previous.rect[3] - previous.rect[1]), Math.abs(word.rect[3] - word.rect[1])) / 2);
      text += differentLine ? "\n" : " "; owners.push(index);
    }
    text += word.text; owners.push(...Array.from({ length: word.text.length }, () => index));
  });
  const value = canonical({ text, owners });
  pageIndices.set(page, { words: page.words, value });
  return value;
}
/** Locate only a uniquely identified excerpt; repeated text must not silently select the first occurrence. */
export function sourceAnchor(source: Source, page?: PageText): Anchor | undefined {
  if (source.rects?.length) return { page: source.page, rects: source.rects, quote: source.text };
  if (!page?.words.length || page.page !== source.page) return;
  const indexed = pageIndex(page);
  const labelled = /(?:选中原文：|当前页附近：)/.test(source.text);
  const candidates = [...new Set([source.text, ...(labelled ? source.text.split(/(?:选中原文：|当前页附近：|\n\s*\n)/) : [])].map(normalized).filter((part) => part.length >= 3))].sort((a, b) => b.length - a.length);
  for (const quote of candidates) {
    let offset = indexed.text.indexOf(quote), length = quote.length;
    // A truncated retrieval chunk may cut extraction tokens at both ends. Require
    // a long, nearly complete interior instead of guessing from a short phrase.
    if (offset < 0 && quote.length > 160) {
      const interior = quote.slice(12, -12); offset = indexed.text.indexOf(interior); length = interior.length;
    }
    if (offset < 0) continue;
    if (indexed.text.indexOf(indexed.text.slice(offset, offset + length), offset + 1) >= 0) return;
    const wordIndices = new Set(indexed.owners.slice(offset, offset + length));
    const rects = [...wordIndices].map((index) => page.words[index].rect);
    if (rects.length) return { page: source.page, quote: source.text, rects };
  }
}
export function unionRects(rects: Rect[]): Rect | undefined {
  if (!rects.length) return;
  return rects.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
}
