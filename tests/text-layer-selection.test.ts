import { describe, expect, it } from "vitest";
import { registerTextLayerSelection, textSelectionRects } from "../src/core/text-layer-selection";

// Minimal structural DOM fixture: ranges below model text offsets and deliberately
// give the empty guard a page-sized box, so geometry regressions are observable.
class FixtureNode extends EventTarget {
  parentNode: FixtureNode | null = null;
  childNodes: FixtureNode[] = [];
  nodeType = 1;
  style = { width: "", height: "", userSelect: "" };
  attrs = new Map<string, string>();
  classes = new Set<string>();
  classList = { add: (name: string) => { this.classes.add(name); }, remove: (name: string) => { this.classes.delete(name); }, contains: (name: string) => this.classes.has(name) };
  insertions = 0;
  isConnected = true;
  data = "";
  constructor(public ownerDocument: FixtureDocument, public tagName = "DIV") { super(); }
  get className() { return [...this.classes].join(" "); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/)); }
  get parentElement() { return this.parentNode; }
  get previousSibling(): FixtureNode | null { const i = this.parentNode?.childNodes.indexOf(this) ?? -1; return i > 0 ? this.parentNode!.childNodes[i - 1] : null; }
  get nextSibling(): FixtureNode | null { const i = this.parentNode?.childNodes.indexOf(this) ?? -1; return i >= 0 ? this.parentNode!.childNodes[i + 1] ?? null : null; }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.childNodes.map(node => node.textContent).join(""); }
  contains(node: FixtureNode): boolean { return node === this || this.childNodes.some(child => child.contains(node)); }
  closest(selector: string): FixtureNode | null { return this.classList.contains(selector.slice(1)) ? this : this.parentNode?.closest(selector) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  append(node: FixtureNode) { this.insertBefore(node, null); }
  insertBefore(node: FixtureNode, before: FixtureNode | null) {
    node.remove(); const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index, 0, node); node.parentNode = this; this.insertions++;
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
}
class FixtureRange {
  startContainer: FixtureNode;
  endContainer: FixtureNode;
  startOffset: number;
  endOffset: number;
  constructor(start: FixtureNode, from: number, end = start, to = start.textContent.length) {
    this.startContainer = start; this.startOffset = from; this.endContainer = end; this.endOffset = to;
  }
  get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
  selectNodeContents(node: FixtureNode) { this.startContainer = this.endContainer = node; this.startOffset = 0; this.endOffset = node.textContent.length; }
  setStart(node: FixtureNode, offset: number) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node: FixtureNode, offset: number) { this.endContainer = node; this.endOffset = offset; }
  cloneRange() { return new FixtureRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset); }
  compareBoundaryPoints(mode: number, other: FixtureRange) {
    const node = mode === 2 ? this.endContainer : this.startContainer;
    const offset = mode === 2 ? this.endOffset : this.startOffset;
    return node === other.endContainer && offset === other.endOffset ? 0 : 1;
  }
  intersectsNode(node: FixtureNode) {
    if (node.nodeType !== 3) return node.contains(this.startContainer) || node.contains(this.endContainer);
    const text = this.startContainer.ownerDocument.textNodes;
    const index = text.indexOf(node), first = text.indexOf(this.startContainer), last = text.indexOf(this.endContainer);
    return index >= first && index <= last && !(node === this.startContainer && this.startOffset === node.textContent.length) && !(node === this.endContainer && this.endOffset === 0);
  }
  getClientRects() {
    const guard = this.startContainer.classList.contains("endOfContent");
    return [{ left: this.startOffset, right: this.endOffset, top: 10, bottom: guard ? 800 : 20, width: this.endOffset - this.startOffset, height: guard ? 790 : 10 }];
  }
}
class FixtureDocument extends EventTarget {
  documentElement = new FixtureNode(this);
  textNodes: FixtureNode[] = [];
  selection: { rangeCount: number; isCollapsed: boolean; focusNode?: FixtureNode; focusOffset?: number; getRangeAt: (index: number) => FixtureRange } | null = null;
  firefox = false;
  listenerCount = new Map<string, number>();
  defaultView = Object.assign(new EventTarget(), { getComputedStyle: () => ({ getPropertyValue: () => this.firefox ? "none" : "" }) });
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, callback, options); this.listenerCount.set(type, (this.listenerCount.get(type) ?? 0) + 1);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, callback, options); this.listenerCount.set(type, (this.listenerCount.get(type) ?? 0) - 1);
  }
  createElement(tag: string) { return new FixtureNode(this, tag.toUpperCase()); }
  createRange() { return new FixtureRange(this.documentElement, 0); }
  createTreeWalker(layer: FixtureNode) { const text = this.textNodes.filter(node => layer.contains(node)); let index = 0; return { nextNode: () => text[index++] ?? null }; }
  getSelection() { return this.selection; }
  text(value: string) { const node = new FixtureNode(this, "#text"); node.nodeType = 3; node.data = value; this.textNodes.push(node); return node; }
  layer(...words: string[]) {
    const layer = this.createElement("div"); layer.className = "textLayer";
    layer.style.width = "600px"; layer.style.height = "800px";
    for (const word of words) { const span = this.createElement("span"); span.append(this.text(word)); layer.append(span); }
    return layer;
  }
  select(range: FixtureRange, reverse = false) { this.selection = { rangeCount: 1, isCollapsed: range.collapsed, focusNode: reverse ? range.startContainer : range.endContainer, focusOffset: reverse ? range.startOffset : range.endOffset, getRangeAt: () => range }; this.dispatchEvent(new Event("selectionchange")); }
  down(target: FixtureNode, pointerType = "mouse") { const event = new Event("pointerdown"); Object.defineProperties(event, { target: { value: target }, button: { value: 0 }, pointerType: { value: pointerType } }); this.dispatchEvent(event); }
}
const register = (layer: FixtureNode) => registerTextLayerSelection(layer as unknown as HTMLElement);
const rectangles = (range: FixtureRange, layer: FixtureNode) => textSelectionRects(range as unknown as Range, layer as unknown as HTMLElement);

