import { describe, expect, it } from "vitest";
import { sourceAnchor, sourceForAnchor } from "../src/core/source-location";
import { buildContext } from "../src/core/context";
import { DEFAULT_TEMPLATES } from "../src/core/templates";
import type { Anchor, Note, PageText, Project, WordBox } from "../src/types";
function page(runs: Array<[string, number]>, source: PageText["source"] = "native"): PageText {
  return {page: 1, text: runs.map(([text]) => text).join("\n\n"), words: runs.map(([text, y]) => ({text, rect: [10, y, 300, y + 15]} as WordBox)), width: 600, height: 800, source, status: "ready"};
}
const cite = (text: string) => ({ id: "S1", page: 1, text });
describe("precise source paragraph resolution", () => {
  it("finds a lower paragraph without substituting the page heading", () => {
    const text = page([["Introduction", 740], ["The derivative measures change.", 300], ["Conclusion", 100]]);
    expect(sourceAnchor(cite("The derivative measures change."), text)?.rects).toEqual([text.words[1].rect]);
  });
  it("rejects an ambiguous repeated phrase and accepts unique surrounding context", () => {
    const text = page([["First example: identical phrase.", 700], ["Second example: identical phrase.", 200]]);
    expect(sourceAnchor(cite("identical phrase"), text)).toBeUndefined();
    expect(sourceAnchor(cite("Second example: identical phrase."), text)?.rects).toEqual([text.words[1].rect]);
  });
  it("normalizes OCR punctuation, ligatures and line-end hyphenation without losing coordinates", () => {
    const text = page([["The co-", 700], ["efficient，is ﬁnite。", 680]], "ocr");
    expect(sourceAnchor(cite("The coefficient, is finite."), text)?.rects).toEqual(text.words.map((word) => word.rect));
  });
  it("matches legacy TeX delimiters and common math commands against extracted symbols", () => {
    const text = page([["For θ ≤ π, the result follows.", 200]]);
    expect(sourceAnchor(cite("For $\\theta \\leq \\pi$, the result follows."), text)?.rects).toEqual([text.words[0].rect]);
  });
  it("preserves explicit coordinates even when extraction differs, and rejects wrong-page text", () => {
    const text = page([["same words", 200]]);
    expect(sourceAnchor({...cite("OCR differs"), rects: [[1, 2, 3, 4]]}, text)?.rects).toEqual([[1, 2, 3, 4]]);
    expect(sourceAnchor({...cite("same words"), page: 2}, text)).toBeUndefined();
  });
  it("preserves the selected source and enriches retrieved paragraphs", () => {
    const p1 = page([["Selected derivative", 700], ["Derivative change in lower paragraph", 200]]);
    const note: Note = {id: "n", title: "n", anchor: {page: 1, quote: "Selected derivative", rects: [p1.words[0].rect]}, inheritedHistory: [], collapsed: false, task: "explain", templateId: DEFAULT_TEMPLATES[0].id, draft: "", draftAssetIds: [], messages: [], createdAt: 1};
    const project: Project = {version: 1, document: {id: "d", name: "d", fingerprint: "d", pdf: new Blob(), pageCount: 1, createdAt: 1, updatedAt: 1}, pages: [p1], notes: [note], assets: [], templates: DEFAULT_TEMPLATES, view: {page: 1, scale: 1, rotation: 0}};
    const result = buildContext({project, note, question: "derivative change", template: DEFAULT_TEMPLATES[0]});
    expect(result.sources[0]).toEqual({id: "S1", page: 1, text: "Selected derivative", rects: [p1.words[0].rect]});
    const lower = result.sources.find((source) => source.text === "Derivative change in lower paragraph");
    expect(lower?.rects).toEqual([p1.words[1].rect]);
  });
});


describe("existing selected-source coordinates", () => {
  const anchor: Anchor = {page: 1, quote: "Selected paragraph", rects: [[10, 200, 300, 220], [10, 180, 200, 200]]};
  it("recovers the selected paragraph rather than nearby page context for legacy S1", () => {
    const source = cite("选中原文：Selected\n paragraph\n\n当前页附近：Heading and a very large page context");
    const resolved = sourceForAnchor(source, anchor);
    expect(resolved).toEqual({...source, text: anchor.quote, rects: anchor.rects});
    expect(resolved.rects).not.toBe(anchor.rects);
    expect(resolved.rects?.[0]).not.toBe(anchor.rects[0]);
    expect(source).not.toHaveProperty("rects");
    // A child inherits the same PDF anchor, so its legacy S1 recovers identically.
    expect(sourceForAnchor(source, structuredClone(anchor))).toEqual(resolved);
  });
  it("recovers plain selected sources while preserving explicit or unrelated coordinates", () => {
    expect(sourceForAnchor(cite("Selected paragraph"), anchor).rects).toEqual(anchor.rects);
    for (const source of [
      {...cite("Selected paragraph"), id: "S2"},
      {...cite("Selected paragraph"), page: 2},
      cite("选中原文：A different passage\n\n当前页附近：Selected paragraph"),
      {...cite("OCR differs"), rects: [[1, 2, 3, 4]] as Anchor["rects"]},
    ]) expect(sourceForAnchor(source, anchor)).toBe(source);
    expect(sourceForAnchor(cite(""), {...anchor, quote: ""})).not.toHaveProperty("rects");
  });
});
