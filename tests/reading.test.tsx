import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AnswerReader from "../src/AnswerReader";
import ContinuousPdf from "../src/ContinuousPdf";
import { createBranch } from "../src/core/branches";
import { buildContext } from "../src/core/context";
import { answerFor, parentReadingTarget, readingTrail } from "../src/core/reading";
import { DEFAULT_TEMPLATES } from "../src/core/templates";
import type { PDFDocumentProxy } from "../src/pdf";
import type { Message, Note, Project } from "../src/types";

vi.mock("../src/PdfPage", () => ({ default: () => <div data-live-pdf="true" /> }));

function message(id: string, content: string, role: Message["role"] = "assistant"): Message {
  return { id, role, content, assetIds: [], status: "complete", createdAt: 1 };
}
function fixture(): Project {
  return {
    version: 1,
    document: { id: "pdf", name: "教材.pdf", fingerprint: "pdf", pdf: new Blob(), pageCount: 3, createdAt: 1, updatedAt: 1 },
    pages: [1, 2, 3].map((page) => ({ page, text: `第 ${page} 页原始文字`, words: [], source: "native", status: "ready", width: 600, height: 800 })),
    notes: [{ id: "root", title: "导数是什么", anchor: { page: 2, rects: [[10, 10, 100, 30]], quote: "原 PDF 中的定义" },
      inheritedHistory: [], collapsed: false, task: "explain", templateId: DEFAULT_TEMPLATES[0].id,
      draft: "", draftAssetIds: [], createdAt: 1,
      messages: [message("q", "请解释导数", "user"), message("a1", "较早回答中选中的一句话"), message("a2", "后来的另一份回答")] }],
    assets: [], templates: structuredClone(DEFAULT_TEMPLATES), view: { page: 2, scale: 1, rotation: 0 },
  };
}

describe("reading answers as nested documents", () => {
  it("returns to the exact parent answer and retains each level of the reading chain", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "选中的一句话");
    child.messages = [message("child-answer", "第二层回答")];
    p.notes.push(child);
    const grandchild = createBranch(p, child, "child-answer", "第二层");
    p.notes.push(grandchild);
    expect(parentReadingTarget(p.notes, child.id)).toEqual({ noteId: "root", messageId: "a1" });
    expect(answerFor(p.notes[0], "a1")?.content).toBe("较早回答中选中的一句话");
    expect(answerFor(p.notes[0])?.id).toBe("a2");
    expect(readingTrail(p.notes, grandchild.id).map((n) => n.id)).toEqual(["root", child.id, grandchild.id]);
    expect(parentReadingTarget(p.notes, "root")).toBeUndefined();
    expect(child.inheritedHistory.map((m) => m.content)).not.toContain("后来的另一份回答");
  });

  it("uses answer selections as the next task's input while keeping PDF citations separate", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "选中的一句话", "translate");
    p.notes.push(child);
    const result = buildContext({ project: p, note: child, question: "", template: p.templates.find((t) => t.id === child.templateId)! });
    expect(child.task).toBe("translate");
    expect(result.prompt).toContain("【选中的原文】\n选中的一句话");
    expect(result.prompt).toContain("当前选文来自该回答，不是 PDF 原文");
    expect(result.sources[0].page).toBe(2);
    expect(result.sources[0].text).toContain("原 PDF 中的定义");
    expect(result.history.at(-1)?.content).toBe("较早回答中选中的一句话");
  });

  it("renders the chosen answer in the reading surface and child notes as links", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "选中的一句话");
    child.messages = [message("child-a", "子回答正文不应嵌入父回答")];
    p.notes.push(child);
    const noop = () => {};
    const html = renderToStaticMarkup(<AnswerReader note={p.notes[0]} project={p} messageId="a1" busy={false} apiReady
      context={(note) => buildContext({ project: p, note, question: "", template: p.templates[0] })}
      onUpdate={noop} onSend={noop} onStop={noop} onSelect={noop} onClearSelection={noop} onBranch={noop} onDelete={noop}
      onPage={noop} onFocus={noop} onAttach={noop} onScreenshot={noop} onRetry={noop} />);
    expect(html).toContain('aria-label="回答阅读页"');
    expect(html).toContain('aria-label="AI 回答正文"');
    expect(html).toContain("较早回答中选中的一句话");
    expect(html).toContain('aria-label="这份回答中的便签"');
    expect(html).not.toContain("子回答正文不应嵌入父回答");
    expect(html).not.toContain("后来的另一份回答</p>");
    expect(html).not.toContain('class="composer"');
  });

  it("bounds a malformed cyclic breadcrumb instead of looping forever", () => {
    const p = fixture();
    p.notes[0].parentId = "root";
    expect(readingTrail(p.notes, "root")).toHaveLength(1);
  });
});

describe("continuous PDF reading", () => {
  it("keeps every page in scroll order and only PDF source notes on the PDF", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "AI 回答中的子便签");
    p.notes.push(child);
    const html = renderToStaticMarkup(<ContinuousPdf pdf={{ numPages: 3 } as PDFDocumentProxy} project={p}
      scrollRoot={createRef<HTMLDivElement>()} pageSizes={new Map()} regionMode={false} onSelect={() => {}} onClearSelection={() => {}} onFocus={() => {}}
      onPageChange={() => {}} onError={() => {}} />);
    expect([...html.matchAll(/data-pdf-page="(\d+)"/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    expect(html).toContain("导数是什么");
    expect(html).not.toContain("AI 回答中的子便签");
    expect((html.match(/data-live-pdf/g) ?? [])).toHaveLength(1);
  });
});
