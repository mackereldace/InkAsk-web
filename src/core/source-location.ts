import type { Anchor, PageText, Rect, Source } from "../types";
const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
/** Locate a cited excerpt in PDF/OCR word coordinates, never substitute an unrelated page image. */
export function sourceAnchor(source: Source, page?: PageText): Anchor | undefined {
  if (source.rects?.length) return { page: source.page, rects: source.rects, quote: source.text };
  if (!page?.words.length) return;
  const text = page.words.map((word) => normalized(word.text));
  const joined = text.join("");
  const candidates = [source.text, ...source.text.split(/(?:选中原文：|当前页附近：|\n\s*\n)/)].map(normalized).filter((part) => part.length >= 3).sort((a, b) => b.length - a.length);
  for (const quote of candidates) {
    let offset = joined.indexOf(quote), length = quote.length;
    // Retrieved chunks can start/end inside word runs. A reliable interior span
    // still identifies the exact corresponding word boxes in this source page.
    if (offset < 0 && quote.length > 80) {
      const interior = quote.slice(20, -20);
      offset = joined.indexOf(interior); length = interior.length;
    }
    if (offset < 0) continue;
    let cursor = 0;
    const rects: Rect[] = [];
    for (let i = 0; i < text.length; i++) {
      if (cursor < offset + length && cursor + text[i].length > offset) rects.push(page.words[i].rect);
      cursor += text[i].length;
    }
    if (rects.length) return { page: source.page, quote: source.text, rects };
  }
}
export function unionRects(rects: Rect[]): Rect | undefined {
  if (!rects.length) return;
  return rects.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
}
