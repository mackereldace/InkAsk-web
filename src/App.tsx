import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  HelpCircle,
  Highlighter,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minus,
  Plus,
  PanelLeft,
  RotateCw,
  ScanText,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import {
  openPdf,
  extractPage,
  renderImage, screenRect,
  type PageViewport,
  type PDFDocumentProxy,
} from "./pdf";
import ContinuousPdf from "./ContinuousPdf";
import AnswerReader from "./AnswerReader";
import Library from "./Library";
import SelectionPopover from "./SelectionPopover";
import type { SourcePreviewResult } from "./SourceCitation";
import { sourceAnchor, unionRects } from "./core/source-location";
import { sourceEvidencePreview } from "./core/source-preview";
import { answerAnchorRange } from "./core/answer-selection";
import { anchorFragments, anchorPage } from "./core/pdf-anchor";
import "./pdf-reader.css";
import "./reader-interactions.css";
import "./library.css";
import { folderLabel, libraryDocuments } from "./core/library";
import { MathText } from "./Markdown";
import ApiSettings from "./ApiSettings";
import { cancelOcr, recognizePage } from "./ocr";
import { dataUrl, streamChat } from "./chat";
import { buildContext } from "./core/context";
import { copyProjectForEdit } from "./core/project-edit";
import { ProjectSaveQueue } from "./core/project-save";
import { createBranch, descendantIds } from "./core/branches";
import { answerFor, parentReadingTarget, readingTrail, type ReadingTarget } from "./core/reading";
import { DEFAULT_TEMPLATES, TASK_LABELS } from "./core/templates";
import {
  saveProject,
  loadProject,
  listDocuments,
  deleteProject,
  listFolders, listDocumentFolders, createFolder, renameFolder, deleteFolder, moveDocument, moveFolder,
  type WorkspaceFolder,
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
  Task, Source,
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
    [folders, setFolders] = useState<WorkspaceFolder[]>([]),
    [documentFolders, setDocumentFolders] = useState<Record<string, string>>({}),
    [currentFolder, setCurrentFolder] = useState<string>(),
    [libraryVisible, setLibraryVisible] = useState(true),
    [sidebarOpen, setSidebarOpen] = useState(false),
    [answerScale, setAnswerScale] = useState(1),
    [status, setStatus] = useState(DEFAULT_STATUS),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false),
    [switching, setSwitching] = useState(false),
    [saved, setSaved] = useState("已保存在本机"),
    [saveFailed, setSaveFailed] = useState(false);
  const [selection, setSelection] = useState<Anchor>(),
    [citationAnchor, setCitationAnchor] = useState<Anchor>(),
    [selectionViewport, setSelectionViewport] = useState<{ page: number; viewport: PageViewport; atStart: boolean }>(),
    [draftId, setDraftId] = useState<string>(),
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
    queue = useRef<ProjectSaveQueue | undefined>(undefined),
    controllers = useRef(new Map<string, AbortController>()),
    fileInput = useRef<HTMLInputElement>(null),
    importInput = useRef<HTMLInputElement>(null),
    openEpoch = useRef(0),
    openRequest = useRef(0),
    switchLocks = useRef(new Set<number>()),
    captures = useRef(new Map<string, Promise<Asset[] | undefined>>()),
    sourcePreviews = useRef(new Map<string, Promise<Blob>>()),
    sourceQueue = useRef(Promise.resolve()),
    selectionEpoch = useRef(0),
    pendingZoom = useRef<{ top: number; left: number; x: number; y: number; ratio: number } | undefined>(undefined),
    ocrEpoch = useRef(0),
    pdfOwned = useRef(new Set<PDFDocumentProxy>()),
    reader = useRef<HTMLDivElement>(null),
    readingView = useRef<ReadingTarget | undefined>(undefined),
    positions = useRef(new Map<string, { top: number; left: number; page?: number; pageOffset?: number }>()),
    pdfPageSizes = useRef(new Map<number, { width: number; height: number }>()),
    pendingNavigation = useRef<{ key: string; page?: number; anchor?: Anchor } | undefined>(undefined);
  function viewKey(target?: ReadingTarget) {
    const note = projectRef.current?.notes.find((n) => n.id === target?.noteId);
    return note ? `${note.id}:${answerFor(note, target?.messageId)?.id ?? "draft"}` : "pdf";
  }
  function clearSelection() {
    selectionEpoch.current++; setSelection(undefined); setAnswerSelection(undefined); setCitationAnchor(undefined); setDraftId(undefined);
    window.getSelection()?.removeAllRanges();
  }
  function rememberPosition() {
    const root = reader.current;
    if (root) {
      const bounds = root.getBoundingClientRect();
      const sheet = !readingView.current ? [...root.querySelectorAll<HTMLElement>("[data-pdf-page]")]
        .find((element) => projectRef.current?.view.direction === "horizontal" ? element.getBoundingClientRect().right > bounds.left : element.getBoundingClientRect().bottom > bounds.top) : undefined;
      positions.current.set(viewKey(readingView.current), {
        top: root.scrollTop, left: root.scrollLeft,
        ...(sheet ? { page: Number(sheet.dataset.pdfPage), pageOffset: projectRef.current?.view.direction === "horizontal" ? bounds.left - sheet.getBoundingClientRect().left : bounds.top - sheet.getBoundingClientRect().top } : {}),
      });
    }
  }
  function navigate(target?: ReadingTarget, page?: number, anchor?: Anchor) {
    rememberPosition();
    setLibraryVisible(false); setSidebarOpen(false);
    readingView.current = target;
    pendingNavigation.current = { key: viewKey(target), page, anchor };
    setFocusId(target?.noteId);
    setReadingMessageId(target?.messageId);
    clearSelection();
    setRegion(false);
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
    root.scrollTop = pending.page ? 0 : position?.top ?? 0;
    root.scrollLeft = pending.page ? 0 : position?.left ?? 0;
    const targetPage = pending.page ?? position?.page;
    if (targetPage && pending.key === "pdf") {
      const sheet = root.querySelector<HTMLElement>(`[data-pdf-page="${targetPage}"]`);
      if (sheet) {
        const offset = pending.page ? 0 : position?.pageOffset ?? 0;
        if (projectRef.current?.view.direction === "horizontal") root.scrollLeft += sheet.getBoundingClientRect().left - root.getBoundingClientRect().left + offset;
        else root.scrollTop += sheet.getBoundingClientRect().top - root.getBoundingClientRect().top + offset;
      }
    }
    if (pending.anchor && pdfRef.current && projectRef.current) {
      const anchor = pending.anchor, document = pdfRef.current, view = projectRef.current.view;
      let cancelled = false, frame = 0;
      void document.getPage(anchor.page).then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: view.scale, rotation: (page.rotate + view.rotation) % 360 });
        frame = requestAnimationFrame(() => {
          if (cancelled) return;
          const sheet = root.querySelector<HTMLElement>(`[data-pdf-page="${anchor.page}"] .pdf-sheet-content`);
          const rect = anchor.rects[0] && screenRect(viewport, anchor.rects[0]);
          if (!sheet || !rect) return;
          const bounds = root.getBoundingClientRect(), origin = sheet.getBoundingClientRect();
          root.scrollTop += origin.top + rect[1] - bounds.top - Math.min(64, bounds.height * .15);
          const left = origin.left + rect[0], right = origin.left + rect[2];
          if (view.direction === "horizontal" || left < bounds.left || right > bounds.right)
            root.scrollLeft += left - bounds.left - 24;
        });
      }).catch(() => {});
      return () => { cancelled = true; cancelAnimationFrame(frame); };
    }
  }, [navigation, project?.document.id, project?.view.direction]);
  const update = useCallback((fn: (p: Project) => void, noteScope?: string | null) => {
    const p = projectRef.current;
    if (!p) return;
    const n = copyProjectForEdit(p, noteScope);
    fn(n); projectRef.current = n; revision.current++; setProject(n); setSaved("正在保存…");
  }, []);
  const updateView = useCallback((fn: (p: Project) => void) => {
    const p = projectRef.current;
    if (!p) return;
    const next = { ...p, view: { ...p.view } };
    fn(next); projectRef.current = next; setProject(next);
    try { localStorage.setItem(`inkask:view:${p.document.id}`, JSON.stringify(next.view)); } catch { /* Reading remains available if browser preferences are full. */ }
  }, []);
  const persist = useCallback(async () => {
    const p = projectRef.current;
    if (!p || savedRevision.current === revision.current) return;
    const rev = revision.current;
    queue.current ??= new ProjectSaveQueue(saveProject);
    try {
      const written = await queue.current.flush({ project: p, revision: rev }, () => projectRef.current ? { project: projectRef.current, revision: revision.current } : undefined);
      if (written.revision === revision.current && written.project.document.id === projectRef.current?.document.id) {
        savedRevision.current = written.revision; setSaved("已保存在本机"); setSaveFailed(false);
      }
    } catch (e) {
      setSaved("保存失败"); setSaveFailed(true); setNotice("本机保存失败，请导出项目备份：" + err(e)); throw e;
    }
  }, []);
  useEffect(() => {
    if (!project || savedRevision.current === revision.current || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void persist().catch(() => {});
    }, controllers.current.size ? 5000 : 700);
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
    void refresh()
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
    const [docs, dirs, membership] = await Promise.all([listDocuments(), listFolders(), listDocumentFolders()]);
    setDocuments(docs); setFolders(dirs); setDocumentFolders(membership);
  }
  function showLibrary(folderId?: string) {
    rememberPosition();
    openRequest.current++;
    setLoading(false); setLibraryVisible(true); setSidebarOpen(false); setCurrentFolder(folderId);
    clearSelection(); setRegion(false); setSearch("");
  }
  async function openExisting(id: string, request = ++openRequest.current) {
    if (projectRef.current?.document.id === id) {
      setLoading(false); setCurrentFolder(documentFolders[id]); navigate(); return;
    }
    setLoading(true);
    try {
      const p = await loadProject(id);
      if (request !== openRequest.current) return;
      if (p && await activate(p, request, true)) setCurrentFolder(documentFolders[id]);
    } catch (e) {
      if (request === openRequest.current) setNotice("打开失败：" + err(e));
    } finally {
      if (request === openRequest.current) setLoading(false);
    }
  }
  async function extractTextPages(d: PDFDocumentProxy, documentId: string, epoch: number) {
    for (let page = 1; page <= d.numPages; page++) {
      if (epoch !== openEpoch.current || projectRef.current?.document.id !== documentId) return;
      const cached = projectRef.current.pages.find((p) => p.page === page);
      if (cached && cached.status !== "pending" && cached.status !== "error") continue;
      try {
        const text = await extractPage(d, page);
        if (epoch === openEpoch.current && projectRef.current?.document.id === documentId)
          update((p) => {
            if (p.pages.some((x) => x.page === page && x.source === "ocr")) return;
            p.pages = p.pages.filter((x) => x.page !== page); p.pages.push(text);
          }, null);
      } catch {
        if (epoch === openEpoch.current && projectRef.current?.document.id === documentId)
          update((p) => {
            const x = p.pages.find((x) => x.page === page);
            if (x) x.status = "error";
            else p.pages.push({ page, text: "", words: [], source: "native", status: "error", width: 600, height: 800 });
          }, null);
      }
    }
  }
  async function activate(p: Project, request: number, alreadySaved = false): Promise<boolean> {
    const d = await openPdf(p.document.pdf);
    if (request !== openRequest.current) { await d.destroy(); return false; }
    let committed = false;
    switchLocks.current.add(request); setSwitching(true);
    try {
      // Stop writers before taking the final source snapshot.
      const epoch = ++openEpoch.current;
      ocrEpoch.current++; void cancelOcr(); setOcr(null);
      for (const c of controllers.current.values()) c.abort();
      controllers.current.clear(); setBusyIds(new Set());
      if (projectRef.current?.notes.some((note) => note.messages.some((message) => message.status === "streaming")))
        update((source) => source.notes.forEach((note) => note.messages.forEach((message) => {
          if (message.status === "streaming") message.status = "stopped";
        })));
      do { await persist(); } while (request === openRequest.current && savedRevision.current !== revision.current);
      if (request !== openRequest.current) return false;
      const previous = pdfRef.current;
      pdfOwned.current.add(d); pdfRef.current = d; setPdf(d);
      p.document.pageCount = d.numPages;
      try {
        const view = JSON.parse(localStorage.getItem(`inkask:view:${p.document.id}`) ?? "null");
        if (view && Number.isInteger(view.page) && view.page >= 1 && view.page <= d.numPages && Number.isFinite(view.scale) && view.scale >= 0.25 && view.scale <= 3 && [0,90,180,270].includes(view.rotation))
          p.view = { page: view.page, scale: view.scale, rotation: view.rotation, direction: view.direction === "horizontal" ? "horizontal" : "vertical" };
      } catch { /* Ignore invalid reading preferences. */ }
      sourcePreviews.current.clear();
      projectRef.current = p; revision.current++;
      if (alreadySaved) savedRevision.current = revision.current;
      setProject(p); setSaved(alreadySaved ? "已保存在本机" : "正在保存…");
      clearSelection(); setFocusId(undefined); setReadingMessageId(undefined);
      setAnswerSelection(undefined); setActiveId(undefined); setRegion(false);
      readingView.current = undefined; positions.current.clear(); pdfPageSizes.current.clear();
      pendingNavigation.current = { key: "pdf", page: p.view.page };
      setLibraryVisible(false); setSidebarOpen(false); setNavigation((value) => value + 1);
      committed = true;
      if (previous) { pdfOwned.current.delete(previous); void previous.destroy(); }
      void extractTextPages(d, p.document.id, epoch);
      return true;
    } finally {
      switchLocks.current.delete(request); setSwitching(switchLocks.current.size > 0);
      if (!committed) {
        await d.destroy();
        const source = projectRef.current, sourcePdf = pdfRef.current;
        if (source && sourcePdf) void extractTextPages(sourcePdf, source.document.id, openEpoch.current);
      }
    }
  }
  async function openFile(file: File, request = ++openRequest.current, destination = currentFolder) {
    if (file.size > 100 * 1024 * 1024) {
      setNotice("首版支持 100 MB 以内的 PDF，请拆分后导入。"); return;
    }
    setLoading(true);
    try {
      const first = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
      if (!first.includes("%PDF-")) throw new Error("请选择有效的 PDF 文件");
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      if (request !== openRequest.current) return;
      const fingerprint = Array.from(new Uint8Array(hash)).map((x) => x.toString(16).padStart(2, "0")).join("");
      const existing = documents.find((d) => d.fingerprint === fingerprint);
      if (existing) { await openExisting(existing.id, request); return; }
      const p: Project = {
        version: 1,
        document: { id: uid(), name: file.name, fingerprint, pdf: file, pageCount: 0, createdAt: Date.now(), updatedAt: Date.now() },
        pages: [], notes: [], assets: [], templates: structuredClone(DEFAULT_TEMPLATES),
        view: { page: 1, scale: 0.95, rotation: 0 },
      };
      if (await activate(p, request)) {
        await persist();
        if (destination) await moveDocument(p.document.id, destination);
        await refresh();
      }
    } catch (e) {
      if (request === openRequest.current) setNotice(err(e));
    } finally {
      if (request === openRequest.current) setLoading(false);
    }
  }
  function pageTo(page: number) {
    const p = projectRef.current;
    if (!p) return;
    const target = Math.min(Math.max(1, page), p.document.pageCount);
    updateView((project) => { project.view.page = target; });
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
    update((project) => { project.notes = project.notes.filter((note) => !ids.has(note.id)); }, null);
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
      }, id);
    }
  }
  async function screenshot(note: Note, attachToQuestion = true) {
    const p = projectRef.current, d = pdfRef.current;
    if (switchLocks.current.size || !p || !d || !note.anchor.rects.length) return;
    const documentId = p.document.id, epoch = openEpoch.current;
    const fragments = anchorFragments(note.anchor);
    if (fragments.length > 4) { setNotice("跨页选区超过 4 页，请缩小截图范围，或取消附图后使用完整选文提问。"); return; }
    const saved = p.notes.find((n) => n.id === note.id);
    const ids = saved?.sourceAssetIds ?? (saved?.sourceAssetId ? [saved.sourceAssetId] : []);
    const existing = ids.map(id => p.assets.find(asset => asset.id === id)).filter((asset): asset is Asset => !!asset);
    const complete = existing.length === fragments.length;
    let pending = captures.current.get(note.id);
    if (!complete && !pending) {
      pending = (async () => {
        const assets: Asset[] = [];
        for (const fragment of fragments) {
          const rect = unionRects(fragment.rects);
          if (!rect) return;
          const { blob } = await renderImage(await d.getPage(fragment.page), rect, p.view.rotation);
          if (projectRef.current?.document.id !== documentId || epoch !== openEpoch.current) return;
          assets.push({ id: uid(), name: `第 ${fragment.page} 页选区.png`, mime: "image/png", data: blob, source: { page: fragment.page, rect } });
        }
        update((project) => {
          const n = project.notes.find((n) => n.id === note.id);
          if (n) {
            project.assets.push(...assets); n.sourceAssetId = assets[0].id;
            if (assets.length > 1) n.sourceAssetIds = assets.map(asset => asset.id);
          }
        }, note.id);
        return assets;
      })();
      captures.current.set(note.id, pending);
      void pending.finally(() => captures.current.delete(note.id)).catch(() => {});
    }
    try {
      const assets = complete ? existing : await pending;
      if (assets && attachToQuestion && projectRef.current?.document.id === documentId)
        update((project) => {
          const n = project.notes.find((n) => n.id === note.id);
          if (n) {
            const added = assets.filter(asset => !n.draftAssetIds.includes(asset.id));
            if (n.draftAssetIds.length + added.length <= 4) n.draftAssetIds.push(...added.map(asset => asset.id));
            else setNotice("每次提问最多附加 4 张图片。");
          }
        }, note.id);
      return assets?.[0];
    } catch (e) { setNotice("截图失败：" + err(e)); }
  }
  async function submitSelection(task: Task, question: string, images: File[], includeCrop: boolean) {
    const p = projectRef.current;
    if (!p || switchLocks.current.size) return;
    if (!status.configured) { setSettings(true); return; }
    if (includeCrop && selection && anchorFragments(selection).length + images.length > 4)
      throw new Error("每次最多附 4 张图片，请缩小截图范围，或取消附选区截图后使用完整选文提问。");
    const documentId = p.document.id, selectionGeneration = selectionEpoch.current, request = openRequest.current;
    let n = p.notes.find((note) => note.id === draftId);
    const template = p.templates.find((template) => template.task === task) ?? p.templates[0];
    if (!n && answerSelection) {
      const parent = p.notes.find((note) => note.id === answerSelection.noteId);
      if (!parent) return;
      n = createBranch(p, parent, answerSelection.messageId, answerSelection.quote, task, answerSelection.anchor);
    } else if (!n && selection) {
      n = { id: uid(), title: selection.quote ? selection.quote.slice(0, 24) : "关于这片区域", anchor: structuredClone(selection), inheritedHistory: [], collapsed: false, task, templateId: template.id, draft: "", draftAssetIds: [], messages: [], createdAt: Date.now() };
    }
    if (!n) return;
    const id = n.id, note = n;
    update((project) => {
      if (!project.notes.some((item) => item.id === id)) project.notes.push(note);
      const current = project.notes.find((item) => item.id === id)!;
      current.task = task; current.templateId = template.id; current.draft = question;
    }, id);
    if (includeCrop && !note.parentId) {
      const asset = await screenshot(note, true);
      if (!asset && !note.anchor.quote) throw new Error("选区截图未完成，请重试。");
    }
    if (projectRef.current?.document.id !== documentId || selectionGeneration !== selectionEpoch.current || request !== openRequest.current) return;
    if (images.length) await attach(id, images);
    if (projectRef.current?.document.id !== documentId || selectionGeneration !== selectionEpoch.current || request !== openRequest.current) return;
    focus(id);
    void send(id);
  }
  function selectPdf(anchor: Anchor) {
    setAnswerSelection(undefined); setDraftId(undefined); setCitationAnchor(undefined); setSelection(anchor);
    const epoch = ++selectionEpoch.current, d = pdfRef.current, view = projectRef.current?.view;
    if (!d || !view) return;
    const native = window.getSelection(), range = native?.rangeCount ? native.getRangeAt(0) : undefined;
    const atStart = !!range && native?.focusNode === range.startContainer && native.focusOffset === range.startOffset;
    const node = native?.focusNode, element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    const focusPage = Number(element?.closest<HTMLElement>("[data-pdf-page]")?.dataset.pdfPage);
    const fragment = anchorPage(anchor, focusPage) ?? (atStart ? anchorFragments(anchor)[0] : anchorFragments(anchor).at(-1)!);
    void d.getPage(fragment.page).then((page) => {
      if (epoch === selectionEpoch.current) setSelectionViewport({ page: fragment.page, atStart, viewport: page.getViewport({ scale: view.scale, rotation: (page.rotate + view.rotation) % 360 }) });
    }).catch(() => {});
  }
  const selectionBounds = useCallback(() => {
    const root = reader.current;
    if (!root) return;
    if (draftId) return root.querySelector(".answer-document-heading")?.getBoundingClientRect();
    if (selection && selectionViewport) {
      const native = window.getSelection();
      if (native?.rangeCount && !native.isCollapsed && root.contains(native.focusNode)) {
        const caret = native.getRangeAt(0).cloneRange(); caret.collapse(selectionViewport.atStart);
        const rect = caret.getBoundingClientRect();
        if (rect.height || rect.width) return rect;
      }
      const fragment = anchorPage(selection, selectionViewport.page);
      const page = root.querySelector(`[data-pdf-page="${selectionViewport.page}"] .pdf-page`);
      const focusRect = selectionViewport.atStart ? fragment?.rects[0] : fragment?.rects.at(-1);
      const rect = focusRect && screenRect(selectionViewport.viewport, focusRect);
      if (!page || !rect) return;
      const bounds = page.getBoundingClientRect();
      return { left: bounds.left + rect[0], top: bounds.top + rect[1], right: bounds.left + rect[2], bottom: bounds.top + rect[3] };
    }
    if (answerSelection) {
      const body = root.querySelector<HTMLElement>(".answer-body");
      return body ? answerAnchorRange(body, answerSelection.anchor, answerSelection.quote)?.getBoundingClientRect() : undefined;
    }
  }, [selection, selectionViewport, answerSelection, draftId]);
  const selectionBoundary = useCallback(() => {
    const root = reader.current?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    return { left: Math.max(left, root?.left ?? left), top: Math.max(top, root?.top ?? top), right: Math.min(left + (viewport?.width ?? window.innerWidth), root?.right ?? window.innerWidth), bottom: Math.min(top + (viewport?.height ?? window.innerHeight), root?.bottom ?? window.innerHeight) };
  }, []);
  const previewSource = useCallback(async (source: Source, claim?: string): Promise<SourcePreviewResult | undefined> => {
    const p = projectRef.current, d = pdfRef.current;
    if (!p || !d) return;
    const epoch = openEpoch.current;
    const resolution = sourceEvidencePreview(source, p.pages.find((page) => page.page === source.page), claim);
    const parts = [];
    for (const part of resolution.parts) {
      const rect = part.anchor && unionRects(part.anchor.rects);
      if (!rect) { parts.push(part); continue; }
      const crop: Anchor["rects"][number] = [rect[0] - 3, rect[1] - 3, rect[2] + 3, rect[3] + 3];
      const key = JSON.stringify([p.document.id, source.page, crop, p.view.rotation]);
      let image = sourcePreviews.current.get(key);
      if (image) { sourcePreviews.current.delete(key); sourcePreviews.current.set(key, image); }
      else {
        image = sourceQueue.current.catch(() => {}).then(async () => {
          if (epoch !== openEpoch.current) throw new Error("资料已切换");
          return (await renderImage(await d.getPage(source.page), crop, p.view.rotation)).blob;
        });
        sourceQueue.current = image.then(() => {}, () => {});
        sourcePreviews.current.set(key, image);
        while (sourcePreviews.current.size > 12) sourcePreviews.current.delete(sourcePreviews.current.keys().next().value!);
        void image.catch(() => sourcePreviews.current.delete(key));
      }
      const blob = await image;
      if (epoch !== openEpoch.current) return;
      // Only raster bytes are shared; each source retains its own exact anchors.
      parts.push({ ...part, blob });
    }
    return { parts, kind: resolution.kind };
  }, []);
  function locateSource(source: Source) {
    const anchor = sourceAnchor(source, projectRef.current?.pages.find((page) => page.page === source.page));
    const page = Math.max(1, Math.min(projectRef.current?.document.pageCount ?? 1, source.page));
    updateView((p) => { p.view.page = page; });
    navigate(undefined, page, anchor);
    setCitationAnchor(anchor);
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
    if (switchLocks.current.size || !p || !n || controllers.current.has(id)) return;
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
    }, id);
    const patch = (fn: (m: Message) => void) => {
      if (projectRef.current?.document.id !== documentId || controllers.current.get(id) !== control) return;
      update((p) => {
        const m = p.notes
          .find((n) => n.id === id)
          ?.messages.find((m) => m.id === answerId);
        if (m) fn(m);
      }, id);
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
      if (controllers.current.get(id) === control) {
        controllers.current.delete(id);
        setBusyIds(new Set(controllers.current.keys()));
        void persist().catch(() => {});
      }
    }
  }
  function branch(parent: Note, message: Message, quote?: string, _task: Task = "custom", anchor?: AnswerAnchor) {
    const selected = anchor ?? { start: 0, end: (quote ?? message.content).length, quote: quote ?? message.content };
    selectionEpoch.current++; setSelection(undefined); setDraftId(undefined);
    setAnswerSelection({ noteId: parent.id, messageId: message.id, quote: selected.quote, anchor: selected });
  }
  async function recognize(rect?: Anchor["rects"][0], selectedPage?: number) {
    const d = pdfRef.current,
      p = projectRef.current;
    if (switchLocks.current.size || !d || !p || ocr !== null) return;
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
    const request = ++openRequest.current, destination = currentFolder;
    setLoading(true);
    try {
      const p = await importProject(file);
      if (request !== openRequest.current) return;
      if (await activate(p, request)) {
        await persist();
        if (destination) await moveDocument(p.document.id, destination);
        await refresh();
        if (request === openRequest.current) setNotice("项目已导入为独立副本。");
      }
    } catch (e) {
      if (request === openRequest.current) setNotice("导入失败：" + err(e));
    } finally { if (request === openRequest.current) setLoading(false); }
  }
  async function openSample() {
    const request = ++openRequest.current, destination = currentFolder;
    setLoading(true);
    try {
      const response = await fetch("/sample.pdf");
      if (!response.ok) throw new Error("示例资料加载失败");
      const blob = await response.blob();
      if (request !== openRequest.current) return;
      await openFile(new File([blob], "理解导数 · InkAsk 示例.pdf", { type: "application/pdf" }), request, destination);
    } catch (e) { if (request === openRequest.current) setNotice(err(e)); }
    finally { if (request === openRequest.current) setLoading(false); }
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
  const answerScaleRef = useRef(answerScale);
  answerScaleRef.current = answerScale;
  useEffect(() => {
    const root = reader.current;
    if (!root || libraryVisible) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const p = projectRef.current;
      if (!p) return;
      const old = readingView.current ? answerScaleRef.current : p.view.scale;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1);
      const next = Math.min(3, Math.max(readingView.current ? 0.5 : 0.25, old * Math.exp(-delta * 0.002)));
      if (next === old) return;
      const bounds = root.getBoundingClientRect();
      pendingZoom.current = { top: root.scrollTop, left: root.scrollLeft, x: event.clientX - bounds.left, y: event.clientY - bounds.top, ratio: next / old };
      if (readingView.current) { answerScaleRef.current = next; setAnswerScale(next); }
      else updateView((p) => { p.view.scale = next; });
      setSelection(undefined); setAnswerSelection(undefined);
    };
    root.addEventListener("wheel", wheel, { passive: false });
    return () => root.removeEventListener("wheel", wheel);
  }, [libraryVisible, project?.document.id, focusId, updateView]);
  useLayoutEffect(() => {
    const root = reader.current, zoom = pendingZoom.current;
    if (!root || !zoom) return;
    pendingZoom.current = undefined;
    root.scrollTop = (zoom.top + zoom.y) * zoom.ratio - zoom.y;
    root.scrollLeft = (zoom.left + zoom.x) * zoom.ratio - zoom.x;
  }, [project?.view.scale, answerScale]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest(".selection-popover,.source-popover,.source-link") || (settings && target.closest(".settings-modal,.modal-backdrop"))) return;
      if (selection || answerSelection || draftId || citationAnchor) clearSelection();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (settings) { setSettings(false); return; } clearSelection(); setSidebarOpen(false); }
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") { event.preventDefault(); setSidebarOpen((open) => !open); }
    };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", keyboard); };
  }, [selection, answerSelection, draftId, citationAnchor, settings]);
  const page = project?.view.page ?? 1,
    currentText = project?.pages.find((p) => p.page === page),
    roots =
      project?.notes.filter((n) => !n.parentId && !!anchorPage(n.anchor, page)) ?? [],
    focused = project?.notes.find((n) => n.id === focusId);
  const parents = readingTrail(project?.notes ?? [], focusId);
  const canOcr = !!currentText && currentText.status !== "pending" && (currentText.source === "ocr" || !currentText.text.trim());
  const sidebarDocuments = libraryDocuments(documents, documentFolders, currentFolder, search);
  return (
    <div
      className={"app-shell " + (sidebarOpen ? "sidebar-visible" : "")}
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
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="收起资料侧栏" onClick={() => setSidebarOpen(false)} />}
      <aside className={"sidebar floating-sidebar " + (sidebarOpen ? "is-open" : "")} inert={!sidebarOpen} aria-label="资料侧栏">
        <button className="sidebar-close icon-button" aria-label="关闭资料侧栏" onClick={() => setSidebarOpen(false)}><X size={17} /></button>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            showLibrary();
          }}
        >
          <span className="brand-icon">
            i<span>✳</span>
          </span>
          <strong>inkask</strong>
          <span className="beta">BETA</span>
        </a>
        <button className="workspace-name" onClick={() => showLibrary()}>
          <span className="workspace-avatar">我</span>
          <div>
            我的阅读空间<small>LOCAL WORKSPACE</small>
          </div>
          <ChevronDown size={14} />
        </button>
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
          <button className="sidebar-action folder-location" onClick={() => showLibrary()}><FolderOpen size={15} />阅读空间</button>
          {folders.filter((folder) => !folder.parentId || folder.id === currentFolder || folder.parentId === currentFolder).map((folder) => <button key={folder.id} className={"sidebar-action folder-location " + (currentFolder === folder.id ? "active" : "")} title={folderLabel(folders, folder.id)} onClick={() => showLibrary(folder.id)}><FolderOpen size={15} /><span>{folder.name}</span></button>)}
          {sidebarDocuments.map((d) => (
              <div
                className={
                  "document-row " +
                  (project?.document.id === d.id ? "active" : "")
                }
                key={d.id}
              >
                <button aria-label={d.name} title={d.name} onClick={() => void openExisting(d.id)}>
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
            <button className="sidebar-toggle icon-button" aria-label="显示资料侧栏" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeft size={18} /></button>
            <BookOpen size={16} />
            <button onClick={() => showLibrary()}>阅读空间</button>
            {project && !libraryVisible && (
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
        {libraryVisible || !project ? (
          <Library key={currentFolder ?? "root"} documents={documents} folders={folders} membership={documentFolders} folderId={currentFolder}
            search={search} onSearch={setSearch} onFolder={showLibrary} onOpen={(id) => void openExisting(id)}
            onAddPdf={() => fileInput.current?.click()} onImport={() => importInput.current?.click()} onSample={() => void openSample()}
            onCreate={async (name) => { await createFolder(name, currentFolder); await refresh(); }}
            onRename={async (id, name) => { await renameFolder(id, name); await refresh(); }}
            onDeleteFolder={async (id) => { await deleteFolder(id); await refresh(); }}
            onMove={async (id, folderId) => { await moveDocument(id, folderId); await refresh(); }}
            onMoveFolder={async (id, parentId) => { await moveFolder(id, parentId); await refresh(); }} />
        ) : (
          <>
            {focused ? <div className="reader-toolbar answer-navigation">
              <button className="back-reading" onClick={back}><ChevronLeft size={17} />返回上一层</button>
              <nav aria-label="阅读层级" className="reading-trail">
                <button onClick={() => navigate()} title={project.document.name}><FileText size={13} />原始 PDF</button>
                {parents.map((note, index) => <span key={note.id}><ChevronRight size={12} />
                  <button aria-current={note.id === focusId ? "page" : undefined} disabled={note.id === focusId}
                    onClick={() => focus(note.id, parents[index + 1]?.parentMessageId)} title={note.title}><MathText>{note.title}</MathText></button>
                </span>)}
              </nav>
              <div className="zoom-controls"><button className="icon-button" aria-label="缩小回答" onClick={() => setAnswerScale((value) => Math.max(0.5, value - 0.1))}><Minus size={15} /></button><span>{Math.round(answerScale * 100)}%</span><button className="icon-button" aria-label="放大回答" onClick={() => setAnswerScale((value) => Math.min(3, value + 0.1))}><Plus size={15} /></button></div>
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
                <button className="icon-button" aria-label="缩小" onClick={() => updateView((p) => { p.view.scale = Math.max(0.25, p.view.scale - 0.1); })}><Minus size={15} /></button>
                <span>{Math.round(project.view.scale * 100)}%</span>
                <button className="icon-button" aria-label="放大" onClick={() => updateView((p) => { p.view.scale = Math.min(3, p.view.scale + 0.1); })}><Plus size={15} /></button>
                <button className="icon-button" aria-label="旋转页面" onClick={() => updateView((p) => { p.view.rotation = (p.view.rotation + 90) % 360; })}><RotateCw size={15} /></button>
                <button className="icon-button" aria-label="适合宽度" onClick={() => updateView((p) => {
                  const text = pdfPageSizes.current.get(p.view.page) ?? p.pages.find((item) => item.page === p.view.page);
                  const width = p.view.rotation % 180 ? text?.height ?? 800 : text?.width ?? 600;
                  p.view.scale = Math.max(0.4, Math.min(2, ((reader.current?.clientWidth ?? 700) - 76) / width));
                })}><Maximize2 size={15} /></button>
              </div>
              <div className="toolbar-spacer" />
              <select className="reading-direction" aria-label="页面拼接方向" value={project.view.direction ?? "vertical"} onChange={(event) => {
                const page = projectRef.current?.view.page;
                updateView((p) => { p.view.direction = event.target.value as "vertical" | "horizontal"; });
                navigate(undefined, page);
              }}><option value="vertical">上下拼接</option><option value="horizontal">左右拼接</option></select>
              <button className={"tool-button " + (region ? "selected" : "")} onClick={() => { setRegion(!region); clearSelection(); }}>
                <Highlighter size={15} />{region ? "正在框选" : "框选区域"}
              </button>
              {ocr !== null ? <button className="tool-button" onClick={() => void stopOcr()}><Loader2 size={14} className="spin" />{Math.round(ocr * 100)}% · 取消</button> : canOcr &&
                <button className="tool-button" disabled={switching} onClick={() => void recognize()}><ScanText size={15} />{currentText?.source === "ocr" ? "重新识别" : "识别本页"}</button>}
              <span className="toolbar-divider" /><span className="notes-count"><MessageSquarePlus size={14} /> {roots.length}</span>
            </div>}
            {!status.configured && <div className="api-hint"><Sparkles size={14} />
              <span>阅读已就绪。配置模型 API 后，即可在便签中获得 AI 回答。</span>
              <button onClick={() => setSettings(true)}>如何配置<ArrowUpRight size={12} /></button>
            </div>}
            <div ref={reader} className={"reader-area " + (focused ? "answer-reader-area" : "pdf-reader-area")} style={{ "--answer-scale": answerScale } as React.CSSProperties}>
              {focused ? <AnswerReader key={`${focused.id}:${readingMessageId ?? "latest"}`} note={focused} messageId={readingMessageId} activeId={activeId} project={project}
                busy={busyIds.has(focused.id)} apiReady={status.configured && !switching} context={context}
                onUpdate={(id, change) => update((p) => { const note = p.notes.find((n) => n.id === id); if (note) Object.assign(note, change); }, id)}
                onSend={(id, prompt) => void send(id, prompt)} onStop={(id) => controllers.current.get(id)?.abort()}
                onRetry={(id) => void send(id, undefined, true)} onBranch={(note, message, anchor) => branch(note, message, anchor?.quote, "custom", anchor)} onDelete={removeNote}
                onPage={pageTo} onPreviewSource={previewSource} onLocateSource={locateSource} onResume={(note) => { clearSelection(); setDraftId(note.id); }} selection={answerSelection?.anchor} onFocus={focus} onAttach={(id, files) => void attach(id, files)} onScreenshot={(note) => void screenshot(note)} onSourceImage={(note) => void screenshot(note, false)}
                onSelect={(note, message, anchor) => { selectionEpoch.current++; setSelection(undefined); setDraftId(undefined); setAnswerSelection({ noteId: note.id, messageId: message.id, quote: anchor.quote, anchor }); }} onClearSelection={() => setAnswerSelection(undefined)}
              /> : pdf && <ContinuousPdf pdf={pdf} project={project} scrollRoot={reader} pageSizes={pdfPageSizes.current} activeId={activeId} regionMode={region} direction={project.view.direction} selection={selection ?? citationAnchor}
                onSelect={selectPdf} onFocus={focus} onError={setNotice}
                onClearSelection={() => setSelection(undefined)}
                onPageChange={(page) => { if (projectRef.current?.view.page !== page) updateView((p) => { p.view.page = page; }); }} />}
            </div>
            {(selection || answerSelection || draftId) && <SelectionPopover key={draftId ?? JSON.stringify(selection ?? answerSelection?.anchor)}
              quote={selection?.quote ?? answerSelection?.quote ?? focused?.anchor.quote ?? ""} initialQuestion={draftId ? focused?.draft : undefined}
              imageOnly={!!selection && !selection.quote} cropAvailable={!answerSelection && (!draftId || !focused?.parentId)} apiReady={status.configured && !switching}
              getAnchor={selectionBounds} boundary={selectionBoundary} onSubmit={submitSelection} onClose={clearSelection} onSettings={() => setSettings(true)} />}
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
