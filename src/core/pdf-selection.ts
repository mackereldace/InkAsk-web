import type { PageViewport } from "pdfjs-dist";
import type { Anchor, AnchorFragment, Rect } from "../types";

export interface PdfSelectionPage {
  page: number;
  layer: HTMLElement;
  wrapper: HTMLElement;
  viewport: PageViewport;
}

export function selectionPages(first: number, last: number): number[] {
  const from = Math.min(first, last), to = Math.max(first, last);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Convert only actual selected line rectangles, never the text-layer bounding box. */
export function pdfSelectionRects(rects: Iterable<Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">>,
  bounds: Pick<DOMRect, "left" | "top" | "right" | "bottom">, viewport: PageViewport): Rect[] {
  const found: Rect[] = [], seen = new Set<string>();
  for (const rect of rects) {
    if (rect.width <= 1 || rect.height <= 1) continue;
    const left = Math.max(bounds.left, rect.left), right = Math.min(bounds.right, rect.right);
    const top = Math.max(bounds.top, rect.top), bottom = Math.min(bounds.bottom, rect.bottom);
    if (right - left <= 1 || bottom - top <= 1) continue;
    const [x1, y1] = viewport.convertToPdfPoint(left - bounds.left, top - bounds.top);
    const [x2, y2] = viewport.convertToPdfPoint(right - bounds.left, bottom - bounds.top);
    const result: Rect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    const key = result.map((value) => value.toFixed(2)).join(",");
    if (!seen.has(key)) { found.push(result); seen.add(key); }
  }
  return found;
}

export function combinePdfFragments(fragments: AnchorFragment[], quote?: string): Anchor | undefined {
  const ordered = fragments.filter((fragment) => fragment.rects.length && fragment.quote.trim()).sort((a, b) => a.page - b.page);
  const first = ordered[0];
  if (!first) return;
  return { ...first, quote: quote?.trim() || ordered.map((fragment) => fragment.quote).join("\n"),
    ...(ordered.length > 1 ? { fragments: ordered } : {}) };
}

/** Range.toString() drops PDF.js's BR elements; serialize only selected text-layer nodes. */
export function readPdfTextRange(range: Range, layer: HTMLElement): { quote: string; rects: DOMRect[] } {
  const chunks: string[] = [], rects: DOMRect[] = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.nodeName === "BR") chunks.push("\n");
      continue;
    }
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    chunks.push(part.toString());
    // Only selected text supplies geometry, never the full-page end guard.
    rects.push(...part.getClientRects());
  }
  return { quote: chunks.join("").trim(), rects };
}

/** Clip one native range to each page. Cross-page common ancestors are valid. */
export function collectPdfSelection(selection: Selection, pages: Iterable<PdfSelectionPage>): Anchor | undefined {
  if (selection.isCollapsed || !selection.rangeCount) return;
  const selected = selection.getRangeAt(0), entries = [...pages];
  if (!entries.some(({ layer }) => layer.contains(selected.startContainer)) ||
      !entries.some(({ layer }) => layer.contains(selected.endContainer))) return;
  const fragments: AnchorFragment[] = [];
  for (const { page, layer, wrapper, viewport } of entries) {
    if (!layer.isConnected || !selected.intersectsNode(layer)) continue;
    const range = document.createRange();
    range.selectNodeContents(layer);
    if (layer.contains(selected.startContainer)) range.setStart(selected.startContainer, selected.startOffset);
    if (layer.contains(selected.endContainer)) range.setEnd(selected.endContainer, selected.endOffset);
    const selectedText = readPdfTextRange(range, layer);
    const quote = selectedText.quote;
    const rects = pdfSelectionRects(selectedText.rects, wrapper.getBoundingClientRect(), viewport);
    if (quote && rects.length) fragments.push({ page, quote, rects });
  }
  return combinePdfFragments(fragments);
}

/** Match PDF.js's text-layer end guard without importing the entire viewer. */
export function resetTextLayerEnd(layer: HTMLElement) {
  const end = layer.querySelector<HTMLElement>(".endOfContent");
  if (end) { layer.append(end); end.style.width = ""; end.style.height = ""; end.style.userSelect = ""; }
  layer.classList.remove("selecting");
}
export function guardTextLayerEnd(selection: Selection, pages: Iterable<PdfSelectionPage>, previous?: Range): Range | undefined {
  if (!selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const modifyStart = previous && (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
    range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
  let anchor = modifyStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode!;
  const page = [...pages].find(({ layer }) => layer.contains(anchor));
  if (!page) return range.cloneRange();
  page.layer.classList.add("selecting");
  const end = page.layer.querySelector<HTMLElement>(".endOfContent");
  if (end && anchor !== end && !end.contains(anchor) && anchor !== page.layer && anchor.parentNode) {
    end.style.width = page.layer.style.width;
    end.style.height = page.layer.style.height;
    end.style.userSelect = "text";
    // Moving only the empty guard leaves all selected text nodes untouched.
    const next = modifyStart ? anchor : anchor.nextSibling;
    if (next !== end) anchor.parentNode.insertBefore(end, next);
  }
  return range.cloneRange();
}
