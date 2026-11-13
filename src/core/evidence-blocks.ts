import type { Anchor, PageText, Rect, WordBox } from "../types";
import type { EvidenceBlock, EvidenceRole } from "./evidence-types";

interface Span { start: number; end: number; word: WordBox }
interface Line { start: number; end: number; spans: Span[]; box?: Rect; height: number; blankBefore?: boolean }
interface Cached { text: string; words: WordBox[]; dimensions: string; blocks: readonly EvidenceBlock[] }
const cache = new WeakMap<PageText, Cached>();
const compact = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const median = (values: number[]) => { const sorted = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 10; };
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const intersection = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
function hash(text: string): string { let value = 2166136261; for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); return (value >>> 0).toString(36); }
function normalizedIndex(text: string) {
  let value = ""; const offsets: number[] = [];
  for (let index = 0; index < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(index)!);
    const next = compact(char); value += next;
    for (let n = 0; n < next.length; n++) offsets.push(index);
    index += char.length;
  }
  return { value, offsets };
}
/** Map extraction runs to the original text, including OCR whitespace differences. */
function spansFor(page: PageText): Span[] {
  const spans: Span[] = []; let cursor = 0;
  const indexed = normalizedIndex(page.text); let normalizedCursor = 0;
  for (const word of page.words) {
    if (!word.text.trim() || word.rect.some((n) => !Number.isFinite(n)) || !area(word.rect)) continue;
    const text = word.text.trim(); let start = page.text.indexOf(text, cursor), end: number;
    if (start >= 0) {
      end = start + text.length;
      while (normalizedCursor < indexed.offsets.length && indexed.offsets[normalizedCursor] < end) normalizedCursor++;
    } else {
      const needle = compact(word.text), at = indexed.value.indexOf(needle, normalizedCursor);
      if (!needle || at < 0) continue;
      start = indexed.offsets[at];
      const last = indexed.offsets[at + needle.length - 1];
      end = last + String.fromCodePoint(page.text.codePointAt(last)!).length;
      normalizedCursor = at + needle.length;
    }
    if (start < cursor) continue;
    spans.push({ start, end, word }); cursor = end;
  }
  return spans;
}
function linesFor(page: PageText, spans: Span[]): Line[] {
  if (!spans.length) {
    const lines: Line[] = []; let previousEnd = 0;
    for (const match of page.text.matchAll(/[^\n]+/g)) {
      const start = match.index!, end = start + match[0].length;
      if (match[0].trim()) {
        lines.push({ start, end, spans: [], height: 0, blankBefore: /\n\s*\n/.test(page.text.slice(previousEnd, start)) });
        previousEnd = end;
      }
    }
    return lines;
  }
  const lines: Line[] = []; const normal = median(spans.map((s) => s.word.rect[3] - s.word.rect[1]));
  for (const span of spans) {
    const rect = span.word.rect, previous = lines.at(-1), height = rect[3] - rect[1];
    const box = previous?.box;
    const overlap = box ? Math.min(box[3], rect[3]) - Math.max(box[1], rect[1]) : 0;
    const sameBaseline = box && (overlap > Math.min(height, normal) * .15 || Math.abs((rect[1] + rect[3] - box[1] - box[3]) / 2) <= normal * .65);
    const gutter = box && box[2] < page.width * .52 && rect[0] > page.width * .52 && rect[0] - box[2] > page.width * .1;
    if (previous && box && sameBaseline && !gutter && !/\n\s*\n/.test(page.text.slice(previous.end, span.start))) {
      previous.end = span.end; previous.spans.push(span); previous.box = union(box, rect);
      previous.height = Math.max(previous.height, height);
    } else {
      lines.push({ start: span.start, end: span.end, spans: [span], box: [...rect], height,
        blankBefore: previous ? /\n\s*\n/.test(page.text.slice(previous.end, span.start)) : false });
    }
  }
  return lines;
}
function trimRange(text: string, start: number, end: number): [number, number] {
  const part = text.slice(start, end), leading = part.length - part.trimStart().length;
  return [start + leading, end - (part.length - part.trimEnd().length)];
}
/** Protected ranges are found globally before semantic or geometry boundaries. */
function protectedSpans(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const escaped = (at: number) => {
    let slashes = 0; for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    return slashes % 2 === 1;
  };
  const runLength = (at: number, char: string) => { let end = at; while (text[end] === char) end++; return end - at; };
  const runClose = (from: number, char: string, length: number, allowBlank: boolean) => {
    const blank = allowBlank ? -1 : text.slice(from).search(/\r?\n[ \t]*\r?\n/);
    const limit = blank < 0 ? text.length : from + blank;
    let at = text.indexOf(char, from);
    while (at >= 0 && at < limit) {
      const size = runLength(at, char);
      if (size === length && !escaped(at)) return at + length;
      at = text.indexOf(char, at + size);
    }
    return -1;
  };
  for (let at = 0; at < text.length;) {
    const char = text[at];
    if (escaped(at)) { at++; continue; }
    if (char === "`" || char === "~") {
      const size = runLength(at, char);
      const prefix = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
      const fence = size >= 3 && /^ {0,3}$/.test(prefix);
      if (fence) {
        const newline = text.indexOf("\n", at + size);
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/gm;
        closing.lastIndex = newline < 0 ? text.length : newline + 1;
        let match: RegExpExecArray | null, end = text.length;
        while ((match = closing.exec(text))) {
          if (match[1][0] === char && match[1].length >= size) { end = match.index + match[0].length; break; }
        }
        ranges.push([at, end]); at = end; continue;
      }
      if (char === "`") {
        const end = runClose(at + size, char, size, false);
        if (end >= 0) { ranges.push([at, end]); at = end; continue; }
      }
      at += size; continue;
    }
    if (char === "$") {
      const size = runLength(at, char);
      if (size <= 2) {
        const end = runClose(at + size, char, size, size === 2);
        if (end >= 0) { ranges.push([at, end]); at = end; continue; }
      }
      at += size; continue;
    }
    if (char === "\\" && (text[at + 1] === "[" || text[at + 1] === "(")) {
      const close = text[at + 1] === "[" ? "\\]" : "\\)";
      let candidate = text.indexOf(close, at + 2);
      while (candidate >= 0 && escaped(candidate)) candidate = text.indexOf(close, candidate + 2);
      if (candidate >= 0) { const end = candidate + 2; ranges.push([at, end]); at = end; continue; }
    }
    at++;
  }
  return ranges;
}
/** Split only at complete sentences outside TeX and fenced/inline code. */
function safeRanges(text: string, start: number, end: number, lineEnds?: ReadonlySet<number>): Array<[number, number]> {
  const ranges: Array<[number, number]> = []; const value = text.slice(start, end);
  const protectedRanges = protectedSpans(value);
  const boundaries: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (protectedRanges.some(([a, b]) => i >= a && i < b) || (lineEnds && !lineEnds.has(start + i + 1))) continue;
    const char = value[i];
    if (/[。！？；]/.test(char) || (/[.!?;]/.test(char) && /\s|$/.test(value[i + 1] ?? "") && !/\d/.test(value[i - 1] ?? ""))) boundaries.push(i + 1);
  }
  let cursor = 0;
  while (value.length - cursor > 600) {
    const preferred = boundaries.find((point) => point - cursor >= 280 && point - cursor <= 600);
    if (preferred === undefined) break; // A long equation/code run stays intact.
    ranges.push(trimRange(text, start + cursor, start + preferred)); cursor = preferred;
  }
  if (start + cursor < end) ranges.push(trimRange(text, start + cursor, end));
  return ranges.filter(([a, b]) => b > a);
}
function labelFor(role: EvidenceRole, section?: string, noteNumber?: string): string {
  const labels: Record<EvidenceRole, string> = { theorem: "题设", proof: "证明", definition: "定义", note: "整理者注", body: "正文", heading: "标题", caption: "图注", marginal: "页码" };
  if (role === "note") return ["整理者注", section, noteNumber].filter(Boolean).join(" · ");
  return [section, labels[role]].filter(Boolean).join(" · ");
}

