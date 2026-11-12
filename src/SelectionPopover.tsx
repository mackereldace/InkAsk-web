import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { floatingPosition, type ScreenBox } from "./core/floating";
import type { Task } from "./types";
interface Props {
  quote: string; initialQuestion?: string; imageOnly?: boolean; cropAvailable?: boolean; apiReady: boolean;
  getAnchor: () => ScreenBox | undefined;
  boundary: () => ScreenBox;
  onSubmit: (task: Task, question: string, images: File[], includeCrop: boolean) => Promise<void>;
  onClose: () => void; onSettings: () => void;
}
export default function SelectionPopover(props: Props) {
  const [question, setQuestion] = useState(props.initialQuestion ?? ""), [images, setImages] = useState<File[]>([]);
  const [includeCrop, setIncludeCrop] = useState(!!props.imageOnly), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [position, setPosition] = useState<ReturnType<typeof floatingPosition>>();
  const box = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0; const anchor = props.getAnchor(), el = box.current, boundary = props.boundary();
      if (!anchor || !el || anchor.bottom < boundary.top || anchor.top > boundary.bottom || anchor.right < boundary.left || anchor.left > boundary.right) { setPosition(undefined); return; }
      const next = floatingPosition(anchor, { width: Math.min(360, boundary.right - boundary.left - 16), height: el.offsetHeight }, boundary);
      setPosition((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure(); const observer = new ResizeObserver(schedule); if (box.current) observer.observe(box.current);
    window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("resize", schedule); };
  }, [props.getAnchor, props.boundary]);
  async function submit(task: Task) {
    if (busy) return;
    if (!props.apiReady) { props.onSettings(); return; }
    setBusy(true); setError("");
    try { await props.onSubmit(task, task === "explain" ? question : "", images, includeCrop); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function addImages(files: File[]) {
    setImages((current) => [...current, ...files.filter((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size <= 10 * 1024 * 1024)].slice(0, 4));
  }
  return createPortal(<div ref={box} className="selection-popover" role="dialog" aria-label="选区提问" style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 360, maxHeight: position?.maxHeight, visibility: position ? "visible" : "hidden" }}
    onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); props.onClose(); } }}>
    <header><span>{props.imageOnly ? "已选择页面区域" : `“${props.quote.slice(0, 68)}${props.quote.length > 68 ? "…" : ""}”`}</span><button aria-label="取消选区" onClick={props.onClose}><X size={15} /></button></header>
    <textarea aria-label="关于选区的问题" placeholder="想了解什么？留空则解释所选内容" value={question} rows={3} disabled={busy}
      onChange={(event) => setQuestion(event.target.value)} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); addImages([...event.clipboardData.files]); } }}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit("explain"); } }} />
    {!!images.length && <div className="popover-attachments">{images.map((file, index) => <button key={index} onClick={() => setImages((items) => items.filter((_, i) => i !== index))} title="点击移除">{file.name}<X size={11} /></button>)}</div>}
    {!props.imageOnly && props.cropAvailable !== false && <label className="popover-crop"><input type="checkbox" checked={includeCrop} onChange={(event) => setIncludeCrop(event.target.checked)} />附选区截图</label>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <footer><button className="icon-button" aria-label="附加图片" onClick={() => input.current?.click()} disabled={busy}><ImagePlus size={16} /></button><input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { addImages([...event.target.files ?? []]); event.target.value = ""; }} />
      <button disabled={busy} onClick={() => void submit("summarize")}>总结</button><button disabled={busy} onClick={() => void submit("translate")}>翻译</button>
      <button className="primary" disabled={busy} onClick={() => void submit("explain")}>{busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{props.apiReady ? "解释" : "配置模型"}</button>
    </footer>
  </div>, document.body);
}
