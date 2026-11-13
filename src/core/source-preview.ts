import type { Anchor, PageText, Rect, Source } from "../types";
import type { EvidenceBlock } from "./evidence-types";
import { pageEvidenceBlocks } from "./evidence-blocks";
import { rankEvidenceBlocks } from "./evidence-retrieval";
import { sourceAnchor, unionRects } from "./source-location";

export interface EvidencePreviewPart { label: string; text: string; anchor?: Anchor }
export interface EvidencePreview {
  parts: EvidencePreviewPart[];
  kind: "evidence" | "selection" | "context" | "unresolved";
}
const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 10;

/** Keep separated columns/paragraphs as separate crops, including sparse captions. */
export function sourceRectGroups(rects: Rect[]): Rect[][] {
  const valid = rects.filter((r) => r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]);
  const height = Math.max(2, median(valid.map((r) => r[3] - r[1])));
  const lines: { box: Rect; rects: Rect[] }[] = [];
  for (const rect of [...valid].sort((a, b) => b[3] - a[3] || a[0] - b[0])) {
    const line = lines.find((line) => Math.min(line.box[3], rect[3]) - Math.max(line.box[1], rect[1]) > Math.min(height, rect[3] - rect[1]) * .2);
    if (line) { line.rects.push(rect); line.box = unionRects([line.box, rect])!; }
    else lines.push({ box: [...rect], rects: [rect] });
  }
  const segments = lines.flatMap((line) => {
    const result: { box: Rect; rects: Rect[] }[] = [];
    for (const rect of line.rects.sort((a, b) => a[0] - b[0])) {
      const last = result.at(-1);
      if (last && rect[0] - last.box[2] <= Math.max(24, height * 4)) { last.rects.push(rect); last.box = unionRects([last.box, rect])!; }
      else result.push({ box: [...rect], rects: [rect] });
    }
    return result;
  }).sort((a, b) => b.box[3] - a.box[3] || a.box[0] - b.box[0]);
  const groups: { box: Rect; bottom: number; rects: Rect[] }[] = [];
  for (const segment of segments) {
    const group = groups.filter((g) => {
      const gap = g.bottom - segment.box[3];
      const overlap = Math.min(g.box[2], segment.box[2]) - Math.max(g.box[0], segment.box[0]);
      return gap >= -height && gap <= Math.max(20, height * 2.2) && overlap > Math.min(g.box[2] - g.box[0], segment.box[2] - segment.box[0]) * .15;
    }).sort((a, b) => Math.abs(a.bottom - segment.box[3]) - Math.abs(b.bottom - segment.box[3]))[0];
    if (group) { group.rects.push(...segment.rects); group.box = unionRects([group.box, segment.box])!; group.bottom = Math.min(group.bottom, segment.box[1]); }
    else groups.push({ box: [...segment.box], bottom: segment.box[1], rects: [...segment.rects] });
  }
  // A proof-ending square or short superscript belongs with the adjacent block.
  for (const tiny of [...groups]) {
    if (tiny.rects.length > 2 || tiny.box[2] - tiny.box[0] > height * 2 || tiny.box[3] - tiny.box[1] > height * 2) continue;
    const parent = groups.filter((g) => g !== tiny && g.box[3] - g.box[1] > height * 2 &&
      tiny.box[0] >= g.box[0] - height * 8 && tiny.box[2] <= g.box[2] + height * 8 &&
      Math.max(0, g.box[1] - tiny.box[3], tiny.box[1] - g.box[3]) < height * 3)
      .sort((a, b) => Math.abs(a.bottom - tiny.box[3]) - Math.abs(b.bottom - tiny.box[3]))[0];
    if (parent) { parent.rects.push(...tiny.rects); parent.box = unionRects([parent.box, tiny.box])!; groups.splice(groups.indexOf(tiny), 1); }
  }
  return groups.map((g) => g.rects.map((r) => [...r] as Rect));
}

function previewParts(anchor: Anchor, label: string): EvidencePreviewPart[] {
  return sourceRectGroups(anchor.rects).map((rects, index, groups) => ({
    label: label + (groups.length > 1 ? ` · ${index + 1}/${groups.length}` : ""),
    text: anchor.quote,
    anchor: { ...anchor, rects },
  }));
}

/** Resolve old large context records at read time; their saved IDs/text stay intact. */
export function sourceEvidencePreview(source: Source, page?: PageText, claim = ""): EvidencePreview {
  const anchor = sourceAnchor(source, page);
  if (!anchor) return { kind: "unresolved", parts: [{ label: source.label ?? "原文摘录", text: source.text }] };
  if (source.blockId) return { kind: "evidence", parts: previewParts(anchor, source.label ?? "原文段落") };
  const selected = source.id === "S1" && source.text.length < 180;
  if (selected) return { kind: "selection", parts: previewParts(anchor, source.label ?? "原文选区") };
  if (page) {
    const start = page.text.indexOf(source.text);
    const unique = start >= 0 && page.text.indexOf(source.text, start + 1) < 0;
    if (unique) {
      const end = start + source.text.length;
      const candidates: EvidenceBlock[] = [];
      for (const block of pageEvidenceBlocks(page)) {
        if (block.role === "marginal" || block.role === "heading") continue;
        const from = Math.max(start, block.start), to = Math.min(end, block.end);
        if (to <= from) continue;
        const raw = page.text.slice(from, to), text = raw.trim();
        if (text.length < 12) continue;
        const matched = sourceAnchor({ id: source.id, page: source.page, text }, page);
        if (!matched?.rects.length) continue;
        candidates.push({ ...block, label: block.label + (from > block.start || to < block.end ? "（原引用节选）" : ""), text, start: from + raw.indexOf(text), end: from + raw.indexOf(text) + text.length, rects: matched.rects });
      }
      if (candidates.length && (source.text.length > 450 || sourceRectGroups(anchor.rects).length > 1)) {
        const ranked = claim.trim() ? rankEvidenceBlocks(candidates, claim, { includeCaptions: true }) : [];
        const first = ranked[0], second = ranked[1];
        const premiseAndProof = first && second && first.block.section && first.block.section === second.block.section &&
          new Set([first.block.role, second.block.role]).has("proof") &&
          [first.block.role, second.block.role].some((role) => role === "theorem" || role === "definition") &&
          /证明|推导|等度|计算|proof|derive/i.test(claim) && second.score >= first.score * .35;
        const focused = first && !premiseAndProof && (!second || first.score > second.score * 1.6)
          ? [first.block] : ranked.length ? ranked.slice(0, 2).map((r) => r.block) : candidates;
        return { kind: "context", parts: focused.flatMap((block) => previewParts({ page: source.page, quote: block.text, rects: block.rects }, block.label)) };
      }
    }
  }
  return { kind: "context", parts: previewParts(anchor, source.label ?? "原文片段") };
}
