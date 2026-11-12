import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, GitBranch, RotateCcw, Square, Trash2 } from "lucide-react";
import { AssetImage, Markdown, MathText } from "./Markdown";
import AnnotationLayer, { type ReadingAnnotation } from "./AnnotationLayer";
import { answerText, answerAnchorRange, answerRangeRects, selectedAnswerAnchor } from "./core/answer-selection";
import { answerFor } from "./core/reading";
import type { PreviewSource } from "./SourceCitation";
import type { AnswerAnchor, ContextResult, Message, Note, Project, Rect, Source } from "./types";

interface Props {
  note: Note;
  project: Project;
  messageId?: string;
  activeId?: string;
  busy: boolean;
  apiReady: boolean;
  context: (note: Note) => ContextResult;
  onUpdate: (id: string, change: Partial<Note>) => void;
  onSend: (id: string, prompt?: string) => void;
  onStop: (id: string) => void;
  onSelect: (note: Note, message: Message, anchor: AnswerAnchor) => void;
  onClearSelection: () => void;
  onBranch: (note: Note, message: Message, anchor?: AnswerAnchor) => void;
  onDelete: (id: string) => void;
  onPage: (page: number) => void;
  onFocus: (id: string, messageId?: string) => void;
  onAttach: (id: string, files: File[]) => void;
  onScreenshot: (note: Note) => void;
  onSourceImage: (note: Note) => void;
  onRetry: (id: string) => void;
  onResume?: (note: Note) => void;
  selection?: AnswerAnchor;
  onPreviewSource?: PreviewSource;
  onLocateSource?: (source: Source) => void;
}

