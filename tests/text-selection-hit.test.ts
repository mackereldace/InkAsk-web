import { describe, expect, it } from "vitest";
import { registerBlankTextSelection } from "../src/core/text-selection-hit";

const box = (left: number, top: number, right: number, bottom: number) => ({left, top, right, bottom, width:right-left, height:bottom-top});
class TestNode extends EventTarget {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  isConnected = true;
  nodeType = 1;
  data = "";
  className = "";
  constructor(public ownerDocument: TestDocument, public nodeName: string, public bounds = box(0,0,0,0)) { super(); }
  get parentElement() { return this.parentNode; }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.childNodes.map(n=>n.textContent).join(""); }
  append(child: TestNode) { this.childNodes.push(child); child.parentNode = this; }
  contains(node: TestNode | null): boolean { return !!node && (node === this || this.childNodes.some(n=>n.contains(node))); }
  closest(selector: string): TestNode | null { return (selector === "span" ? this.nodeName === "SPAN" : this.className.split(" ").includes(selector.slice(1))) ? this : this.parentNode?.closest(selector) ?? null; }
  getBoundingClientRect() { return this.bounds; }
}
class TestRange {
  startContainer: TestNode;
  endContainer: TestNode;
  startOffset = 0;
  endOffset = 0;
  constructor(private doc: TestDocument) { this.startContainer = this.endContainer = doc.layer; }
  selectNodeContents(node: TestNode) { this.startContainer = this.endContainer = node; this.startOffset = 0; this.endOffset = node.data.length; }
  setStart(node: TestNode, offset: number) { this.startContainer = node; this.startOffset = offset; }
  collapse() { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
  getBoundingClientRect() {
    this.doc.runReads++;
    return this.startContainer.bounds;
  }
  getClientRects() {
    this.doc.caretReads++;
    const node = this.startContainer, bounds = node.bounds;
    const x = bounds.left + (bounds.right - bounds.left) * this.startOffset / node.data.length;
    return [box(x,bounds.top,x,bounds.bottom)];
  }
}
class TestView extends EventTarget {
  frames = new Map<number, FrameRequestCallback>();
  next = 1;
  requestAnimationFrame = (callback: FrameRequestCallback) => { const id = this.next++; this.frames.set(id, callback); return id; };
  cancelAnimationFrame = (id: number) => { this.frames.delete(id); };
  flush() {
    let count = 0;
    while (this.frames.size) {
      if (++count > 20) throw new Error("selectionchange loop");
      const batch = [...this.frames]; this.frames.clear();
      for (const [, callback] of batch) callback(0);
    }
  }
}
class TestDocument extends EventTarget {
  defaultView = new TestView();
  layer = new TestNode(this, "DIV", box(0,0,600,800));
  words: TestNode[] = [];
  runReads = 0;
  caretReads = 0;
  extendCalls: Array<{node:TestNode;offset:number}> = [];
  baseCalls: Array<{anchor:TestNode;anchorOffset:number;focus:TestNode;focusOffset:number}> = [];
  selection: { anchorNode:TestNode; anchorOffset:number; focusNode:TestNode; focusOffset:number; extend:(node:TestNode,offset:number)=>void; setBaseAndExtent:(anchor:TestNode,anchorOffset:number,focus:TestNode,focusOffset:number)=>void };
  constructor() {
    super(); this.layer.className = "textLayer";
    for (const bounds of [box(100,100,200,120),box(140,140,240,160),box(100,180,200,200)]) {
      const span = new TestNode(this,"SPAN",bounds), text = new TestNode(this,"#text",bounds);
      text.nodeType = 3; text.data = "abcdefghij"; span.append(text); this.layer.append(span); this.layer.append(new TestNode(this,"BR")); this.words.push(text);
    }
    this.selection = {
      anchorNode:this.words[0],anchorOffset:2,focusNode:this.words[0],focusOffset:2,
      extend:(node,offset)=>{ this.extendCalls.push({node,offset}); this.selection.focusNode=node; this.selection.focusOffset=offset; this.changed(); },
      setBaseAndExtent:(anchor,anchorOffset,focus,focusOffset)=>{ this.baseCalls.push({anchor,anchorOffset,focus,focusOffset}); Object.assign(this.selection,{anchorNode:anchor,anchorOffset,focusNode:focus,focusOffset}); this.changed(); },
    };
  }
  caretPositionFromPoint() { return { offsetNode:this.words[0], offset:1 }; }
  createRange() { return new TestRange(this); }
  createTreeWalker(root:TestNode) {
    const nodes:TestNode[]=[];
    const visit=(parent:TestNode)=>{for(const child of parent.childNodes){nodes.push(child);visit(child);}};visit(root);
    let index=0;return{nextNode:()=>nodes[index++]??null};
  }
  elementFromPoint(x:number,y:number) { return this.words.find(node=>x>=node.bounds.left&&x<=node.bounds.right&&y>=node.bounds.top&&y<=node.bounds.bottom)?.parentNode ?? this.layer; }
  getSelection() { return this.selection; }
  changed() { this.dispatchEvent(new Event("selectionchange")); }
  pointer(type:string,x:number,y:number, options:Record<string,unknown>={}) {
    const event = new Event(type);
    const fields = {target:this.words[0].parentNode,button:0,buttons:0,pointerType:"mouse",pointerId:1,clientX:x,clientY:y,shiftKey:false,metaKey:false,ctrlKey:false,altKey:false,...options};
    for (const [name,value] of Object.entries(fields)) Object.defineProperty(event,name,{value});
    this.dispatchEvent(event);
  }
  register() { return registerBlankTextSelection(this.layer as unknown as HTMLElement); }
  begin(buttons=0, options:Record<string,unknown>={}) { this.pointer("pointerdown",125,110,{buttons,...options}); this.changed(); }
  move(x=270,y=135, buttons=0) { this.pointer("pointermove",x,y,{buttons}); this.defaultView.flush(); }
}

describe("blank mouse-selection repair", () => {
  for (const buttons of [0,1]) it(`continues to the next line with buttons=${buttons}, retaining the browser's initial anchor`, () => {
    const doc = new TestDocument(), release = doc.register();
    doc.begin(buttons); doc.move(270,135,buttons);
    expect(doc.selection.anchorNode).toBe(doc.words[0]); expect(doc.selection.anchorOffset).toBe(2);
    expect(doc.selection.focusNode).toBe(doc.words[1]); expect(doc.selection.focusOffset).toBe(10);
    expect(doc.extendCalls).toEqual([{node:doc.words[1],offset:10}]); expect(doc.baseCalls).toEqual([]);
    release();
  });
  it("updates the approximate hit-test caret from the first native selectionchange", () => {
    const doc = new TestDocument(), release = doc.register();
    doc.pointer("pointerdown",125,110); doc.selection.anchorOffset=4; doc.selection.focusOffset=4; doc.changed();
    doc.move(); expect(doc.selection.anchorOffset).toBe(4); expect(doc.baseCalls).toEqual([]); release();
  });
  it("restores the recorded origin if a blank native hit changes the anchor", () => {
    const doc = new TestDocument(), release = doc.register();doc.begin();
    doc.pointer("pointermove",270,135);
    doc.selection.anchorNode = doc.words[2]; doc.selection.anchorOffset = 0; doc.changed();
    doc.defaultView.flush();
    expect(doc.baseCalls).toEqual([{anchor:doc.words[0],anchorOffset:2,focus:doc.words[1],focusOffset:10}]);
    expect(doc.selection.anchorNode).toBe(doc.words[0]);expect(doc.selection.anchorOffset).toBe(2);release();
  });
  it("keeps a rightward blank overrun at the current line end", () => {
    const doc = new TestDocument(), release = doc.register();doc.begin();doc.move(300,110);
    expect(doc.selection.focusNode).toBe(doc.words[0]);expect(doc.selection.focusOffset).toBe(10);release();
  });
  it("does not take over real text hits or motion without a pointerdown", () => {
    const doc = new TestDocument(), release = doc.register();
    doc.move(); doc.changed();doc.defaultView.flush();expect(doc.extendCalls).toEqual([]);
    doc.begin();doc.move(170,150);expect(doc.extendCalls).toEqual([]);expect(doc.baseCalls).toEqual([]);release();
  });
  it("does not take over touch or modifier gestures", () => {
    const doc = new TestDocument(), release = doc.register();
    for (const options of [{pointerType:"touch"},{pointerType:"pen"},{shiftKey:true},{metaKey:true},{ctrlKey:true},{altKey:true},{button:2}]) {
      doc.begin(0,options);doc.move();
    }
    expect(doc.extendCalls).toEqual([]);expect(doc.baseCalls).toEqual([]);release();
  });
  for (const event of ["pointerup","pointercancel","blur","unregister"]) it(`stops pending/future repairs after ${event}`, () => {
    const doc = new TestDocument(), release = doc.register();doc.begin();
    doc.pointer("pointermove",270,135);expect(doc.defaultView.frames.size).toBe(1);
    if (event === "blur") doc.defaultView.dispatchEvent(new Event("blur"));
    else if (event === "unregister") release();
    else doc.pointer(event,270,135);
    expect(doc.defaultView.frames.size).toBe(0);
    doc.defaultView.flush();
    const previous = doc.extendCalls.length;doc.move(300,175);doc.changed();doc.defaultView.flush();
    expect(doc.extendCalls.length).toBe(previous);expect(doc.defaultView.frames.size).toBe(0);
    // pointerup performs the last real endpoint repair before finishing.
    expect(previous).toBe(event === "pointerup" ? 1 : 0);release();
  });
  it("stops when a reliable buttons=1 gesture loses its pressed button", () => {
    const doc = new TestDocument(), release = doc.register();doc.begin(1);doc.move(270,135,0);doc.move(270,135,1);
    expect(doc.extendCalls).toEqual([]);release();
  });
  it("caches run/caret geometry across repeated blank moves and avoids selectionchange loops", () => {
    const doc = new TestDocument(), release = doc.register();doc.begin();doc.move();
    const {runReads,caretReads}=doc;expect(caretReads).toBeGreaterThan(0);
    doc.move(280,135);doc.move(290,135);
    expect(doc.runReads).toBe(runReads);expect(doc.caretReads).toBe(caretReads);
    expect(doc.extendCalls).toHaveLength(1);release();
  });
});
