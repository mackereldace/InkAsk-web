import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import PdfPage from "./PdfPage";
import type { PDFDocumentProxy } from "./pdf";
import type { Anchor, Note, PageText, Project } from "./types";
import { collectPdfSelection, guardTextLayerEnd, resetTextLayerEnd, selectionPages, type PdfSelectionPage } from "./core/pdf-selection";
import { pageAtReadingPosition, type ReadingDirection } from "./core/pdf-reader";

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

function Sheet({ pdf, page, text, notes, project, scrollRoot, pageSizes, pinned, registerText, ...props }: Omit<Props, "onPageChange"> & {
  page: number; text?: PageText; notes: Note[]; pinned: boolean;
  registerText: (page: number, entry?: PdfSelectionPage) => void;
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
        renderCanvas={near} registerText={registerText}
        text={text} notes={notes} regionMode={props.regionMode} selection={props.selection} activeId={props.activeId}
        onSelect={props.onSelect} onFocus={props.onFocus} onError={props.onError}
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
  const textPages = useRef(new Map<number, PdfSelectionPage>());
  const [pinned, setPinned] = useState<number[]>([]);
  const pinnedRef = useRef<number[]>([]);
  const selectCallback = useRef(props.onSelect);
  selectCallback.current = props.onSelect;
  const regionMode = useRef(props.regionMode);
  regionMode.current = props.regionMode;
  const registerText = useCallback((page: number, entry?: PdfSelectionPage) => {
    if (entry) textPages.current.set(page, entry); else textPages.current.delete(page);
  }, []);
  const stack = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let pointerDown = false, previous: Range | undefined, lastSelection = "";
    const pin = (pages: number[]) => {
      if (pages.length === pinnedRef.current.length && pages.every((page, i) => page === pinnedRef.current[i])) return;
      pinnedRef.current = pages; setPinned(pages);
    };
    const pageOf = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const sheet = element?.closest<HTMLElement>("[data-pdf-page]");
      return sheet && stack.current?.contains(sheet) ? Number(sheet.dataset.pdfPage) : undefined;
    };
    const reset = () => { for (const { layer } of textPages.current.values()) resetTextLayerEnd(layer); previous = undefined; };
    const changed = () => {
      if (regionMode.current) return;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        // A click starts collapsed before the first selectionchange; retain its origin.
        if (!pointerDown) { pin([]); reset(); lastSelection = ""; }
        return;
      }
      const first = pageOf(selection.anchorNode), last = pageOf(selection.focusNode);
      if (!first || !last) return;
      pin(selectionPages(first, last));
      const anchor = collectPdfSelection(selection, textPages.current.values());
      if (anchor) {
        const signature = JSON.stringify(anchor);
        if (signature !== lastSelection) { lastSelection = signature; selectCallback.current(anchor); }
      }
      if (pointerDown) previous = guardTextLayerEnd(selection, textPages.current.values(), previous);
    };
    const down = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.button !== 0 || !target?.closest(".textLayer") || !stack.current?.contains(target)) return;
      pointerDown = true;
      if (!event.shiftKey) { lastSelection = ""; previous = undefined; }
      const origin = pageOf(target);
      if (origin) pin(event.shiftKey ? [...new Set([...pinnedRef.current, origin])].sort((a, b) => a - b) : [origin]);
    };
    const up = () => { changed(); pointerDown = false; reset(); };
    const blur = () => { pointerDown = false; reset(); };
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", blur);
    document.addEventListener("keyup", changed);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("selectionchange", changed); document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", blur);
      document.removeEventListener("keyup", changed); window.removeEventListener("blur", blur); reset();
    };
  }, [props.pdf]);
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
  const pages = useMemo(() => new Map(props.project.pages.map((page) => [page.page, page])), [props.project.pages]);
  const notes = useMemo(() => {
    const byPage = new Map<number, Note[]>();
    for (const note of props.project.notes) {
      if (note.parentId) continue;
      for (const page of note.anchor.fragments?.map((part) => part.page) ?? [note.anchor.page]) {
        const group = byPage.get(page) ?? [];
        group.push(note); byPage.set(page, group);
      }
    }
    return byPage;
  }, [props.project.notes]);
  return <div ref={stack} className={"continuous-pdf direction-" + (props.direction ?? "vertical")} aria-label="PDF 连续阅读">
    {Array.from({ length: props.pdf.numPages }, (_, index) => <Sheet {...props} key={index + 1}
      pinned={pinned.includes(index + 1)} registerText={registerText}
      page={index + 1} text={pages.get(index + 1)} notes={notes.get(index + 1) ?? []} />)}
  </div>;
}