describe("native text-layer endpoint guard", () => {
  it("shares listeners across pages and duplicate registrations; releases its own guard once", () => {
    const doc = new FixtureDocument(), a = doc.layer("alpha"), b = doc.layer("beta");
    const releaseA = register(a), releaseAgain = register(a), releaseB = register(b);
    expect(doc.listenerCount.get("selectionchange")).toBe(1);
    expect(a.childNodes.filter(n => n.className === "endOfContent")).toHaveLength(1);
    releaseA(); expect(a.childNodes).toHaveLength(2);
    releaseAgain(); releaseAgain(); expect(a.childNodes).toHaveLength(1);
    releaseB(); expect(doc.listenerCount.get("selectionchange")).toBe(0);
  });
  it("places the guard after a forward endpoint, before a reverse endpoint and never moves text", () => {
    const doc = new FixtureDocument(), layer = doc.layer("alpha", "beta", "gamma"), spans = [...layer.childNodes];
    const release = register(layer), end = layer.childNodes.at(-1)!;
    const range = new FixtureRange(spans[0].childNodes[0], 1, spans[1].childNodes[0], 2);
    doc.down(spans[0]); expect(doc.documentElement.attrs.get("data-pdf-selecting")).toBe("true");
    doc.select(range); expect(end.previousSibling).toBe(spans[1]);
    expect(end.style).toEqual({ width: "600px", height: "800px", userSelect: "text" });
    const count = layer.insertions; doc.select(range); expect(layer.insertions).toBe(count);
    doc.select(range, true); expect(end.nextSibling).toBe(spans[0]);
    expect(layer.childNodes.filter(node => node !== end)).toEqual(spans);
    release();
  });
  it("protects the initial collapsed caret after App clears the previous selection", () => {
    const doc = new FixtureDocument(), layer = doc.layer("alpha", "beta"), [a] = layer.childNodes;
    const release = register(layer), end = layer.childNodes.at(-1)!;
    doc.down(a);
    doc.selection = null; doc.dispatchEvent(new Event("selectionchange"));
    doc.select(new FixtureRange(a.childNodes[0], 2, a.childNodes[0], 2));
    expect(end.previousSibling).toBe(a);
    expect(layer.classList.contains("selecting")).toBe(true);
    expect(end.style.userSelect).toBe("text");
    expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(true);
    release();
  });
  it("handles endOffset zero through BR/empty siblings without walking outside the layer", () => {
    const doc = new FixtureDocument(), layer = doc.layer("alpha", "beta"), [a, b] = layer.childNodes;
    const br = doc.createElement("br"), empty = doc.createElement("span"); layer.insertBefore(br, b); layer.insertBefore(empty, b);
    const release = register(layer), end = layer.childNodes.at(-1)!;
    doc.select(new FixtureRange(a.childNodes[0], 1, b.childNodes[0], 0));
    expect(end.previousSibling).toBe(a);
    doc.select(new FixtureRange(a.childNodes[0], 0, a.childNodes[0], 0));
    expect(end).toBe(layer.childNodes.at(-1));
    release();
  });
  it("resets unrelated/empty selections, pointerup/cancel and blur; mouse state is separate from selecting class", () => {
    const doc = new FixtureDocument(), layer = doc.layer("alpha", "beta"), release = register(layer), spans = [...layer.childNodes], end = spans.pop()!;
    const range = new FixtureRange(spans[0].childNodes[0], 1, spans[1].childNodes[0], 2);
    for (const type of ["pointerup", "pointercancel", "blur"]) {
      doc.down(spans[0]); doc.select(range);
      (type === "blur" ? doc.defaultView : doc).dispatchEvent(new Event(type));
      expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(false);
      expect(end).toBe(layer.childNodes.at(-1)); expect(end.style.userSelect).toBe("");
      doc.select(range); expect(layer.classList.contains("selecting")).toBe(true);
      expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(false);
    }
    const other = doc.layer("elsewhere"); doc.select(new FixtureRange(other.childNodes[0].childNodes[0], 1));
    expect(layer.classList.contains("selecting")).toBe(false);
    doc.selection = null; doc.dispatchEvent(new Event("selectionchange")); expect(end.style.userSelect).toBe("");
    doc.down(spans[0], "touch"); expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(false);
    release(); expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(false);
  });
  it("does not move the native Firefox endpoint guard", () => {
    const doc = new FixtureDocument(); doc.firefox = true;
    const layer = doc.layer("alpha", "beta"), release = register(layer), end = layer.childNodes.at(-1)!;
    doc.select(new FixtureRange(layer.childNodes[0].childNodes[0], 1));
    expect(end).toBe(layer.childNodes.at(-1)); expect(end.style.userSelect).toBe(""); release();
  });
  it("clears an unmounted dragging layer without removing another page's listeners", () => {
    const doc = new FixtureDocument(), a = doc.layer("alpha"), b = doc.layer("beta"), releaseA = register(a), releaseB = register(b);
    doc.down(a.childNodes[0]); releaseA();
    expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(false);
    expect(doc.listenerCount.get("selectionchange")).toBe(1);
    doc.down(b.childNodes[0]); expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(true);
    releaseB(); expect(doc.documentElement.attrs.has("data-pdf-selecting")).toBe(false);
  });
});

