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
interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  scale: number;
  rotation: number;
  text?: PageText;
  notes: Note[];
  regionMode: boolean;
  activeId?: string;
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
  onSelect,
  onFocus,
  onSize,
  onError,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    layer = useRef<HTMLDivElement>(null),
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
    let rendering:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | undefined;
    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (!alive) return;
        const viewport = pdfPage.getViewport({
          scale,
          rotation: (pdfPage.rotate + rotation) % 360,
        });
        setVp(viewport);
        sizeCallback.current({
          width: viewport.width,
          height: viewport.height,
          viewport,
        });
        const el = canvas.current!,
          container = layer.current!;
        const ratio = window.devicePixelRatio || 1;
        el.width = Math.ceil(viewport.width * ratio);
        el.height = Math.ceil(viewport.height * ratio);
        container.replaceChildren();
        container.style.setProperty("--total-scale-factor", String(scale));
        rendering = pdfPage.render({
          canvas: el,
          canvasContext: el.getContext("2d")!,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await rendering.promise;
        if (!alive || text?.source === "ocr") return;
        const content = await pdfPage.getTextContent();
        if (!alive) return;
        container.replaceChildren();
        textLayer = new pdfjs.TextLayer({
          textContentSource: content,
          container,
          viewport,
        });
        await textLayer.render();
      } catch (e) {
        if (
          alive &&
          !(e instanceof Error && e.name === "RenderingCancelledException")
        )
          errorCallback.current("页面渲染失败：" + String(e));
      }
    })();
    return () => {
      alive = false;
      rendering?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, page, scale, rotation, text?.source]);
  function selection() {
    if (regionMode || !vp) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return;
    const range = s.getRangeAt(0);
    if (!wrap.current?.contains(range.commonAncestorContainer)) return;
    const quote = s.toString().trim();
    if (!quote) return;
    const bounds = wrap.current!.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
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
          onPointerUp={() => {
            if (drag && vp && drag[2] - drag[0] > 8 && drag[3] - drag[1] > 8)
              onSelect({
                page,
                quote: "",
                rects: [
                  normalizeRect([
                    ...vp.convertToPdfPoint(drag[0], drag[1]),
                    ...vp.convertToPdfPoint(drag[2], drag[3]),
                  ]),
                ],
              });
            origin.current = undefined;
            setDrag(undefined);
          }}
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
