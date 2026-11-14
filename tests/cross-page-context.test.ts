import { describe, expect, it } from "vitest";
import { buildContext } from "../src/core/context";
import { DEFAULT_TEMPLATES } from "../src/core/templates";
import { sourceForAnchor } from "../src/core/source-location";
import type { Anchor, Note, Project } from "../src/types";

const fragments = [
  { page: 1, quote: "Premise at the end of page one", rects: [[10, 20, 200, 30] as [number, number, number, number]] },
  { page: 2, quote: "Only the first half line", rects: [[10, 700, 120, 710] as [number, number, number, number]] },
];
const anchor: Anchor = { ...fragments[0], quote: fragments.map(fragment => fragment.quote).join("\n"), fragments };
function fixture(parentId?: string): { note: Note; project: Project } {
  const note: Note = { id: "n", title: "Cross page", anchor, ...(parentId ? { parentId, branchQuote: "Explain this answer" } : {}), inheritedHistory: [], collapsed: false, task: "explain", templateId: DEFAULT_TEMPLATES[0].id, draft: "", draftAssetIds: [], messages: [], createdAt: 1 };
  const project: Project = { version: 1, document: { id: "d", name: "Cross page", fingerprint: "d", pdf: new Blob(), pageCount: 2, createdAt: 1, updatedAt: 1 }, pages: [], notes: [note], assets: [], templates: DEFAULT_TEMPLATES, view: { page: 1, scale: 1, rotation: 0 } };
  return { note, project };
}
describe("page-local sources for a continuous selection", () => {
  for (const parentId of [undefined, "parent"]) it(`keeps both partial pages for ${parentId ? "a nested answer" : "a PDF question"}`, () => {
    const { note, project } = fixture(parentId), before = JSON.stringify(note);
    const context = buildContext({ note, project, question: "Explain", template: DEFAULT_TEMPLATES[0] });
    expect(context.sources).toEqual(fragments.map((fragment, index) => ({ id: `S${index + 1}`, page: fragment.page, text: fragment.quote, rects: fragment.rects })));
    expect(context.prompt).toContain("[S1] 第 1 页"); expect(context.prompt).toContain("[S2] 第 2 页");
    expect(context.prompt).toContain(fragments[1].quote);
    expect(context.sources[1].rects).not.toBe(fragments[1].rects);
    const custom = buildContext({ note, project, question: "Explain", template: { ...DEFAULT_TEMPLATES[0], body: "第 {{page_number}} 页：{{selected_text}}\n{{question}}" } });
    expect(custom.prompt).toContain("第 1、2 页");
    expect(custom.prompt).toContain(fragments[1].quote);
    expect(JSON.stringify(note)).toBe(before);
  });
  it("restores a source only from its own page fragment", () => {
    const source = { id: "S1", page: 2, text: fragments[1].quote };
    expect(sourceForAnchor(source, anchor)).toEqual({ ...source, rects: fragments[1].rects });
    expect(source).not.toHaveProperty("rects");
  });
});
