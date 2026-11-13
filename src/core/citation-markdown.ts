import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathMarkdown } from "./math-markdown";
import type { Source } from "../types";

interface Node {
  type: string;
  url?: string;
  identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** Use the same actual Markdown citations for rendering and the source summary. */
export function prepareCitationMarkdown(input: string, sources: readonly Pick<Source, "id">[] = []) {
  const content = normalizeMathMarkdown(input), ids = new Set(sources.map((source) => source.id));
  const citedIds = new Set<string>(), changes: { start: number; end: number; id: string }[] = [];
  const tree = parser.parse(content) as Node, definitions = new Map<string, string>();
  const definitionsIn = (node: Node) => { if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url); node.children?.forEach(definitionsIn); };
  definitionsIn(tree);
  const link = (url?: string) => { const id = url?.startsWith("#source-") ? url.slice(8) : undefined; if (id && ids.has(id)) citedIds.add(id); };
  const visit = (node: Node) => {
    if (["code", "inlineCode", "math", "inlineMath", "image", "imageReference", "html", "definition"].includes(node.type)) return;
    if (node.type === "link") { link(node.url); return; }
    if (node.type === "linkReference") { link(definitions.get(node.identifier ?? "")); return; }
    if (node.type === "text") {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const match of content.slice(start, end).matchAll(/(?<!\[)\[(S\d+)\](?!\()/g)) {
        if (!ids.has(match[1])) continue;
        const offset = start + match.index!;
        let slashes = 0;
        for (let cursor = offset - 1; cursor >= 0 && content[cursor] === "\\"; cursor--) slashes++;
        if (slashes % 2) continue;
        citedIds.add(match[1]); changes.push({ start: offset, end: offset + match[0].length, id: match[1] });
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  let rendered = content;
  for (const change of changes.sort((a, b) => b.start - a.start)) rendered = rendered.slice(0, change.start) + `[${change.id}](#source-${change.id})` + rendered.slice(change.end);
  return { content: rendered, citedIds };
}
