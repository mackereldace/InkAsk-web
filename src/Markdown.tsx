import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { X } from "lucide-react";
import type { Asset, Message, Project } from "./types";

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
export function Markdown({
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
