import { unified } from "unified";
import remarkParse from "remark-parse";

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}
const parser = unified().use(remarkParse);

/**
 * `\middle|` inside `\left\{…\right\}` stretches to the height of the braces, which
 * looks like a stray vertical rule in set-builder notation. `\mid` is the
 * conventional "such that" bar at normal height; models reach for `\middle|`
 * far more often than they need it.
 */
const MIDDLE_BAR = /(?:\\\s*)?\\middle\|(?:\\\s*)?/g;

function normalizeProse(source: string): string {
  let output = "";
  let at = 0;
  while (at < source.length) {
    if (source.startsWith("\\\\", at)) {
      output += "\\\\";
      at += 2;
      continue;
    }
    if (source.startsWith("\\(", at) || source.startsWith("\\[", at)) {
      const display = source[at + 1] === "[";
      const end = source.indexOf(display ? "\\]" : "\\)", at + 2);
      if (end >= 0) {
        const body = source.slice(at + 2, end);
        output += display ? `\n$$\n${body.trim()}\n$$\n` : `$${body}$`;
        at = end + 2;
        continue;
      }
    }
    output += source[at++];
  }
  return output.replace(MIDDLE_BAR, "\\mid ");
}

/** Protect every actual CommonMark code range, including indented code. */
export function normalizeMathMarkdown(source: string): string {
  if (!source.includes("\\(") && !source.includes("\\[") && !source.includes("\\middle")) {
    return source;
  }
  const protectedRanges: Array<[number, number]> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start != null && end != null) protectedRanges.push([start, end]);
      return;
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(source));
  protectedRanges.sort((a, b) => a[0] - b[0]);
  let output = "", cursor = 0;
  for (const [start, end] of protectedRanges) {
    output += normalizeProse(source.slice(cursor, start)) + source.slice(start, end);
    cursor = end;
  }
  return output + normalizeProse(source.slice(cursor));
}

/** CommonMark strips one padding space; preserve raw backticks and spaces. */
export function codeSpan(raw: string): string {
  const longest = Math.max(0, ...(raw.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const padding = raw.startsWith("`") || raw.endsWith("`") || (raw.startsWith(" ") && raw.endsWith(" ") && /[^ ]/.test(raw)) ? " " : "";
  return `${ticks}${padding}${raw}${padding}${ticks}`;
}

/** Titles may shorten prose, but never cut a formula's closing delimiter. */
export function mathExcerpt(source: string, limit = 28): string {
  const text = normalizeMathMarkdown(source).trim();
  if (text.startsWith("```")) return "代码片段";
  let end = Math.min(limit, text.length);
  for (const atom of text.matchAll(/(`+)[\s\S]*?\1|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$])+?\$/g)) {
    if (atom.index < end && atom.index + atom[0].length > end) end = atom.index + atom[0].length;
  }
  return text.slice(0, end).replace(/\n+/g, " ") + (end < text.length ? "…" : "");
}
