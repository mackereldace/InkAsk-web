import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitBranch,
  ImagePlus,
  LocateFixed,
  MoreHorizontal,
  Square,
  X,
  FileText,
  Braces,
  Copy,
  RotateCcw,
} from "lucide-react";
import type {
  Asset,
  ContextResult,
  Message,
  Note,
  Project,
  Task,
} from "./types";
import { TASK_LABELS } from "./core/templates";
export function AssetImage({
  asset,
  onRemove,
}: {
  asset: Asset;
  onRemove?: () => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(asset.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [asset.data]);
  return (
    <div className="asset-thumb">
      <img src={url} alt={asset.name} />
      {onRemove && (
        <button onClick={onRemove} aria-label="移除图片">
          <X size={12} />
        </button>
      )}
      <span>{asset.name}</span>
    </div>
  );
}
function Markdown({
  message,
  project,
  onPage,
}: {
  message: Message;
  project: Project;
  onPage: (page: number) => void;
}) {
  const content = message.content.replace(/\[([S]\d+)\]/g, (all, id: string) =>
    message.sources?.some((s) => s.id === id) ? `[${id}](#source-${id})` : all,
  );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false }]]}
      urlTransform={(url) =>
        url.startsWith("asset:") || url.startsWith("inkask://asset/")
          ? url
          : defaultUrlTransform(url)
      }
      components={{
        img: ({ src, alt }) => {
          const a = project.assets.find(
            (a) => `asset:${a.id}` === src || `inkask://asset/${a.id}` === src,
          );
          return a ? (
            <AssetImage asset={a} />
          ) : (
            <span className="muted">[未附加的图片：{alt}]</span>
          );
        },
        a: ({ href, children }) => {
          if (href?.startsWith("#source-")) {
            const source = message.sources?.find((s) => s.id === href.slice(8));
            return source ? (
              <button
                className="source-link"
                title={source.text}
                onClick={() => onPage(source.page)}
              >
                第 {source.page} 页
              </button>
            ) : (
              <span>{children}</span>
            );
          }
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
interface Props {
  note: Note;
  project: Project;
  activeId?: string;
  depth?: number;
  busy: boolean;
  apiReady: boolean;
  context: (n: Note) => ContextResult;
  onUpdate: (id: string, change: Partial<Note>) => void;
  onSend: (id: string, prompt?: string) => void;
  onStop: (id: string) => void;
  onBranch: (note: Note, message: Message, quote?: string) => void;
  onDelete: (id: string) => void;
  onPage: (page: number) => void;
  onFocus: (id: string) => void;
  onAttach: (id: string, files: File[]) => void;
  onScreenshot: (note: Note) => void;
  onRetry: (id: string) => void;
  busyIds: Set<string>;
}
export default function NoteCard(props: Props) {
  const { note, project, depth = 0, onUpdate, onSend, onPage } = props;
  const [preview, setPreview] = useState(false),
    [edited, setEdited] = useState(""),
    [editing, setEditing] = useState(false),
    [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    answer = useRef<HTMLDivElement>(null);
  const ctx = props.context(note),
    template =
      project.templates.find((t) => t.id === note.templateId) ??
      project.templates[0];
  function openPreview() {
    setEdited(ctx.prompt);
    setPreview(!preview);
  }
  function send() {
    onSend(note.id, preview ? edited : undefined);
    setPreview(false);
  }
  return (
    <article
      id={`note-${note.id}`}
      data-note-id={note.id}
      className={
        "note-card " +
        (props.activeId === note.id ? "is-active" : "") +
        (depth ? " child-note" : "")
      }
    >
      <header className="note-header">
        <button
          className="icon-button"
          aria-label={note.collapsed ? "展开便签" : "折叠便签"}
          onClick={() => onUpdate(note.id, { collapsed: !note.collapsed })}
        >
          {note.collapsed ? (
            <ChevronRight size={15} />
          ) : (
            <ChevronDown size={15} />
          )}
        </button>
        <span className="note-kind">
          {note.parentId ? <GitBranch size={14} /> : <FileText size={14} />}
        </span>
        {editing ? (
          <input
            className="title-input"
            autoFocus
            value={note.title}
            onChange={(e) => onUpdate(note.id, { title: e.target.value })}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
          />
        ) : (
          <button
            className="note-title"
            onClick={() => setEditing(true)}
            title="修改标题"
          >
            {note.title || "未命名便签"}
          </button>
        )}
        <span className="note-page">p.{note.anchor.page}</span>
        <div className="menu-wrap">
          <button
            className="icon-button"
            aria-label="便签菜单"
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={17} />
          </button>
          {menu && (
            <div className="dropdown">
              <button
                onClick={() => {
                  onPage(note.anchor.page);
                  setMenu(false);
                }}
              >
                <LocateFixed size={14} />
                定位原文
              </button>
              <button
                onClick={() => {
                  setEditing(true);
                  setMenu(false);
                }}
              >
                修改标题
              </button>
              <button
                className="danger"
                onClick={() => {
                  setMenu(false);
                  props.onDelete(note.id);
                }}
              >
                删除便签及子追问
              </button>
            </div>
          )}
        </div>
      </header>
      {!note.collapsed && (
        <>
          {(note.branchQuote || note.anchor.quote) && (
            <blockquote className="note-quote">
              {note.branchQuote || note.anchor.quote}
            </blockquote>
          )}
          {!note.messages.length && !note.parentId && (
            <details className="quote-editor">
              <summary>校正选文 / OCR 文字</summary>
              <textarea
                aria-label="校正选文"
                value={note.anchor.quote}
                onChange={(e) =>
                  onUpdate(note.id, {
                    anchor: { ...note.anchor, quote: e.target.value },
                  })
                }
              />
            </details>
          )}
          <div className="messages" ref={answer}>
            {note.messages.map((m) => (
              <div key={m.id} className={`message ${m.role}`}>
                <div className="message-label">
                  {m.role === "assistant" ? (
                    <>
                      <span className="ai-mark">✳</span> InkAsk
                    </>
                  ) : (
                    <>
                      你{" "}
                      <span className="message-time">
                        {new Date(m.createdAt).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </>
                  )}
                </div>
                <div
                  className={
                    "message-body " +
                    (m.status === "streaming" ? "streaming" : "")
                  }
                >
                  <Markdown message={m} project={project} onPage={onPage} />
                  {m.status === "streaming" && !m.content && (
                    <span className="thinking">
                      正在阅读文档<span>•••</span>
                    </span>
                  )}
                </div>
                {!!m.assetIds.length && (
                  <div className="attachment-list">
                    {m.assetIds.map((id) => {
                      const a = project.assets.find((a) => a.id === id);
                      return a ? <AssetImage key={id} asset={a} /> : null;
                    })}
                  </div>
                )}
                {m.error && <p className="inline-error">{m.error}</p>}
                {m.status === "stopped" && (
                  <p className="muted small">已停止 · 部分回答已保留</p>
                )}
                {m.role === "assistant" && m.status !== "streaming" && (
                  <div className="message-actions">
                    <button
                      onClick={() => {
                        const s = window.getSelection();
                        const quote =
                          s &&
                          !s.isCollapsed &&
                          answer.current?.contains(s.anchorNode)
                            ? s.toString().trim()
                            : undefined;
                        props.onBranch(note, m, quote);
                      }}
                    >
                      <GitBranch size={13} />
                      分支追问
                    </button>
                    <button
                      onClick={() =>
                        void navigator.clipboard?.writeText(m.content)
                      }
                    >
                      <Copy size={12} />
                      复制
                    </button>
                    {(m.status === "error" || m.status === "stopped") && (
                      <button onClick={() => props.onRetry(note.id)}>
                        <RotateCcw size={12} />
                        重试
                      </button>
                    )}
                    {m.prompt && (
                      <details>
                        <summary>提问记录</summary>
                        <pre>{m.prompt}</pre>
                      </details>
                    )}
                  </div>
                )}
                {project.notes
                  .filter(
                    (n) => n.parentId === note.id && n.parentMessageId === m.id,
                  )
                  .map((child) =>
                    depth >= 1 ? (
                      <button
                        key={child.id}
                        className="branch-jump"
                        onClick={() => props.onFocus(child.id)}
                      >
                        <GitBranch size={13} />
                        {child.title}
                        <ChevronRight size={14} />
                      </button>
                    ) : (
                      <NoteCard
                        {...props}
                        key={child.id}
                        note={child}
                        depth={depth + 1}
                        busy={props.busyIds.has(child.id)}
                      />
                    ),
                  )}
              </div>
            ))}
          </div>
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
                  附上原文截图
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
                  onClick={send}
                  disabled={!props.apiReady}
                  title={
                    props.apiReady
                      ? "发送 · ⌘/Ctrl + Enter"
                      : "请先在 .env 中配置模型 API"
                  }
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </article>
  );
}
