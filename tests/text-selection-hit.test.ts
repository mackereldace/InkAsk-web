import { describe, expect, it } from "vitest";
import { flushBlankTextSelection, registerBlankTextSelection } from "../src/core/text-selection-hit";

const box = (left: number, top: number, right: number, bottom: number) => ({left, top, right, bottom, width:right-left, height:bottom-top});
class TestNode extends EventTarget {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  isConnected = true;
  nodeType = 1;
  data = "";
  className = "";
  verticalCaret = false;
  isSheet = false;
  constructor(public ownerDocument: TestDocument, public nodeName: string, public bounds = box(0,0,0,0)) { super(); }
  get parentElement() { return this.parentNode; }
  get classList() { return { contains: (name: string) => this.className.split(" ").includes(name) }; }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.childNodes.map(n=>n.textContent).join(""); }
  append(child: TestNode) { this.childNodes.push(child); child.parentNode = this; }
  contains(node: TestNode | null): boolean { return !!node && (node === this || this.childNodes.some(n=>n.contains(node))); }
  closest(selector: string): TestNode | null { return (selector === "span" ? this.nodeName === "SPAN" : selector === "[data-pdf-page]" ? this.isSheet : this.className.split(" ").includes(selector.slice(1))) ? this : this.parentNode?.closest(selector) ?? null; }
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
    if (node.verticalCaret) {
      const y = bounds.top + (bounds.bottom - bounds.top) * this.startOffset / node.data.length;
      return [box(bounds.left,y,bounds.right,y)];
    }
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
  scope = new TestNode(this, "DIV", box(0,0,600,800));
  sheet = new TestNode(this, "SECTION", box(0,0,600,800));
  layer = new TestNode(this, "DIV", box(0,0,600,800));
  sheets: TestNode[] = [this.sheet];
  placeholders: Array<{sheet:TestNode;canvas:TestNode}> = [];
  layers: Array<{layer:TestNode;words:TestNode[];sheet:TestNode}> = [];
  words: TestNode[] = [];
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  runReads = 0;
  caretReads = 0;
  removeCalls = 0;
  extendCalls: Array<{node:TestNode;offset:number}> = [];
  baseCalls: Array<{anchor:TestNode;anchorOffset:number;focus:TestNode;focusOffset:number}> = [];
  selection: { anchorNode:TestNode|null; anchorOffset:number; focusNode:TestNode|null; focusOffset:number; rangeCount:number; extend:(node:TestNode,offset:number)=>void; setBaseAndExtent:(anchor:TestNode,anchorOffset:number,focus:TestNode,focusOffset:number)=>void; removeAllRanges:()=>void };
  constructor(public direction: "vertical" | "horizontal" = "vertical") {
    super(); this.scope.className = `continuous-pdf direction-${direction}`; this.layer.className = "textLayer"; this.sheet.isSheet=true;this.scope.append(this.sheet);this.sheet.append(this.layer);
    this.layers.push({layer:this.layer,words:this.addWords(this.layer,0,0),sheet:this.sheet});
    this.selection = {
      anchorNode:this.words[0],anchorOffset:2,focusNode:this.words[0],focusOffset:2,rangeCount:1,
      extend:(node,offset)=>{ this.extendCalls.push({node,offset}); this.selection.focusNode=node; this.selection.focusOffset=offset; this.changed(); },
      setBaseAndExtent:(anchor,anchorOffset,focus,focusOffset)=>{ this.baseCalls.push({anchor,anchorOffset,focus,focusOffset}); Object.assign(this.selection,{anchorNode:anchor,anchorOffset,focusNode:focus,focusOffset}); this.changed(); },
      removeAllRanges:()=>{this.removeCalls++;Object.assign(this.selection,{anchorNode:null,anchorOffset:0,focusNode:null,focusOffset:0,rangeCount:0});this.changed();},
    };
  }
  addWords(layer: TestNode, dx: number, dy: number) {
    const words: TestNode[] = [];
    for (const position of [box(100,100,200,120),box(140,140,240,160),box(100,180,200,200)]) {
      const bounds = box(position.left+dx,position.top+dy,position.right+dx,position.bottom+dy);
      const span = new TestNode(this,"SPAN",bounds), text = new TestNode(this,"#text",bounds);
      text.nodeType = 3; text.data = "abcdefghij"; span.append(text); layer.append(span); layer.append(new TestNode(this,"BR")); this.words.push(text); words.push(text);
    }
    return words;
  }
  addSheet() {
    const index = this.sheets.length, dx = this.direction === "horizontal" ? index * 600 : 0, dy = this.direction === "vertical" ? index * 800 : 0;
    const sheet = new TestNode(this,"SECTION",box(dx,dy,dx+600,dy+800));sheet.isSheet=true;this.scope.append(sheet);this.sheets.push(sheet);return sheet;
  }
  addPage(sheet=this.addSheet()) {
    const {left:dx,top:dy}=sheet.bounds;
    const layer = new TestNode(this,"DIV",sheet.bounds); layer.className="textLayer"; sheet.append(layer);
    const page={layer,words:this.addWords(layer,dx,dy),sheet}; this.layers.push(page); return page;
  }
  addPlaceholder() {
    const sheet=this.addSheet(), canvas=new TestNode(this,"CANVAS",sheet.bounds);sheet.append(canvas);
    const placeholder={sheet,canvas};this.placeholders.push(placeholder);return placeholder;
  }
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type,callback,options);
    if (callback) { const listeners=this.listeners.get(type)??new Set();listeners.add(callback);this.listeners.set(type,listeners); }
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type,callback,options);if(callback)this.listeners.get(type)?.delete(callback);
  }
  caretPositionFromPoint(x: number, y: number) {
    const node=this.words.find(node=>x>=node.bounds.left&&x<=node.bounds.right&&y>=node.bounds.top&&y<=node.bounds.bottom);
    if(!node)return null;
    const bounds=node.bounds, fraction=node.verticalCaret?(y-bounds.top)/(bounds.bottom-bounds.top):(x-bounds.left)/(bounds.right-bounds.left);
    return {offsetNode:node,offset:Math.round(fraction*node.data.length)};
  }
  createRange() { return new TestRange(this); }
  createTreeWalker(root:TestNode) {
    const nodes:TestNode[]=[];
    const visit=(parent:TestNode)=>{for(const child of parent.childNodes){nodes.push(child);visit(child);}};visit(root);
    let index=0;return{nextNode:()=>nodes[index++]??null};
  }
  elementFromPoint(x:number,y:number) { return this.words.find(node=>x>=node.bounds.left&&x<=node.bounds.right&&y>=node.bounds.top&&y<=node.bounds.bottom)?.parentNode
    ?? this.layers.find(({layer})=>x>=layer.bounds.left&&x<=layer.bounds.right&&y>=layer.bounds.top&&y<=layer.bounds.bottom)?.layer
    ?? this.placeholders.find(({sheet})=>x>=sheet.bounds.left&&x<=sheet.bounds.right&&y>=sheet.bounds.top&&y<=sheet.bounds.bottom)?.canvas ?? this.scope; }
  getSelection() { return this.selection; }
  changed() { this.dispatchEvent(new Event("selectionchange")); }
  pointer(type:string,x:number,y:number, options:Record<string,unknown>={}) {
    const event = new Event(type);
    const fields = {target:this.elementFromPoint(x,y),button:0,buttons:0,pointerType:"mouse",pointerId:1,clientX:x,clientY:y,shiftKey:false,metaKey:false,ctrlKey:false,altKey:false,...options};
    for (const [name,value] of Object.entries(fields)) Object.defineProperty(event,name,{value});
    this.dispatchEvent(event);
  }
  register(layer=this.layer, vertical=false) { return registerBlankTextSelection(layer as unknown as HTMLElement,vertical); }
  begin(buttons=0, options:Record<string,unknown>={}) { this.pointer("pointerdown",125,110,{buttons,...options}); this.changed(); }
  beginOn(node:TestNode, offset=2, buttons=0) {
    Object.assign(this.selection,{anchorNode:node,anchorOffset:offset,focusNode:node,focusOffset:offset,rangeCount:1});
    this.pointer("pointerdown",node.bounds.left+(node.bounds.right-node.bounds.left)*offset/node.data.length,(node.bounds.top+node.bounds.bottom)/2,{buttons});this.changed();
  }
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

