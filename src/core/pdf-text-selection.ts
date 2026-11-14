import type { PageViewport } from "pdfjs-dist";
import type { Anchor, AnchorFragment, PageText, Rect } from "../types";

export interface PdfTextPage {
  page: number;
  layer: HTMLElement;
  wrapper: HTMLElement;
  viewport: PageViewport;
}

const validRect = (rect: Rect) => rect.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1];
const rectKey = (rect: Rect) => rect.map(value => value.toFixed(2)).join(",");

/** Read only selected Text nodes and real BRs, never a page/container rectangle. */
function readPageRange(range: Range, page: PdfTextPage): AnchorFragment | undefined {
  const doc = page.layer.ownerDocument, bounds = page.wrapper.getBoundingClientRect();
  const walker = doc.createTreeWalker(page.layer, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
  const chunks: string[] = [], rects: Rect[] = [], seen = new Set<string>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (element?.closest(".endOfContent,.annotation-layer,.pdf-selection") || !range.intersectsNode(node)) continue;
    if (node.nodeType === 1) {
      if (node.nodeName === "BR") chunks.push("\n");
      continue;
    }
    if (node.nodeType !== 3 || !node.textContent) continue;
    const part = doc.createRange(); part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    if (part.collapsed) continue;
    chunks.push(part.toString());
    for (const box of part.getClientRects()) {
      const left = Math.max(bounds.left, box.left), right = Math.min(bounds.right, box.right);
      const top = Math.max(bounds.top, box.top), bottom = Math.min(bounds.bottom, box.bottom);
      if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
      const [x1, y1] = page.viewport.convertToPdfPoint(left - bounds.left, top - bounds.top);
      const [x2, y2] = page.viewport.convertToPdfPoint(right - bounds.left, bottom - bounds.top);
      const rect: Rect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
      const key = rectKey(rect);
      if (validRect(rect) && !seen.has(key)) { seen.add(key); rects.push(rect); }
    }
  }
  const quote = chunks.join("").trim();
  return quote ? { page: page.page, quote, rects } : undefined;
}

function cachedPage(page: PageText): AnchorFragment | undefined {
  if (page.status !== "ready" || !page.text.trim() || !page.words.length) return;
  const rects: Rect[] = [], seen = new Set<string>();
  for (const word of page.words) {
    if (!word.text || !validRect(word.rect)) continue;
    const key = rectKey(word.rect);
    if (!seen.has(key)) { seen.add(key); rects.push([...word.rect]); }
  }
  return rects.length ? { page: page.page, quote: page.text.trim(), rects } : undefined;
}

/** A completed empty result is different from text that has not loaded yet. */
function confirmedEmpty(page: PageText | undefined, number: number): boolean {
  return !!page && page.page === number && (page.status === "empty" || page.status === "ready") &&
    !page.text.trim() && !page.words.some(word => word.text.trim());
}

/** Preserve partial endpoint pages; only truly interior unmounted pages use cache. */
export function collectPdfTextSelection(
  selection: Selection, pages: Iterable<PdfTextPage>, cache?: ReadonlyMap<number, PageText>,
): Anchor | undefined {
  if (selection.isCollapsed || !selection.rangeCount) return;
  const entries = [...pages].filter(page => page.layer.isConnected && page.wrapper.isConnected);
  const range = selection.getRangeAt(0);
  const owner = (node: Node) => entries.find(page => page.layer === node || page.layer.contains(node));
  const start = owner(range.startContainer), end = owner(range.endContainer);
  if (!start || !end) return;
  // Outside chrome/annotations cannot become an endpoint even when nested.
  const invalidEndpoint = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest(".annotation-layer,.pdf-selection");
  if (invalidEndpoint(range.startContainer) || invalidEndpoint(range.endContainer)) return;
  const first = Math.min(start.page, end.page), last = Math.max(start.page, end.page);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1) return;
  const byPage = new Map(entries.map(page => [page.page, page]));
  const fragments: AnchorFragment[] = [];
  for (let number = first; number <= last; number++) {
    const page = byPage.get(number);
    let fragment: AnchorFragment | undefined;
    if (page) {
      const local = page.layer.ownerDocument.createRange(); local.selectNodeContents(page.layer);
      if (page === start) local.setStart(range.startContainer, range.startOffset);
      if (page === end) local.setEnd(range.endContainer, range.endOffset);
      fragment = local.collapsed ? undefined : readPageRange(local, page);
      // Empty endpoints (e.g. next-layer offset 0) add no page. Only a completed
      // empty result may omit an interior page; a new empty DOM layer alone
      // does not establish that its native/OCR extraction has finished.
      if (!fragment && number > first && number < last && !confirmedEmpty(cache?.get(number), number)) return;
    } else {
      if (number === first || number === last) return;
      const cached = cache?.get(number);
      if (!cached || cached.page !== number) return;
      if (confirmedEmpty(cached, number)) continue;
      fragment = cachedPage(cached);
      if (!fragment) return;
    }
    if (fragment) {
      if (!fragment.rects.length) return;
      fragments.push(fragment);
    }
  }
  const initial = fragments[0];
  if (!initial) return;
  return {
    page: initial.page, rects: initial.rects.map(rect => [...rect]),
    quote: fragments.map(fragment => fragment.quote).join("\n").trim(),
    ...(fragments.length > 1 ? { fragments } : {}),
  };
}
