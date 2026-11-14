import { blankTextTarget, type SelectionBox } from "./text-selection-layout";

interface TextRun extends SelectionBox { node: Text; carets?: Array<{ offset: number; coordinate: number }> }
interface Caret { node: Text; offset: number }
const inside = (box: SelectionBox, x: number, y: number) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/** BRs are PDF.js's real line boundaries, including formula superscripts. */
function textLines(layer: HTMLElement, vertical: boolean): TextRun[][] {
  const doc = layer.ownerDocument, walker = doc.createTreeWalker(layer, 5 /* elements and text */);
  const explicit: TextRun[][] = [], runs: TextRun[] = [];
  let line: TextRun[] = [], hasBreaks = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1 && node.nodeName === "BR") {
      hasBreaks = true;
      if (line.length) explicit.push(line);
      line = [];
    } else if (node.nodeType === 3 && node.textContent && !node.parentElement?.closest(".endOfContent")) {
      const range = doc.createRange(); range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      const run = { node: node as Text, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      line.push(run); runs.push(run);
    }
  }
  if (line.length) explicit.push(line);
  if (hasBreaks) return explicit;
  // OCR words have no BRs. Group overlapping visual rows without changing DOM.
  const rows: TextRun[][] = [];
  for (const run of runs) {
    const start = vertical ? run.left : run.top, end = vertical ? run.right : run.bottom;
    const row = rows.find(row => {
      const first = row[0], a = vertical ? first.left : first.top, b = vertical ? first.right : first.bottom;
      return Math.min(end, b) - Math.max(start, a) > Math.min(end - start, b - a) * 0.5;
    });
    if (row) row.push(run); else rows.push([run]);
  }
  return rows;
}

