/** PDF.js TextLayerBuilder's empty endpoint guard, without taking over Selection. */
interface LayerEntry { layer: HTMLElement; end: HTMLDivElement; users: number }
interface Controller { layers: Map<HTMLElement, LayerEntry>; forget: (layer: HTMLElement) => void; dispose: () => void }
const controllers = new WeakMap<Document, Controller>();

function reset(entry: LayerEntry) {
  const { layer, end } = entry;
  if (end.parentNode !== layer || end.nextSibling) layer.append(end);
  end.style.width = end.style.height = end.style.userSelect = "";
  layer.classList.remove("selecting");
}

function createController(doc: Document): Controller {
  const layers = new Map<HTMLElement, LayerEntry>();
  const view = doc.defaultView;
  let previous: Range | undefined, pointerDown = false, pointerLayer: HTMLElement | undefined;
  const entryAt = (node: Node | null) => node ? [...layers.values()].find(({ layer }) => layer === node || layer.contains(node)) : undefined;
  const dragging = (active: boolean) => {
    if (active) doc.documentElement.setAttribute("data-pdf-selecting", "true");
    else doc.documentElement.removeAttribute("data-pdf-selecting");
  };
  const resetAll = () => { for (const entry of layers.values()) reset(entry); previous = undefined; };
  const finish = () => { pointerDown = false; pointerLayer = undefined; dragging(false); resetAll(); };
  const down = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    previous = undefined;
    const entry = entryAt(pointer.target as Node | null);
    pointerDown = !!entry;
    pointerLayer = entry?.layer;
    dragging(!!entry && (!pointer.pointerType || pointer.pointerType === "mouse"));
    if (entry) entry.layer.classList.add("selecting");
    else resetAll();
  };
  const keyup = () => { if (!pointerDown) { dragging(false); resetAll(); } };
  const changed = () => {
    const selection = doc.getSelection();
    if (!selection?.rangeCount || (selection.isCollapsed && !pointerDown)) { resetAll(); return; }
    // Only this document's registered PDF layers may be affected.
    const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
    const active = new Set<LayerEntry>();
    for (const entry of layers.values()) {
      if (entry.layer.isConnected && ranges.some(range => range.intersectsNode(entry.layer))) {
        active.add(entry); entry.layer.classList.add("selecting");
      } else reset(entry);
    }
    if (!active.size) { previous = undefined; return; }
    const range = ranges[0];
    const modifyStart = !range.collapsed && (selection.focusNode
      ? selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset
      : !!previous && (range.compareBoundaryPoints(2, previous) === 0 || range.compareBoundaryPoints(1, previous) === 0));
    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === 3) anchor = anchor.parentNode;
    if ((anchor as Element | null)?.classList?.contains("highlight")) anchor = anchor!.parentNode;
    const owner = entryAt(anchor);
    if (!owner || !active.has(owner)) { previous = undefined; return; }
    // Firefox already handles the empty endpoint; match PDF.js's exception.
    if (view?.getComputedStyle(owner.end).getPropertyValue("-moz-user-select") === "none") {
      previous = range.cloneRange(); return;
    }
    if (!modifyStart && range.endOffset === 0) {
      // A boundary at the beginning of a run belongs after the previous nonempty
      // run, including BR/empty siblings. Never walk outside the owning layer.
      let candidate: Node | null = anchor;
      do {
        while (candidate && candidate !== owner.layer && !candidate.previousSibling) candidate = candidate.parentNode;
        if (!candidate || candidate === owner.layer) { candidate = null; break; }
        candidate = candidate.previousSibling;
      } while (candidate && (!candidate.childNodes.length || candidate === owner.end));
      anchor = candidate;
    }
    if (anchor && anchor !== owner.layer && anchor !== owner.end && !owner.end.contains(anchor) && anchor.parentNode && owner.layer.contains(anchor)) {
      const { end, layer } = owner;
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = "text";
      const reference = modifyStart ? anchor : anchor.nextSibling;
      // Reinserting an already correctly placed guard can generate another
      // selectionchange. Keep this operation idempotent.
      if (reference !== end && !(end.parentNode === anchor.parentNode && end.nextSibling === reference))
        anchor.parentNode.insertBefore(end, reference);
    }
    previous = range.cloneRange();
  };
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("pointerup", finish);
  doc.addEventListener("pointercancel", finish);
  doc.addEventListener("selectionchange", changed);
  doc.addEventListener("keyup", keyup);
  view?.addEventListener("blur", finish);
  return { layers, forget(layer) {
    if (pointerLayer === layer) finish();
    else if (previous && (layer.contains(previous.startContainer) || layer.contains(previous.endContainer))) previous = undefined;
  }, dispose() {
    finish();
    doc.removeEventListener("pointerdown", down, true);
    doc.removeEventListener("pointerup", finish);
    doc.removeEventListener("pointercancel", finish);
    doc.removeEventListener("selectionchange", changed);
    doc.removeEventListener("keyup", keyup);
    view?.removeEventListener("blur", finish);
  } };
}

/** Register after native/OCR text has rendered; release before replacing it. */
export function registerTextLayerSelection(layer: HTMLElement): () => void {
  const doc = layer.ownerDocument;
  let controller = controllers.get(doc);
  if (!controller) { controller = createController(doc); controllers.set(doc, controller); }
  let entry = controller.layers.get(layer);
  if (entry) entry.users++;
  else {
    const end = doc.createElement("div");
    end.className = "endOfContent";
    layer.append(end);
    entry = { layer, end, users: 1 };
    controller.layers.set(layer, entry);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry!.users) return;
    controller!.forget(layer); reset(entry!); entry!.end.remove(); controller!.layers.delete(layer);
    if (!controller!.layers.size) { controller!.dispose(); controllers.delete(doc); }
  };
}

/** Empty guard/container boxes must never enlarge a screenshot/highlight. */
export function textSelectionRects(range: Range, layer: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = layer.ownerDocument.createTreeWalker(layer, 4 /* SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent || !range.intersectsNode(node) || node.parentElement?.closest(".endOfContent")) continue;
    const part = layer.ownerDocument.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    if (!part.collapsed) rects.push(...part.getClientRects());
  }
  return rects;
}
