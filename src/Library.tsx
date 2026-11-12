import { useState } from "react";
import { ArrowUpRight, ChevronRight, FilePlus2, FileText, Folder, FolderPlus, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { folderLabel, folderTrail, libraryDocuments } from "./core/library";
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
}
export default function Library(props: Props) {
  const [creating, setCreating] = useState(false), [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const folders = props.folders.filter((folder) => folder.parentId === props.folderId).sort((a, b) => a.name.localeCompare(b.name));
  const documents = libraryDocuments(props.documents, props.membership, props.folderId, props.search);
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="library-home" aria-label="阅读空间资料管理">
    <header className="library-heading">
      <div><span className="eyebrow">YOUR READING SPACE</span><h1>{props.folderId ? folderLabel(props.folders, props.folderId).split(" / ").at(-1) : "阅读空间"}</h1><p>按自己的方式整理资料，便签与追问随文件一起保存。</p></div>
      <div className="library-actions"><button className="secondary" onClick={() => setCreating(true)} disabled={busy}><FolderPlus size={16} />新建文件夹</button><button className="primary" onClick={props.onAddPdf}><Plus size={16} />打开 PDF</button></div>
    </header>
    <div className="library-controls"><nav aria-label="文件夹路径"><button onClick={() => props.onFolder()}>阅读空间</button>{folderTrail(props.folders, props.folderId).map((folder) => <span key={folder.id}><ChevronRight size={13} /><button onClick={() => props.onFolder(folder.id)}>{folder.name}</button></span>)}</nav>
      <label className="library-search"><Search size={15} /><input aria-label="搜索阅读空间" placeholder="搜索全部资料…" value={props.search} onChange={(event) => props.onSearch(event.target.value)} /></label>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {creating && <form className="folder-form" onSubmit={(event) => { event.preventDefault(); void act(async () => { await props.onCreate(name); setName(""); setCreating(false); }); }}>
      <FolderPlus size={18} /><input aria-label="新文件夹名称" placeholder="文件夹名称" autoFocus value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      <button className="primary" disabled={busy || !name.trim()}>创建</button><button type="button" aria-label="取消创建文件夹" onClick={() => setCreating(false)}><X size={16} /></button>
    </form>}
    {!props.search.trim() && !!folders.length && <div className="folder-grid">{folders.map((folder) => <div className="folder-card" key={folder.id}>
      {editing?.id === folder.id ? <form onSubmit={(event) => { event.preventDefault(); void act(async () => { await props.onRename(folder.id, editing.name); setEditing(undefined); }); }}>
        <input aria-label="修改文件夹名称" value={editing.name} onChange={(event) => setEditing({ id: folder.id, name: event.target.value })} autoFocus /><button disabled={busy || !editing.name.trim()}>保存</button><button type="button" onClick={() => setEditing(undefined)}>取消</button>
      </form> : <><button className="folder-open" onClick={() => props.onFolder(folder.id)}><Folder size={24} /><span><strong>{folder.name}</strong><small>{props.documents.filter((document) => props.membership[document.id] === folder.id).length} 份资料</small></span><ChevronRight size={16} /></button>
        <div className="folder-tools"><button aria-label={`重命名文件夹：${folder.name}`} onClick={() => setEditing({ id: folder.id, name: folder.name })} disabled={busy}><Pencil size={13} /></button><button aria-label={`删除文件夹：${folder.name}`} title="移除文件夹，内容移到上一级" disabled={busy} onClick={() => void act(() => props.onDeleteFolder(folder.id))}><Trash2 size={13} /></button></div></>}
    </div>)}</div>}
    <div className="library-section-label"><span>{props.search.trim() ? "搜索结果" : "资料"}</span><small>{documents.length} 份</small></div>
    <div className="library-document-grid">{documents.map((document) => <article className="library-document-card" key={document.id}>
      <button className="library-document-open" onClick={() => props.onOpen(document.id)}><span className="library-pdf-icon"><FileText size={28} /></span><strong>{document.name}</strong><small>{document.pageCount} 页 · {new Date(document.updatedAt).toLocaleDateString("zh-CN")}</small><ArrowUpRight size={16} /></button>
      <label>文件夹<select aria-label={`文件夹：${document.name}`} value={props.membership[document.id] ?? ""} disabled={busy} onChange={(event) => void act(() => props.onMove(document.id, event.target.value || undefined))}>
        <option value="">阅读空间</option>{props.folders.map((folder) => <option value={folder.id} key={folder.id}>{folderLabel(props.folders, folder.id)}</option>)}
      </select></label>
    </article>)}</div>
    {!documents.length && (!folders.length || props.search.trim()) && <div className="library-empty"><FilePlus2 size={35} /><h2>{props.search.trim() ? "没有找到这份资料" : "为下一次阅读留个位置"}</h2><p>{props.search.trim() ? "换个名称试试。" : "打开 PDF，或先建一个文件夹整理资料。"}</p><button className="secondary" onClick={props.onImport}>导入 InkAsk 项目</button>{!props.documents.length && <button className="sample-button" onClick={props.onSample}>先打开示例资料 <ArrowUpRight size={12} /></button>}</div>}
  </section>;
}
