import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Loader2, X } from "lucide-react";
import { floatingPosition } from "./core/floating";
import { MathText } from "./Markdown";
import type { Anchor, Source } from "./types";
export interface SourcePreviewResult { blob?: Blob; anchor?: Anchor }
export type PreviewSource = (source: Source) => Promise<SourcePreviewResult | undefined>;
export default function SourceCitation({ source, preview, onLocate }: { source: Source; preview?: PreviewSource; onLocate: (source: Source) => void }) {
  const [open, setOpen] = useState(false), [result, setResult] = useState<SourcePreviewResult>(), [url, setUrl] = useState(""), [loading, setLoading] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof floatingPosition>>();
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewRef = useRef(preview); previewRef.current = preview;
  const key = JSON.stringify(source);
  function enter() { clearTimeout(closeTimer.current); setOpen(true); }
  function leave() { closeTimer.current = setTimeout(() => setOpen(false), 200); }
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) { setResult(undefined); setLoading(false); return; }
    if (!previewRef.current) return;
    let alive = true; setLoading(true);
    void previewRef.current(source).then((value) => { if (alive) setResult(value); }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, key]);
  useEffect(() => {
    if (!result?.blob) { setUrl(""); return; }
    const value = URL.createObjectURL(result.blob); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [result?.blob]);
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
  return <><button ref={button} className="source-link" aria-label={`原文引用 ${source.id}，第 ${source.page} 页`} aria-expanded={open} onPointerEnter={enter} onPointerLeave={leave} onFocus={enter} onBlur={leave}
    onClick={enter} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>[{source.id}]</button>
    {open && typeof document !== "undefined" && createPortal(<div ref={panel} className="source-popover" role="dialog" aria-label="原文引用预览" style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 440, maxHeight: position?.maxHeight, visibility: position ? "visible" : "hidden" }} onPointerEnter={enter} onPointerLeave={leave} onFocusCapture={enter} onBlurCapture={leave}>
      <header><strong>原文段落 · 第 {source.page} 页</strong><button aria-label="关闭引用预览" onClick={() => setOpen(false)}><X size={15} /></button></header>
      {loading && !url ? <div className="source-preview-loading"><Loader2 size={15} className="spin" />正在截取对应原文…</div> : url ? <img className="source-preview-image" src={url} alt={`第 ${source.page} 页对应原文截图`} /> : <div className="source-quote"><MathText>{source.text}</MathText></div>}
      <footer><span>{!loading && !result?.anchor?.rects.length && !source.rects?.length ? "暂未匹配到段落位置，显示文字摘录" : "悬停或点击查看对应段落"}</span><button onClick={() => { onLocate({ ...source, ...(result?.anchor ? { rects: result.anchor.rects } : {}) }); setOpen(false); }}>{result?.anchor?.rects.length || source.rects?.length ? "定位这段原文" : "前往此页"}<ArrowUpRight size={13} /></button></footer>
    </div>, document.body)}</>;
}