describe("selected text geometry", () => {
  it("clips the first and last text nodes and excludes BRs, guard boxes and other layers", () => {
    const doc = new FixtureDocument(), layer = doc.layer("alpha", "beta", "gamma"), [a, b, c] = layer.childNodes;
    const br = doc.createElement("br"); layer.insertBefore(br, b);
    const release = register(layer), end = layer.childNodes.at(-1)!; layer.insertBefore(end, b);
    doc.layer("another layer");
    const range = new FixtureRange(a.childNodes[0], 2, c.childNodes[0], 3);
    const found = rectangles(range, layer);
    expect(found.map(r => [r.left, r.right, r.height])).toEqual([[2,5,10],[0,4,10],[0,3,10]]);
    expect(rectangles(new FixtureRange(b.childNodes[0], 1, b.childNodes[0], 3), layer).map(r => [r.left,r.right])).toEqual([[1,3]]);
    release();
  });
  it("excludes zero-length boundary text and a nonintersecting layer", () => {
    const doc = new FixtureDocument(), layer = doc.layer("alpha", "beta"), other = doc.layer("elsewhere"), [a,b] = layer.childNodes;
    expect(rectangles(new FixtureRange(a.childNodes[0], 5, b.childNodes[0], 2), layer).map(r => [r.left,r.right])).toEqual([[0,2]]);
    expect(rectangles(new FixtureRange(other.childNodes[0].childNodes[0], 1, other.childNodes[0].childNodes[0], 3), layer)).toEqual([]);
  });
});