export default function AnswerReader(props: Props) {
  const { note, project, onUpdate, onPage } = props;
  const body = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null);
  const [annotationLayout, setAnnotationLayout] = useState<{ width: number; annotations: ReadingAnnotation[]; selectionRects: Rect[]; signature: string }>({ width: 0, annotations: [], selectionRects: [], signature: "" });
  const answer = answerFor(note, props.messageId);
  const answers = note.messages.filter((m) => m.role === "assistant");
  const question = answer ? note.messages.slice(0, note.messages.indexOf(answer)).reverse().find((m) => m.role === "user") : undefined;
  const children = answer ? project.notes.filter((n) => n.parentId === note.id && n.parentMessageId === answer.id) : [];
  const parentMessage = project.notes.find((n) => n.id === note.parentId)?.messages.find((m) => m.id === note.parentMessageId);
  const previewSource: PreviewSource | undefined = props.onPreviewSource ? (source) => props.onPreviewSource!({ ...source, ...(!source.rects?.length && source.id === "S1" && source.page === note.anchor.page && source.text.trim() === note.anchor.quote.trim() ? { rects: note.anchor.rects } : {}) }) : undefined;
  const annotationKey = JSON.stringify(children.map((child) => [child.id, child.title, child.branchQuote, child.answerAnchor]));
  useLayoutEffect(() => {
    const root = body.current, wrapper = surface.current;
    if (!root || !wrapper) { setAnnotationLayout((current) => current.width || current.annotations.length ? { width: 0, annotations: [], selectionRects: [], signature: "" } : current); return; }
    let alive = true, frame = 0;
    const measure = () => {
      frame = 0;
      if (!alive) return;
      const annotations = children.map((child) => {
        const range = answerAnchorRange(root, child.answerAnchor, child.branchQuote ?? "");
        return {
          id: child.id, title: child.title,
          rects: range ? answerRangeRects(range, wrapper) : [],
          preview: <><small>{range ? "选文便签" : "已保存便签 · 选文位置已变化"}</small><MathText>{child.branchQuote || child.title}</MathText></>,
        };
      });
      const width = wrapper.clientWidth;
      const pending = props.selection ? answerAnchorRange(root, props.selection, props.selection.quote) : undefined;
      const selectionRects = pending ? answerRangeRects(pending, wrapper) : [];
      const signature = JSON.stringify([width, annotationKey, annotations.map((item) => [item.id, item.rects]), selectionRects]);
      setAnnotationLayout((current) => current.signature === signature ? current : { width, annotations, selectionRects, signature });
    };
    const schedule = () => { if (alive && !frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(wrapper);
    root.addEventListener("load", schedule, true);
    void document.fonts?.ready.then(schedule);
    return () => { alive = false; observer.disconnect(); root.removeEventListener("load", schedule, true); cancelAnimationFrame(frame); };
  }, [answer?.id, answer?.content, annotationKey, props.selection]);
  const select = () => {
    const selection = window.getSelection();
    if (!answer || answer.status === "streaming" || !selection || selection.isCollapsed || !selection.rangeCount ||
      !body.current?.contains(selection.anchorNode) || !body.current.contains(selection.focusNode)) {
      return;
    }
    const anchor = selectedAnswerAnchor(body.current, selection.getRangeAt(0));
    if (anchor) props.onSelect(note, answer, anchor);

  };
  const selectionCallback = useRef(select);
  selectionCallback.current = select;
  useEffect(() => {
    const changed = () => selectionCallback.current();
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);
  return <article className="answer-document" aria-label="回答阅读页" data-note-id={note.id}>
    <header className="answer-document-heading">
      <span className="eyebrow">{answer ? "INKASK · 阅读回答" : "INKASK · 新的提问"}</span>
      {answers.length > 1 && <select aria-label="切换本便签的回答" value={answer?.id} onChange={(e) => props.onFocus(note.id, e.target.value)}>
        {answers.map((m, index) => <option key={m.id} value={m.id}>回答 {index + 1}</option>)}
      </select>}
      <details className="answer-info"><summary>便签信息</summary>
        <label>标题<input aria-label="便签标题" value={note.title} onChange={(e) => onUpdate(note.id, { title: e.target.value })} /></label>
        <button onClick={() => props.onDelete(note.id)}><Trash2 size={13} />删除此便签及子追问</button>
      </details>
    </header>
    <details className="reading-source" open={!answer}>
      <summary>{note.parentId ? "选中的上一层回答" : `选中的 PDF 原文 · 第 ${note.anchor.page} 页`}</summary>
      <blockquote className="message-body"><Markdown message={{ content: note.branchQuote || note.anchor.quote || "已选择原文区域", sources: parentMessage?.sources }} project={project} onPage={onPage} onPreviewSource={previewSource} onLocateSource={props.onLocateSource} /></blockquote>
    </details>
    {question && <div className="answer-question"><small>这次提问</small><div className="message-body"><Markdown message={question} project={project} onPage={onPage} onPreviewSource={previewSource} onLocateSource={props.onLocateSource} /></div>
      {!!question.assetIds.length && <div className="attachment-list">{question.assetIds.map((id) => {
        const asset = project.assets.find((a) => a.id === id); return asset ? <AssetImage key={id} asset={asset} /> : null;
      })}</div>}
    </div>}
    {answer ? <>
      <div ref={surface} className="answer-annotation-surface">
      <div ref={body} className={"message-body answer-body " + (answer.status === "streaming" ? "streaming" : "")}
        aria-label="AI 回答正文" onMouseUp={select} onKeyUp={select} onTouchEnd={select}>
        <Markdown message={answer} project={project} onPage={onPage} onPreviewSource={previewSource} onLocateSource={props.onLocateSource} />
        {answer.status === "streaming" && !answer.content && <span className="thinking" role="status">正在阅读文档，生成回答…</span>}
      </div>
      <div className="pending-answer-selection" aria-hidden="true">{annotationLayout.selectionRects.map((rect, index) => <span key={index} style={{ left: rect[0], top: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] }} />)}</div>
      <AnnotationLayer width={annotationLayout.width} annotations={annotationLayout.annotations} activeId={props.activeId} onFocus={props.onFocus} />
      </div>
      {answer.error && <p className="inline-error" role="alert">{answer.error}</p>}
      {answer.status === "stopped" && <p className="small muted">已停止，收到的回答已保留。</p>}
      <div className="answer-actions">
        {props.busy ? <button onClick={() => props.onStop(note.id)}><Square size={13} />停止生成</button> : <>
          {!!answer.content.trim() && <button onClick={() => {
            const text = body.current ? answerText(body.current).text : "";
            const quote = text.trim();
            const start = text.length - text.trimStart().length;
            props.onBranch(note, answer, quote ? { start, end: start + quote.length, quote } : undefined);
          }}><GitBranch size={14} />对整篇回答提问</button>}
          <button onClick={() => void navigator.clipboard?.writeText(answer.content)}><Copy size={13} />复制回答</button>
          {(answer.status === "error" || answer.status === "stopped") && answer.id === note.messages.at(-1)?.id && <button onClick={() => props.onRetry(note.id)}><RotateCcw size={13} />重试</button>}
        </>}
        {answer.prompt && <details><summary>提问记录</summary><pre>{answer.prompt}</pre></details>}
      </div>
      {!!answer.sources?.length && <details className="answer-sources"><summary>本次参考来源 · {[...new Set(answer.sources.map((source) => source.page))].length} 页</summary>
        <p>这些片段是本次提供给模型的相关原文；悬停引用编号可查看对应截图。</p>
        <div className="message-body"><Markdown message={{ content: answer.sources.map((source) => `[${source.id}] 第 ${source.page} 页`).join(" · "), sources: answer.sources }} project={project} onPage={onPage} onPreviewSource={previewSource} onLocateSource={props.onLocateSource} /></div>
      </details>}
      <p className="answer-reading-hint">选中回答里的文字，继续进入下一层提问。</p>
    </> : <div className="legacy-draft">
      <p>{note.draft || "这条便签尚未发送问题。"}</p>
      <button className="secondary" onClick={() => props.onResume?.(note)}>继续提问</button>
    </div>}
  </article>;
}
