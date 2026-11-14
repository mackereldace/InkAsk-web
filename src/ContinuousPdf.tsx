import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import PdfPage from "./PdfPage";
import type { PDFDocumentProxy } from "./pdf";
import type { Anchor, Note, PageText, Project } from "./types";
import { pageAtReadingPosition, type ReadingDirection } from "./core/pdf-reader";
import { anchorFragments } from "./core/pdf-anchor";
import { collectPdfTextSelection, type PdfTextPage } from "./core/pdf-text-selection";
import { flushBlankTextSelection } from "./core/text-selection-hit";

interface Props {
  pdf: PDFDocumentProxy;
  project: Project;
  scrollRoot: RefObject<HTMLDivElement | null>;
  pageSizes: Map<number, { width: number; height: number }>;
  activeId?: string;
  regionMode: boolean;
  direction?: ReadingDirection;
  selection?: Anchor;
  onSelect: (anchor: Anchor) => void;
  onClearSelection: () => void;
  onFocus: (id: string) => void;
  onPageChange: (page: number) => void;
  onError: (message: string) => void;
}

function Sheet({ pdf, page, text, notes, project, scrollRoot, pageSizes, pinned, onTextLayer, ...props }: Omit<Props, "onPageChange"> & {
  page: number; text?: PageText; notes: Note[]; pinned: boolean; onTextLayer: (entry: PdfTextPage) => () => void;
}) {
  const section = useRef<HTMLElement>(null);
  const [near, setNear] = useState(page === project.view.page);
  const [measured, setMeasured] = useState<{ width: number; height: number; scale: number; rotation: number }>();
  const { scale, rotation } = project.view;
  const swapped = rotation % 180 !== 0;
  const base = pageSizes.get(page) ?? { width: text?.width ?? 600, height: text?.height ?? 800 };
  const size = measured?.scale === scale && measured.rotation === rotation
    ? measured
    : { width: (swapped ? base.height : base.width) * scale,
        height: (swapped ? base.width : base.height) * scale };
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: scrollRoot.current, rootMargin: "1000px 600px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRoot]);
  return (
    <section ref={section} id={`pdf-sheet-${page}`} data-pdf-page={page}
      className="pdf-sheet" aria-label={`PDF 第 ${page} 页`} style={{ width: size.width }}>
      <div className="pdf-sheet-content" style={{ width: size.width, height: size.height }}>
      {near || pinned ? <PdfPage pdf={pdf} page={page} scale={scale} rotation={rotation}
        text={text} notes={notes} regionMode={props.regionMode} selection={props.selection} activeId={props.activeId}
        onSelect={props.onSelect} onTextLayer={onTextLayer} onFocus={props.onFocus} onError={props.onError}
        onSize={({ width, height }) => {
          pageSizes.set(page, { width: (swapped ? height : width) / scale, height: (swapped ? width : height) / scale });
          setMeasured({ width, height, scale, rotation });
        }}
      /> : <div className="pdf-page-placeholder" style={{ width: size.width, height: size.height }} aria-label={`第 ${page} 页，滚动到此处显示`} />}
      </div>
    </section>
  );
}

