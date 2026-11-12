import { useEffect, useRef, useState, type RefObject } from "react";
import PdfPage from "./PdfPage";
import type { PDFDocumentProxy } from "./pdf";
import type { Anchor, Note, PageText, Project } from "./types";

interface Props {
  pdf: PDFDocumentProxy;
  project: Project;
  scrollRoot: RefObject<HTMLDivElement | null>;
  pageSizes: Map<number, { width: number; height: number }>;
  activeId?: string;
  regionMode: boolean;
  onSelect: (anchor: Anchor) => void;
  onClearSelection: () => void;
  onFocus: (id: string) => void;
  onPageChange: (page: number) => void;
  onError: (message: string) => void;
}

function Sheet({ pdf, page, text, notes, project, scrollRoot, pageSizes, ...props }: Omit<Props, "onPageChange"> & {
  page: number; text?: PageText; notes: Note[];
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
      {near ? <PdfPage pdf={pdf} page={page} scale={scale} rotation={rotation}
        text={text} notes={notes} regionMode={props.regionMode} activeId={props.activeId}
        onSelect={props.onSelect} onFocus={props.onFocus} onError={props.onError}
        onSize={({ width, height }) => {
          pageSizes.set(page, { width: (swapped ? height : width) / scale, height: (swapped ? width : height) / scale });
          setMeasured({ width, height, scale, rotation });
        }}
      /> : <div className="pdf-page-placeholder" style={{ width: size.width, height: size.height }} aria-label={`第 ${page} 页，滚动到此处显示`} />}
    </section>
  );
}

export default function ContinuousPdf(props: Props) {
  const stack = useRef<HTMLDivElement>(null);
  const onPageChange = useRef(props.onPageChange);
  onPageChange.current = props.onPageChange;
  const clearSelection = useRef(props.onClearSelection);
  clearSelection.current = props.onClearSelection;
  useEffect(() => {
    const changed = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !stack.current?.contains(selection.anchorNode) || !stack.current.contains(selection.focusNode)) clearSelection.current();
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);
  useEffect(() => {
    const root = props.scrollRoot.current;
    const el = stack.current;
    if (!root || !el) return;
    const visible = new Set<HTMLElement>();
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = root.getBoundingClientRect();
      const line = bounds.top + Math.min(160, bounds.height * 0.3);
      const current = [...visible].map((sheet) => ({ sheet, rect: sheet.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > bounds.top && rect.top < bounds.bottom)
        .sort((a, b) => {
          const distance = (r: DOMRect) => r.top <= line && r.bottom >= line ? 0 : Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line));
          return distance(a.rect) - distance(b.rect);
        })[0];
      if (current) onPageChange.current(Number(current.sheet.dataset.pdfPage));
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
    return () => { observer.disconnect(); root.removeEventListener("scroll", schedule); cancelAnimationFrame(frame); };
  }, [props.pdf, props.scrollRoot]);
  const pages = new Map(props.project.pages.map((page) => [page.page, page]));
  const notes = new Map<number, Note[]>();
  for (const note of props.project.notes) {
    if (note.parentId) continue;
    const group = notes.get(note.anchor.page) ?? [];
    group.push(note);
    notes.set(note.anchor.page, group);
  }
  return <div ref={stack} className="continuous-pdf" aria-label="PDF 连续阅读">
    {Array.from({ length: props.pdf.numPages }, (_, index) => <Sheet {...props} key={index + 1}
      page={index + 1} text={pages.get(index + 1)} notes={notes.get(index + 1) ?? []} />)}
  </div>;
}
