import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, ClipboardPaste, Scissors, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, Grid2X2, List, MoreHorizontal, MoveRight, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { canMoveFolder, folderLabel, folderTrail, libraryDocuments, libraryItemKey, selectLibraryItems, topLevelMoveItems, type LibraryItemRef } from "./core/library";
import type { WorkspaceFolder } from "./core/storage";
import type { InkDocument } from "./types";

interface Props {
  documents: InkDocument[];
  folders: WorkspaceFolder[];
  membership: Record<string, string>;
  folderId?: string;
  search: string;
  onSearch: (value: string) => void;
  onFolder: (id?: string) => void;
  onOpen: (id: string) => void;
  onAddPdf: () => void;
  onImport: () => void;
  onSample: () => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  onMove: (id: string, folderId?: string) => Promise<void>;
  onMoveFolder?: (id: string, parentId?: string) => Promise<void>;
}
interface Entry extends LibraryItemRef { key: string; name: string; detail: string; date: number }
const DRAG_TYPE = "application/x-inkask-library";
// In-memory cut state intentionally survives directory navigation, which remounts Library.
let cutClipboard: LibraryItemRef[] = [];
let preferredView: "grid" | "list" = "grid";
export default function Library(props: Props) {
  const [creating, setCreating] = useState(false), [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [cutItems, setCutItems] = useState(cutClipboard);
  const [view, setView] = useState(preferredView), [dropTarget, setDropTarget] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; items: LibraryItemRef[] }>();
  const [moving, setMoving] = useState<LibraryItemRef[]>(), [destination, setDestination] = useState<string>();
  const root = useRef<HTMLElement>(null), anchor = useRef<string | undefined>(undefined), busyRef = useRef(false);
  const query = props.search.trim().toLocaleLowerCase();
  const folders = props.folders.filter((folder) => query ? folder.name.toLocaleLowerCase().includes(query) : folder.parentId === props.folderId).sort((a, b) => a.name.localeCompare(b.name));
  const documents = libraryDocuments(props.documents, props.membership, props.folderId, props.search).sort((a, b) => a.name.localeCompare(b.name));
  const entries: Entry[] = [
    ...folders.map((folder): Entry => ({ kind: "folder", id: folder.id, key: `folder:${folder.id}`, name: folder.name, date: folder.createdAt, detail: `${props.folders.filter((child) => child.parentId === folder.id).length + props.documents.filter((doc) => props.membership[doc.id] === folder.id).length} 个项目` })),
    ...documents.map((document): Entry => ({ kind: "document", id: document.id, key: `document:${document.id}`, name: document.name, date: document.updatedAt, detail: `${document.pageCount} 页 · PDF` })),
  ];
  const selectedEntries = entries.filter((entry) => selected.includes(entry.key));
  const visibleKeys = entries.map((entry) => entry.key);
  const current = props.folders.find((folder) => folder.id === props.folderId);
  const cutKeys = new Set(cutItems.map(libraryItemKey));
  async function act(operation: () => Promise<void>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError("");
    try { await operation(); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  function existing(items: LibraryItemRef[]): LibraryItemRef[] {
    return items.filter((item) => item.kind === "folder" ? props.folders.some((folder) => folder.id === item.id) : props.documents.some((doc) => doc.id === item.id));
  }
  function validDestination(items: LibraryItemRef[], target?: string): boolean {
    return (!target || props.folders.some((folder) => folder.id === target)) && items.every((item) => item.kind !== "folder" || (!!props.onMoveFolder && canMoveFolder(props.folders, item.id, target)));
  }
  async function move(items: LibraryItemRef[], target?: string) {
    const valid = topLevelMoveItems(existing(items), props.folders, props.membership);
    if (!valid.length || busyRef.current) return;
    if (!validDestination(valid, target)) { setError("不能移入自身、子文件夹或不存在的目录。"); return; }
    const names = new Set<string>();
    for (const item of valid.filter((entry) => entry.kind === "folder")) {
      const folder = props.folders.find((folder) => folder.id === item.id)!;
      if (names.has(folder.name) || props.folders.some((other) => other.id !== item.id && other.parentId === target && other.name === folder.name)) {
        setError(`目标目录已存在同名文件夹「${folder.name}」，请先重命名。`); return;
      }
      names.add(folder.name);
    }
    const success = await act(async () => {
      for (const item of valid) {
        if (item.kind === "folder") await props.onMoveFolder!(item.id, target);
        else await props.onMove(item.id, target);
      }
    });
    if (success) {
      const moved = new Set(items.map(libraryItemKey));
      cutClipboard = cutClipboard.filter((item) => !moved.has(libraryItemKey(item)));
      setCutItems(cutClipboard); setSelected([]); setMoving(undefined); setMenu(undefined);
    }
  }
  function cut(items: LibraryItemRef[]) {
    cutClipboard = existing(items).map(({ kind, id }) => ({ kind, id }));
    setCutItems(cutClipboard); setMenu(undefined);
  }
  function open(item: LibraryItemRef) {
    if (busyRef.current) return;
    if (item.kind === "folder") props.onFolder(item.id); else props.onOpen(item.id);
  }
  function choose(entry: Entry, event: MouseEvent) {
    setSelected((previous) => selectLibraryItems(previous, visibleKeys, entry.key, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey, anchor: anchor.current }));
    if (!event.shiftKey) anchor.current = entry.key;
  }
  function openMove(items: LibraryItemRef[]) {
    setMoving(topLevelMoveItems(existing(items), props.folders, props.membership));
    setDestination(props.folderId); setMenu(undefined); setError("");
  }
  function readDrag(event: DragEvent): LibraryItemRef[] {
    try {
      const value: unknown = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
      if (!Array.isArray(value)) return [];
      return existing(value.filter((item): item is LibraryItemRef => !!item && typeof item === "object" && (item.kind === "folder" || item.kind === "document") && typeof item.id === "string"));
    } catch { return []; }
  }
  function dropProps(target?: string) {
    const key = target ?? "root";
    return {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(key);
      },
      onDragLeave: (event: DragEvent) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget((previous) => previous === key ? undefined : previous);
      },
      onDrop: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault(); event.stopPropagation(); setDropTarget(undefined);
        void move(readDrag(event), target);
      },
    };
  }
  function keydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement).closest("input,textarea,select,[role=dialog],[role=menu]")) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(visibleKeys); }
    else if (command && event.key.toLowerCase() === "x") { event.preventDefault(); cut(selectedEntries); }
    else if (command && event.key.toLowerCase() === "v") { event.preventDefault(); void move(cutClipboard, props.folderId); }
    else if (!(event.target as HTMLElement).closest(".finder-items") || (event.target as HTMLElement).closest("button")) return;
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && !event.altKey) {
      event.preventDefault();
      const elements = [...root.current!.querySelectorAll<HTMLElement>(".finder-item")];
      if (!elements.length) return;
      const active = (event.target as HTMLElement).closest(".finder-item");
      const at = active ? elements.indexOf(active as HTMLElement) : Math.max(0, visibleKeys.indexOf(selected.at(-1) ?? ""));
      const columns = view === "grid" ? Math.max(1, Math.floor((root.current!.querySelector(".finder-items")!.clientWidth - 24) / 135)) : 1;
      const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -columns : columns;
      const index = Math.max(0, Math.min(elements.length - 1, at + step)), key = visibleKeys[index];
      setSelected((previous) => selectLibraryItems(previous, visibleKeys, key, { additive: command, range: event.shiftKey, anchor: anchor.current ?? visibleKeys[at] }));
      if (!event.shiftKey) anchor.current = key;
      elements[index].focus();
    }
    else if (event.key === " " && (event.target as HTMLElement).closest(".finder-item")) {
      event.preventDefault();
      const key = (event.target as HTMLElement).closest<HTMLElement>(".finder-item")!.dataset.libraryKey!;
      setSelected((previous) => selectLibraryItems(previous, visibleKeys, key, { additive: true }));
    }
    else if (event.key === "Enter" && selectedEntries.length === 1) { event.preventDefault(); open(selectedEntries[0]); }
    else if (event.key === "F2" && selectedEntries.length === 1 && selectedEntries[0].kind === "folder") { event.preventDefault(); setEditing({ id: selectedEntries[0].id, name: selectedEntries[0].name }); }
    else if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); props.onFolder(current?.parentId); }
    else if (event.key === "Escape") { setMenu(undefined); setMoving(undefined); setEditing(undefined); setCreating(false); setSelected([]); }
  }
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { setMenu(undefined); if (!busyRef.current) setMoving(undefined); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    if (!moving) return;
    const frame = requestAnimationFrame(() => {
      const dialog = root.current?.querySelector<HTMLElement>(".finder-move-dialog");
      (dialog?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not(:disabled)') ?? dialog?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [moving]);
  const moveFolders = [...props.folders].sort((a, b) => folderLabel(props.folders, a.id).localeCompare(folderLabel(props.folders, b.id)));
  return <section ref={root} className="library-home finder" aria-label="阅读空间资料管理" tabIndex={-1} onKeyDown={keydown}
    onPointerDown={(event) => { if (!(event.target as HTMLElement).closest("[data-finder-menu]")) setMenu(undefined); }}>
    <header className="library-heading">
      <div><span className="eyebrow">YOUR READING SPACE</span><h1>{current?.name ?? "阅读空间"}</h1><p>资料和便签放在一起，按你的方式整理。</p></div>
      <div className="library-actions"><button className="secondary" onClick={() => setCreating(true)} disabled={busy}><FolderPlus size={16} />新建文件夹</button><button className="primary" onClick={props.onAddPdf}><Plus size={16} />打开 PDF</button></div>
    </header>
    <div className="finder-toolbar">
      <button className="finder-icon-button" title="返回上一级" aria-label="返回上一级文件夹" disabled={!props.folderId || busy} onClick={() => props.onFolder(current?.parentId)}><ArrowLeft size={17} /></button>
      <div className="finder-view-switch" role="group" aria-label="资料显示方式">
        <button aria-label="图标视图" aria-pressed={view === "grid"} onClick={() => { preferredView = "grid"; setView("grid"); }}><Grid2X2 size={16} /></button><button aria-label="列表视图" aria-pressed={view === "list"} onClick={() => { preferredView = "list"; setView("list"); }}><List size={17} /></button>
      </div>
      <span className="finder-toolbar-divider" />
      <button className="finder-action" disabled={!selectedEntries.length || busy} onClick={() => openMove(selectedEntries)}><MoveRight size={15} /><span>移动到…</span></button>
      <button className="finder-icon-button" aria-label="剪切所选项目" title="剪切 · ⌘/Ctrl X" disabled={!selectedEntries.length || busy} onClick={() => cut(selectedEntries)}><Scissors size={16} /></button>
      <button className="finder-action" disabled={!cutItems.length || busy} onClick={() => void move(cutClipboard, props.folderId)} title="移动到当前文件夹 · ⌘/Ctrl V"><ClipboardPaste size={15} /><span>粘贴{cutItems.length ? ` (${cutItems.length})` : ""}</span></button>
      <label className="library-search"><Search size={15} /><input aria-label="搜索阅读空间" placeholder="搜索资料与文件夹" value={props.search} onChange={(event) => props.onSearch(event.target.value)} /></label>
    </div>
    <nav className="finder-path" aria-label="文件夹路径"><button className={dropTarget === "root" ? "drop-target" : ""} {...dropProps()} onClick={() => props.onFolder()}><FolderOpen size={14} />阅读空间</button>{folderTrail(props.folders, props.folderId).map((folder) => <span key={folder.id}><ChevronRight size={12} /><button className={dropTarget === folder.id ? "drop-target" : ""} {...dropProps(folder.id)} onClick={() => props.onFolder(folder.id)}>{folder.name}</button></span>)}</nav>
    {error && !moving && <p className="inline-error" role="alert">{error}<button aria-label="关闭资料管理提示" onClick={() => setError("")}><X size={14} /></button></p>}
    {creating && <form className="folder-form" onSubmit={(event) => { event.preventDefault(); void act(async () => { await props.onCreate(name); setName(""); setCreating(false); }); }}>
      <FolderPlus size={18} /><input aria-label="新文件夹名称" placeholder="文件夹名称" autoFocus value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      <button className="primary" disabled={busy || !name.trim()}>创建</button><button type="button" aria-label="取消创建文件夹" onClick={() => setCreating(false)}><X size={16} /></button>
    </form>}
    {editing && <form className="folder-form" onSubmit={(event) => { event.preventDefault(); void act(async () => { await props.onRename(editing.id, editing.name); setEditing(undefined); }); }}>
      <Pencil size={17} /><input aria-label="修改文件夹名称" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} autoFocus disabled={busy} /><button className="primary" disabled={busy || !editing.name.trim()}>保存</button><button type="button" aria-label="取消重命名" onClick={() => setEditing(undefined)}><X size={16} /></button>
    </form>}
    <div className={"finder-items " + view + (dropTarget === (props.folderId ?? "root") ? " drop-target" : "")} role="listbox" aria-label={query ? "搜索结果" : "资料和文件夹"} aria-multiselectable="true" aria-busy={busy} tabIndex={0}
      {...dropProps(props.folderId)} onClick={(event) => { if (!(event.target as HTMLElement).closest(".finder-item")) setSelected([]); }}>
      {view === "list" && <div className="finder-list-heading" aria-hidden="true"><span>名称</span><span>类型 / 大小</span><span>修改日期</span></div>}
      {entries.map((entry) => <div role="option" aria-selected={selected.includes(entry.key)} aria-label={entry.name} tabIndex={0} key={entry.key} data-library-key={entry.key}
        className={"finder-item " + entry.kind + (selected.includes(entry.key) ? " selected" : "") + (cutKeys.has(entry.key) ? " cut" : "") + (dropTarget === entry.id ? " drop-target" : "")}
        onClick={(event) => choose(entry, event)} onDoubleClick={() => open(entry)}
        onContextMenu={(event) => { event.preventDefault(); const items = selected.includes(entry.key) ? selectedEntries : [entry]; if (!selected.includes(entry.key)) setSelected([entry.key]); setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 204)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 248)), items }); }}
        draggable={!busy} onDragStart={(event) => {
          const items = selected.includes(entry.key) ? selectedEntries : [entry];
          event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(items.map(({ kind, id }) => ({ kind, id })))); event.dataTransfer.effectAllowed = "move";
        }} onDragEnd={() => setDropTarget(undefined)} {...(entry.kind === "folder" ? dropProps(entry.id) : {})}>
        <span className="finder-entry-icon">{entry.kind === "folder" ? <Folder size={56} strokeWidth={1.15} /> : <FileText size={49} strokeWidth={1.1} />}{selected.includes(entry.key) && <Check className="finder-entry-check" size={13} />}</span>
        <strong>{entry.name}</strong><small className="finder-entry-detail">{entry.detail}</small><time>{new Date(entry.date).toLocaleDateString("zh-CN")}</time>
        <button className="finder-item-menu" aria-label={`更多操作：${entry.name}`} title="更多操作" onClick={(event) => { event.stopPropagation(); setSelected([entry.key]); const bounds = event.currentTarget.getBoundingClientRect(); setMenu({ x: Math.max(8, Math.min(bounds.right - 190, window.innerWidth - 204)), y: Math.max(8, Math.min(bounds.bottom, window.innerHeight - 248)), items: [entry] }); }}><MoreHorizontal size={16} /></button>
      </div>)}
      {!entries.length && <div className="library-empty"><FilePlus2 size={35} /><h2>{query ? "没有找到匹配的项目" : "这个文件夹还是空的"}</h2><p>{query ? "换个名称试试。" : "拖入 PDF，或把资料移动到这里。"}</p><button className="secondary" onClick={props.onImport}>导入 InkAsk 项目</button>{!props.documents.length && <button className="sample-button" onClick={props.onSample}>先打开示例资料 <ArrowUpRight size={12} /></button>}</div>}
    </div>
    <footer className="finder-status"><span>{selectedEntries.length ? `已选中 ${selectedEntries.length} 项，共 ${entries.length} 项` : `${folders.length} 个文件夹，${documents.length} 份资料`}</span><small>{busy ? "正在移动或整理…" : "双击打开 · 拖动移动 · ⌘/Ctrl X、V 剪切粘贴"}</small></footer>
    {menu && <div className="finder-context-menu" role="menu" data-finder-menu style={{ left: menu.x, top: menu.y }}>
      {menu.items.length === 1 && <button role="menuitem" onClick={() => { open(menu.items[0]); setMenu(undefined); }}><FolderOpen size={14} />打开</button>}
      <button role="menuitem" disabled={busy} onClick={() => cut(menu.items)}><Scissors size={14} />剪切<span>⌘ X</span></button>
      <button role="menuitem" disabled={busy} onClick={() => openMove(menu.items)}><MoveRight size={14} />移动到…</button>
      {menu.items.length === 1 && menu.items[0].kind === "folder" && <><hr /><button role="menuitem" disabled={busy} onClick={() => { const folder = props.folders.find((folder) => folder.id === menu.items[0].id); if (folder) setEditing({ id: folder.id, name: folder.name }); setMenu(undefined); }}><Pencil size={14} />重命名</button><button role="menuitem" disabled={busy} onClick={() => { const id = menu.items[0].id; setMenu(undefined); void act(() => props.onDeleteFolder(id)); }}><Trash2 size={14} />移除文件夹<small>内容移到上一级</small></button></>}
    </div>}
    {moving && <div className="finder-dialog-backdrop" onClick={() => !busy && setMoving(undefined)}><section className="finder-move-dialog" role="dialog" aria-modal="true" aria-label="移动所选项目" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")];
        if (!buttons.length) return;
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)!.focus(); }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
      }}>
      <header><div><MoveRight size={19} /><h2>移动 {moving.length} 个项目</h2></div><button aria-label="关闭移动窗口" onClick={() => setMoving(undefined)} disabled={busy}><X size={18} /></button></header>
      <p>选择目标文件夹，资料中的便签会一同移动。</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="finder-destination-list" role="listbox" aria-label="目标文件夹"><button role="option" aria-selected={!destination} onClick={() => setDestination(undefined)}><FolderOpen size={20} />阅读空间{!destination && <Check size={15} />}</button>
        {moveFolders.map((folder) => { const valid = validDestination(moving, folder.id); return <button role="option" aria-selected={destination === folder.id} disabled={!valid} key={folder.id} onClick={() => setDestination(folder.id)} style={{ paddingLeft: 15 + Math.max(0, folderTrail(props.folders, folder.id).length - 1) * 18 }}><Folder size={20} /><span><strong>{folder.name}</strong><small>{folderLabel(props.folders, folder.parentId)}</small></span>{destination === folder.id && <Check size={15} />}</button>; })}
      </div><footer><button className="secondary" disabled={busy} onClick={() => setMoving(undefined)}>取消</button><button className="primary" disabled={busy || !validDestination(moving, destination)} onClick={() => void move(moving, destination)}>移动到这里</button></footer>
    </section></div>}
  </section>;
}