/** A read-only, versioned evidence index; neither source text nor saved notes change. */
export function pageEvidenceBlocks(page: PageText): readonly EvidenceBlock[] {
  const dimensions = `${page.source}:${page.width}:${page.height}`;
  const cached = cache.get(page);
  if (cached?.text === page.text && cached.words === page.words && cached.dimensions === dimensions) return cached.blocks;
  const protectedRanges = protectedSpans(page.text);
  const spans = spansFor(page), lines = linesFor(page, spans), normal = median(spans.map((s) => s.word.rect[3] - s.word.rect[1]));
  const version = hash(`${dimensions}:${page.text}:${spans.map((s) => s.word.rect.join(",")).join(";")}`);
  const blocks: EvidenceBlock[] = [];
  let pending: Line[] = [], role: EvidenceRole = "body", section: string | undefined, notes = false, noteNumber: string | undefined;
  const flush = () => {
    if (!pending.length) return;
    const from = pending[0].start, to = pending.at(-1)!.end;
    const lineEnds = spans.length ? new Set(pending.map((line) => trimRange(page.text, line.start, line.end)[1])) : undefined;
    for (const [start, end] of safeRanges(page.text, from, to, lineEnds)) {
      const rects = pending.flatMap((line) => line.spans).filter((span) => span.start < end && span.end > start).map((span) => [...span.word.rect] as Rect);
      blocks.push({ id: `p${page.page}:${version}:${start}-${end}`, page: page.page, text: page.text.slice(start, end), start, end, rects, role, label: labelFor(role, section, noteNumber), ...(section ? { section } : {}) });
    }
    pending = [];
  };
  const column = (line?: Line) => !line?.box ? -1 : line.box[2] <= page.width * .5 ? 0 : line.box[0] >= page.width * .5 ? 1 : -1;
  for (const line of lines) {
    // The opening line can begin a block; every later line through the closing
    // delimiter belongs to that same block, even when it looks like a heading.
    if (protectedRanges.some(([start, end]) => line.start > start && line.start < end)) {
      pending.push(line); continue;
    }
    const text = page.text.slice(line.start, line.end).trim(), clean = text.replace(/\s+/g, "");
    const box = line.box;
    const marginal = /^[-—]?\d+[-—]?$/.test(clean) && (!box || box[1] > page.height * .88 || box[3] < page.height * .12);
    const caption = /^(?:原图\s*\d+|图\s*[\d一二三四五六七八九十]+|Figure\s*\d+|Fig\.\s*\d+)/i.test(text);
    const sectionMatch = /^T\s*(\d+)\b/.exec(text);
    const noteHeading = /^整理者注/.test(clean);
    const numbered = notes ? /^(\d+)\s*[.、]/.exec(text) : undefined;
    const explicitRole: EvidenceRole | undefined = /^(?:题目|定理|命题|引理|推论|Theorem\b|Lemma\b|Proposition\b)/i.test(text) ? "theorem"
      : /^(?:Pf\s*[:：.]|Proof\b|证明(?:\s*[:：.]|$))/i.test(text) ? "proof"
      : /^(?:定义|Definition\b)/i.test(text) ? "definition" : undefined;
    const visualHeading = !!box && line.height > normal * 1.25 && clean.length < 100 && !/[=∫∑≤≥]/.test(clean);
    const heading = !caption && (!!sectionMatch || (visualHeading && clean.length > 2 && /[\p{L}\u3400-\u9fff]/u.test(clean) && !noteHeading && !explicitRole));
    const previous = pending.at(-1), prevColumn = column(previous), thisColumn = column(line);
    const ending = /^[□∎■]+$/.test(clean);
    const previousText = previous ? page.text.slice(previous.start, previous.end) : "";
    const proseColumns = role !== "proof" && role !== "theorem" && !/[=∫∑∀∃≤≥]/.test(previousText + text);
    const physicalBreak = !ending && previous?.box && box && (
      (prevColumn !== -1 && thisColumn !== -1 && prevColumn !== thisColumn && (proseColumns || Math.abs((box[1] + box[3] - previous.box[1] - previous.box[3]) / 2) <= normal * .8)) ||
      (box[1] - previous.box[3] > normal * 3) ||
      (previous.box[1] - box[3] > normal * 2.5)
    );
    if (marginal || caption || heading || noteHeading || numbered || explicitRole || line.blankBefore || physicalBreak) flush();
    if (marginal) {
      const old: EvidenceRole = role; role = "marginal"; pending = [line]; flush(); role = old; continue;
    }
    if (heading) {
      section = sectionMatch ? `T${sectionMatch[1]}` : text.slice(0, 70); notes = false; noteNumber = undefined;
      role = "heading"; pending = [line]; flush(); role = "body"; continue;
    }
    if (noteHeading) { role = "note"; notes = true; noteNumber = undefined; if (visualHeading) section = undefined; }
    else if (numbered) { role = "note"; noteNumber = numbered[1]; const match = /\bT\s*(\d+)\b/.exec(text); section = match ? `T${match[1]}` : undefined; }
    else if (caption) { role = "caption"; noteNumber = undefined; }
    else if (explicitRole) { role = explicitRole; noteNumber = undefined; notes = false; }
    else if (line.blankBefore && role !== "proof" && !notes) { role = "body"; noteNumber = undefined; }
    pending.push(line);
    if (caption) flush();
  }
  flush();
  const result = Object.freeze(blocks);
  cache.set(page, { text: page.text, words: page.words, dimensions, blocks: result });
  return result;
}

/** Geometry wins over text, so repeated definitions preserve the user's location. */
export function anchorEvidenceBlocks(page: PageText, anchor: Anchor): EvidenceBlock[] {
  if (anchor.page !== page.page) return [];
  const blocks = pageEvidenceBlocks(page);
  const spatial = blocks.filter((block) => block.rects.some((rect) => anchor.rects.some((selected) => intersection(rect, selected) > Math.min(area(rect), area(selected)) * .05)));
  if (spatial.length) return spatial;
  const quote = compact(anchor.quote); if (!quote) return [];
  const indexed = normalizedIndex(page.text), at = indexed.value.indexOf(quote);
  if (at < 0 || indexed.value.indexOf(quote, at + 1) >= 0) return [];
  const start = indexed.offsets[at], last = indexed.offsets[at + quote.length - 1];
  const end = last + String.fromCodePoint(page.text.codePointAt(last)!).length;
  return blocks.filter((block) => block.start < end && block.end > start);
}
