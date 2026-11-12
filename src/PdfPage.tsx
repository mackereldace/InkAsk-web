import { useEffect, useRef, useState } from "react";
import {
  pdfjs,
  screenRect,
  normalizeRect,
  type PDFDocumentProxy,
  type PageViewport,
  type PDFPageProxy,
} from "./pdf";
import type { Anchor, Note, PageText, Rect } from "./types";
import AnnotationLayer from "./AnnotationLayer";
import { MathText } from "./Markdown";
import { startCanvasRender } from "./core/pdf-reader";
import type { PdfSelectionPage } from "./core/pdf-selection";
interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  scale: number;
  rotation: number;
  text?: PageText;
  notes: Note[];
  regionMode: boolean;
  renderCanvas?: boolean;
  registerText?: (page: number, entry?: PdfSelectionPage) => void;
  activeId?: string;
  selection?: Anchor;
  onSelect: (anchor: Anchor) => void;
  onFocus: (id: string) => void;
  onSize: (size: {
    width: number;
    height: number;
    viewport: PageViewport;
  }) => void;
  onError: (message: string) => void;
}
export default function PdfPage({
  pdf,
  page,
  scale,
  rotation,
  text,
  notes,
  regionMode,
  renderCanvas = true,
  registerText,
  activeId,
  selection: selected,
  onSelect,
  onFocus,
  onSize,
  onError,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    layer = useRef<HTMLDivElement>(null),
    wrap = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<PageViewport>(),
    [pdfPage, setPdfPage] = useState<PDFPageProxy>(),
    [drag, setDrag] = useState<Rect>();
  const origin = useRef<number[] | undefined>(undefined);
  const sizeCallback = useRef(onSize),
    errorCallback = useRef(onError);
  sizeCallback.current = onSize;
  errorCallback.current = onError;
  const ocr = text?.source === "ocr";
  useEffect(() => {
    let alive = true;
    void pdf.getPage(page).then((value) => {
      if (!alive) return;
      const viewport = value.getViewport({ scale, rotation: (value.rotate + rotation) % 360 });
      setPdfPage(value); setVp(viewport);
      sizeCallback.current({ width: viewport.width, height: viewport.height, viewport });
    }).catch((error) => { if (alive) errorCallback.current("页面渲染失败：" + String(error)); });
    return () => { alive = false; };
  }, [pdf, page, scale, rotation]);
  // Raster eviction must not destroy the browser's native selection endpoints.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !vp || !pdfPage || !renderCanvas) return;
    let alive = true;
    let job: ReturnType<typeof startCanvasRender>;
    try {
      job = startCanvasRender({ page: pdfPage, viewport: vp, destination: el,
        isCurrent: () => alive && canvas.current === el && el.isConnected,
        ratio: window.devicePixelRatio || 1 });
    } catch (error) {
      errorCallback.current("页面渲染失败：" + String(error));
      return;
    }
    void job.promise.catch((error) => {
      if (alive && !(error instanceof Error && error.name === "RenderingCancelledException"))
        errorCallback.current("页面渲染失败：" + String(error));
    });
    return () => { alive = false; job.cancel(); el.width = 0; el.height = 0; };
  }, [pdfPage, vp, renderCanvas]);
  useEffect(() => {
    const container = layer.current;
    if (!container || !vp || !pdfPage || ocr) return;
    let alive = true;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | undefined;
    container.replaceChildren();
    container.style.setProperty("--total-scale-factor", String(vp.scale));
    void (async () => {
      try {
        const content = await pdfPage.getTextContent();
        if (!alive || !container.isConnected) return;
        textLayer = new pdfjs.TextLayer({ textContentSource: content, container, viewport: vp });
        await textLayer.render();
        if (alive) {
          const end = document.createElement("div");
          end.className = "endOfContent";
          container.append(end);
        }
      } catch (error) {
        if (alive && !(error instanceof Error && error.name === "RenderingCancelledException"))
          errorCallback.current("页面渲染失败：" + String(error));
      }
    })();
    return () => { alive = false; textLayer?.cancel(); container.replaceChildren(); };
  }, [pdfPage, vp, ocr]);
  useEffect(() => {
    const wrapper = wrap.current;
    const container = wrapper?.querySelector<HTMLElement>(ocr ? ".ocr-text" : ".native-text");
    if (!wrapper || !container || !vp) return;
    registerText?.(page, { page, layer: container, wrapper, viewport: vp });
    return () => registerText?.(page);
  }, [page, vp, ocr, registerText]);
  const selectedFragment = selected?.fragments?.find((fragment) => fragment.page === page)
    ?? (selected?.page === page ? selected : undefined);
  return (
    <div
      ref={wrap}
      className={"pdf-page" + (regionMode ? " region-mode" : "")}
      style={{ width: vp?.width ?? 600, height: vp?.height ?? 800 }}
    >
      <canvas
        ref={canvas}
        style={{ width: "100%", height: "100%" }}
        aria-label={`PDF 第 ${page} 页`}
      />
      <div
        ref={layer}
        className="textLayer native-text"
        style={{
          pointerEvents:
            regionMode || text?.source === "ocr" ? "none" : undefined,
        }}
      />
      {text?.source === "ocr" && (
        <div
          className="textLayer ocr-text"
          style={{ pointerEvents: regionMode ? "none" : undefined }}
        >
          {text?.source === "ocr" &&
            vp &&
            text.words.map((w, i) => {
              const r = screenRect(vp, w.rect);
              return (
                <span
                  className="ocr-word"
                  key={i}
                  style={{
                    left: r[0],
                    top: r[1],
                    width: r[2] - r[0],
                    height: r[3] - r[1],
                    fontSize: Math.max(5, (r[3] - r[1]) * 0.85),
                  }}
                >
                  {w.text}{" "}
                </span>
              );
            })}
        </div>
      )}
      {vp && selectedFragment && <div className="pdf-selection" aria-label={selectedFragment.quote ? "已选择的 PDF 文字" : "已框选的 PDF 区域"}>
        {selectedFragment.rects.map((rect, index) => {
          const r = screenRect(vp, rect);
          return <span key={index} className={"pdf-selection-rect " + (selectedFragment.quote ? "text-selection" : "area-selection")}
            style={{ left: r[0], top: r[1], width: r[2] - r[0], height: r[3] - r[1] }} />;
        })}
      </div>}
      {vp && <AnnotationLayer width={vp.width} activeId={activeId} onFocus={onFocus}
        annotations={notes.map((note) => ({
          id: note.id, title: note.title,
          rects: (note.anchor.fragments?.find((part) => part.page === page)?.rects ?? note.anchor.rects).map((rect) => screenRect(vp, rect)),
          preview: <><small>选文便签</small><MathText>{note.anchor.quote || note.title}</MathText></>,
        }))} />}
      {regionMode && (
        <div
          className="region-overlay"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const b = e.currentTarget.getBoundingClientRect();
            origin.current = [e.clientX - b.left, e.clientY - b.top];
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag([...origin.current, ...origin.current] as Rect);
          }}
          onPointerMove={(e) => {
            if (!origin.current) return;
            const b = e.currentTarget.getBoundingClientRect();
            setDrag(
              normalizeRect([
                ...origin.current,
                Math.max(0, Math.min(b.width, e.clientX - b.left)),
                Math.max(0, Math.min(b.height, e.clientY - b.top)),
              ]),
            );
          }}
          onPointerUp={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const end = origin.current ? normalizeRect([...origin.current, Math.max(0, Math.min(b.width, e.clientX - b.left)), Math.max(0, Math.min(b.height, e.clientY - b.top))]) : undefined;
            if (end && vp && end[2] - end[0] > 8 && end[3] - end[1] > 8)
              onSelect({
                page,
                quote: "",
                rects: [
                  normalizeRect([
                    ...vp.convertToPdfPoint(end[0], end[1]),
                    ...vp.convertToPdfPoint(end[2], end[3]),
                  ]),
                ],
              });
            origin.current = undefined;
            setDrag(undefined);
          }}
          onPointerCancel={() => { origin.current = undefined; setDrag(undefined); }}
        >
          {drag && (
            <div
              className="region-box"
              style={{
                left: drag[0],
                top: drag[1],
                width: drag[2] - drag[0],
                height: drag[3] - drag[1],
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
