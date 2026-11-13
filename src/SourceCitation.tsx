import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Loader2, X } from "lucide-react";
import { floatingPosition } from "./core/floating";
import { MathText } from "./Markdown";
import type { Anchor, Source } from "./types";
export interface SourcePreviewPart { blob?: Blob; anchor?: Anchor; label?: string; text?: string }
export interface SourcePreviewResult extends SourcePreviewPart { parts?: SourcePreviewPart[]; kind?: "evidence" | "selection" | "context" | "unresolved" }
export type PreviewSource = (source: Source, claim?: string) => Promise<SourcePreviewResult | undefined>;
function PreviewImage({ blob, page }: { blob: Blob; page: number }) {
  const [url, setUrl] = useState("");
  useEffect(() => { const url = URL.createObjectURL(blob); setUrl(url); return () => URL.revokeObjectURL(url); }, [blob]);
  return url ? <img className="source-preview-image" loading="lazy" decoding="async" src={url} srcSet={`${url} 2x`} alt={`第 ${page} 页对应原文截图`} /> : null;
}
export default function SourceCitation({ source, preview, onLocate, claim }: { source: Source; preview?: PreviewSource; onLocate: (source: Source) => void; claim?: string }) {
  const [open, setOpen] = useState(false), [result, setResult] = useState<SourcePreviewResult>(), [loading, setLoading] = useState(false), [original, setOriginal] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof floatingPosition>>();
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewRef = useRef(preview); previewRef.current = preview;
  const key = JSON.stringify([source, claim]);
  function enter() { clearTimeout(closeTimer.current); setOpen(true); }
  function leave() { closeTimer.current = setTimeout(() => setOpen(false), 200); }
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) { setResult(undefined); setLoading(false); setOriginal(false); return; }
    if (!previewRef.current) return;
    let alive = true; setLoading(true);
    void previewRef.current(source, claim).then((value) => { if (alive) setResult(value); }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, key]);
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => {
      frame = 0; if (!button.current || !panel.current) return;
      const box = button.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const boundary = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth), bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) };
      const next = floatingPosition(box, { width: 440, height: panel.current.offsetHeight }, boundary);
      setPosition((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure(); const observer = new ResizeObserver(schedule); if (panel.current) observer.observe(panel.current);
    window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    const outside = (event: PointerEvent) => { if (!button.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.removeEventListener("pointerdown", outside); };
  }, [open]);
  const parts = result?.parts ?? (result?.blob || result?.anchor ? [result] : []);
  const anchored = parts.some((part) => !!part.anchor?.rects.length);
  return <><button ref={button} className="source-link" aria-label={`原文引用 ${source.id}，第 ${source.page} 页`} title={source.label} aria-expanded={open} onPointerEnter={enter} onPointerLeave={leave} onFocus={enter} onBlur={leave}
    onClick={enter} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>[{source.id}]</button>
    {open && typeof document !== "undefined" && createPortal(<div ref={panel} className="source-popover" role="dialog" aria-label="原文引用预览" style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 440, maxHeight: position?.maxHeight, visibility: position ? "visible" : "hidden" }} onPointerEnter={enter} onPointerLeave={leave} onFocusCapture={enter} onBlurCapture={leave}>
      <header><strong>{result?.kind === "selection" ? "原文选区" : "相关原文"} · 第 {source.page} 页</strong><button aria-label="关闭引用预览" onClick={() => setOpen(false)}><X size={15} /></button></header>
      {loading ? <div className="source-preview-loading"><Loader2 size={15} className="spin" />正在查找对应段落…</div> : parts.length ? <div className="source-preview-parts">{parts.map((part, index) => <section className="source-preview-part" key={JSON.stringify([part.anchor?.rects, part.label, index])}>
        {part.label && <strong>{part.label}</strong>}
        {part.blob ? <PreviewImage blob={part.blob} page={source.page} /> : <div className="source-quote"><MathText>{part.text ?? source.text}</MathText></div>}
        {!!part.anchor?.rects.length && <button className="source-part-locate" onClick={() => { onLocate({ ...source, text: part.text ?? source.text, rects: part.anchor!.rects }); setOpen(false); }}>{parts.length > 1 ? "定位此段" : "定位这段原文"}<ArrowUpRight size={13} /></button>}
      </section>)}</div> : <div className="source-quote"><MathText>{source.text}</MathText></div>}
      {result?.kind === "context" && <details className="source-original" onToggle={(event) => setOriginal(event.currentTarget.open)}><summary>查看原始引用（{source.text.length} 字符）</summary>{original && <div className="source-quote"><MathText>{source.text}</MathText></div>}</details>}
      <footer><span>{!loading && !anchored ? "暂未匹配到段落位置，显示文字摘录" : result?.kind === "context" ? "相关段落来自原始引用，原记录保持完整" : "对应选文与证据段落"}</span>{!loading && !anchored && <button onClick={() => { onLocate(source); setOpen(false); }}>前往此页<ArrowUpRight size={13} /></button>}</footer>
    </div>, document.body)}</>;
}
