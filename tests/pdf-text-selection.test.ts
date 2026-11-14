import { describe, expect, it } from "vitest";
import type { PageViewport } from "pdfjs-dist";
import { collectPdfTextSelection, type PdfTextPage } from "../src/core/pdf-text-selection";
import type { PageText } from "../src/types";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
class TestNode {
  childNodes: TestNode[] = [];
  parentNode: TestNode | null = null;
  nodeType = 1;
  data = "";
  className = "";
  isConnected = true;
  start = 0;
  end = 0;
  rectangles: ReturnType<typeof box>[] | undefined;
  constructor(public ownerDocument: TestDocument, public nodeName: string, public bounds = box(0, 0, 0, 0)) {}
  get parentElement() { return this.parentNode; }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.childNodes.map(child => child.textContent).join(""); }
  append(...children: TestNode[]) { for (const child of children) { this.childNodes.push(child); child.parentNode = this; } }
  contains(node: TestNode | null): boolean { return !!node && (node === this || this.childNodes.some(child => child.contains(node))); }
  closest(selectors: string): TestNode | null {
    return selectors.split(",").some(selector => this.className.split(" ").includes(selector.trim().slice(1))) ? this : this.parentNode?.closest(selectors) ?? null;
  }
  getBoundingClientRect() { return this.bounds; }
}
const point = (node: TestNode, offset: number) => node.nodeType === 3 ? node.start + offset : node.childNodes[offset]?.start ?? node.end;
class TestRange {
  startContainer: TestNode;
  endContainer: TestNode;
  startOffset = 0;
  endOffset = 0;
  constructor(doc: TestDocument) { this.startContainer = this.endContainer = doc.root; }
  get collapsed() { return point(this.startContainer, this.startOffset) === point(this.endContainer, this.endOffset); }
  setStart(node: TestNode, offset: number) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node: TestNode, offset: number) { this.endContainer = node; this.endOffset = offset; }
  selectNodeContents(node: TestNode) { this.setStart(node, 0); this.setEnd(node, node.nodeType === 3 ? node.data.length : node.childNodes.length); }
  intersectsNode(node: TestNode) { return node.end > point(this.startContainer, this.startOffset) && node.start < point(this.endContainer, this.endOffset); }
  toString() {
    if (this.startContainer !== this.endContainer || this.startContainer.nodeType !== 3) throw new Error("Only actual text may be serialized");
    return this.startContainer.data.slice(this.startOffset, this.endOffset);
  }
  getClientRects() {
    if (this.startContainer !== this.endContainer || this.startContainer.nodeType !== 3) throw new Error("Container/guard rectangles must never be read");
    const node = this.startContainer, bounds = node.bounds, unit = bounds.width / node.data.length;
    return node.rectangles ?? [box(bounds.left + unit * this.startOffset, bounds.top, bounds.left + unit * this.endOffset, bounds.bottom)];
  }
}
class TestDocument {
  root = new TestNode(this, "ROOT");
  entries: PdfTextPage[] = [];
  nodes = new Map<number, { wrapper: TestNode; layer: TestNode; text: TestNode; span: TestNode }>();
  addPage(page: number, text = page === 1 ? "first tail" : "next begin") {
    const top = (page - 1) * 100;
    const wrapper = new TestNode(this, "DIV", box(0, top, 100, top + 100)), layer = new TestNode(this, "DIV", wrapper.bounds);
    layer.className = "textLayer";
    const span = new TestNode(this, "SPAN", box(10, top + 10, 90, top + 20)), node = new TestNode(this, "#text", span.bounds);
    node.nodeType = 3; node.data = text; span.append(node); layer.append(span); wrapper.append(layer); this.root.append(wrapper);
    const viewport = { convertToPdfPoint: (x: number, y: number) => [x, 100 - y] } as unknown as PageViewport;
    this.entries.push({ page, layer: layer as unknown as HTMLElement, wrapper: wrapper as unknown as HTMLElement, viewport });
    const result = { wrapper, layer, text: node, span }; this.nodes.set(page, result); this.index(); return result;
  }
  index() {
    let cursor = 0;
    const visit = (node: TestNode) => {
      node.start = cursor;
      if (node.nodeType === 3) cursor += node.data.length;
      else if (node.nodeName === "BR") cursor++;
      else for (const child of node.childNodes) visit(child);
      node.end = cursor;
    };
    visit(this.root);
  }
  createRange() { return new TestRange(this); }
  createTreeWalker(root: TestNode) {
    const nodes: TestNode[] = [];
    const visit = (parent: TestNode) => { for (const child of parent.childNodes) { nodes.push(child); visit(child); } };
    visit(root); let index = 0; return { nextNode: () => nodes[index++] ?? null };
  }
  selection(start: TestNode, from: number, end = start, to = start.data.length, reverse = false): Selection {
    this.index(); const range = this.createRange(); range.setStart(start, from); range.setEnd(end, to);
    return { rangeCount: 1, isCollapsed: range.collapsed, getRangeAt: () => range, anchorNode: reverse ? end : start, focusNode: reverse ? start : end, anchorOffset: reverse ? to : from, focusOffset: reverse ? from : to } as unknown as Selection;
  }
}
const middle = (): PageText => ({ page: 2, text: "middle page", words: [{ text: "middle page", rect: [10, 40, 90, 50] }], source: "native", status: "ready", width: 100, height: 100 });
const emptyMiddle = (status: PageText["status"] = "empty"): PageText => ({ ...middle(), status, text: "", words: [] });

