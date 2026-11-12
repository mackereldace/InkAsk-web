import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderOpen,
  GitBranch,
  HelpCircle,
  Highlighter,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minus,
  Plus,
  RotateCw,
  ScanText,
  Search,
  Settings2,
  Sparkles,
  X,
  ZoomIn,
} from "lucide-react";
import {
  openPdf,
  extractPage,
  renderImage,
  type PDFDocumentProxy,
} from "./pdf";
import ContinuousPdf from "./ContinuousPdf";
import AnswerReader from "./AnswerReader";
import { MathText } from "./Markdown";
import ApiSettings from "./ApiSettings";
import { cancelOcr, recognizePage } from "./ocr";
import { dataUrl, streamChat } from "./chat";
import { buildContext } from "./core/context";
import { createBranch, descendantIds } from "./core/branches";
import { answerFor, parentReadingTarget, readingTrail, type ReadingTarget } from "./core/reading";
import { DEFAULT_TEMPLATES, TASK_LABELS } from "./core/templates";
import {
  saveProject,
  loadProject,
  listDocuments,
  deleteProject,
} from "./core/storage";
import { exportProject, importProject, exportMarkdown } from "./core/archive";
import type {
  Anchor,
  AnswerAnchor,
  ApiStatus,
  Asset,
  InkDocument,
  Message,
  Note,
  Project,
  Task,
} from "./types";
const uid = () => crypto.randomUUID();
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const DEFAULT_STATUS: ApiStatus = {
  configured: false,
  model: "",
  contextBudget: 12000,
};
export default function App() {
  const [project, setProject] = useState<Project>(),
    [pdf, setPdf] = useState<PDFDocumentProxy>(),
    [documents, setDocuments] = useState<InkDocument[]>([]),
    [status, setStatus] = useState(DEFAULT_STATUS),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false),
    [saved, setSaved] = useState("已保存在本机"),
    [saveFailed, setSaveFailed] = useState(false);
  const [selection, setSelection] = useState<Anchor>(),
    [region, setRegion] = useState(false),
    [activeId, setActiveId] = useState<string>(),
    [focusId, setFocusId] = useState<string>(),
    [readingMessageId, setReadingMessageId] = useState<string>(),
    [answerSelection, setAnswerSelection] = useState<{ noteId: string; messageId: string; quote: string; anchor: AnswerAnchor }>(),
    [navigation, setNavigation] = useState(0),
    [ocr, setOcr] = useState<number | null>(null),
    [busyIds, setBusyIds] = useState(new Set<string>()),
    [settings, setSettings] = useState(
      () =>
        new URLSearchParams(window.location.search).get("settings") === "api",
    ),
    [templateId, setTemplateId] = useState(""),
    [exportMenu, setExportMenu] = useState(false),
    [search, setSearch] = useState("");
  const projectRef = useRef<Project | undefined>(undefined),
    pdfRef = useRef<PDFDocumentProxy | undefined>(undefined),
    revision = useRef(0),
    savedRevision = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    queue = useRef(Promise.resolve()),
    controllers = useRef(new Map<string, AbortController>()),
    fileInput = useRef<HTMLInputElement>(null),
    importInput = useRef<HTMLInputElement>(null),
    openEpoch = useRef(0),
    ocrEpoch = useRef(0),
    pdfOwned = useRef(new Set<PDFDocumentProxy>()),
    reader = useRef<HTMLDivElement>(null),
    readingView = useRef<ReadingTarget | undefined>(undefined),
    positions = useRef(new Map<string, { top: number; left: number; page?: number; pageOffset?: number }>()),
    pdfPageSizes = useRef(new Map<number, { width: number; height: number }>()),
    pendingNavigation = useRef<{ key: string; page?: number } | undefined>(undefined);
  function viewKey(target?: ReadingTarget) {
    const note = projectRef.current?.notes.find((n) => n.id === target?.noteId);
    return note ? `${note.id}:${answerFor(note, target?.messageId)?.id ?? "draft"}` : "pdf";
  }
  function navigate(target?: ReadingTarget, page?: number) {
    const root = reader.current;
    if (root) {
      const bounds = root.getBoundingClientRect();
      const sheet = !readingView.current ? [...root.querySelectorAll<HTMLElement>("[data-pdf-page]")]
        .find((element) => element.getBoundingClientRect().bottom > bounds.top) : undefined;
      positions.current.set(viewKey(readingView.current), {
        top: root.scrollTop, left: root.scrollLeft,
        ...(sheet ? { page: Number(sheet.dataset.pdfPage), pageOffset: bounds.top - sheet.getBoundingClientRect().top } : {}),
      });
    }
    readingView.current = target;
    pendingNavigation.current = { key: viewKey(target), page };
    setFocusId(target?.noteId);
    setReadingMessageId(target?.messageId);
    setSelection(undefined);
    setAnswerSelection(undefined);
    setRegion(false);
    window.getSelection()?.removeAllRanges();
    setNavigation((value) => value + 1);
    if (target && ocr !== null) {
      ocrEpoch.current++;
      void cancelOcr();
      setOcr(null);
    }
  }
  useLayoutEffect(() => {
    const root = reader.current;
    const pending = pendingNavigation.current;
    if (!root || !pending) return;
    pendingNavigation.current = undefined;
    const position = positions.current.get(pending.key);
    root.scrollTop = position?.top ?? 0;
    root.scrollLeft = position?.left ?? 0;
    const targetPage = pending.page ?? position?.page;
    if (targetPage && pending.key === "pdf") {
      const sheet = root.querySelector<HTMLElement>(`[data-pdf-page="${targetPage}"]`);
      if (sheet) root.scrollTop += sheet.getBoundingClientRect().top - root.getBoundingClientRect().top + (pending.page ? -20 : position?.pageOffset ?? 0);
    }
  }, [navigation, project?.document.id]);
  const update = useCallback((fn: (p: Project) => void) => {
    const p = projectRef.current;
    if (!p) return;
    const n: Project = {
      ...p,
      document: { ...p.document, updatedAt: Date.now() },
      notes: p.notes.map((n) => ({
        ...n,
        messages: n.messages.map((m) => ({ ...m })),
        draftAssetIds: [...n.draftAssetIds],
      })),
      pages: [...p.pages],
      assets: [...p.assets],
      templates: p.templates.map((t) => ({ ...t })),
      view: { ...p.view },
    };
    fn(n);
    projectRef.current = n;
    revision.current++;
    setProject(n);
    setSaved("正在保存…");
  }, []);
  const persist = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    const rev = revision.current;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        try {
          await saveProject(p);
          if (rev === revision.current) {
            savedRevision.current = rev;
            setSaved("已保存在本机");
            setSaveFailed(false);
          }
        } catch (e) {
          setSaved("保存失败");
          setSaveFailed(true);
          setNotice("本机保存失败，请导出项目备份：" + err(e));
          throw e;
        }
      });
    await queue.current;
  }, []);
  useEffect(() => {
    if (!project || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void persist().catch(() => {});
    }, 700);
  }, [project, persist]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (
        saveFailed ||
        controllers.current.size ||
        savedRevision.current !== revision.current
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
      void persist().catch(() => {});
    };
    window.addEventListener("beforeunload", before);
    const background = () => {
      if (document.visibilityState === "hidden") void persist().catch(() => {});
    };
    document.addEventListener("visibilitychange", background);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("visibilitychange", background);
    };
  }, [persist, saveFailed]);
  useEffect(() => {
    void fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setNotice("本地 API 服务未连接，阅读与 OCR 仍可使用。"));
    void listDocuments()
      .then(setDocuments)
      .catch((e) => setNotice("无法读取本地资料库：" + err(e)));
    return () => {
      for (const c of controllers.current.values()) c.abort();
    };
  }, []);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  async function refresh() {
    setDocuments(await listDocuments());
  }
  async function openExisting(id: string) {
    if (projectRef.current?.document.id === id) { navigate(); return; }
    try {
      await persist();
      const p = await loadProject(id);
      if (p) await activate(p);
    } catch (e) {
      setNotice(err(e));
    }
  }
  async function activate(p: Project) {
    const epoch = ++openEpoch.current;
    setLoading(true);
    setSelection(undefined);
    setFocusId(undefined);
    setReadingMessageId(undefined);
    setAnswerSelection(undefined);
    setActiveId(undefined);
    readingView.current = undefined;
    positions.current.clear();
    pdfPageSizes.current.clear();
    pendingNavigation.current = { key: "pdf", page: p.view.page };
    ocrEpoch.current++;
    void cancelOcr();
    setOcr(null);
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    setBusyIds(new Set());
    try {
      await persist().catch(() => {
        throw new Error("当前项目尚未保存，请先导出备份。");
      });
      const d = await openPdf(p.document.pdf);
      if (epoch !== openEpoch.current) {
        await d.destroy();
        return;
      }
      const previous = pdfRef.current;
      pdfOwned.current.add(d);
      pdfRef.current = d;
      setPdf(d);
      p.document.pageCount = d.numPages;
      projectRef.current = p;
      revision.current++;
      setProject(p);
      setSaved("正在保存…");
      if (previous) {
        pdfOwned.current.delete(previous);
        void previous.destroy();
      }
      for (let page = 1; page <= d.numPages; page++) {
        if (epoch !== openEpoch.current) break;
        const cached = projectRef.current?.pages.find((p) => p.page === page);
        if (cached && cached.status !== "pending" && cached.status !== "error")
          continue;
        try {
          const text = await extractPage(d, page);
          if (epoch === openEpoch.current)
            update((p) => {
              if (p.pages.some((x) => x.page === page && x.source === "ocr"))
                return;
              p.pages = p.pages.filter((x) => x.page !== page);
              p.pages.push(text);
            });
        } catch {
          if (epoch === openEpoch.current)
            update((p) => {
              const x = p.pages.find((x) => x.page === page);
              if (x) x.status = "error";
            });
        }
        if (page === 1) setLoading(false);
      }
    } catch (e) {
      setNotice("打开失败：" + err(e));
    } finally {
      if (epoch === openEpoch.current) setLoading(false);
    }
  }
  async function openFile(file: File) {
    if (file.size > 100 * 1024 * 1024) {
      setNotice("首版支持 100 MB 以内的 PDF，请拆分后导入。");
      return;
    }
    setLoading(true);
    try {
      const first = new TextDecoder().decode(
        await file.slice(0, 1024).arrayBuffer(),
      );
      if (!first.includes("%PDF-")) throw new Error("请选择有效的 PDF 文件");
      const hash = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const fingerprint = Array.from(new Uint8Array(hash))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      const existing = documents.find((d) => d.fingerprint === fingerprint);
      if (existing) {
        await openExisting(existing.id);
        return;
      }
      const p: Project = {
        version: 1,
        document: {
          id: uid(),
          name: file.name,
          fingerprint,
          pdf: file,
          pageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        pages: [],
        notes: [],
        assets: [],
        templates: structuredClone(DEFAULT_TEMPLATES),
        view: { page: 1, scale: 0.95, rotation: 0 },
      };
      await activate(p);
      await persist();
      await refresh();
    } catch (e) {
      setNotice(err(e));
    } finally {
      setLoading(false);
    }
  }
  function pageTo(page: number) {
    const p = projectRef.current;
    if (!p) return;
    const target = Math.min(Math.max(1, page), p.document.pageCount);
    update((project) => { project.view.page = target; });
    navigate(undefined, target);
    setActiveId(undefined);
  }
  function focus(id: string, messageId?: string) {
    if (!projectRef.current?.notes.some((note) => note.id === id)) return;
    navigate({ noteId: id, messageId });
    setActiveId(id);
  }
  function back() {
    const p = projectRef.current;
    if (!p || !focusId) return;
    const parent = parentReadingTarget(p.notes, focusId);
    if (parent) { focus(parent.noteId, parent.messageId); setActiveId(focusId); }
    else navigate();
  }
  function removeNote(id: string) {
    const p = projectRef.current;
    if (!p) return;
    const ids = new Set([id, ...descendantIds(p.notes, id)]);
    if (focusId && ids.has(focusId)) {
      const parent = parentReadingTarget(p.notes, id);
      navigate(parent);
    }
    for (const child of ids) controllers.current.get(child)?.abort();
    update((project) => { project.notes = project.notes.filter((note) => !ids.has(note.id)); });
  }
  async function attach(id: string, files: File[]) {
    for (const file of files) {
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 10 * 1024 * 1024
      ) {
        setNotice("支持 10 MB 以内的 PNG、JPEG 或 WebP 图片。");
        continue;
      }
      const asset: Asset = {
        id: uid(),
        name: file.name,
        mime: file.type,
        data: file,
      };
      update((p) => {
        const n = p.notes.find((n) => n.id === id);
        if (n && n.draftAssetIds.length < 4) {
          p.assets.push(asset);
          n.draftAssetIds.push(asset.id);
        } else setNotice("每次提问最多附加 4 张图片。");
      });
    }
  }
  async function screenshot(note: Note) {
    const d = pdfRef.current,
      documentId = projectRef.current?.document.id;
    if (!d) return;
    try {
      const rect = note.anchor.rects.reduce(
        (a, b) =>
          [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.max(a[2], b[2]),
            Math.max(a[3], b[3]),
          ] as Anchor["rects"][0],
      );
      const { blob } = await renderImage(
        await d.getPage(note.anchor.page),
        rect,
        projectRef.current?.view.rotation ?? 0,
      );
      if (projectRef.current?.document.id !== documentId) return;
      const asset: Asset = {
        id: uid(),
        name: `第 ${note.anchor.page} 页选区.png`,
        mime: "image/png",
        data: blob,
        source: { page: note.anchor.page, rect },
      };
      update((p) => {
        const n = p.notes.find((n) => n.id === note.id);
        if (n && n.draftAssetIds.length < 4) {
          p.assets.push(asset);
          n.draftAssetIds.push(asset.id);
        }
      });
    } catch (e) {
      setNotice("截图失败：" + err(e));
    }
  }
  async function makeNote(task: Task, withScreenshot = false) {
    const p = projectRef.current;
    if (!p) return;
    if (answerSelection) {
      const parent = p.notes.find((note) => note.id === answerSelection.noteId);
      const message = parent?.messages.find((message) => message.id === answerSelection.messageId);
      if (parent && message) branch(parent, message, answerSelection.quote, task, answerSelection.anchor);
      return;
    }
    if (!selection) return;
    const template = p.templates.find((t) => t.task === task) ?? p.templates[0];
    const n: Note = {
      id: uid(),
      title: selection.quote ? selection.quote.slice(0, 24) : "关于这片区域",
      anchor: structuredClone(selection),
      inheritedHistory: [],
      collapsed: false,
      task,
      templateId: template.id,
      draft: "",
      draftAssetIds: [],
      messages: [],
      createdAt: Date.now(),
    };
    update((p) => p.notes.push(n));
    focus(n.id);
    if (withScreenshot || !n.anchor.quote) await screenshot(n);
  }
  function context(n: Note) {
    const p = projectRef.current!;
    return buildContext({
      project: p,
      note: n,
      question: n.draft,
      template:
        p.templates.find((t) => t.id === n.templateId) ?? p.templates[0],
      budget: status.contextBudget,
    });
  }
  async function send(id: string, promptOverride?: string, retry = false) {
    const p = projectRef.current,
      n = p?.notes.find((n) => n.id === id);
    if (!p || !n || controllers.current.has(id)) return;
    const documentId = p.document.id;
    const lastUser = [...n.messages].reverse().find((m) => m.role === "user");
    const template =
      p.templates.find((t) => t.id === n.templateId) ?? p.templates[0];
    const ctx =
      retry && lastUser?.prompt
        ? {
            prompt: lastUser.prompt,
            sources: lastUser.sources ?? [],
            coverage: lastUser.coverage ?? "",
            history: lastUser.history ?? [],
            truncated: false,
          }
        : context(n);
    const prompt = promptOverride ?? ctx.prompt;
    const assetIds =
      retry && lastUser ? lastUser.assetIds : [...n.draftAssetIds];
    const text =
      retry && lastUser ? lastUser.content : n.draft || TASK_LABELS[n.task];
    const answerId =
      retry && n.messages.at(-1)?.role === "assistant"
        ? n.messages.at(-1)!.id
        : uid();
    const control = new AbortController();
    controllers.current.set(id, control);
    setBusyIds(new Set(controllers.current.keys()));
    update((p) => {
      const note = p.notes.find((n) => n.id === id)!;
      if (retry && note.messages.at(-1)?.role === "assistant")
        note.messages.pop();
      if (!retry)
        note.messages.push({
          id: uid(),
          role: "user",
          content: text,
          assetIds,
          status: "complete",
          createdAt: Date.now(),
          prompt,
          template: structuredClone(template),
          sources: ctx.sources,
          coverage: ctx.coverage,
          history: structuredClone(ctx.history),
        });
      note.messages.push({
        id: answerId,
        role: "assistant",
        content: "",
        assetIds: [],
        status: "streaming",
        createdAt: Date.now(),
        prompt,
        sources: ctx.sources,
        coverage: ctx.coverage,
      });
      note.draft = "";
      note.draftAssetIds = [];
    });
    const patch = (fn: (m: Message) => void) => {
      if (projectRef.current?.document.id !== documentId) return;
      update((p) => {
        const m = p.notes
          .find((n) => n.id === id)
          ?.messages.find((m) => m.id === answerId);
        if (m) fn(m);
      });
    };
    try {
      const images = await Promise.all(
        assetIds.map((id) => {
          const a = p.assets.find((a) => a.id === id);
          if (!a) throw new Error("附加图片缺失");
          return dataUrl(a.data);
        }),
      );
      const history = await Promise.all(
        ctx.history.map(async (h) => ({
          role: h.role,
          content: h.content,
          images: await Promise.all(
            (h.assetIds ?? []).map((id) => {
              const a = p.assets.find((a) => a.id === id);
              return a ? dataUrl(a.data) : Promise.resolve("");
            }),
          ).then((x) => x.filter(Boolean)),
        })),
      );
      await streamChat({ prompt, history, images }, control.signal, (delta) =>
        patch((m) => {
          m.content += delta;
        }),
      );
      patch((m) => {
        m.status = "complete";
      });
    } catch (e) {
      patch((m) => {
        m.status = control.signal.aborted ? "stopped" : "error";
        if (!control.signal.aborted) m.error = err(e);
      });
    } finally {
      controllers.current.delete(id);
      setBusyIds(new Set(controllers.current.keys()));
      void persist().catch(() => {});
    }
  }
  function branch(parent: Note, message: Message, quote?: string, task: Task = "custom", answerAnchor?: AnswerAnchor) {
    const p = projectRef.current;
    if (!p) return;
    const n = createBranch(p, parent, message.id, quote, task, answerAnchor);
    update((p) => p.notes.push(n));
    focus(n.id);
  }
  async function recognize(rect?: Anchor["rects"][0], selectedPage?: number) {
    const d = pdfRef.current,
      p = projectRef.current;
    if (!d || !p || ocr !== null) return;
    const page = selectedPage ?? p.view.page,
      docId = p.document.id,
      epoch = ++ocrEpoch.current;
    setOcr(0);
    try {
      const result = await recognizePage(
        await d.getPage(page),
        rect,
        (n) => {
          if (epoch === ocrEpoch.current) setOcr(n);
        },
        p.view.rotation,
      );
      if (
        epoch !== ocrEpoch.current ||
        projectRef.current?.document.id !== docId
      )
        return;
      update((p) => {
        const old = p.pages.find((x) => x.page === page);
        if (rect && old?.status === "ready") {
          const intersects = (r: Anchor["rects"][0]) =>
            r[0] < rect[2] &&
            r[2] > rect[0] &&
            r[1] < rect[3] &&
            r[3] > rect[1];
          const first = old.words.findIndex((w) => intersects(w.rect));
          const words = old.words.filter((w) => !intersects(w.rect));
          const insertAt =
            first < 0
              ? words.length
              : old.words.slice(0, first).filter((w) => !intersects(w.rect))
                  .length;
          words.splice(insertAt, 0, ...result.words);
          p.pages = p.pages.filter((x) => x.page !== page);
          p.pages.push({
            ...result,
            words,
            text: words.map((w) => w.text).join(" "),
          });
        } else {
          p.pages = p.pages.filter((x) => x.page !== page);
          p.pages.push(result);
        }
      });
      if (rect)
        setSelection({ page, rects: [rect], quote: result.text.trim() });
      if (!result.text.trim())
        setNotice("未识别到文字，可重选区域或直接截图提问。");
    } catch (e) {
      if (epoch === ocrEpoch.current)
        setNotice("OCR 失败，可重试或截图提问：" + err(e));
    } finally {
      if (epoch === ocrEpoch.current) setOcr(null);
    }
  }
  async function stopOcr() {
    ocrEpoch.current++;
    setOcr(null);
    await cancelOcr();
  }
  async function importFile(file: File) {
    setLoading(true);
    try {
      const p = await importProject(file);
      await activate(p);
      await persist();
      await refresh();
      setNotice("项目已导入为独立副本。");
    } catch (e) {
      setNotice("导入失败：" + err(e));
    } finally {
      setLoading(false);
    }
  }
  async function exportZip() {
    const p = projectRef.current;
    if (!p) return;
    setExportMenu(false);
    try {
      download(
        await exportProject(p),
        p.document.name.replace(/\.pdf$/i, "") + ".inkask",
      );
    } catch (e) {
      setNotice("导出失败：" + err(e));
    }
  }
  const page = project?.view.page ?? 1,
    currentText = project?.pages.find((p) => p.page === page),
    roots =
      project?.notes.filter((n) => !n.parentId && n.anchor.page === page) ?? [],
    focused = project?.notes.find((n) => n.id === focusId);
  const parents = readingTrail(project?.notes ?? [], focusId);
  const totalNotes = project?.notes.length ?? 0,
    donePages = project?.pages.filter((p) => p.status === "ready").length ?? 0;
  return (
    <div
      className="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (e.target instanceof Element && e.target.closest(".composer"))
          return;
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) void (f.name.endsWith(".inkask") ? importFile(f) : openFile(f));
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openFile(f);
          e.target.value = "";
        }}
      />
      <input
        ref={importInput}
        type="file"
        accept=".inkask"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = "";
        }}
      />
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate();
          }}
        >
          <span className="brand-icon">
            i<span>✳</span>
          </span>
          <strong>inkask</strong>
          <span className="beta">BETA</span>
        </a>
        <div className="workspace-name">
          <span className="workspace-avatar">我</span>
          <div>
            我的阅读空间<small>LOCAL WORKSPACE</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <button
          className="primary open-pdf"
          onClick={() => fileInput.current?.click()}
        >
          <Plus size={17} />
          打开 PDF<span>⌘ O</span>
        </button>
        <div className="library-label">
          资料库 <span>{documents.length}</span>
        </div>
        <div className="search-box">
          <Search size={14} />
          <input
            aria-label="搜索资料"
            placeholder="搜索资料…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <nav className="document-list">
          {documents
            .filter((d) => d.name.toLowerCase().includes(search.toLowerCase()))
            .map((d) => (
              <div
                className={
                  "document-row " +
                  (project?.document.id === d.id ? "active" : "")
                }
                key={d.id}
              >
                <button onClick={() => void openExisting(d.id)}>
                  <FileText size={16} />
                  <span>{d.name}</span>
                </button>
                <button
                  className="remove-doc"
                  title="删除本机项目"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `删除「${d.name}」及本机笔记？请先导出备份。`,
                      )
                    )
                      return;
                    if (projectRef.current?.document.id === d.id) {
                      setNotice("请先打开另一份文档，再删除当前项目。");
                      return;
                    }
                    void deleteProject(d.id)
                      .then(refresh)
                      .catch((e) => setNotice(err(e)));
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          {!documents.length && (
            <p className="empty-library">
              你的下一次发现
              <br />
              从一份文档开始。
            </p>
          )}
        </nav>
        <button
          className="sidebar-action"
          onClick={() => importInput.current?.click()}
        >
          <FolderOpen size={16} />
          导入 InkAsk 项目
        </button>
        <div className="sidebar-bottom">
          <div className="local-badge">
            <span className="status-dot" />
            文档保存在你的设备上
          </div>
          <button className="sidebar-action" onClick={() => setSettings(true)}>
            <Settings2 size={16} />
            API 与模板
          </button>
          <span className="version">InkAsk 0.1 · 思考，留在原文旁</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <BookOpen size={16} />
            <span>阅读空间</span>
            {project && (
              <>
                <ChevronRight size={13} />
                <strong>{project.document.name}</strong>
              </>
            )}
          </div>
          <div className="topbar-right">
            <span className={"save-indicator " + (saveFailed ? "error" : "")}>
              {saved === "正在保存…" ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <Check size={13} />
              )}{" "}
              {saved}
            </span>
            <button
              className="icon-button"
              onClick={() => setSettings(true)}
              aria-label="帮助与设置"
            >
              <HelpCircle size={18} />
            </button>
            {project && (
              <div className="menu-wrap">
                <button
                  className="secondary"
                  onClick={() => setExportMenu(!exportMenu)}
                >
                  <ArrowDownToLine size={14} />
                  导出
                  <ChevronDown size={12} />
                </button>
                {exportMenu && (
                  <div className="dropdown export-dropdown">
                    <button onClick={() => void exportZip()}>
                      完整项目 (.inkask)
                    </button>
                    <button
                      onClick={() => {
                        download(
                          new Blob([exportMarkdown(project)], {
                            type: "text/markdown;charset=utf-8",
                          }),
                          project.document.name + ".md",
                        );
                        setExportMenu(false);
                      }}
                    >
                      笔记 Markdown
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>
        {notice && (
          <div className="notice" role="alert">
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="关闭通知"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {!project ? (
          <div className="welcome">
            <div className="eyebrow">
              <span /> A LITTLE SPACE FOR BIG IDEAS
            </div>
            <h1>
              读到这里，
              <br />
              让思考<span>展开。</span>
            </h1>
            <p>把问题留在原文旁，让每一次追问都有迹可循。</p>
            <button
              className="upload-zone"
              onClick={() => fileInput.current?.click()}
            >
              <span className="upload-icon">
                <FilePlus2 size={30} />
                <span>+</span>
              </span>
              <strong>打开一份 PDF，开始阅读</strong>
              <span>拖放文件到这里，或点击选择</span>
              <small>文字与扫描文档 · PDF，最大 100 MB</small>
              <span className="upload-cta">
                选择 PDF <ArrowUpRight size={15} />
              </span>
            </button>
            <button
              className="sample-button"
              onClick={() =>
                void fetch("/sample.pdf")
                  .then((r) => {
                    if (!r.ok) throw new Error("示例资料加载失败");
                    return r.blob();
                  })
                  .then((b) =>
                    openFile(
                      new File([b], "理解导数 · InkAsk 示例.pdf", {
                        type: "application/pdf",
                      }),
                    ),
                  )
                  .catch((e) => setNotice(err(e)))
              }
            >
              先打开示例资料 <ArrowUpRight size={12} />
            </button>
            <div className="welcome-features">
              <div>
                <Highlighter size={18} />
                <strong>选中，即可提问</strong>
                <span>原文就是问题的起点</span>
              </div>
              <div>
                <MessageSquarePlus size={18} />
                <strong>便签，承载思考</strong>
                <span>回答留在你需要的位置</span>
              </div>
              <div>
                <GitBranch size={18} />
                <strong>追问，自由分支</strong>
                <span>沿着好奇心继续探索</span>
              </div>
            </div>
            <div className="welcome-foot">
              <span className="status-dot" />
              本地保存 · 无需账号 <span>AI 回答需配置模型 API</span>
            </div>
          </div>
        ) : (
          <>
            <div className="document-heading">
              <div>
                <span className="eyebrow">{focused ? `READING CHAIN · 第 ${parents.length} 层` : "READ · ASK · UNDERSTAND"}</span>
                <h1>{focused ? <MathText>{focused.title}</MathText> : project.document.name.replace(/\.pdf$/i, "")}</h1>
                <p>{focused ? "阅读回答，选中文字继续提问" : <>{project.document.pageCount} 页 <span>·</span> {totalNotes} 个思考便签 <span>·</span> 已提取 {donePages} 页文字</>}</p>
              </div>
              <span className="document-tag"><span />{focused ? "回答阅读" : "连续阅读"}</span>
            </div>
            {focused ? <div className="reader-toolbar answer-navigation">
              <button className="back-reading" onClick={back}><ChevronLeft size={17} />返回上一层</button>
              <nav aria-label="阅读层级" className="reading-trail">
                <button onClick={() => navigate()} title={project.document.name}><FileText size={13} />原始 PDF</button>
                {parents.map((note, index) => <span key={note.id}><ChevronRight size={12} />
                  <button aria-current={note.id === focusId ? "page" : undefined} disabled={note.id === focusId}
                    onClick={() => focus(note.id, parents[index + 1]?.parentMessageId)} title={note.title}><MathText>{note.title}</MathText></button>
                </span>)}
              </nav>
            </div> : <div className="reader-toolbar">
              <div className="page-controls">
                <button className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => pageTo(page - 1)}><ChevronLeft size={17} /></button>
                <input aria-label="页码" type="number" min="1" max={project.document.pageCount} value={page}
                  onChange={(e) => { const n = Number(e.target.value); if (n) pageTo(n); }} />
                <span>/ {project.document.pageCount}</span>
                <button className="icon-button" aria-label="下一页" disabled={page >= project.document.pageCount} onClick={() => pageTo(page + 1)}><ChevronRight size={17} /></button>
              </div>
              <div className="toolbar-divider" />
              <div className="zoom-controls">
                <button className="icon-button" aria-label="缩小" onClick={() => update((p) => { p.view.scale = Math.max(0.4, p.view.scale - 0.1); })}><Minus size={15} /></button>
                <span>{Math.round(project.view.scale * 100)}%</span>
                <button className="icon-button" aria-label="放大" onClick={() => update((p) => { p.view.scale = Math.min(2, p.view.scale + 0.1); })}><Plus size={15} /></button>
                <button className="icon-button" aria-label="旋转页面" onClick={() => update((p) => { p.view.rotation = (p.view.rotation + 90) % 360; })}><RotateCw size={15} /></button>
                <button className="icon-button" aria-label="适合宽度" onClick={() => update((p) => {
                  const text = pdfPageSizes.current.get(p.view.page) ?? p.pages.find((item) => item.page === p.view.page);
                  const width = p.view.rotation % 180 ? text?.height ?? 800 : text?.width ?? 600;
                  p.view.scale = Math.max(0.4, Math.min(2, ((reader.current?.clientWidth ?? 700) - 76) / width));
                })}><Maximize2 size={15} /></button>
              </div>
              <div className="toolbar-spacer" />
              <button className={"tool-button " + (region ? "selected" : "")} onClick={() => { setRegion(!region); setSelection(undefined); }}>
                <Highlighter size={15} />{region ? "正在框选" : "框选区域"}
              </button>
              {ocr !== null ? <button className="tool-button" onClick={() => void stopOcr()}><Loader2 size={14} className="spin" />{Math.round(ocr * 100)}% · 取消</button> :
                <button className="tool-button" onClick={() => void recognize()}><ScanText size={15} />{currentText?.source === "ocr" ? "重新识别" : "识别本页"}</button>}
              <span className="toolbar-divider" /><span className="notes-count"><MessageSquarePlus size={14} /> {roots.length}</span>
            </div>}
            {!status.configured && <div className="api-hint"><Sparkles size={14} />
              <span>阅读已就绪。配置模型 API 后，即可在便签中获得 AI 回答。</span>
              <button onClick={() => setSettings(true)}>如何配置<ArrowUpRight size={12} /></button>
            </div>}
            <div ref={reader} className={"reader-area " + (focused ? "answer-reader-area" : "pdf-reader-area")}>
              {focused ? <AnswerReader key={`${focused.id}:${readingMessageId ?? "latest"}`} note={focused} messageId={readingMessageId} activeId={activeId} project={project}
                busy={busyIds.has(focused.id)} apiReady={status.configured} context={context}
                onUpdate={(id, change) => update((p) => { const note = p.notes.find((n) => n.id === id); if (note) Object.assign(note, change); })}
                onSend={(id, prompt) => void send(id, prompt)} onStop={(id) => controllers.current.get(id)?.abort()}
                onRetry={(id) => void send(id, undefined, true)} onBranch={(note, message, anchor) => branch(note, message, anchor?.quote, "custom", anchor)} onDelete={removeNote}
                onPage={pageTo} onFocus={focus} onAttach={(id, files) => void attach(id, files)} onScreenshot={(note) => void screenshot(note)}
                onSelect={(note, message, anchor) => { setSelection(undefined); setAnswerSelection({ noteId: note.id, messageId: message.id, quote: anchor.quote, anchor }); }} onClearSelection={() => setAnswerSelection(undefined)}
              /> : pdf && <ContinuousPdf pdf={pdf} project={project} scrollRoot={reader} pageSizes={pdfPageSizes.current} activeId={activeId} regionMode={region}
                onSelect={(anchor) => { setAnswerSelection(undefined); setSelection(anchor); }} onFocus={focus} onError={setNotice}
                onClearSelection={() => setSelection(undefined)}
                onPageChange={(page) => { if (projectRef.current?.view.page !== page) update((p) => { p.view.page = page; }); }} />}
            </div>
            {(selection || answerSelection) && (
              <div className="selection-toolbar" onMouseDown={(e) => e.preventDefault()}>
                <div className="selected-excerpt">
                  {answerSelection ? <MathText>{answerSelection.quote}</MathText> : (selection?.quote)
                    ? `“${selection.quote.slice(0, 50)}${selection.quote.length > 50 ? "…" : ""}”`
                    : "已选择页面区域"}
                </div>
                <div className="selection-actions">
                  {(
                    [
                      "explain",
                      "formula",
                      "summarize",
                      "translate",
                      "custom",
                    ] as Task[]
                  ).map((t) => (
                    <button key={t} onClick={() => void makeNote(t)}>
                      {t === "explain" && <Sparkles size={13} />}{" "}
                      {TASK_LABELS[t]}
                    </button>
                  ))}
                  {!answerSelection && <button onClick={() => void makeNote("custom", true)}>截图提问</button>}
                  {selection && !selection.quote && (
                    <button
                      disabled={ocr !== null}
                      onClick={() => void recognize(selection.rects[0], selection.page)}
                    >
                      <ScanText size={13} />
                      识别区域
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label="取消选区"
                    onClick={() => { setSelection(undefined); setAnswerSelection(undefined); window.getSelection()?.removeAllRanges(); }}
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        <footer className="app-footer">
          <span>
            <span className="status-dot" />
            {status.configured ? `AI 已配置 · ${status.model}` : "本地阅读模式"}
          </span>
          <span>
            边读，边问。让理解多走一步。 <Sparkles size={11} />
          </span>
        </footer>
      </main>
      {loading && (
        <div className="loading-toast">
          <Loader2 size={16} className="spin" />
          正在打开文档…
        </div>
      )}
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="API 与模板"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">MAKE IT YOURS</span>
                <h2>API 与模板</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭设置"
                onClick={() => setSettings(false)}
              >
                <X size={19} />
              </button>
            </header>
            <div className="settings-content">
              <ApiSettings status={status} onChange={setStatus} />
              <h3>提示词模板</h3>
              {!project ? (
                <p className="muted">
                  打开一份 PDF 后即可编辑模板。模板随项目保存与导出。
                </p>
              ) : (
                <>
                  <select
                    aria-label="编辑模板"
                    value={templateId || project.templates[0]?.id}
                    onChange={(e) => setTemplateId(e.target.value)}
                  >
                    {project.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · v{t.version}
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const t =
                      project.templates.find((t) => t.id === templateId) ??
                      project.templates[0];
                    return t ? (
                      <div className="template-editor">
                        <input
                          aria-label="模板名称"
                          value={t.name}
                          onChange={(e) =>
                            update((p) => {
                              const target = p.templates.find(
                                (x) => x.id === t.id,
                              )!;
                              target.name = e.target.value;
                              target.version++;
                            })
                          }
                        />
                        <textarea
                          aria-label="模板内容"
                          value={t.body}
                          onChange={(e) =>
                            update((p) => {
                              const target = p.templates.find(
                                (x) => x.id === t.id,
                              )!;
                              target.body = e.target.value;
                              target.version++;
                            })
                          }
                        />
                        <div className="template-actions">
                          <button
                            className="secondary"
                            onClick={() => {
                              const id = uid();
                              update((p) =>
                                p.templates.push({
                                  ...t,
                                  id,
                                  name: t.name + " · 副本",
                                  version: 1,
                                }),
                              );
                              setTemplateId(id);
                            }}
                          >
                            另存为模板
                          </button>
                          <button
                            className="secondary"
                            onClick={() =>
                              update((p) => {
                                const original = DEFAULT_TEMPLATES.find(
                                  (x) => x.task === t.task,
                                )!;
                                const target = p.templates.find(
                                  (x) => x.id === t.id,
                                )!;
                                target.body = original.body;
                                target.version++;
                              })
                            }
                          >
                            恢复默认内容
                          </button>
                        </div>
                        <p className="small muted">
                          支持 {"{{task}}"}、{"{{selected_text}}"}、
                          {"{{question}}"}、{"{{context_with_source_ids}}"}{" "}
                          等变量。
                        </p>
                      </div>
                    ) : null;
                  })()}
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