describe("continuous PDF mouse endpoints", () => {
  for (const direction of ["vertical","horizontal"] as const) {
    it(`ends midway through the second page's actual line in ${direction} layout`, () => {
      const doc=new TestDocument(direction), page=doc.addPage(), release1=doc.register(), release2=doc.register(page.layer);
      doc.begin();
      // Model the reported failure: the native focus lands at the layer end.
      doc.selection.focusNode=page.layer;doc.selection.focusOffset=page.layer.childNodes.length;
      const target=page.words[0].bounds;doc.move((target.left+target.right)/2,(target.top+target.bottom)/2);
      expect(doc.selection.anchorNode).toBe(doc.words[0]);expect(doc.selection.anchorOffset).toBe(2);
      expect(doc.selection.focusNode).toBe(page.words[0]);expect(doc.selection.focusOffset).toBe(5);
      expect(doc.extendCalls).toEqual([{node:page.words[0],offset:5}]);
      expect(doc.baseCalls).toEqual([]);release1();release2();
    });

    it(`retains a second-page origin while dragging backward in ${direction} layout`, () => {
      const doc=new TestDocument(direction), page=doc.addPage(), release1=doc.register(), release2=doc.register(page.layer);
      doc.beginOn(page.words[0],2);
      doc.selection.focusNode=doc.layer;doc.selection.focusOffset=0;
      doc.move(150,110);
      expect(doc.selection.anchorNode).toBe(page.words[0]);expect(doc.selection.anchorOffset).toBe(2);
      expect(doc.selection.focusNode).toBe(doc.words[0]);expect(doc.selection.focusOffset).toBe(5);
      expect(doc.extendCalls).toEqual([{node:doc.words[0],offset:5}]);release1();release2();
    });

    it(`projects second-page blank space to the adjacent line in ${direction} layout`, () => {
      const doc=new TestDocument(direction), page=doc.addPage(), release1=doc.register(), release2=doc.register(page.layer);
      doc.begin();const word=page.words[1];doc.move(word.bounds.right+30,word.bounds.top-5);
      expect(doc.selection.anchorNode).toBe(doc.words[0]);expect(doc.selection.focusNode).toBe(word);expect(doc.selection.focusOffset).toBe(10);
      expect(doc.selection.focusNode).not.toBe(page.words[2]);release1();release2();
    });

    it(`returns precisely to the origin page after crossing in ${direction} layout`, () => {
      const doc=new TestDocument(direction), page=doc.addPage(), release1=doc.register(), release2=doc.register(page.layer);
      doc.begin();const target=page.words[0].bounds;doc.move((target.left+target.right)/2,(target.top+target.bottom)/2);
      doc.selection.focusNode=doc.layer;doc.selection.focusOffset=doc.layer.childNodes.length;
      doc.move(150,110);
      expect(doc.selection.anchorNode).toBe(doc.words[0]);expect(doc.selection.anchorOffset).toBe(2);
      expect(doc.selection.focusNode).toBe(doc.words[0]);expect(doc.selection.focusOffset).toBe(5);
      release1();release2();
    });
  }

  it("shares document listeners across two pages and duplicate registrations", () => {
    const doc=new TestDocument(), page=doc.addPage(), release1=doc.register(), duplicate=doc.register(), release2=doc.register(page.layer);
    for(const type of ["pointerdown","pointermove","pointerup","pointercancel","selectionchange"])
      expect(doc.listeners.get(type)?.size).toBe(1);
    release1();expect(doc.listeners.get("pointerdown")?.size).toBe(1);
    doc.begin();doc.move(150,910);expect(doc.selection.focusNode).toBe(page.words[0]);
    duplicate();release2();
    for(const listeners of doc.listeners.values())expect(listeners.size).toBe(0);
    expect(doc.defaultView.frames.size).toBe(0);
  });

  it("cancels an unregistered origin without disabling the remaining page", () => {
    const doc=new TestDocument(), page=doc.addPage(), release1=doc.register(), release2=doc.register(page.layer);
    doc.begin();doc.pointer("pointermove",150,910);expect(doc.defaultView.frames.size).toBe(1);
    release1();expect(doc.defaultView.frames.size).toBe(0);
    doc.move(150,910);expect(doc.extendCalls).toEqual([]);
    doc.beginOn(page.words[0],2);doc.move(270,935);
    expect(doc.selection.anchorNode).toBe(page.words[0]);expect(doc.selection.anchorOffset).toBe(2);
    expect(doc.selection.focusNode).toBe(page.words[1]);expect(doc.selection.focusOffset).toBe(10);
    release2();
  });

  it("flushes a queued cross-page endpoint before the caller collects its range", () => {
    const doc=new TestDocument(), page=doc.addPage(), release1=doc.register(), release2=doc.register(page.layer);
    doc.begin();doc.pointer("pointermove",150,910);
    doc.selection.focusNode=page.layer;doc.selection.focusOffset=page.layer.childNodes.length;
    expect(doc.defaultView.frames.size).toBe(1);
    flushBlankTextSelection(doc as unknown as Document);
    const collected={node:doc.selection.focusNode,offset:doc.selection.focusOffset};
    expect(collected).toEqual({node:page.words[0],offset:5});
    doc.defaultView.flush();expect(doc.extendCalls).toHaveLength(1);
    doc.pointer("pointerup",150,910);expect(doc.defaultView.frames.size).toBe(0);
    release1();release2();
  });

  it("uses a target page's rotated text axis independently of the horizontal page stack", () => {
    const doc=new TestDocument("horizontal"), page=doc.addPage();
    page.words.forEach((node,index)=>{
      node.bounds=box(700+index*40,100,720+index*40,200);node.parentNode!.bounds=node.bounds;node.verticalCaret=true;
    });
    const release1=doc.register(), release2=doc.register(page.layer,true);
    doc.begin();doc.move(735,150);
    expect(doc.selection.anchorNode).toBe(doc.words[0]);expect(doc.selection.focusNode).toBe(page.words[1]);expect(doc.selection.focusOffset).toBe(5);
    release1();release2();
  });

  it("reuses the target page's geometry until a scroll invalidates it", () => {
    const doc=new TestDocument(), page=doc.addPage(), release1=doc.register(), release2=doc.register(page.layer);
    doc.begin();doc.move(270,935);const reads={runs:doc.runReads,carets:doc.caretReads};
    expect(reads.runs).toBe(3);expect(reads.carets).toBeGreaterThan(0);
    doc.move(280,935);expect(doc.runReads).toBe(reads.runs);expect(doc.caretReads).toBe(reads.carets);
    doc.defaultView.dispatchEvent(new Event("scroll"));doc.defaultView.flush();
    expect(doc.runReads).toBeGreaterThan(reads.runs);expect(doc.caretReads).toBeGreaterThan(reads.carets);
    release1();release2();
  });
});