export default function ContinuousPdf(props: Props) {
  const stack = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const textPages = useRef(new Map<number, PdfTextPage>());
  const pages = useMemo(() => new Map(props.project.pages.map((page) => [page.page, page])), [props.project.pages]);
  const cachedPages = useRef(pages); cachedPages.current = pages;
  const signature = useRef("");
  const [gesture, setGesture] = useState<{ origin: number; focus: number }>();
  const gestureRef = useRef(gesture);
  const collectFrame = useRef(0), finishFrame = useRef(0);
  const collect = useCallback(() => {
    collectFrame.current = 0;
    const root = stack.current;
    if (!root || latest.current.regionMode) return;
    if (!flushBlankTextSelection(root.ownerDocument)) {
      signature.current = ""; latest.current.onClearSelection(); return;
    }
    const selection = root.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const layerAt = (node: Node | null) => node && [...textPages.current.values()].find(entry => entry.layer === node || entry.layer.contains(node));
    const origin = layerAt(selection.anchorNode), focus = layerAt(selection.focusNode);
    if (!origin || !focus) return;
    if (gestureRef.current && gestureRef.current.focus !== focus.page) {
      gestureRef.current = { ...gestureRef.current, focus: focus.page }; setGesture(gestureRef.current);
    }
    const anchor = collectPdfTextSelection(selection, textPages.current.values(), cachedPages.current);
    if (!anchor) {
      if (signature.current) { signature.current = ""; latest.current.onClearSelection(); }
      return;
    }
    const next = JSON.stringify(anchor);
    if (next !== signature.current) { signature.current = next; latest.current.onSelect(anchor); }
  }, []);
  const scheduleCollection = useCallback(() => {
    if (!stack.current?.isConnected) return;
    if (!collectFrame.current) collectFrame.current = requestAnimationFrame(collect);
  }, [collect]);
  const registerTextPage = useCallback((entry: PdfTextPage) => {
    textPages.current.set(entry.page, entry); scheduleCollection();
    return () => {
      if (textPages.current.get(entry.page) === entry) textPages.current.delete(entry.page);
      scheduleCollection();
    };
  }, [scheduleCollection]);
  useEffect(() => {
    const root = stack.current;
    if (!root) return;
    const doc = root.ownerDocument;
    const finish = () => {
      cancelAnimationFrame(finishFrame.current);
      finishFrame.current = requestAnimationFrame(() => {
        finishFrame.current = 0; collect(); gestureRef.current = undefined; setGesture(undefined);
      });
    };
    doc.addEventListener("selectionchange", scheduleCollection);
    doc.addEventListener("pointerup", finish); doc.addEventListener("pointercancel", finish);
    doc.defaultView?.addEventListener("blur", finish);
    return () => {
      doc.removeEventListener("selectionchange", scheduleCollection);
      doc.removeEventListener("pointerup", finish); doc.removeEventListener("pointercancel", finish);
      doc.defaultView?.removeEventListener("blur", finish);
      cancelAnimationFrame(collectFrame.current); cancelAnimationFrame(finishFrame.current);
    };
  }, [collect, scheduleCollection]);
  useEffect(() => { scheduleCollection(); }, [pages, scheduleCollection]);
  useEffect(() => { if (!props.selection) signature.current = ""; }, [props.selection]);
  const onPageChange = useRef(props.onPageChange);
  onPageChange.current = props.onPageChange;
  useEffect(() => {
    const root = props.scrollRoot.current;
    const el = stack.current;
    if (!root || !el) return;
    const visible = new Set<HTMLElement>();
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = root.getBoundingClientRect();
      const current = pageAtReadingPosition([...visible].map((sheet) => ({ page: Number(sheet.dataset.pdfPage), rect: sheet.getBoundingClientRect() })), bounds, props.direction ?? "vertical");
      if (current !== undefined) onPageChange.current(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target as HTMLElement);
        else visible.delete(entry.target as HTMLElement);
      }
      schedule();
    }, { root });
    el.querySelectorAll<HTMLElement>("[data-pdf-page]").forEach((sheet) => observer.observe(sheet));
    root.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(root); resize.observe(el);
    return () => { observer.disconnect(); resize.disconnect(); root.removeEventListener("scroll", schedule); cancelAnimationFrame(frame); };
  }, [props.pdf, props.scrollRoot, props.direction]);
  const notes = useMemo(() => {
    const byPage = new Map<number, Note[]>();
    for (const note of props.project.notes) {
      if (note.parentId) continue;
      for (const fragment of anchorFragments(note.anchor)) {
        const group = byPage.get(fragment.page) ?? [];
        group.push(note); byPage.set(fragment.page, group);
      }
    }
    return byPage;
  }, [props.project.notes]);
  const parts = props.selection ? anchorFragments(props.selection) : [];
  const pinned = new Set(gesture ? [gesture.origin, gesture.focus] : [parts[0]?.page, parts.at(-1)?.page]);
  return <div ref={stack} className={"continuous-pdf direction-" + (props.direction ?? "vertical")} aria-label="PDF 连续阅读"
    onMouseUp={collect} onKeyUp={collect} onTouchEnd={collect}
    onPointerDownCapture={(event) => {
      const target = event.target as Element;
      if (event.button !== 0 || !target.closest(".textLayer")) return;
      const page = Number(target.closest<HTMLElement>("[data-pdf-page]")?.dataset.pdfPage);
      if (!page) return;
      cancelAnimationFrame(finishFrame.current); finishFrame.current = 0; signature.current = "";
      gestureRef.current = { origin: page, focus: page }; setGesture(gestureRef.current);
    }}>
    {Array.from({ length: props.pdf.numPages }, (_, index) => <Sheet {...props} key={index + 1}
      page={index + 1} pinned={pinned.has(index + 1)} onTextLayer={registerTextPage} text={pages.get(index + 1)} notes={notes.get(index + 1) ?? []} />)}
  </div>;
}
