import type { AnswerAnchor, Rect } from "../types";
import { codeSpan } from "./math-markdown";

interface Segment {
  node: Node;
  start: number;
  end: number;
  atomic: boolean;
}
export interface AnswerText {
  text: string;
  segments: Segment[];
}
const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "TR"]);

/** One stable text stream, with TeX instead of KaTeX's duplicated MathML/HTML. */
export function answerText(root: HTMLElement): AnswerText {
  let text = "";
  const segments: Segment[] = [];
  const separate = (separator = "\n") => {
    if (text && !text.endsWith(separator)) text += separator;
  };
  const append = (node: Node, value: string, atomic = false) => {
    if (!value) return;
    const start = text.length;
    text += value;
    segments.push({ node, start, end: text.length, atomic });
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) { append(node, node.textContent ?? ""); return; }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (el.matches('[hidden], [aria-hidden="true"], .annotation-layer, script, style')) return;
    if (el.classList.contains("katex")) {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (tex != null) {
        const display = Boolean(el.closest(".katex-display"));
        if (display) separate();
        append(el, display ? `$$${tex}$$` : `$${tex}$`, true);
        if (display) separate();
      }
      return;
    }
    if (el.tagName === "PRE" || el.tagName === "CODE") {
      const raw = el.textContent ?? "";
      const longest = Math.max(0, ...(raw.match(/`+/g) ?? []).map((run) => run.length));
      const ticks = "`".repeat(Math.max(el.tagName === "PRE" ? 3 : 1, longest + 1));
      if (el.tagName === "PRE") {
        separate();
        const language = el.querySelector("code")?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? "";
        append(el, `${ticks}${language}\n${raw.replace(/\n$/, "")}\n${ticks}`, true);
        separate();
      } else append(el, codeSpan(raw), true);
      return;
    }
    if (el.tagName === "BR") { separate(); return; }
    const block = BLOCKS.has(el.tagName);
    if (block) separate();
    for (const child of el.childNodes) walk(child);
    if (el.tagName === "TD" || el.tagName === "TH") separate("\t");
    else if (block) separate();
  };
  for (const node of root.childNodes) walk(node);
  return { text, segments };
}

export function selectedAnswerAnchor(root: HTMLElement, range: Range): AnswerAnchor | undefined {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const model = answerText(root);
  let start: number | undefined;
  let end: number | undefined;
  for (const segment of model.segments) {
    if (!range.intersectsNode(segment.node)) continue;
    const from = !segment.atomic && range.startContainer === segment.node ? range.startOffset : 0;
    const to = !segment.atomic && range.endContainer === segment.node ? range.endOffset : segment.end - segment.start;
    if (to <= from) continue;
    start ??= segment.start + from;
    end = segment.start + to;
  }
  if (start == null || end == null) return;
  const raw = model.text.slice(start, end);
  start += raw.length - raw.trimStart().length;
  end -= raw.length - raw.trimEnd().length;
  if (end <= start) return;
  return { start, end, quote: model.text.slice(start, end) };
}

function boundary(segment: Segment, index: number, end: boolean): [Node, number] {
  if (!segment.atomic) return [segment.node, Math.max(0, Math.min(index - segment.start, segment.end - segment.start))];
  const parent = segment.node.parentNode!;
  const childIndex = Array.prototype.indexOf.call(parent.childNodes, segment.node) as number;
  return [parent, childIndex + (end ? 1 : 0)];
}

/** Reject ambiguous legacy quotes; retained offsets distinguish repeated text. */
export function answerAnchorRange(root: HTMLElement, anchor: AnswerAnchor | undefined, quote: string): Range | undefined {
  const model = answerText(root);
  let start: number;
  let end: number;
  if (anchor && model.text.slice(anchor.start, anchor.end) === anchor.quote) {
    start = anchor.start;
    end = anchor.end;
  } else {
    const needle = (anchor?.quote || quote).trim();
    if (!needle) return;
    start = model.text.indexOf(needle);
    if (start < 0 || model.text.indexOf(needle, start + 1) >= 0) return;
    end = start + needle.length;
  }
  const first = model.segments.find((segment) => segment.end > start);
  const last = [...model.segments].reverse().find((segment) => segment.start < end);
  if (!first || !last) return;
  const range = root.ownerDocument.createRange();
  range.setStart(...boundary(first, start, false));
  range.setEnd(...boundary(last, end, true));
  return range;
}

export function answerRangeRects(range: Range, surface: HTMLElement): Rect[] {
  const bounds = surface.getBoundingClientRect();
  const visible: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> = [];
  for (const segment of answerText(surface).segments) {
    if (!range.intersectsNode(segment.node)) continue;
    if (segment.atomic) {
      const element = segment.node as HTMLElement;
      if (element.classList.contains("katex")) {
        const parts = [...element.querySelectorAll<HTMLElement>(".katex-html > .base, .katex-html > .tag")]
          .map((part) => part.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
        if (parts.length) {
          const left = Math.min(...parts.map((rect) => rect.left)), top = Math.min(...parts.map((rect) => rect.top));
          const right = Math.max(...parts.map((rect) => rect.right)), bottom = Math.max(...parts.map((rect) => rect.bottom));
          visible.push({ left, top, right, bottom, width: right - left, height: bottom - top });
        } else visible.push(element.getBoundingClientRect());
      } else visible.push(element.getBoundingClientRect());
      continue;
    }
    const part = surface.ownerDocument.createRange();
    part.selectNodeContents(segment.node);
    if (range.startContainer === segment.node) part.setStart(segment.node, range.startOffset);
    if (range.endContainer === segment.node) part.setEnd(segment.node, range.endOffset);
    visible.push(...Array.from(part.getClientRects()));
  }
  const rects: Rect[] = visible.filter((rect) => rect.width > 1 && rect.height > 1)
    .map((rect) => [rect.left - bounds.left, rect.top - bounds.top, rect.right - bounds.left, rect.bottom - bounds.top]);
  // KaTeX returns nested rectangles. Keep each visible area once.
  return rects.filter((rect, index) => !rects.some((other, otherIndex) => otherIndex !== index &&
    other[0] <= rect[0] + 0.5 && other[1] <= rect[1] + 0.5 && other[2] >= rect[2] - 0.5 && other[3] >= rect[3] - 0.5 &&
    ((other[2] - other[0]) * (other[3] - other[1]) > (rect[2] - rect[0]) * (rect[3] - rect[1]) + 1 || otherIndex < index)));
}