describe("pending endpoint pages", () => {
  for (const direction of ["vertical", "horizontal"] as const) {
    it(`never substitutes the previous ready page for a ${direction} placeholder`, () => {
      const doc = new TestDocument(direction), placeholder = doc.addPlaceholder(), release = doc.register();
      const x = placeholder.sheet.bounds.left + 150, y = placeholder.sheet.bounds.top + 110;
      doc.begin(); doc.move(x, y);
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(false);
      expect(doc.extendCalls).toEqual([]); expect(doc.baseCalls).toEqual([]);
      doc.pointer("pointerup", x, y);
      expect(doc.removeCalls).toBe(1); expect(doc.selection.rangeCount).toBe(0);
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(false);
      doc.dispatchEvent(new Event("keydown"));
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(true);
      doc.beginOn(doc.words[0]); doc.move(300, 110);
      expect(doc.selection.focusNode).toBe(doc.words[0]); expect(doc.selection.focusOffset).toBe(10);
      release();
    });
    it(`rejects an unregistered text layer in ${direction} layout`, () => {
      const doc = new TestDocument(direction), page = doc.addPage(), release = doc.register();
      const bounds = page.words[0].bounds;
      doc.begin(); doc.move((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(false);
      expect(doc.extendCalls).toEqual([]); expect(doc.baseCalls).toEqual([]);
      release();
    });
    it(`resolves the actual ${direction} endpoint when its page finishes registering`, () => {
      const doc = new TestDocument(direction), placeholder = doc.addPlaceholder(), release1 = doc.register();
      const x = placeholder.sheet.bounds.left + 150, y = placeholder.sheet.bounds.top + 110;
      doc.begin(); doc.move(x, y);
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(false);
      const page = doc.addPage(placeholder.sheet), release2 = doc.register(page.layer);
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(true);
      expect(doc.selection.anchorNode).toBe(doc.words[0]); expect(doc.selection.anchorOffset).toBe(2);
      expect(doc.selection.focusNode).toBe(page.words[0]); expect(doc.selection.focusOffset).toBe(5);
      doc.pointer("pointerup", x, y); expect(doc.removeCalls).toBe(0);
      release1(); release2();
    });
    it(`can return to ready text after entering a ${direction} pending sheet`, () => {
      const doc = new TestDocument(direction), placeholder = doc.addPlaceholder(), release = doc.register();
      doc.begin(); doc.move(placeholder.sheet.bounds.left + 150, placeholder.sheet.bounds.top + 110);
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(false);
      doc.move(300, 110);
      expect(flushBlankTextSelection(doc as unknown as Document)).toBe(true);
      expect(doc.selection.focusNode).toBe(doc.words[0]); expect(doc.selection.focusOffset).toBe(10);
      release();
    });
  }
});
