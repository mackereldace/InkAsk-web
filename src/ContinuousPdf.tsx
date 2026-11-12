import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import PdfPage from "./PdfPage";
import type { PDFDocumentProxy } from "./pdf";
import type { Anchor, Note, PageText, Project } from "./types";
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
      <div className="pdf-sheet-content" style={{ width: size.width, height: size.height }}>
      {near ? <PdfPage pdf={pdf} page={page} scale={scale} rotation={rotation}
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
  const stack = useRef<HTMLDivElement>(null);
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
      const group = byPage.get(note.anchor.page) ?? [];
      group.push(note); byPage.set(note.anchor.page, group);
    }
    return byPage;
  }, [props.project.notes]);
  return <div ref={stack} className={"continuous-pdf direction-" + (props.direction ?? "vertical")} aria-label="PDF 连续阅读">
    {Array.from({ length: props.pdf.numPages }, (_, index) => <Sheet {...props} key={index + 1}
      page={index + 1} text={pages.get(index + 1)} notes={notes.get(index + 1) ?? []} />)}
  </div>;
}
