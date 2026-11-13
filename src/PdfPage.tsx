import { useEffect, useRef, useState } from "react";
import {
  pdfjs,
  screenRect,
  normalizeRect,
  type PDFDocumentProxy,
  type PageViewport,
} from "./pdf";
import type { Anchor, Note, PageText, Rect } from "./types";
import AnnotationLayer from "./AnnotationLayer";
import { MathText } from "./Markdown";
import { startCanvasRender } from "./core/pdf-reader";
import { registerTextLayerSelection, textSelectionRects } from "./core/text-layer-selection";
import { registerBlankTextSelection } from "./core/text-selection-hit";
interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  scale: number;
  rotation: number;
  text?: PageText;
  notes: Note[];
  regionMode: boolean;
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
  activeId,
  selection: selected,
  onSelect,
  onFocus,
  onSize,
  onError,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    layer = useRef<HTMLDivElement>(null),
    ocrLayer = useRef<HTMLDivElement>(null),
    wrap = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<PageViewport>(),
    [drag, setDrag] = useState<Rect>();
  const origin = useRef<number[] | undefined>(undefined);
  const sizeCallback = useRef(onSize),
    errorCallback = useRef(onError);
  sizeCallback.current = onSize;
  errorCallback.current = onError;
  useEffect(() => {
    let alive = true;
    const el = canvas.current, container = layer.current, wrapper = wrap.current;
    if (!el || !container || !wrapper) return;
    const ownsDom = () => alive && canvas.current === el && layer.current === container && wrap.current === wrapper && el.isConnected && container.isConnected;
    let rendering: ReturnType<typeof startCanvasRender> | undefined;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | undefined;
    let unregisterSelection: (() => void) | undefined;
    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (!ownsDom()) return;
        const viewport = pdfPage.getViewport({ scale, rotation: (pdfPage.rotate + rotation) % 360 });
        setVp(viewport);
        sizeCallback.current({ width: viewport.width, height: viewport.height, viewport });
        // A size callback may synchronously unmount a virtualized page.
        if (!ownsDom()) return;
        container.replaceChildren();
        container.style.setProperty("--total-scale-factor", String(scale));
        rendering = startCanvasRender({ page: pdfPage, viewport, destination: el, isCurrent: ownsDom, ratio: window.devicePixelRatio || 1 });
        if (!(await rendering.promise) || !ownsDom() || text?.source === "ocr") return;
        const content = await pdfPage.getTextContent();
        if (!ownsDom()) return;
        container.replaceChildren();
        textLayer = new pdfjs.TextLayer({ textContentSource: content, container, viewport });
        await textLayer.render();
        if (ownsDom()) {
          const releaseGuard = registerTextLayerSelection(container);
          const releaseHit = registerBlankTextSelection(container, viewport.rotation % 180 !== 0);
          unregisterSelection = () => { releaseHit(); releaseGuard(); };
        }
      } catch (e) {
        if (ownsDom() && !(e instanceof Error && e.name === "RenderingCancelledException"))
          errorCallback.current("页面渲染失败：" + String(e));
      }
    })();
    return () => {
      alive = false; unregisterSelection?.(); rendering?.cancel(); textLayer?.cancel();
      if (!el.isConnected) { el.width = 0; el.height = 0; }
    };
  }, [pdf, page, scale, rotation, text?.source]);
  useEffect(() => {
    if (vp && text?.source === "ocr" && ocrLayer.current) {
      const releaseGuard = registerTextLayerSelection(ocrLayer.current);
      const releaseHit = registerBlankTextSelection(ocrLayer.current, vp.rotation % 180 !== 0);
      return () => { releaseHit(); releaseGuard(); };
    }
  }, [vp, text?.source, text?.words]);
  function selection() {
    if (regionMode || !vp) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return;
    const range = s.getRangeAt(0);
    if (!wrap.current?.contains(range.commonAncestorContainer)) return;
    const quote = s.toString().trim();
    if (!quote) return;
    const bounds = wrap.current!.getBoundingClientRect();
    const textRoot = text?.source === "ocr" ? ocrLayer.current : layer.current;
    if (!textRoot) return;
    const rects = textSelectionRects(range, textRoot)
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) =>
        normalizeRect([
          ...vp.convertToPdfPoint(r.left - bounds.left, r.top - bounds.top),
          ...vp.convertToPdfPoint(r.right - bounds.left, r.bottom - bounds.top),
        ]),
      );
    if (rects.length) onSelect({ page, quote, rects });
  }
  const selectionCallback = useRef(selection);
  selectionCallback.current = selection;
  useEffect(() => {
    const changed = () => selectionCallback.current();
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);
  return (
    <div
      ref={wrap}
      className={"pdf-page" + (regionMode ? " region-mode" : "")}
      style={{ width: vp?.width ?? 600, height: vp?.height ?? 800 }}
      onMouseUp={selection}
      onKeyUp={selection}
      onTouchEnd={selection}
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
          ref={ocrLayer}
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
      {vp && selected?.page === page && <div className="pdf-selection" aria-label={selected.quote ? "已选择的 PDF 文字" : "已框选的 PDF 区域"}>
        {selected.rects.map((rect, index) => {
          const r = screenRect(vp, rect);
          return <span key={index} className={"pdf-selection-rect " + (selected.quote ? "text-selection" : "area-selection")}
            style={{ left: r[0], top: r[1], width: r[2] - r[0], height: r[3] - r[1] }} />;
        })}
      </div>}
      {vp && <AnnotationLayer width={vp.width} activeId={activeId} onFocus={onFocus}
        annotations={notes.map((note) => ({
          id: note.id, title: note.title,
          rects: note.anchor.rects.map((rect) => screenRect(vp, rect)),
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