function nativeCaret(doc: Document, x: number, y: number, layer: HTMLElement): Caret | undefined {
  const modern = (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(x, y);
  const valid = (node?: Node, offset?: number): Caret | undefined => node?.nodeType === 3 && layer.contains(node) && !node.parentElement?.closest(".endOfContent") && offset !== undefined
    ? { node: node as Text, offset } : undefined;
  const found = valid(modern?.offsetNode, modern?.offset);
  if (found) return found;
  const legacy = doc.caretRangeFromPoint?.(x, y);
  return valid(legacy?.startContainer, legacy?.startOffset);
}

/** Use actual caret geometry, preserving ligatures, CJK and UTF-16 boundaries. */
function runCaret(run: TextRun, point: { x: number; y: number }, vertical: boolean): Caret {
  const node = run.node, range = node.ownerDocument.createRange();
  const coordinate = vertical ? point.y : point.x;
  let offset = 0, best = Infinity;
  const boundaries = [0]; let end = 0;
  for (const character of node.data) { end += character.length; boundaries.push(end); }
  if (!run.carets) {
    run.carets = [];
    for (const boundary of boundaries) {
      range.setStart(node, boundary); range.collapse(true);
      const rect = range.getClientRects()[0];
      if (rect && (rect.height || rect.width)) run.carets.push({ offset: boundary, coordinate: vertical ? rect.top : rect.left });
    }
  }
  for (const caret of run.carets) {
    const distance = Math.abs(coordinate - caret.coordinate);
    if (distance < best) { best = distance; offset = caret.offset; }
  }
  if (!run.carets.length) {
    const from = vertical ? run.top : run.left, to = vertical ? run.bottom : run.right;
    const index = Math.round(Math.max(0, Math.min(1, (coordinate - from) / Math.max(1, to - from))) * (boundaries.length - 1));
    offset = boundaries[index];
  }
  return { node, offset };
}

interface TextLayerEntry { layer: HTMLElement; vertical: boolean; users: number; lines?: TextRun[][] }
interface HitController {
  entries: Map<HTMLElement, TextLayerEntry>;
  flush: () => boolean;
  forget: (entry: TextLayerEntry) => void;
  dispose: () => void;
}
const hitControllers = new WeakMap<Document, HitController>();

function createHitController(doc: Document): HitController {
  const view = doc.defaultView!;
  const entries = new Map<HTMLElement, TextLayerEntry>();
  let drag: { origin: TextLayerEntry; anchor: Caret; start: { x: number; y: number }; point: { x: number; y: number }; moved: boolean; xDirection: -1 | 0 | 1; yDirection: -1 | 0 | 1; crossed: boolean; pointerId: number; reliableButtons: boolean } | undefined;
  let frame = 0, pendingEndpoint = false;
  const clearGeometry = () => { for (const entry of entries.values()) entry.lines = undefined; };
  const stop = () => { drag = undefined; clearGeometry(); view.cancelAnimationFrame(frame); frame = 0; };
  const entryAt = (node: Node | null) => node ? [...entries.values()].find(entry => entry.layer === node || entry.layer.contains(node)) : undefined;
  const targetAt = (point: { x: number; y: number }, hit: Element | null): TextLayerEntry | undefined => {
    if (!drag) return;
    const scope = drag.origin.layer.closest(".continuous-pdf"), direct = entryAt(hit);
    if (direct && direct.layer.closest(".continuous-pdf") === scope) return direct;
    // A visible sheet whose text is still rendering is not the preceding page.
    const sheet = hit?.closest("[data-pdf-page]");
    if (scope && sheet && scope.contains(sheet)) {
      const ownPage = [...entries.values()].find(entry => sheet.contains(entry.layer));
      if (!ownPage) { pendingEndpoint = true; return; }
      return ownPage;
    }
    if (hit?.closest(".textLayer")) return;
    const horizontal = scope?.classList.contains("direction-horizontal") ?? false;
    const distance = (entry: TextLayerEntry) => {
      const box = entry.layer.getBoundingClientRect();
      const x = Math.max(box.left - point.x, point.x - box.right, 0), y = Math.max(box.top - point.y, point.y - box.bottom, 0);
      return horizontal ? x + y * .001 : y + x * .001;
    };
    return [...entries.values()].filter(entry => entry.layer.isConnected && entry.layer.closest(".continuous-pdf") === scope)
      .sort((a, b) => distance(a) - distance(b))[0];
  };
  const repair = (): boolean => {
    frame = 0;
    if (!drag?.moved) return !pendingEndpoint;
    if (!drag.origin.layer.isConnected || !drag.anchor.node.isConnected) { pendingEndpoint = true; return false; }
    const { point, anchor } = drag;
    const hit = doc.elementFromPoint(point.x, point.y);
    pendingEndpoint = false;
    const entry = targetAt(point, hit);
    if (!entry) return !pendingEndpoint;
    const { layer, vertical } = entry;
    if (entry !== drag.origin) drag.crossed = true;
    const span = hit?.closest("span");
    const onText = span && layer.contains(span) && inside(span.getBoundingClientRect(), point.x, point.y);
    if (onText && !drag.crossed) return true;
    let target = onText ? nativeCaret(doc, point.x, point.y, layer) : undefined;
    if (!target || !span?.contains(target.node)) {
      entry.lines ??= textLines(layer, vertical);
      const run = onText ? entry.lines.flat().find(run => inside(run, point.x, point.y))
        : blankTextTarget(entry.lines, point, vertical ? drag.xDirection : drag.yDirection, vertical);
      if (!run) return true;
      target = runCaret(run, point, vertical);
    }
    const selection = doc.getSelection();
    if (!selection || (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset && selection.focusNode === target.node && selection.focusOffset === target.offset)) return true;
    if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset)
      selection.extend(target.node, target.offset);
    else selection.setBaseAndExtent(anchor.node, anchor.offset, target.node, target.offset);
    return true;
  };
  const schedule = () => { if (drag?.moved && !frame) frame = view.requestAnimationFrame(repair); };
  const down = (event: PointerEvent) => {
    stop();
    pendingEndpoint = false;
    if (event.button !== 0 || (event.pointerType && event.pointerType !== "mouse") || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const origin = entryAt(event.target as Node);
    if (!origin) return;
    const anchor = nativeCaret(doc, event.clientX, event.clientY, origin.layer);
    if (!anchor) return;
    const point = { x: event.clientX, y: event.clientY };
    drag = { origin, anchor, start: point, point, moved: false, xDirection: 0, yDirection: 0, crossed: false, pointerId: event.pointerId, reliableButtons: !!(event.buttons & 1) };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    // Some WebKit mouse input reports buttons=0 even on pointerdown. In that
    // case the observed down/up lifecycle, rather than buttons, owns the drag.
    if (drag.reliableButtons && !(event.buttons & 1)) { stop(); return; }
    const dx = event.clientX - drag.point.x, dy = event.clientY - drag.point.y;
    if (Math.abs(dx) > .5) drag.xDirection = dx > 0 ? 1 : -1;
    if (Math.abs(dy) > .5) drag.yDirection = dy > 0 ? 1 : -1;
    drag.point = { x: event.clientX, y: event.clientY };
    drag.moved ||= Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) >= 3;
    schedule();
  };
  const changed = () => {
    if (!drag) return;
    const selection = doc.getSelection();
    if (!drag.moved && selection?.anchorNode?.nodeType === 3 && drag.origin.layer.contains(selection.anchorNode))
      drag.anchor = { node: selection.anchorNode as Text, offset: selection.anchorOffset };
    schedule();
  };
  const up = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.point = { x: event.clientX, y: event.clientY };
    view.cancelAnimationFrame(frame); frame = 0;
    if (!repair()) doc.getSelection()?.removeAllRanges();
    stop();
  };
  const scroll = () => { clearGeometry(); schedule(); };
  const keyboard = () => { if (!drag) pendingEndpoint = false; };
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("pointermove", move);
  doc.addEventListener("pointerup", up);
  doc.addEventListener("pointercancel", stop);
  doc.addEventListener("selectionchange", changed);
  doc.addEventListener("keydown", keyboard);
  view.addEventListener("scroll", scroll, true); view.addEventListener("blur", stop); view.addEventListener("resize", scroll);
  return { entries, flush() { view.cancelAnimationFrame(frame); frame = 0; return repair(); }, forget(entry) {
    if (drag?.origin === entry) { pendingEndpoint = true; stop(); }
  }, dispose() {
    stop();
    doc.removeEventListener("pointerdown", down, true); doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up);
    doc.removeEventListener("pointercancel", stop); doc.removeEventListener("selectionchange", changed);
    doc.removeEventListener("keydown", keyboard);
    view.removeEventListener("scroll", scroll, true); view.removeEventListener("blur", stop); view.removeEventListener("resize", scroll);
  } };
}

/** Single document gesture retains its origin while crossing registered pages. */
export function registerBlankTextSelection(layer: HTMLElement, vertical = false): () => void {
  const doc = layer.ownerDocument;
  if (!doc.defaultView) return () => {};
  let controller = hitControllers.get(doc);
  if (!controller) { controller = createHitController(doc); hitControllers.set(doc, controller); }
  let entry = controller.entries.get(layer);
  if (entry) entry.users++;
  else { entry = { layer, vertical, users: 1 }; controller.entries.set(layer, entry); }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (--entry!.users) return;
    controller!.forget(entry!); controller!.entries.delete(layer);
    if (!controller!.entries.size) { controller!.dispose(); hitControllers.delete(doc); }
  };
}

/** Collection must follow endpoint repair, including the final mouseup. */
export function flushBlankTextSelection(doc: Document): boolean {
  return hitControllers.get(doc)?.flush() ?? true;
}
