import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { X } from "lucide-react";
import type { Asset, Message, Project, Source } from "./types";
import { normalizeMathMarkdown } from "./core/math-markdown";

export function MathText({ children }: { children: string }) {
  return <span className="math-text"><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false }]]}
    skipHtml
    components={{
      p: ({ children }) => <span>{children}</span>,
      h1: ({ children }) => <span>{children}</span>, h2: ({ children }) => <span>{children}</span>,
      h3: ({ children }) => <span>{children}</span>, h4: ({ children }) => <span>{children}</span>,
      img: () => null,
      a: ({ children }) => <span>{children}</span>,
    }}
  >{normalizeMathMarkdown(children)}</ReactMarkdown></span>;
}

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
    <span className="asset-thumb">
      {url ? <img src={url} alt={asset.name} /> : <span>正在载入图片…</span>}
      {onRemove && (
        <button onClick={onRemove} aria-label="移除图片">
          <X size={12} />
        </button>
      )}
      <span>{asset.name}</span>
    </span>
  );
}
interface RenderContext {
  assets: Asset[];
  sources?: Source[];
  onPage: (page: number) => void;
}
const MarkdownContext = createContext<RenderContext>({ assets: [], onPage: () => {} });

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const { assets } = useContext(MarkdownContext);
  const asset = assets.find((asset) => `asset:${asset.id}` === src || `inkask://asset/${asset.id}` === src);
  return asset ? <AssetImage asset={asset} /> : <span className="muted">[未附加的图片：{alt}]</span>;
}
function MarkdownLink({ href, children }: ComponentProps<"a">) {
  const { sources, onPage } = useContext(MarkdownContext);
  if (href?.startsWith("#source-")) {
    const source = sources?.find((item) => item.id === href.slice(8));
    return source ? <button className="source-link" title={source.text} onClick={() => onPage(source.page)}>第 {source.page} 页</button> : <span>{children}</span>;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}
// Stable component identities keep image effects and Blob URLs mounted across measurements.
const MARKDOWN_COMPONENTS: Components = { img: MarkdownImage, a: MarkdownLink };
export function Markdown({ message, project, onPage }: {
  message: Pick<Message, "content" | "sources">;
  project: Project;
  onPage: (page: number) => void;
}) {
  const context = useMemo(() => ({ assets: project.assets, sources: message.sources, onPage }), [project.assets, message.sources, onPage]);
  const content = message.content.replace(/\[([S]\d+)\]/g, (all, id: string) =>
    message.sources?.some((source) => source.id === id) ? `[${id}](#source-${id})` : all);
  return <MarkdownContext.Provider value={context}><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false }]]}
    urlTransform={(url) => url.startsWith("asset:") || url.startsWith("inkask://asset/") ? url : defaultUrlTransform(url)}
    components={MARKDOWN_COMPONENTS}
  >{normalizeMathMarkdown(content)}</ReactMarkdown></MarkdownContext.Provider>;
}
