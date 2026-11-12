import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageViewport } from "pdfjs-dist";
import { combinePdfFragments, pdfSelectionRects, readPdfTextRange, selectionPages } from "../src/core/pdf-selection";

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
describe("continuous PDF text selection", () => {
  it("retains all pages regardless of drag direction", () => {
    expect(selectionPages(5, 2)).toEqual([2, 3, 4, 5]);
    expect(selectionPages(3, 3)).toEqual([3]);
  });
  it("preserves complete quote and page-local coordinates in reading order", () => {
    const anchor = combinePdfFragments([
      { page: 2, quote: "Next paragraph", rects: [[10, 30, 90, 42]] },
      { page: 1, quote: "First paragraph", rects: [[10, 5, 90, 17]] },
    ], "First paragraph\nNext paragraph");
    expect(anchor).toEqual({ page: 1, quote: "First paragraph\nNext paragraph", rects: [[10, 5, 90, 17]], fragments: [
      { page: 1, quote: "First paragraph", rects: [[10, 5, 90, 17]] },
      { page: 2, quote: "Next paragraph", rects: [[10, 30, 90, 42]] },
    ] });
    expect(combinePdfFragments([{ page: 1, quote: "", rects: [[0, 0, 1, 1]] }])).toBeUndefined();
    expect(combinePdfFragments([{ page: 1, quote: "one", rects: [[0, 0, 1, 1]] }])).not.toHaveProperty("fragments");
  });
  it("converts each selected line through its actual viewport, clips borders and removes duplicate boxes", () => {
    const convertToPdfPoint = vi.fn((x, y) => [y / 2, x / 2]); // rotated viewport
    const viewport = { convertToPdfPoint } as unknown as PageViewport;
    const result = pdfSelectionRects([
      rect(90, 210, 160, 230), rect(90, 210, 160, 230),
      rect(110, 240, 180, 260), rect(10, 10, 20, 20), rect(100, 200, 100, 210),
    ], rect(100, 200, 300, 600), viewport);
    expect(result).toEqual([[5, 0, 15, 30], [20, 5, 30, 40]]);
    expect(convertToPdfPoint).toHaveBeenCalledWith(0, 10);
  });
});


describe("PDF.js text-layer quote serialization", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps selected BRs and partial boundary text while excluding page chrome and guards", () => {
    const text = (value: string) => ({ nodeType: 3, nodeName: "#text", textContent: value });
    const first = text("Before change."), last = text("Select this sentence. After");
    const br = { nodeType: 1, nodeName: "BR", textContent: "" };
    const guard = { nodeType: 1, nodeName: "DIV", textContent: "" };
    const annotation = text("Unrelated annotation label");
    const nodes = [first, br, guard, last, annotation];
    const selectedNodes = new Set([first, br, guard, last]);
    const selected = { startContainer: first, startOffset: 7, endContainer: last, endOffset: 21,
      intersectsNode: (node: unknown) => selectedNodes.has(node as typeof first) } as unknown as Range;
    const boxes: DOMRect[] = [];
    vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
    vi.stubGlobal("NodeFilter", { SHOW_ELEMENT: 1, SHOW_TEXT: 4 });
    const createTreeWalker = vi.fn(() => {
      let index = 0;
      return { nextNode: () => nodes[index++] ?? null };
    });
    vi.stubGlobal("document", { createTreeWalker, createRange: () => {
      let value = "", start = 0, end = 0;
      return {
        selectNodeContents: (node: typeof first) => { value = node.textContent; end = value.length; },
        setStart: (_node: unknown, offset: number) => { start = offset; },
        setEnd: (_node: unknown, offset: number) => { end = offset; },
        toString: () => value.slice(start, end),
        getClientRects: () => { const box = rect(start, 0, end, 10) as DOMRect; boxes.push(box); return [box]; },
      };
    } });
    const layer = {} as HTMLElement;
    expect(readPdfTextRange(selected, layer)).toEqual({ quote: "change.\nSelect this sentence.", rects: boxes });
    expect(boxes).toHaveLength(2);
    expect(createTreeWalker).toHaveBeenCalledWith(layer, 5);
  });
});
