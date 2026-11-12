import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, Braces, Copy, GitBranch, ImagePlus, RotateCcw, Square, Trash2 } from "lucide-react";
import { AssetImage, Markdown, MathText } from "./Markdown";
import AnnotationLayer, { type ReadingAnnotation } from "./AnnotationLayer";
import { answerText, answerAnchorRange, answerRangeRects, selectedAnswerAnchor } from "./core/answer-selection";
import { answerFor } from "./core/reading";
import type { AnswerAnchor, ContextResult, Message, Note, Project, Task } from "./types";

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
}

export default function AnswerReader(props: Props) {
  const { note, project, onUpdate, onSend, onPage } = props;
  const [preview, setPreview] = useState(false), [edited, setEdited] = useState("");
  const input = useRef<HTMLInputElement>(null), body = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null);
  const [annotationLayout, setAnnotationLayout] = useState<{ width: number; annotations: ReadingAnnotation[]; signature: string }>({ width: 0, annotations: [], signature: "" });
  const answer = answerFor(note, props.messageId);
  const answers = note.messages.filter((m) => m.role === "assistant");
  const question = answer ? note.messages.slice(0, note.messages.indexOf(answer)).reverse().find((m) => m.role === "user") : undefined;
  const children = answer ? project.notes.filter((n) => n.parentId === note.id && n.parentMessageId === answer.id) : [];
  const parentMessage = project.notes.find((n) => n.id === note.parentId)?.messages.find((m) => m.id === note.parentMessageId);
  const sourceImage = !note.parentId && project.assets.find((asset) => asset.id === note.sourceAssetId);
  const annotationKey = JSON.stringify(children.map((child) => [child.id, child.title, child.branchQuote, child.answerAnchor]));
  useLayoutEffect(() => {
    const root = body.current, wrapper = surface.current;
    if (!root || !wrapper) { setAnnotationLayout((current) => current.width || current.annotations.length ? { width: 0, annotations: [], signature: "" } : current); return; }
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
      const signature = JSON.stringify([width, annotationKey, annotations.map((item) => [item.id, item.rects])]);
      setAnnotationLayout((current) => current.signature === signature ? current : { width, annotations, signature });
    };
    const schedule = () => { if (alive && !frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(wrapper);
    root.addEventListener("load", schedule, true);
    void document.fonts?.ready.then(schedule);
    return () => { alive = false; observer.disconnect(); root.removeEventListener("load", schedule, true); cancelAnimationFrame(frame); };
  }, [answer?.id, answer?.content, annotationKey]);
  const ctx = props.context(note);
  const template = project.templates.find((t) => t.id === note.templateId) ?? project.templates[0];
  function openPreview() { setEdited(ctx.prompt); setPreview(!preview); }
  function send() {
    if (!props.apiReady || props.busy) return;
    onSend(note.id, preview ? edited : undefined);
    setPreview(false);
  }
  const select = () => {
    const selection = window.getSelection();
    if (!answer || answer.status === "streaming" || !selection || selection.isCollapsed || !selection.rangeCount ||
      !body.current?.contains(selection.anchorNode) || !body.current.contains(selection.focusNode)) {
      props.onClearSelection();
      return;
    }
    const anchor = selectedAnswerAnchor(body.current, selection.getRangeAt(0));
    if (anchor) props.onSelect(note, answer, anchor);
    else props.onClearSelection();
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
      {sourceImage && <div className="source-image"><AssetImage asset={sourceImage} /></div>}
      {sourceImage ? <details className="source-text"><summary>文字摘录</summary><blockquote className="message-body"><Markdown message={{ content: note.branchQuote || note.anchor.quote }} project={project} onPage={onPage} /></blockquote></details> :
        <blockquote className="message-body"><Markdown message={{ content: note.branchQuote || note.anchor.quote || "已选择原文区域，可附上截图提问。", sources: parentMessage?.sources }} project={project} onPage={onPage} /></blockquote>}
      {!sourceImage && !note.parentId && <button className="source-capture" onClick={() => props.onSourceImage(note)}><ImagePlus size={14} />查看原文截图</button>}
      {!answer && !note.parentId && <label className="quote-editor">校正选文 / OCR 文字<textarea aria-label="校正选文" value={note.anchor.quote}
        onChange={(e) => onUpdate(note.id, { anchor: { ...note.anchor, quote: e.target.value } })} /></label>}
    </details>
    {question && <div className="answer-question"><small>这次提问</small><div className="message-body"><Markdown message={question} project={project} onPage={onPage} /></div>
      {!!question.assetIds.length && <div className="attachment-list">{question.assetIds.map((id) => {
        const asset = project.assets.find((a) => a.id === id); return asset ? <AssetImage key={id} asset={asset} /> : null;
      })}</div>}
    </div>}
    {answer ? <>
      <div ref={surface} className="answer-annotation-surface">
      <div ref={body} className={"message-body answer-body " + (answer.status === "streaming" ? "streaming" : "")}
        aria-label="AI 回答正文" onMouseUp={select} onKeyUp={select} onTouchEnd={select}>
        <Markdown message={answer} project={project} onPage={onPage} />
        {answer.status === "streaming" && !answer.content && <span className="thinking" role="status">正在阅读文档，生成回答…</span>}
      </div>
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
      <p className="answer-reading-hint">选中回答里的文字，继续进入下一层提问。</p>
    </> : <>
          <div
            className="composer"
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (files.length) {
                e.preventDefault();
                props.onAttach(note.id, files);
              }
            }}
          >
            <div className="composer-tools">
              <select
                aria-label="提示词模板"
                value={template?.id}
                onChange={(e) => {
                  const t = project.templates.find(
                    (t) => t.id === e.target.value,
                  )!;
                  onUpdate(note.id, { templateId: t.id, task: t.task as Task });
                }}
              >
                {project.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button
                className={preview ? "selected" : ""}
                onClick={openPreview}
              >
                <Braces size={13} />
                提示词
              </button>
            </div>
            {preview && (
              <div className="prompt-preview">
                <label>本次发送的提示词 · 可直接修改</label>
                <textarea
                  aria-label="本次提示词"
                  value={edited}
                  onChange={(e) => setEdited(e.target.value)}
                />
              </div>
            )}
            <textarea
              aria-label={note.parentId ? "输入分支问题" : "输入问题"}
              placeholder={
                note.messages.length
                  ? "沿着这个思路，继续问…"
                  : "想理解哪一点？也可以直接发送。"
              }
              value={note.draft}
              onChange={(e) => onUpdate(note.id, { draft: e.target.value })}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  !props.busy
                ) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {!!note.draftAssetIds.length && (
              <div className="attachment-list">
                {note.draftAssetIds.map((id) => {
                  const a = project.assets.find((a) => a.id === id);
                  return a ? (
                    <AssetImage
                      key={id}
                      asset={a}
                      onRemove={() =>
                        onUpdate(note.id, {
                          draftAssetIds: note.draftAssetIds.filter(
                            (x) => x !== id,
                          ),
                        })
                      }
                    />
                  ) : null;
                })}
              </div>
            )}
            <div className="context-info">
              参考第{" "}
              {[
                ...new Set([
                  note.anchor.page,
                  ...ctx.sources.map((s) => s.page),
                ]),
              ].join("、")}{" "}
              页 <span>· {ctx.coverage}</span>
              {ctx.truncated && <strong> · 已裁剪较早上下文</strong>}
            </div>
            <div className="composer-footer">
              <div>
                <button
                  className="icon-button"
                  title="上传图片 / 粘贴图片"
                  aria-label="上传图片"
                  onClick={() => input.current?.click()}
                >
                  <ImagePlus size={16} />
                </button>
                <input
                  ref={input}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    props.onAttach(note.id, Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <button
                  className="text-button"
                  onClick={() => props.onScreenshot(note)}
                >
                  {note.parentId ? "附上 PDF 原文截图" : "附上原文截图"}
                </button>
              </div>
              {props.busy ? (
                <button
                  className="stop-button"
                  onClick={() => props.onStop(note.id)}
                >
                  <Square size={12} />
                  停止
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送问题"
                  onClick={send}
                  disabled={!props.apiReady}
                  title={
                    props.apiReady
                      ? "发送 · ⌘/Ctrl + Enter"
                      : "请先在设置中配置模型 API"
                  }
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
    </>}
  </article>;
}