describe("page-local collection of a continuous PDF selection", () => {
  for (const reverse of [false, true]) it(`keeps a partial last page and document order for reverse=${reverse}`, () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2);
    const anchor = collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4, reverse), doc.entries);
    expect(anchor).toEqual({ page: 1, quote: "tail\nnext", rects: [[58, 80, 90, 90]], fragments: [
      { page: 1, quote: "tail", rects: [[58, 80, 90, 90]] },
      { page: 2, quote: "next", rects: [[10, 80, 42, 90]] },
    ] });
    expect(anchor!.rects[0]).not.toBe(anchor!.fragments![0].rects[0]);
  });

  it("preserves the old single-page result and excludes unselected text", () => {
    const doc = new TestDocument(), page = doc.addPage(1);
    expect(collectPdfTextSelection(doc.selection(page.text, 2, page.text, 5), doc.entries)).toEqual({ page: 1, quote: "rst", rects: [[26, 80, 50, 90]] });
    expect(collectPdfTextSelection(doc.selection(page.text, 2, page.text, 2), doc.entries)).toBeUndefined();
    expect(collectPdfTextSelection({ rangeCount: 0, isCollapsed: false } as Selection, doc.entries)).toBeUndefined();
  });

  it("keeps page-local coordinates when sheets are joined horizontally", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2);
    last.wrapper.bounds = last.layer.bounds = box(100, 0, 200, 100);
    last.span.bounds = last.text.bounds = box(110, 10, 190, 20);
    const result = collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4), doc.entries);
    expect(result?.quote).toBe("tail\nnext");
    expect(result?.fragments?.map(fragment => fragment.rects)).toEqual([[[58, 80, 90, 90]], [[10, 80, 42, 90]]]);
  });

  it("honors element child offsets and keeps BRs without reading guard/container boxes", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2, "alpha");
    const br = new TestNode(doc, "BR"), guard = new TestNode(doc, "DIV", box(0, 100, 100, 200)); guard.className = "endOfContent";
    const span = new TestNode(doc, "SPAN", box(10, 130, 90, 140)), text = new TestNode(doc, "#text", span.bounds); text.nodeType = 3; text.data = "omega"; span.append(text);
    last.layer.append(br, guard, span); doc.index();
    const toGuard = collectPdfTextSelection(doc.selection(first.text, 6, guard, 0), doc.entries);
    expect(toGuard?.fragments![1]).toEqual({ page: 2, quote: "alpha", rects: [[10, 80, 90, 90]] });
    const toElementOffset = collectPdfTextSelection(doc.selection(first.text, 6, last.layer, 1), doc.entries);
    expect(toElementOffset?.quote).toBe("tail\nalpha");
    const throughLines = collectPdfTextSelection(doc.selection(first.text, 6, text, 2), doc.entries);
    expect(throughLines?.fragments![1]).toEqual({ page: 2, quote: "alpha\nom", rects: [[10, 80, 90, 90], [10, 60, 42, 70]] });
  });

  it("does not turn a next-layer offset-zero boundary into an entire extra page", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2);
    const result = collectPdfTextSelection(doc.selection(first.text, 6, last.layer, 0), doc.entries);
    expect(result).toEqual({ page: 1, quote: "tail", rects: [[58, 80, 90, 90]] });
    expect(result).not.toHaveProperty("fragments");
  });

  it("does not retain an empty first endpoint fragment", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2);
    expect(collectPdfTextSelection(doc.selection(first.layer, 1, last.text, 4), doc.entries)).toEqual({ page: 2, quote: "next", rects: [[10, 80, 42, 90]] });
  });

  it("uses cache only for a strictly interior unmounted page", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(3);
    const result = collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4), doc.entries, new Map([[2, middle()]]));
    expect(result?.quote).toBe("tail\nmiddle page\nnext");
    expect(result?.fragments!.map(fragment => fragment.page)).toEqual([1, 2, 3]);
    expect(result?.fragments![2]).toEqual({ page: 3, quote: "next", rects: [[10, 80, 42, 90]] });
    expect(result?.fragments![1].rects).toEqual([[10, 40, 90, 50]]);
  });

  it("reads a mounted interior layer rather than replacing it with cache text", () => {
    const doc = new TestDocument(), first = doc.addPage(1); doc.addPage(2, "mounted text"); const last = doc.addPage(3);
    const result = collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4), doc.entries, new Map([[2, middle()]]));
    expect(result?.fragments![1].quote).toBe("mounted text");
  });

  for (const reverse of [false, true]) it(`crosses a confirmed empty unmounted middle page for reverse=${reverse}`, () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(3);
    const result = collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4, reverse), doc.entries, new Map([[2, emptyMiddle()]]));
    expect(result?.quote).toBe("tail\nnext");
    expect(result?.fragments?.map(fragment => fragment.page)).toEqual([1, 3]);
    expect(result?.fragments?.[1]).toEqual({ page: 3, quote: "next", rects: [[10, 80, 42, 90]] });
  });

  for (const status of ["empty", "ready"] as const) it(`crosses a mounted empty middle layer confirmed as ${status}`, () => {
    const doc = new TestDocument(), first = doc.addPage(1); doc.addPage(2, ""); const last = doc.addPage(3);
    for (const reverse of [false, true]) {
      const result = collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4, reverse), doc.entries, new Map([[2, emptyMiddle(status)]]));
      expect(result?.quote).toBe("tail\nnext");
      expect(result?.fragments?.map(fragment => fragment.page)).toEqual([1, 3]);
    }
  });

  it("does not interpret a mounted empty layer as confirmation that extraction finished", () => {
    const doc = new TestDocument(), first = doc.addPage(1); doc.addPage(2, ""); const last = doc.addPage(3);
    const selection = doc.selection(first.text, 6, last.text, 4);
    expect(collectPdfTextSelection(selection, doc.entries)).toBeUndefined();
    for (const page of [emptyMiddle("pending"), emptyMiddle("error"), { ...emptyMiddle(), page: 3 }, middle()])
      expect(collectPdfTextSelection(selection, doc.entries, new Map([[2, page]]))).toBeUndefined();
  });

  it("rejects unmounted pending/error or inconsistent empty metadata instead of omitting it", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(3), selection = doc.selection(first.text, 6, last.text, 4);
    for (const page of [emptyMiddle("pending"), emptyMiddle("error"), { ...emptyMiddle(), text: "unresolved text" }, { ...emptyMiddle(), words: middle().words }])
      expect(collectPdfTextSelection(selection, doc.entries, new Map([[2, page]]))).toBeUndefined();
    const result = collectPdfTextSelection(selection, doc.entries, new Map([[2, emptyMiddle("ready")]]));
    expect(result?.fragments?.map(fragment => fragment.page)).toEqual([1, 3]);
  });

  it("rejects missing or unready interior text rather than silently omitting a page", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(3), selection = doc.selection(first.text, 6, last.text, 4);
    expect(collectPdfTextSelection(selection, doc.entries)).toBeUndefined();
    for (const page of [{ ...middle(), status: "pending" as const }, { ...middle(), words: [] }, { ...middle(), text: " " }, { ...middle(), page: 3 }, { ...middle(), words: [{ text: "middle", rect: [0, 0, 0, 0] as [number, number, number, number] }] }])
      expect(collectPdfTextSelection(selection, doc.entries, new Map([[2, page]]))).toBeUndefined();
  });

  it("does not substitute full cache for empty endpoint text or missing endpoint geometry", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2);
    last.text.rectangles = [];
    expect(collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4), doc.entries, new Map([[2, middle()]]))).toBeUndefined();
    last.layer.isConnected = false;
    expect(collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4), doc.entries, new Map([[2, middle()]]))).toBeUndefined();
  });

  it("rejects page chrome and annotation endpoints", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2);
    const annotation = new TestNode(doc, "SPAN"), text = new TestNode(doc, "#text"); annotation.className = "annotation-layer"; text.nodeType = 3; text.data = "note"; annotation.append(text); last.wrapper.append(annotation);
    expect(collectPdfTextSelection(doc.selection(first.text, 6, text, 2), doc.entries)).toBeUndefined();
    last.layer.append(annotation);
    expect(collectPdfTextSelection(doc.selection(first.text, 6, text, 2), doc.entries)).toBeUndefined();
  });

  it("clips actual text boxes to their page and deduplicates them", () => {
    const doc = new TestDocument(), page = doc.addPage(1);
    page.text.rectangles = [box(-20, 10, 120, 20), box(-20, 10, 120, 20), box(200, 200, 220, 220)];
    expect(collectPdfTextSelection(doc.selection(page.text, 0), doc.entries)?.rects).toEqual([[0, 80, 100, 90]]);
  });

  it("converts each page through its own rotated viewport", () => {
    const doc = new TestDocument(), first = doc.addPage(1), last = doc.addPage(2);
    doc.entries[1].viewport = { convertToPdfPoint: (x: number, y: number) => [y, x] } as unknown as PageViewport;
    const result = collectPdfTextSelection(doc.selection(first.text, 6, last.text, 4), doc.entries);
    expect(result?.fragments![0].rects).toEqual([[58, 80, 90, 90]]);
    expect(result?.fragments![1].rects).toEqual([[10, 10, 20, 42]]);
  });
});
