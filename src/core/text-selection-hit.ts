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
  const legacy = modern ? undefined : doc.caretRangeFromPoint?.(x, y);
  const node = modern?.offsetNode ?? legacy?.startContainer, offset = modern?.offset ?? legacy?.startOffset;
  if (node?.nodeType === 3 && layer.contains(node) && !node.parentElement?.closest(".endOfContent") && offset !== undefined)
    return { node: node as Text, offset };
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

/** Repair only empty-space mouse endpoints. Native text, touch and keyboard stay native. */
export function registerBlankTextSelection(layer: HTMLElement, vertical = false): () => void {
  const doc = layer.ownerDocument, view = doc.defaultView;
  if (!view) return () => {};
  let drag: { anchor: Caret; start: { x: number; y: number }; point: { x: number; y: number }; moved: boolean; direction: -1 | 0 | 1; pointerId: number; reliableButtons: boolean } | undefined;
  let lines: TextRun[][] | undefined, frame = 0;
  const stop = () => { drag = undefined; lines = undefined; view.cancelAnimationFrame(frame); frame = 0; };
  const repair = () => {
    frame = 0;
    if (!drag?.moved || !layer.isConnected || !drag.anchor.node.isConnected) return;
    const { point, anchor } = drag, bounds = layer.getBoundingClientRect();
    const primary = vertical ? point.x : point.y;
    if (primary < (vertical ? bounds.left : bounds.top) || primary > (vertical ? bounds.right : bounds.bottom)) return;
    const hit = doc.elementFromPoint(point.x, point.y);
    if (hit?.closest(".textLayer") && !layer.contains(hit)) return;
    const span = hit?.closest("span");
    if (span && layer.contains(span) && inside(span.getBoundingClientRect(), point.x, point.y)) return;
    lines ??= textLines(layer, vertical);
    const run = blankTextTarget(lines, point, drag.direction, vertical);
    if (!run) return;
    const target = runCaret(run, point, vertical), selection = doc.getSelection();
    if (!selection || (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset && selection.focusNode === target.node && selection.focusOffset === target.offset)) return;
    if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset)
      selection.extend(target.node, target.offset);
    else selection.setBaseAndExtent(anchor.node, anchor.offset, target.node, target.offset);
  };
  const schedule = () => { if (drag?.moved && !frame) frame = view.requestAnimationFrame(repair); };
  const down = (event: PointerEvent) => {
    stop();
    if (event.button !== 0 || (event.pointerType && event.pointerType !== "mouse") || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !layer.contains(event.target as Node)) return;
    const anchor = nativeCaret(doc, event.clientX, event.clientY, layer);
    if (!anchor) return;
    const point = { x: event.clientX, y: event.clientY };
    drag = { anchor, start: point, point, moved: false, direction: 0, pointerId: event.pointerId, reliableButtons: !!(event.buttons & 1) };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    // Some WebKit mouse input reports buttons=0 even on pointerdown. In that
    // case the observed down/up lifecycle, rather than buttons, owns the drag.
    if (drag.reliableButtons && !(event.buttons & 1)) { stop(); return; }
    const delta = vertical ? event.clientX - drag.point.x : event.clientY - drag.point.y;
    if (Math.abs(delta) > 0.5) drag.direction = delta > 0 ? 1 : -1;
    drag.point = { x: event.clientX, y: event.clientY };
    drag.moved ||= Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) >= 3;
    schedule();
  };
  const changed = () => {
    if (!drag) return;
    const selection = doc.getSelection();
    if (!drag.moved && selection?.anchorNode?.nodeType === 3 && layer.contains(selection.anchorNode))
      drag.anchor = { node: selection.anchorNode as Text, offset: selection.anchorOffset };
    schedule();
  };
  const up = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.point = { x: event.clientX, y: event.clientY };
    view.cancelAnimationFrame(frame); frame = 0;
    repair(); stop();
  };
  const scroll = () => { lines = undefined; schedule(); };
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("pointermove", move);
  doc.addEventListener("pointerup", up);
  doc.addEventListener("pointercancel", stop);
  doc.addEventListener("selectionchange", changed);
  view.addEventListener("scroll", scroll, true); view.addEventListener("blur", stop); view.addEventListener("resize", scroll);
  return () => {
    stop();
    doc.removeEventListener("pointerdown", down, true); doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up);
    doc.removeEventListener("pointercancel", stop); doc.removeEventListener("selectionchange", changed);
    view.removeEventListener("scroll", scroll, true); view.removeEventListener("blur", stop); view.removeEventListener("resize", scroll);
  };
}
